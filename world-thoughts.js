// world-thoughts.js — 12B-1：念头池后端（shadow mode）。
// 只收集/去重/排序/展示，验证念头池本身稳定。【严禁】喂 Claude / 进 <此刻>/唤醒包/聊天md/surfacing/记忆库；
// 【严禁】写回 mood/longing/libido/social/stress/focus/comfort。念头池=短中期"当前浮现素材池"，不是真实感受值。
//
// 【12B v1 冻结范围 · 2026-06-15】念头池 v1 当前只承担"未完成待办的跨窗口保留 + 克制浮现"，
// 不承担完整生活事件池或情绪驱动功能。数据源=phone_todos_cheng 未完成待办；category 只 unresolved_intent；
// 排序用现有 base salience；防重复用 24–36h base-salience 冷却；待办做完由 collector archive。
// 12B-3「7 个后台驱动排序器」spec 已作废：候选全属同一 category，类别驱动给所有念头加相同权重=空转。
// 故：不建 drive table、不做 effective_score、不做 decay 倍率、不恢复已停用的 collector / decay。
//
// 念头来源(source_type)：timeline / todo / inner_thought / world_message / pending_wake。
// 去重唯一键：source_type + source_id + category（source_id NOT NULL）。
// 工程分类(category)：relationship / unresolved_intent / curiosity / work / object / bodily_need / life_event。
import { supabase } from './memory.js';

const ACTIVE_CAP = 50;
const WM_UNRESPONDED_MS = 30 * 60 * 1000; // world_message 发出超 30 分钟没 user 回复 = 未回应
const DECAY_AGE_MS = 7 * 24 * 3600 * 1000; // 超 7 天才开始衰减
const DECAY_FACTOR = 0.9;
const DECAY_FLOOR = 0.1;

function nowISO() { return new Date().toISOString(); }
function plus8Date(ts) { return ts ? new Date(new Date(ts).getTime() + 8 * 3600000).toISOString().slice(0, 10) : ''; }
function shortAction(a) { const s = String(a || '').split(' → ')[0].trim(); return s.length > 26 ? s.slice(0, 26) + '…' : s; }
function truncate(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
// 小心思/消息常用 ---bubble--- 分多个气泡，浮现只取第一段，避免标记和半截下一气泡漏进来。
function firstBubble(s) { return String(s || '').split('---bubble---')[0]; }
// 洗掉残留的世界标签([WORLD_MESSAGE]/[TODO]/[WORLD_CHOICE]/[MEMORY]，配对或单个)，保留里面的话。
// 小心思本应是标签外散文，但偶有澄写漏闭合标签导致残留——念头 content 这里兜底洗一遍。
function stripTags(s) {
  return String(s || '').replace(/\[\/?(WORLD_MESSAGE|WORLD_CHOICE|TODO|MEMORY)(:[^\]]*)?\]/gi, '').replace(/\s+/g, ' ').trim();
}

// ── 水位线 ──────────────────────────────────────────
async function getWaterline(sourceType) {
  const { data } = await supabase.from('world_thought_collect_state').select('last_collected_at').eq('source_type', sourceType).limit(1);
  return data?.[0]?.last_collected_at || '1970-01-01T00:00:00Z';
}
async function setWaterline(sourceType, maxCreatedAt) {
  await supabase.from('world_thought_collect_state')
    .upsert({ source_type: sourceType, last_collected_at: maxCreatedAt, updated_at: nowISO() }, { onConflict: 'source_type' });
}
// 候选念头 upsert：已存在(任何状态)就跳过——不重复、不复活已 dismissed/archived 的。
async function upsertThoughts(cands) {
  if (!cands.length) return 0;
  const rows = cands.map(c => ({ ...c, last_seen_at: nowISO() }));
  const { error } = await supabase.from('world_thoughts_cheng')
    .upsert(rows, { onConflict: 'source_type,source_id,category', ignoreDuplicates: true });
  if (error) { console.warn('[THOUGHTS] upsert 失败:', error.message); return 0; }
  return rows.length;
}

// ── 各来源「采集候选」（不 upsert、不推水位线）。候选带 created_at(源行)+_wl(水位线源键)。──────────────
const MAX_NEW_PER_COLLECT = 8; // 每轮最多新增 active 念头数，避免一波新事件冲掉旧念头

