// world-sleep.js — 14A 基础睡眠链。
// 澄自主决定睡不睡/睡多久（聊天里输出 [SLEEP:Nh]/[SLEEP_BOTH:Nh]/[WAKE]），后端只认明确标签、
// 持久化状态(world_sleep_state_cheng 单行)、每 world tick 恢复体力、按规则到点醒来。不催不提醒不强制。
// 标签风格 + 校验/回滚思路抄 world-move.js 的 MOVE_BOTH。
// 醒来分两套（6/16 跟用户定）：
//   nap(午睡)：到点靠倒计时自己醒（没午睡闹钟）。
//   night(晚睡)：工作日靠早 8 点 morning_wakeup 闹钟叫醒（倒计时不触发醒）；非工作日才用倒计时。
// 本版不做：梦境/春梦/晨勃/睡眠质量/半夜醒来/小茉莉身体值结算。
import { supabase } from './memory.js';
import { realWorldTime } from './world-narration.js';
import { randomUUID } from 'crypto';
import { maybeScheduleDream, triggerDreamIfDue, onWake } from './world-dream.js';
import {
  scheduleNightMorningCheck,
  cancelScheduledNightInterruption,
  maybeTriggerDreamWake,
  maybeTriggerMorningErection,
} from './world-night.js';

// 睡着时每 world 小时额外回体力（自然衰减 -2 由 world-tick 照常扣 → 净 +8）。
export const SLEEP_ENERGY_GAIN = 10;

const MIN_HOURS = 1, MAX_HOURS = 12;
const ABSENT_PRESENCE = ['不在家', '外出', '离线'];
// 工作日列表：跟 world-workday.js 的 WEEKDAYS_WORK 一致（这里内联避免循环 import）。
const WEEKDAYS_WORK = ['星期一', '星期二', '星期三', '星期四', '星期五'];

// 睡眠地点白名单：night(正经睡)只许卧室/休息室；nap(午睡)放宽到客厅/工位/茶水间。kind 由 world_time 自动判。
const NIGHT_LOCATIONS = ['家 · 卧室', '家 · 客厅', '公司 · 澄休息室'];
const NAP_LOCATIONS   = ['家 · 卧室', '家 · 客厅', '公司 · 澄休息室', '公司 · 工位', '公司 · 茶水间'];

// world_time 时段判 kind：21:00–05:59 = night，其余 = nap。
function sleepKindForTime(worldTime) {
  const m = /^(\d{1,2}):/.exec(String(worldTime || '').trim());
  const h = m ? parseInt(m[1], 10) : 12;
  return (h >= 21 || h < 6) ? 'night' : 'nap';
}

