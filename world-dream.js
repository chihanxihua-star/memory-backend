// world-dream.js — 14B-1 梦境生命周期：调度(night睡眠开始排梦) → 睡眠中某tick触发生成 → 醒来定记忆程度 → 残留注入一次。
// 只 night 睡眠做梦，nap 不做。一轮睡眠最多一条梦。完整梦永不进 Claude——只存库/给小茉莉看；澄醒来只看 recalled_content。
// 生成走 world-dream-gen.js 的独立 API；失败只 warning，不连累睡眠/tick。
import { supabase } from './memory.js';
import { realWorldTime } from './world-narration.js';
import { generateDream, readDreamConfig } from './world-dream-gen.js';

// ── 周目标 ───────────────────────────────────────────────
// Asia/Shanghai 自然周（周一到周日）。weekKey = 本周周一的 YYYY-MM-DD。
function shanghaiYMD() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
// 锚在上海日历日，再用 UTC 算术求本周周一 + 本周还剩几晚（含今晚）。
function weekInfo() {
  const ymd = shanghaiYMD();
  const d = new Date(ymd + 'T00:00:00Z');
  const dow = d.getUTCDay();          // 0=周日..6=周六
  const mon1 = dow === 0 ? 7 : dow;   // 周一=1..周日=7
  const monday = new Date(d.getTime() - (mon1 - 1) * 86400000);
  return { weekKey: monday.toISOString().slice(0, 10), nightsLeft: 8 - mon1 }; // 周一7晚..周日1晚
}

async function readWeek() {
  const { data } = await supabase.from('world_dream_week_state_cheng').select('*').eq('name', '澄').limit(1);
  return (data && data[0]) || null;
}
// 新的一周 → 重置目标(2-4)和已生成数。返回当前周状态。
async function ensureWeekTarget() {
  const { weekKey } = weekInfo();
  const wk = await readWeek();
  if (!wk || wk.week_key !== weekKey) {
    const cfg = await readDreamConfig();                       // 每周次数范围网页可调
    const lo = Number.isFinite(cfg?.week_min) ? cfg.week_min : 2;
    const hi = Math.max(lo, Number.isFinite(cfg?.week_max) ? cfg.week_max : 4);
    const target = lo + Math.floor(Math.random() * (hi - lo + 1));
    const { data } = await supabase.from('world_dream_week_state_cheng')
      .update({ week_key: weekKey, target_count: target, generated_count: 0, updated_at: new Date().toISOString() })
      .eq('name', '澄').select().single();
    console.log(`[DREAM] 新一周 ${weekKey} 目标 ${target} 个梦`);
    return data || { week_key: weekKey, target_count: target, generated_count: 0 };
  }
  return wk;
}
async function bumpWeekGenerated() {
  const wk = await readWeek();
  await supabase.from('world_dream_week_state_cheng')
    .update({ generated_count: (wk?.generated_count || 0) + 1, updated_at: new Date().toISOString() })
    .eq('name', '澄');
}

function hourOf(worldTime) {
  const m = /^(\d{1,2}):/.exec(String(worldTime || '').trim());
  return m ? parseInt(m[1], 10) : 0;
}

// ── 调度：night 睡眠开始时决定本轮排不排梦 ───────────────
// 只 night；可用睡眠时长≥3h 才排（工作日按入睡→8点算，非工作日按 planned_hours）；本周没超目标；
// 概率=剩余目标/本周剩余晚数（越到周末概率越高）；触发点取睡满 [2, 可用-1] 的随机整数小时。
export async function maybeScheduleDream({ sleepSessionId, kind, plannedHours, worldTime, workday }) {
  try {
    if (kind !== 'night' || !sleepSessionId) return;
    const available = workday
      ? (() => { const h = hourOf(worldTime); return h >= 8 ? (24 - h) + 8 : (8 - h); })()
      : (Number(plannedHours) || 0);
    if (available < 3) { console.log(`[DREAM] 可用睡眠 ${available}h <3，不排梦`); return; }

    const wk = await ensureWeekTarget();
    const remainingTarget = (wk.target_count || 0) - (wk.generated_count || 0);
    if (remainingTarget <= 0) { console.log('[DREAM] 本周梦已够，不排'); return; }
    const { nightsLeft } = weekInfo();
    const p = Math.min(1, Math.max(0, remainingTarget / Math.max(1, nightsLeft)));
    if (Math.random() >= p) { console.log(`[DREAM] 今晚不排（p=${p.toFixed(2)}, 剩${remainingTarget}/${nightsLeft}晚）`); return; }

    const trigger = 2 + Math.floor(Math.random() * (available - 2)); // [2, available-1]
    await supabase.from('world_dreams_cheng').insert({
      sleep_session_id: sleepSessionId, dream_status: 'scheduled', trigger_after_hours: trigger,
    });
    console.log(`[DREAM] 排梦 session=${sleepSessionId.slice(0, 8)} 触发@睡满${trigger}h（可用${available}h, p=${p.toFixed(2)}）`);
  } catch (e) { console.warn('[DREAM] 排梦失败（不连累睡眠）:', e.message); }
}