// ⚠️【disabled by current design / not called · 12B v1】timeline 来源已主动移除（错标没收尾 + 漏 ignored 情绪），不恢复。保留代码仅备查，不是漏接/故障。
async function gatherTimeline() {
  const wl = await getWaterline('timeline');
  const { data } = await supabase.from('daily_timeline_cheng')
    .select('id, action, detail, world_time, location, created_at').gt('created_at', wl).order('created_at', { ascending: true }).limit(60);
  const out = [];
  for (const r of data || []) {
    const d = r.detail || {};
    const hasIgnored = d.ignored_effects && Object.keys(d.ignored_effects).length > 0;
    const hasItem = !!d.item;
    if (!hasIgnored && !hasItem && !d.event_type) continue; // 跳过纯衰减/作息/工资等系统行
    const category = hasItem ? 'object' : (d.event_type === 'work_event' ? 'work' : 'life_event');
    const salience = hasItem ? 0.5 : (hasIgnored ? 0.45 : 0.35);
    const content = hasItem ? `${d.item.name}还没有处理。` : `刚才有件事还没收尾：${shortAction(r.action)}。`;
    out.push({
      source_type: 'timeline', source_id: String(r.id), category, content, salience, status: 'active', created_at: r.created_at, _wl: 'timeline',
      metadata: { action: r.action, ignored_effects: d.ignored_effects || null, item: d.item || null, event_type: d.event_type || null, npc: d.npc || null, world_time: r.world_time, location: r.location },
    });
  }
  return out;
}
async function gatherTodos() {
  const wl = await getWaterline('todo');
  const { data } = await supabase.from('phone_todos_cheng')
    .select('id, title, urgency, status, created_at').eq('status', 'open').gt('created_at', wl).order('created_at', { ascending: true }).limit(60);
  return (data || []).map(t => {
    const u = Number(t.urgency); const sal = Math.min(0.95, 0.5 + (Number.isFinite(u) ? u : 0.5) * 0.4);
    return { source_type: 'todo', source_id: String(t.id), category: 'unresolved_intent', content: `小手机里还有一条待办：${truncate(t.title, 40)}`, salience: sal, status: 'active', created_at: t.created_at, _wl: 'todo', metadata: { urgency: t.urgency, title: t.title } };
  });
}
// ⚠️【disabled by current design / not called · 12B v1】小心思来源已主动移除（演的戏 / 漏闭合标签漏情绪），不恢复。保留代码仅备查，不是漏接/故障。
async function gatherInnerThoughts() {
  const wl = await getWaterline('inner_thought');
  const { data } = await supabase.from('world_inner_thoughts_cheng')
    .select('id, content, timeline_id, created_at').gt('created_at', wl).order('created_at', { ascending: true }).limit(60);
  return (data || []).map(it => ({
    source_type: 'inner_thought', source_id: String(it.id), category: String(it.content || '').includes('小茉莉') ? 'relationship' : 'life_event',
    content: `之前留下一段小心思：${truncate(stripTags(firstBubble(it.content)), 40)}`, salience: 0.55, status: 'active', created_at: it.created_at, _wl: 'inner_thought', metadata: { timeline_id: it.timeline_id, full: it.content },
  }));
}
// ⚠️【disabled by current design / not called · 12B v1】pending_wake 来源已主动移除（系统自会唤醒，无需再浮现），不恢复。保留代码仅备查，不是漏接/故障。
async function gatherPending() {
  const wl = await getWaterline('pending_wake');
  const { data } = await supabase.from('pending_wake_cheng')
    .select('id, wake_type, reason, status, created_at').eq('status', 'queued').gt('created_at', wl).order('created_at', { ascending: true }).limit(60);
  return (data || []).map(p => ({ source_type: 'pending_wake', source_id: String(p.id), category: 'unresolved_intent', content: '还有一个等待中的后续事件没有完成。', salience: 0.7, status: 'active', created_at: p.created_at, _wl: 'pending_wake', metadata: { wake_type: p.wake_type, reason: p.reason } }));
}
// world_message 未回应：最近一条 world_message，发出超 30min 且其后无 user 消息。无水位线(每轮重判，靠去重)。
// ⚠️【disabled by current design / not called · 12B v1】world_message 来源已主动移除（上下文都在 / 回话即归档），不恢复。保留代码仅备查，不是漏接/故障。
async function gatherWorldMessage() {
  const { data: wm } = await supabase.from('messages').select('id, created_at').eq('event', 'world_message').order('created_at', { ascending: false }).limit(1);
  const m = wm?.[0];
  if (!m || Date.now() - new Date(m.created_at).getTime() < WM_UNRESPONDED_MS) return [];
  const { data: replies } = await supabase.from('messages').select('id').eq('role', 'user').gt('created_at', m.created_at).limit(1);
  if (replies?.length) return [];
  return [{ source_type: 'world_message', source_id: String(m.id), category: 'unresolved_intent', content: '刚才发给小茉莉的那条消息还没有回应。', salience: 0.7, status: 'active', created_at: m.created_at, _wl: null, metadata: { sent_at: m.created_at } }];
}

