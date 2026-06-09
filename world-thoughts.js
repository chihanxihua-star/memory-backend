// world-thoughts.js — 12B-1：念头池后端（shadow mode）。
// 只收集/去重/排序/展示，验证念头池本身稳定。【严禁】喂 Claude / 进 <此刻>/唤醒包/聊天md/surfacing/记忆库；
// 【严禁】写回 mood/longing/libido/social/stress/focus/comfort。念头池=短中期"当前浮现素材池"，不是真实感受值。
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
async function gatherInnerThoughts() {
  const wl = await getWaterline('inner_thought');
  const { data } = await supabase.from('world_inner_thoughts_cheng')
    .select('id, content, timeline_id, created_at').gt('created_at', wl).order('created_at', { ascending: true }).limit(60);
  return (data || []).map(it => ({
    source_type: 'inner_thought', source_id: String(it.id), category: String(it.content || '').includes('小茉莉') ? 'relationship' : 'life_event',
    content: `之前留下一段小心思：${truncate(it.content, 40)}`, salience: 0.55, status: 'active', created_at: it.created_at, _wl: 'inner_thought', metadata: { timeline_id: it.timeline_id },
  }));
}
async function gatherPending() {
  const wl = await getWaterline('pending_wake');
  const { data } = await supabase.from('pending_wake_cheng')
    .select('id, wake_type, reason, status, created_at').eq('status', 'queued').gt('created_at', wl).order('created_at', { ascending: true }).limit(60);
  return (data || []).map(p => ({ source_type: 'pending_wake', source_id: String(p.id), category: 'unresolved_intent', content: '还有一个等待中的后续事件没有完成。', salience: 0.7, status: 'active', created_at: p.created_at, _wl: 'pending_wake', metadata: { wake_type: p.wake_type, reason: p.reason } }));
}
// world_message 未回应：最近一条 world_message，发出超 30min 且其后无 user 消息。无水位线(每轮重判，靠去重)。
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
  const gathered = (await Promise.all([gatherTimeline(), gatherTodos(), gatherInnerThoughts(), gatherPending(), gatherWorldMessage()])).flat();
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

// ── 入口：collector（内存锁，防 tick + 手动并发）──────────────
let isCollecting = false;
export async function collectWorldThoughts() {
  if (isCollecting) return { ok: false, reason: 'already_running' };
  isCollecting = true;
  const stats = { inserted: 0, archived: 0, decayed: 0 };
  try {
    await scanNewSources(stats); // 采集所有源 → 按 created_at 排序 → 每轮最多新增 8 条 → 按源推水位线
    await settleResolved(stats);
    await decayThoughts(stats);
    console.log(`[THOUGHTS] collect: +${stats.inserted} 新 / ${stats.archived} 收尾 / ${stats.decayed} 衰减`);
    return { ok: true, ...stats };
  } catch (e) {
    console.error('[THOUGHTS] collect 异常:', e.message);
    return { ok: false, error: e.message };
  } finally { isCollecting = false; }
}