// 解析时长 → 整数 1–12 世界小时（越界钳，非法返回 null，后端不替澄选时长只做范围校验）。
function parseHours(payload) {
  const m = /(\d+)/.exec(String(payload || '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  if (!Number.isFinite(h) || h <= 0) return null;
  return Math.max(MIN_HOURS, Math.min(MAX_HOURS, h));
}

async function readCheng() {
  const { data } = await supabase.from('character_status_cheng').select('*').eq('name', '澄').limit(1);
  return data && data[0];
}

export async function readSleepState() {
  const { data } = await supabase.from('world_sleep_state_cheng').select('*').eq('name', '澄').limit(1);
  return (data && data[0]) || null;
}

// tick 用：澄是否正在睡（world-tick 据此决定加不加 +10、要不要跳过事件检测）。
export async function isChengSleeping() {
  const s = await readSleepState();
  return !!(s && (s.status === 'sleeping' || s.status === 'interrupted_awake'));
}

async function isWorkdayNow() {
  try {
    const { data } = await supabase.from('world_environment_cheng').select('weekday').eq('name', 'default').limit(1);
    return WEEKDAYS_WORK.includes(String(data?.[0]?.weekday || '').trim());
  } catch { return false; } // 读不到当非工作日：宁可倒计时自己醒，也别在周末卡死睡不醒
}

async function writeStartTimeline(loc, hours, kind, withUser) {
  try {
    await supabase.from('daily_timeline_cheng').insert({
      world_time: realWorldTime(), location: loc,
      action: withUser ? '和小茉莉一起入睡' : '入睡',
      detail: { via: 'chat_sleep', sleep_kind: kind, planned_hours: hours, with_user: withUser, note: `计划睡眠 ${hours} 世界小时` },
      source: 'action',
    });
  } catch (e) { console.error('[SLEEP] 入睡行程写入失败:', e.message); }
}

// 醒来行程：只在开始/自动醒/提前醒三时刻写（中间每小时不写，避免刷屏）。
async function writeWakeTimeline(wakeReason, sleep, sleptHours) {
  const slept = sleptHours != null ? sleptHours : (sleep?.slept_hours || 0);
  const cheng = await readCheng();
  const note = wakeReason === 'manual' ? `提前醒来，睡了约 ${slept} 世界小时`
    : wakeReason === 'planned_duration_complete' ? `实际睡眠 ${slept} 世界小时，按计划醒来`
    : `被闹钟叫醒，睡了约 ${slept} 世界小时`;
  try {
    await supabase.from('daily_timeline_cheng').insert({
      world_time: realWorldTime(), location: cheng?.location || null,
      action: '醒来',
      detail: { via: 'sleep_complete', wake_reason: wakeReason, slept_hours: slept, planned_hours: sleep?.planned_hours ?? null, note },
      source: wakeReason === 'manual' ? 'action' : 'system',
    });
  } catch (e) { console.error('[SLEEP] 醒来行程写入失败:', e.message); }
}

// 内部：把澄置为 sleeping（写睡眠表 + character_status.activity=睡觉 + 入睡行程 + 14B-1 排梦）。
async function enterSleep(cheng, kind, hours, withUser) {
  const now = new Date().toISOString();
  const sleepSessionId = randomUUID(); // 一轮睡眠一个 id，梦/记录都绑它
  await supabase.from('world_sleep_state_cheng').update({
    status: 'sleeping', sleep_kind: kind, planned_hours: hours, slept_hours: 0,
    remaining_hours: hours, with_user: withUser, started_at: now,
    started_world_time: cheng.world_time || null, wake_reason: null,
    last_processed_tick_id: null, sleep_session_id: sleepSessionId, updated_at: now,
  }).eq('name', '澄');
  await supabase.from('character_status_cheng').update({ activity: '睡觉', updated_at: now }).eq('id', cheng.id);
  await writeStartTimeline(cheng.location || '', hours, kind, withUser);
  console.log(`[SLEEP] 入睡 kind=${kind} ${hours}h @ ${cheng.location} ${withUser ? '(和小茉莉)' : ''}`);
  // 14B-1：只 night 睡眠在此决定排不排梦（nap 不做梦）。工作日按入睡→8点算可用时长，非工作日按 planned_hours。
  if (kind === 'night') {
    const workday = await isWorkdayNow();
    await maybeScheduleDream({ sleepSessionId, kind, plannedHours: hours, worldTime: cheng.world_time, workday });
    await scheduleNightMorningCheck({ sleepSessionId, kind, worldTime: cheng.world_time });
  }
}

// [SLEEP:Nh]：澄独自睡。校验时长 + 地点。返回 { ok, reason }。
export async function processSleep(payload) {
  const hours = parseHours(payload);
  if (hours == null) { console.log('[SLEEP] 时长解析失败，忽略:', payload); return { ok: false, reason: 'bad_hours' }; }
  const cheng = await readCheng();
  if (!cheng) { console.warn('[SLEEP] 读状态失败，忽略'); return { ok: false, reason: 'read_failed' }; }
  const loc = cheng.location || '';
  const kind = sleepKindForTime(cheng.world_time);
  const allowed = kind === 'night' ? NIGHT_LOCATIONS : NAP_LOCATIONS;
  if (!allowed.includes(loc)) {
    console.warn(`[SLEEP] 拒绝：地点「${loc}」不能睡（kind=${kind}）`);
    return { ok: false, reason: 'bad_location', kind };
  }
  await enterSleep(cheng, kind, hours, false);
  return { ok: true, kind, hours };
}

// [SLEEP_BOTH:Nh]：澄和小茉莉一起睡。在 processSleep 校验基础上加：两人同地点 + 小茉莉在场。
// 只改小茉莉的 activity=睡觉（位置保持共同移动后的地点），不结算她的体力/健康等数值，她之后手动改正常覆盖。
export async function processSleepBoth(payload) {
  const hours = parseHours(payload);
  if (hours == null) { console.log('[SLEEP_BOTH] 时长解析失败，忽略:', payload); return { ok: false, reason: 'bad_hours' }; }
  const [cheng, { data: ur }] = await Promise.all([
    readCheng(),
    supabase.from('user_status_cheng').select('*').eq('name', 'user').limit(1),
  ]);
  const user = ur && ur[0];
  if (!cheng || !user) { console.warn('[SLEEP_BOTH] 读状态失败，忽略'); return { ok: false, reason: 'read_failed' }; }
  const loc = cheng.location || '';
  const kind = sleepKindForTime(cheng.world_time);
  const allowed = kind === 'night' ? NIGHT_LOCATIONS : NAP_LOCATIONS;
  if (!allowed.includes(loc)) {
    console.warn(`[SLEEP_BOTH] 拒绝：地点「${loc}」不能睡（kind=${kind}）`);
    return { ok: false, reason: 'bad_location', kind };
  }
  if (ABSENT_PRESENCE.includes(String(user.presence || '').trim())) {
    console.warn(`[SLEEP_BOTH] 拒绝：小茉莉 presence=${user.presence}，不在场`);
    return { ok: false, reason: 'user_absent' };
  }
  if ((user.location || '') !== loc) {
    console.warn(`[SLEEP_BOTH] 拒绝：两人不在同一地点（澄 ${loc} / 小茉莉 ${user.location}）`);
    return { ok: false, reason: 'not_colocated' };
  }
  await enterSleep(cheng, kind, hours, true);
  // 小茉莉只改 activity，不动 location/presence、不结算数值
  await supabase.from('user_status_cheng')
    .update({ activity: '睡觉', updated_at: new Date().toISOString() }).eq('name', 'user');
  return { ok: true, kind, hours, withUser: true };
}

// [WAKE]：澄提前醒。本来就 awake = 忽略不报错。
export async function processWake() {
  const sleep = await readSleepState();
  if (!sleep || sleep.status !== 'sleeping') { console.log('[WAKE] 本来就醒着，忽略'); return { ok: false, reason: 'not_sleeping' }; }
  const now = new Date().toISOString();
  await supabase.from('world_sleep_state_cheng').update({
    status: 'awake', wake_reason: 'manual', remaining_hours: 0, planned_hours: null, with_user: false, updated_at: now,
  }).eq('name', '澄');
  await supabase.from('character_status_cheng').update({ activity: '醒来', updated_at: now }).eq('name', '澄');
  await writeWakeTimeline('manual', sleep);
  await cancelScheduledNightInterruption(sleep.sleep_session_id, 'manual_wake');
  await onWake(sleep.sleep_session_id, 'manual', sleep.slept_hours); // 14B-1：定记忆程度/取消未触发的梦
  console.log('[WAKE] 提前醒来');
  return { ok: true };
}

// 闹钟叫醒（morning_wakeup 等工作日作息闹铃）：若正在睡 → 翻成 awake（不改 activity，交给闹钟流程接管）。
// 这就是"工作日早 8 点闹钟优先"的落地：night 睡过点也会被闹钟拽起来。返回是否真叫醒了。
export async function wakeIfSleeping(wakeReason = 'alarm') {
  const sleep = await readSleepState();
  if (!sleep || !['sleeping', 'interrupted_awake'].includes(sleep.status)) return false;
  const now = new Date().toISOString();
  await supabase.from('world_sleep_state_cheng').update({
    status: 'awake', wake_reason: wakeReason, remaining_hours: 0, planned_hours: null, with_user: false, updated_at: now,
  }).eq('name', '澄');
  await writeWakeTimeline(wakeReason, sleep);
  await cancelScheduledNightInterruption(sleep.sleep_session_id, wakeReason);
  await onWake(sleep.sleep_session_id, wakeReason, sleep.slept_hours); // 14B-1：定记忆程度/取消未触发的梦
  console.log(`[SLEEP] 闹钟叫醒（${wakeReason}）`);
  return true;
}

// 每个 world tick 结算一次（world-tick._advanceOneTick 在体力恢复后、健康引擎前调用）。
// 幂等：同一 tickId 不重复结算（last_processed_tick_id）。slept+1 / remaining-1；到点按 nap/工作日规则决定是否自动醒。
export async function evaluateSleepTick(tickId) {
  const sleep = await readSleepState();
  if (!sleep || sleep.status !== 'sleeping') return;
  if (sleep.last_processed_tick_id === tickId) return; // 幂等：本轮已处理

  const slept = (sleep.slept_hours || 0) + 1;
  const remaining = (sleep.remaining_hours || 0) - 1;

  let autoWake = false;
  if (remaining <= 0) {
    if (sleep.sleep_kind === 'nap') autoWake = true;            // 午睡：没闹钟，倒计时自己醒
    else autoWake = !(await isWorkdayNow());                    // 晚睡：工作日靠 8 点闹钟，非工作日才倒计时醒
  }

  const guard = `last_processed_tick_id.is.null,last_processed_tick_id.neq.${tickId}`;
  if (autoWake) {
    const now = new Date().toISOString();
    await supabase.from('world_sleep_state_cheng').update({
      status: 'awake', slept_hours: slept, remaining_hours: 0, with_user: false,
      planned_hours: null, wake_reason: 'planned_duration_complete',
      last_processed_tick_id: tickId, updated_at: now,
    }).eq('name', '澄').or(guard);
    await supabase.from('character_status_cheng').update({ activity: '刚醒', updated_at: now }).eq('name', '澄');
    await writeWakeTimeline('planned_duration_complete', sleep, slept);
    console.log(`[SLEEP] 自动醒来（睡了 ${slept} 世界小时，kind=${sleep.sleep_kind}）`);
    await cancelScheduledNightInterruption(sleep.sleep_session_id, 'planned_duration_complete');
    await onWake(sleep.sleep_session_id, 'planned_duration_complete', slept); // 14B-1：定记忆程度/取消未触发的梦
  } else {
    await supabase.from('world_sleep_state_cheng').update({
      slept_hours: slept, remaining_hours: Math.max(0, remaining),
      last_processed_tick_id: tickId, updated_at: new Date().toISOString(),
    }).eq('name', '澄').or(guard);
    const updatedSleep = { ...sleep, slept_hours: slept, remaining_hours: Math.max(0, remaining), status: 'sleeping' };
    const dream = await triggerDreamIfDue(sleep.sleep_session_id, slept); // 14B-1：睡满到点则后台生成梦
    const dreamWake = dream ? await maybeTriggerDreamWake({ sleep: updatedSleep, dream, sleptHours: slept }) : null;
    if (!dreamWake) {
      const cheng = await readCheng();
      await maybeTriggerMorningErection({ sleep: updatedSleep, worldTime: cheng?.world_time, sleptHours: slept });
    }
  }
}