// 统一处理：采集 → 按 created_at 升序 → 最多新增 8 条 active；水位线只推进到「本轮实际处理过的 max(created_at)」，
// 没被处理的候选不推进（不丢数据）。去重靠 source_type+source_id+category，重复也算已处理(推水位线)但不占 8 名额。
async function scanNewSources(stats) {
  // 浮现源只留小手机待办 todo——小心思(演的戏/漏情绪)、pending_wake(系统自会唤醒)、
  // world_message(上下文都在/回话即归档)、timeline(错标没收尾+漏 ignored 情绪) 都已砍。
  // gatherInnerThoughts/gatherTimeline/gatherPending/gatherWorldMessage 保留定义但不再调用。
  const gathered = await gatherTodos();
  if (!gathered.length) return;
  gathered.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  // 现有键集合（判去重）
  const ids = [...new Set(gathered.map(c => c.source_id))];
  const exist = new Set();
  if (ids.length) {
    const { data: ex } = await supabase.from('world_thoughts_cheng').select('source_type, source_id, category').in('source_id', ids);
    for (const r of ex || []) exist.add(`${r.source_type}|${r.source_id}|${r.category}`);
  }
  const toInsert = []; const processedMax = {}; let newCount = 0;
  for (const c of gathered) {
    if (newCount >= MAX_NEW_PER_COLLECT) break; // 够 8 条就停，后续候选留下次（水位线不推过它们）
    if (c._wl) processedMax[c._wl] = (!processedMax[c._wl] || c.created_at > processedMax[c._wl]) ? c.created_at : processedMax[c._wl];
    const key = `${c.source_type}|${c.source_id}|${c.category}`;
    if (exist.has(key)) continue; // 重复：已处理（推水位线），不占名额
    const { created_at, _wl, ...row } = c;
    toInsert.push(row); exist.add(key); newCount++;
  }
  stats.inserted += await upsertThoughts(toInsert);
  for (const [st, mx] of Object.entries(processedMax)) await setWaterline(st, mx);
}

// ── 收尾：active 念头来源已失效 → archived（active ≤50，全表扫小集合，成本低）──────────────
async function settleResolved(stats) {
  const { data: active } = await supabase.from('world_thoughts_cheng')
    .select('id, source_type, source_id, metadata').eq('status', 'active').limit(ACTIVE_CAP + 20);
  for (const t of active || []) {
    let archive = null;
    if (t.source_type === 'todo') {
      const { data } = await supabase.from('phone_todos_cheng').select('status').eq('id', t.source_id).limit(1);
      if (data?.[0] && data[0].status !== 'open') archive = 'todo_closed';
    } else if (t.source_type === 'pending_wake') {
      const { data } = await supabase.from('pending_wake_cheng').select('status').eq('id', t.source_id).limit(1);
      if (data?.[0] && data[0].status !== 'queued') archive = 'pending_resolved';
    } else if (t.source_type === 'world_message') {
      const sentAt = t.metadata?.sent_at;
      if (sentAt) {
        const { data } = await supabase.from('messages').select('id').eq('role', 'user').gt('created_at', sentAt).limit(1);
        if (data?.length) archive = 'user_replied';
      }
    }
    if (archive) {
      await supabase.from('world_thoughts_cheng')
        .update({ status: 'archived', updated_at: nowISO(), metadata: { ...(t.metadata || {}), resolved_reason: archive } }).eq('id', t.id);
      stats.archived++;
    }
  }
}