async function readDreamBySession(sleepSessionId) {
  if (!sleepSessionId) return null;
  const { data } = await supabase.from('world_dreams_cheng').select('*').eq('sleep_session_id', sleepSessionId).limit(1);
  return (data && data[0]) || null;
}

// ── 睡眠中触发生成（每 tick 在 slept_hours+1 后调）─────────
// 到点(睡满≥trigger)且 status=scheduled → 调 API 生成 → 存 full_dream+四版本，status=generated，周计数+1，写"做梦"timeline。
// 生成是几秒的 API 调用，跑在 tick 串行链里（不会并发重复）；失败则本次梦 cancelled，不计数、不连累睡眠。
export async function triggerDreamIfDue(sleepSessionId, sleptHours) {
  try {
    const dream = await readDreamBySession(sleepSessionId);
    if (!dream || dream.dream_status !== 'scheduled') return null;
    if (sleptHours < (dream.trigger_after_hours || 99)) return null; // 还没到触发点
    let result;
    try { result = await generateDream(); }
    catch (e) {
      console.warn('[DREAM] 生成失败，本次梦取消:', e.message);
      await supabase.from('world_dreams_cheng').update({ dream_status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('sleep_session_id', sleepSessionId).eq('dream_status', 'scheduled');
      return null;
    }
    const now = new Date().toISOString();
    const { data: upd } = await supabase.from('world_dreams_cheng').update({
      dream_status: 'generated', dream_type: result.dream_type, full_dream: result.full_dream,
      recall_variants: result.recall_variants, occurred_after_hours: sleptHours, occurred_at: now,
      source_snapshot: result.material || null, generated_by: `${result.provider}/${result.model}`,
      about_me: result.about_me ?? null, dream_category: result.dream_category ?? null,
      dream_tags: (result.material && result.material.dreamTags) || [], updated_at: now,
    }).eq('sleep_session_id', sleepSessionId).eq('dream_status', 'scheduled').select(); // guard 防并发重复
    if (!upd || !upd.length) return null; // 已被别处处理
    await bumpWeekGenerated();
    // 13：timeline 只记"做梦"，完整梦不进 timeline（更不进 Claude）
    await supabase.from('daily_timeline_cheng').insert({
      world_time: realWorldTime(), location: null, action: '做梦',
      detail: { via: 'dream', note: '梦境已生成，醒后记忆程度待定', dream_type: result.dream_type }, source: 'system',
    });
    console.log(`[DREAM] 生成成功（${result.dream_type}，睡满${sleptHours}h）`);
    return upd[0];
  } catch (e) { console.warn('[DREAM] 触发生成异常（不连累睡眠）:', e.message); return null; }
}

// ── 醒来：定记忆程度 / 取消未触发的梦 ─────────────────────
// 记忆程度概率（4 档）默认值，按醒来方式分 4 套。网页可在 world_dream_config_cheng.recall_probs 覆盖。
const DEFAULT_RECALL = {
  base:          { full: 0.15, partial: 0.45, trace: 0.30, forgotten: 0.10 }, // 自然睡醒
  alarm:         { full: 0.07, partial: 0.38, trace: 0.37, forgotten: 0.18 }, // 工作日闹钟叫醒
  manual_recent: { full: 0.40, partial: 0.42, trace: 0.13, forgotten: 0.05 }, // [WAKE] 梦后1h内
  manual:        { full: 0.22, partial: 0.46, trace: 0.24, forgotten: 0.08 }, // [WAKE] 其它
};
// 记忆程度→实际内容映射（6/17 用户上调一档，觉得记太少）：full=完整梦，partial=原full版，trace=原partial版，forgotten不变。
export function recallContentFor(dream, level) {
  const v = (dream && dream.recall_variants) || {};
  switch (level) {
    case 'full': return (dream && dream.full_dream) || v.full || '';
    case 'partial': return v.full || '';
    case 'trace': return v.partial || '';
    case 'forgotten': return v.forgotten || '';
    default: return v[level] || '';
  }
}
function weightedPick(weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of entries) { if ((r -= w) < 0) return k; }
  return entries[entries.length - 1][0];
}
// 醒来时调（任何醒来路径：自动醒/[WAKE]/闹钟）。dream 已生成→按概率定 recall_level + recalled_content；
// dream 还只是 scheduled（没睡到触发点就醒了）→ cancelled，不计数。
export async function onWake(sleepSessionId, wakeReason, sleptHours) {
  try {
    const dream = await readDreamBySession(sleepSessionId);
    if (!dream) return;
    const now = new Date().toISOString();
    if (dream.dream_status === 'scheduled') {
      await supabase.from('world_dreams_cheng').update({ dream_status: 'cancelled', wake_reason: wakeReason, updated_at: now })
        .eq('sleep_session_id', sleepSessionId).eq('dream_status', 'scheduled');
      console.log('[DREAM] 醒来时梦还没触发 → 取消');
      return;
    }
    if (dream.dream_status !== 'generated') return; // 已 recalled/surfaced/cancelled

    // 概率按醒来方式选档（网页可在 recall_probs 覆盖；缺省用 DEFAULT_RECALL）：闹钟更易忘、梦后1h内提前醒更易记清。
    const cfg = await readDreamConfig();
    const rp = (cfg && cfg.recall_probs) || {};
    let profile;
    if (wakeReason === 'morning_alarm') profile = rp.alarm || DEFAULT_RECALL.alarm;
    else if (wakeReason === 'manual') {
      const recent = Number.isFinite(sleptHours) && dream.occurred_after_hours != null && (sleptHours - dream.occurred_after_hours) <= 1;
      profile = recent ? (rp.manual_recent || DEFAULT_RECALL.manual_recent) : (rp.manual || DEFAULT_RECALL.manual);
    } else profile = rp.base || DEFAULT_RECALL.base;
    const level = weightedPick(profile);
    const content = recallContentFor(dream, level);
    await supabase.from('world_dreams_cheng').update({
      dream_status: 'recalled', recall_level: level, recalled_content: content, wake_reason: wakeReason, updated_at: now,
    }).eq('sleep_session_id', sleepSessionId).eq('dream_status', 'generated');
    console.log(`[DREAM] 醒来记忆程度=${level}（wake=${wakeReason}）`);
  } catch (e) { console.warn('[DREAM] onWake 异常:', e.message); }
}

// ── 残留注入（给聊天/世界唤醒消费）─────────────────────────
// 取一条 status=recalled 的梦，返回其 recalled_content 并标 surfaced（只注入一次）。没有则返 null。
export async function consumeDreamResidue() {
  try {
    const { data } = await supabase.from('world_dreams_cheng')
      .select('*').eq('dream_status', 'recalled').order('updated_at', { ascending: false }).limit(1);
    const dream = data && data[0];
    if (!dream) return null;
    const content = (dream.recalled_content || '').trim();
    const now = new Date().toISOString();
    // 标 surfaced（即使内容为空也标，避免反复查）。guard 防并发重复消费。
    const { data: upd } = await supabase.from('world_dreams_cheng')
      .update({ dream_status: 'surfaced', surfaced_at: now, updated_at: now })
      .eq('id', dream.id).eq('dream_status', 'recalled').select();
    if (!upd || !upd.length) return null; // 被别处先消费了
    if (!content) return null; // recalled_content 为空不输出 block
    return content;
  } catch (e) { console.warn('[DREAM] consumeDreamResidue 异常:', e.message); return null; }
}