// ── 衰减：active 超 7 天，每天最多 ×0.9 一次；<0.1 archive；active 超 50 砍最低；不碰旧感受字段 ──────────────
// ⚠️【disabled by current design / not called · 12B v1】decay 已主动关闭：待办要一直提醒到做完，不因时间褪色。不恢复。保留代码仅备查，不是漏接/故障。
async function decayThoughts(stats) {
  const today = plus8Date(Date.now());
  const cutoff = new Date(Date.now() - DECAY_AGE_MS).toISOString();
  const { data: old } = await supabase.from('world_thoughts_cheng')
    .select('id, salience, last_decay_at, created_at').eq('status', 'active').lt('created_at', cutoff);
  for (const t of old || []) {
    if (plus8Date(t.last_decay_at) === today) continue; // 今天已 decay 过
    const sal = Number(t.salience) * DECAY_FACTOR;
    if (sal < DECAY_FLOOR) {
      await supabase.from('world_thoughts_cheng').update({ status: 'archived', salience: sal, last_decay_at: nowISO(), updated_at: nowISO() }).eq('id', t.id);
      stats.archived++;
    } else {
      await supabase.from('world_thoughts_cheng').update({ salience: sal, last_decay_at: nowISO(), updated_at: nowISO() }).eq('id', t.id);
      stats.decayed++;
    }
  }
  // active 超上限 → 砍最低 salience 的
  const { data: act } = await supabase.from('world_thoughts_cheng')
    .select('id, salience').eq('status', 'active').order('salience', { ascending: false });
  if (act && act.length > ACTIVE_CAP) {
    const extra = act.slice(ACTIVE_CAP).map(t => t.id);
    await supabase.from('world_thoughts_cheng').update({ status: 'archived', updated_at: nowISO() }).in('id', extra);
    stats.archived += extra.length;
  }
}

// ── 12B-2：小世界浮现（只读挑 1 条 active 念头进聊天 surfacing；【不改状态/不落库】）──────────────
// denylist 只是第二层保险(主防线是 collector 写 content 时就是事实句)；命中要打日志，作为回头修 collector 的信号。
const SURFACE_DENYLIST = ['很想', '欲望', '依恋', '焦虑', '不安', '放不下', '惦记', 'attachment', 'desire', 'libido', 'longing', 'mood', 'stress', 'salience', 'priority', 'unresolved_weight'];
// 冷却随紧急度变：salience 0.5→36h、0.95→24h，线性插值（夹在 24~36h）。越急间隔越短=浮得越勤。
const COOLDOWN_LOW_H = 36, COOLDOWN_HIGH_H = 24;
function salienceCooldownMs(salience) {
  const s = Math.min(0.95, Math.max(0.5, Number(salience) || 0.5));
  const t = (s - 0.5) / (0.95 - 0.5); // 0..1
  return (COOLDOWN_LOW_H + t * (COOLDOWN_HIGH_H - COOLDOWN_LOW_H)) * 3600 * 1000;
}
const surfaceCooldown = new Map(); // thought_id -> last_shown_at(ms)，内存级，重启清空（与澄失忆对齐，刻意不持久化）

// ── 12B-2.1 观测（只内存、不落库、重启清空；不影响 pick 行为；不喂 Claude）──────────────
const pickHistory = [];             // 最近 20 次聊天小世界浮现决策（不含 worldWakeInjection）
let worldWakeInjectionLatest = false; // 最近一次世界唤醒包 build 后 tag 扫描结果（tripwire，正常恒 false）
const wakeInjectionHistory = [];    // 最近 20 次唤醒包 tag 扫描（跟 pickHistory 分开）
function pushPickHistory(rec) { pickHistory.push(rec); if (pickHistory.length > 20) pickHistory.shift(); }

// 返回一条自然事实 content（string）或 ''。只读，不改 thought 状态、不落库。
export async function pickWorldThought() {
  const rec = { decidedAt: new Date().toISOString(), activeThoughtsSnapshot: [], selectedThought: null, injectedBlock: null, cooldownSkipped: [], filteredThoughts: [], notes: [] };
  try {
    const { data } = await supabase.from('world_thoughts_cheng')
      .select('id, content, salience, status, source_type, created_at').eq('status', 'active')
      .order('salience', { ascending: false }).order('created_at', { ascending: false }).limit(15);
    const now = Date.now();
    rec.activeThoughtsSnapshot = (data || []).map(t => ({ id: t.id, content: t.content, salience: t.salience, status: t.status, source_type: t.source_type, created_at: t.created_at }));
    for (const t of data || []) {
      // 已存旧念头的 content 可能含 ---bubble---（修复前收集的），展示时切到第一段洗干净。
      const c = firstBubble(t.content).trim();
      if (!c) continue;
      const hit = SURFACE_DENYLIST.find(w => c.includes(w));
      if (hit) {
        console.warn(`[thought-surfacing] filtered thought id=${t.id} reason=unsafe_content hit="${hit}" content="${c}"`);
        rec.filteredThoughts.push({ id: t.id, content: c, filtered_reason: 'unsafe_content', matched_word: hit, log_time: new Date().toISOString() });
        continue;
      }
      const cdMs = salienceCooldownMs(t.salience);
      const last = surfaceCooldown.get(t.id) || 0;
      if (now - last < cdMs) {
        rec.cooldownSkipped.push({ id: t.id, content: c, last_shown_at: new Date(last).toISOString(), skipped_reason: `cooldown_${Math.round(cdMs / 3600000)}h` });
        continue;
      }
      surfaceCooldown.set(t.id, now);
      rec.selectedThought = { id: t.id, content: c, salience: t.salience, reason: 'selected_for_world_surfacing' };
      rec.injectedBlock = c;
      pushPickHistory(rec);
      return c; // 只给事实 content，不带 salience/category/source_type/metadata
    }
    rec.notes.push('no_eligible_thought');
    pushPickHistory(rec);
    return '';
  } catch (e) { rec.notes.push('error:' + e.message); pushPickHistory(rec); console.warn('[thought-surfacing] pick 失败:', e.message); return ''; }
}

// 世界唤醒包 build 后调用：扫 package 文本里有没有 <小世界浮现>（tripwire，正常恒 false）。只观测、不读 pick、不注入。
export function recordWakeInjectionScan(packageText) {
  const has = /<小世界浮现>/.test(String(packageText || ''));
  worldWakeInjectionLatest = has;
  wakeInjectionHistory.push({ checkedAt: new Date().toISOString(), hasWorldSurfacingTag: has, matchedTag: has ? '<小世界浮现>' : null, notes: [] });
  if (wakeInjectionHistory.length > 20) wakeInjectionHistory.shift();
  if (has) console.warn('[thought-surfacing] ⚠️ 回归告警：世界唤醒包里出现 <小世界浮现>');
}

// 只读 debug 观测（不重新 pick、不触发 collector、不改 cooldown/状态/库）。pickHistory 只管聊天决策；
// worldWakeInjectionLatest / wakeInjectionHistory 单独管唤醒包扫描。倒序返回。
export function getSurfacingDebug() {
  return {
    pickHistory: [...pickHistory].reverse(),
    latestPick: pickHistory[pickHistory.length - 1] || null,
    worldWakeInjectionLatest,
    wakeInjectionHistory: [...wakeInjectionHistory].reverse(),
  };
}

// ── 入口：collector（内存锁，防 tick + 手动并发）──────────────
let isCollecting = false;
export async function collectWorldThoughts() {
  if (isCollecting) return { ok: false, reason: 'already_running' };
  isCollecting = true;
  const stats = { inserted: 0, archived: 0, decayed: 0 };
  try {
    await scanNewSources(stats); // 只采 todo → 按 created_at 排序 → 每轮最多新增 8 条 → 推水位线
    await settleResolved(stats); // 待办做完(status≠open) → 归档，停止浮现
    // 衰减 + 砍最低已去掉：待办该一直提醒到做完，不因放久了淡出（decayThoughts 保留定义但不调用）。
    console.log(`[THOUGHTS] collect: +${stats.inserted} 新 / ${stats.archived} 收尾`);
    return { ok: true, ...stats };
  } catch (e) {
    console.error('[THOUGHTS] collect 异常:', e.message);
    return { ok: false, error: e.message };
  } finally { isCollecting = false; }
}
