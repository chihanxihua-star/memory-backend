import { WORK_EVENTS } from './world-work-events.js';
// world-random-events.js — 10B：随机事件引擎（最小版）。
// tick 后（pending_wake / hungry 都没命中且 CC 空闲时）按概率触发一个生活随机事件。
// 系统只负责触发+给选项+结算；要不要联系小茉莉由澄自己定（prompt 不写"你应该联系"）。
// 限频用现实时间（保护 Max 用量）；once_per_day / cooldown 用内存标记（重启清空，可接受，不改 world_time）。

// ── 事件定义 ──────────────────────────────────────────
// locations: 允许触发的当前地点；time_range: world_time HH:mm 区间；weather_required: 需天气含某词；
// probability: 每次检测命中概率；cooldown_world_minutes: 同事件冷却（世界分钟，按 tick 近似）；once_per_day: 当天一次。
// 选项: effects(0-100钳位/钱包封底0) + 可选 target_location/target_activity。
export const RANDOM_EVENTS = {
  afternoon_sleepy: {
    id: 'afternoon_sleepy', label: '下午犯困', reason: '下午犯困，有点撑不住',
    locations: ['公司 · 工位'], time_range: ['13:00', '16:00'],
    probability: 0.25, cooldown_world_minutes: 180, once_per_day: true,
    pulse_hint: { emotion: 'tired', intensity: 0.4 },
    options: [
      { id: 1, label: '去茶水间倒杯咖啡', effects_hint: [{ stat: 'energy', direction: 'up', strength: 'small' }, { stat: 'focus', direction: 'up', strength: 'small' }, { stat: 'stress', direction: 'up', strength: 'tiny' }], target_location: '公司 · 茶水间', target_activity: '倒咖啡', pulse_hint: { emotion: 'calm', intensity: 0.3 } },
      { id: 2, label: '去休息室眯一会儿', effects_hint: [{ stat: 'energy', direction: 'up', strength: 'medium' }, { stat: 'stress', direction: 'down', strength: 'small' }, { stat: 'focus', direction: 'up', strength: 'tiny' }], target_location: '公司 · 澄休息室', target_activity: '休息', pulse_hint: { emotion: 'calm', intensity: 0.4 } },
      { id: 3, label: '硬撑继续工作', effects_hint: [{ stat: 'energy', direction: 'down', strength: 'small' }, { stat: 'focus', direction: 'down', strength: 'medium' }, { stat: 'stress', direction: 'up', strength: 'small' }], target_activity: '工作', pulse_hint: { emotion: 'tired', intensity: 0.5 } },
    ],
  },
  tea_restock: {
    id: 'tea_restock', label: '茶水间补货', reason: '茶水间刚补了货，零食饮料满满当当',
    locations: ['公司 · 工位', '公司 · 澄休息室'], time_range: ['09:00', '18:00'],
    probability: 0.2, cooldown_world_minutes: 240, once_per_day: true,
    pulse_hint: { emotion: 'happy', intensity: 0.2 },
    options: [
      { id: 1, label: '去拿杯热饮', effects_hint: [{ stat: 'energy', direction: 'up', strength: 'small' }, { stat: 'mood', direction: 'up', strength: 'small' }, { stat: 'comfort', direction: 'up', strength: 'tiny' }], target_location: '公司 · 茶水间', target_activity: '倒水', pulse_hint: { emotion: 'calm', intensity: 0.3 } },
      { id: 2, label: '顺手抓把零食垫垫', effects_hint: [{ stat: 'satiety', direction: 'up', strength: 'small' }, { stat: 'mood', direction: 'up', strength: 'tiny' }], target_location: '公司 · 茶水间', target_activity: '吃零食', pulse_hint: { emotion: 'happy', intensity: 0.3 } },
      { id: 3, label: '不去，专心干活', effects_hint: [{ stat: 'focus', direction: 'up', strength: 'tiny' }], target_activity: '工作' },
    ],
  },
  // rain_offwork（下班下雨）已收编进下班链（2026-06-12）：16 点 offwork_choice 雨天版接管
  // （打车/地铁淋雨/等雨小），避免跟系统下班判断穿帮（人已到家还弹"到点下班了"）。定义删除，
  // 想找原版选项看 git 历史或 CHANGELOG 当日条目。
  convenience_newproduct: {
    id: 'convenience_newproduct', label: '便利店新品', reason: '路过便利店，看到上了新品',
    locations: ['外出 · 商场', '外出 · 路上', '家 · 客厅'],
    probability: 0.18, cooldown_world_minutes: 360, once_per_day: true,
    pulse_hint: { emotion: 'happy', intensity: 0.2 },
    options: [
      { id: 1, label: '买来尝尝', effects_hint: [{ stat: 'mood', direction: 'up', strength: 'small' }, { stat: 'satiety', direction: 'up', strength: 'small' }], effects: { wallet_balance: -12 }, target_activity: '吃东西', pulse_hint: { emotion: 'happy', intensity: 0.4 } },
      { id: 2, label: '拍给小茉莉看看', effects_hint: [{ stat: 'mood', direction: 'up', strength: 'small' }], pulse_hint: { emotion: 'longing', intensity: 0.3 } },
      { id: 3, label: '算了，省钱', effects_hint: [{ stat: 'stress', direction: 'up', strength: 'tiny' }] },
    ],
  },
  boss_perk: {
    id: 'boss_perk', label: '老板发福利', reason: '老板今天发了点福利',
    locations: ['公司 · 工位', '公司 · 澄休息室'], time_range: ['09:00', '18:00'],
    probability: 0.12, cooldown_world_minutes: 1440, once_per_day: true,
    pulse_hint: { emotion: 'happy', intensity: 0.4, spike: 5 },
    options: [
      { id: 1, label: '开心收下', effects_hint: [{ stat: 'mood', direction: 'up', strength: 'medium' }, { stat: 'stress', direction: 'down', strength: 'small' }], pulse_hint: { emotion: 'happy', intensity: 0.5 } },
      { id: 2, label: '想着带回家给小茉莉', effects_hint: [{ stat: 'mood', direction: 'up', strength: 'small' }, { stat: 'longing', direction: 'up', strength: 'small' }], pulse_hint: { emotion: 'longing', intensity: 0.4 } },
      { id: 3, label: '转手送同事', effects_hint: [{ stat: 'social', direction: 'up', strength: 'small' }, { stat: 'mood', direction: 'up', strength: 'tiny' }], pulse_hint: { emotion: 'happy', intensity: 0.3 } },
    ],
  },
  stray_animal: {
    id: 'stray_animal', label: '门口遇到流浪动物', reason: '公司门口蹲着只流浪小动物',
    locations: ['公司 · 工位', '外出 · 路上', '外出 · 商场'],
    probability: 0.15, cooldown_world_minutes: 360, once_per_day: true,
    pulse_hint: { emotion: 'happy', intensity: 0.3 },
    options: [
      { id: 1, label: '蹲下喂点吃的', effects_hint: [{ stat: 'mood', direction: 'up', strength: 'small' }, { stat: 'stress', direction: 'down', strength: 'small' }], pulse_hint: { emotion: 'happy', intensity: 0.5 } },
      { id: 2, label: '撸两下、拍张照', effects_hint: [{ stat: 'mood', direction: 'up', strength: 'small' }], pulse_hint: { emotion: 'happy', intensity: 0.4 } },
      { id: 3, label: '没带吃的，看两眼走开', effects_hint: [{ stat: 'mood', direction: 'down', strength: 'tiny' }], pulse_hint: { emotion: 'sad', intensity: 0.2 } },
    ],
  },
};

// 11B：工作事件并入同一事件池（同一套唤醒系统，不另开）。
const ALL_EVENTS = { ...RANDOM_EVENTS, ...WORK_EVENTS };

// ── 内存状态 ──────────────────────────────────────────
const triggeredToday = new Set();   // once_per_day 标记（世界跨午夜清空）
const lastTriggeredTick = {};       // eventId → 触发时的 tickCount（cooldown 用）
let tickCount = 0;
let lastRandomRealMs = 0;           // 上次普通随机事件触发的现实时间（全局限频）
let todayWorkNpcEventSeen = false;  // 11B：当天是否已出现过 NPC(老板/同事)工作事件（跨午夜清）
const GLOBAL_RATE_MS = 60 * 60 * 1000; // 每现实小时最多 1 次普通随机事件

export function bumpRandomTick() { tickCount += 1; }
export function onMidnightCross() {
  triggeredToday.clear();
  todayWorkNpcEventSeen = false;
  console.log('[RANDOM] 跨午夜，清空 once_per_day / NPC 过场标记');
}

function toMin(hhmm) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim()); return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null; }
function inTimeRange(worldTime, [a, b]) {
  const t = toMin(worldTime), lo = toMin(a), hi = toMin(b);
  if (t == null || lo == null || hi == null) return true;
  return t >= lo && t <= hi;
}
// 单时段 time_range 或多时段 time_ranges（任一命中）。都没写=不限时。
function timeOk(ev, worldTime) {
  if (Array.isArray(ev.time_ranges)) return ev.time_ranges.some(r => inTimeRange(worldTime, r));
  if (ev.time_range) return inTimeRange(worldTime, ev.time_range);
  return true;
}
function eligible(ev, status, envWeatherText, weekday) {
  const loc = status.location || '';
  if (ev.locations && !ev.locations.includes(loc)) return false;
  if (!timeOk(ev, status.world_time)) return false;
  if (ev.once_per_day && triggeredToday.has(ev.id)) return false;
  if (ev.cooldown_world_minutes && lastTriggeredTick[ev.id] != null) {
    const cdTicks = Math.ceil(ev.cooldown_world_minutes / 60); // 每 tick = 1 世界小时 = 60 世界分钟
    if (tickCount - lastTriggeredTick[ev.id] < cdTicks) return false;
  }
  if (ev.weather_required && !String(envWeatherText || '').includes(ev.weather_required)) return false;
  // 11B 工作事件额外门槛：工作日 + 活动白名单。
  if (ev.workday_only && !WEEKDAYS_WORK.includes(String(weekday || '').trim())) return false;
  if (ev.activity_in && !ev.activity_in.includes(status.activity || '')) return false;
  return true;
}
const WEEKDAYS_WORK = ['星期一', '星期二', '星期三', '星期四', '星期五'];

// 把事件对象包成 turn 用的形态（解析 npcPool → npc）。
function pack(ev) {
  const npc = ev.npc || (Array.isArray(ev.npcPool) && ev.npcPool.length ? ev.npcPool[Math.floor(Math.random() * ev.npcPool.length)] : null);
  return { key: ev.id, isRandom: true, reason: ev.reason, options: ev.options, label: ev.label, event_type: ev.event_type || 'random', npc, wmHint: ev.wmHint };
}

// 检测一个随机/工作事件（不标记，等真发出后再 markRandomEventFired）。
// 全局限频：上次触发距今不足 1 现实小时 → 不出（保护 Max 用量；fast_test 下也按现实时间限）。
// NPC 过场：当天还没出现过 NPC 工作事件 + 13:00-16:00 → npc_boost 事件概率提权（倾向每天一次公司社交，但不硬拉）。
export function detectRandomEvent(status, { envWeatherText = '', weekday = '', nowMs = Date.now() } = {}) {
  if (nowMs - lastRandomRealMs < GLOBAL_RATE_MS) return null;
  const cands = Object.values(ALL_EVENTS).filter(ev => eligible(ev, status, envWeatherText, weekday));
  if (!cands.length) return null;
  const t = toMin(status.world_time);
  const boostActive = !todayWorkNpcEventSeen && t != null && t >= 780 && t < 960; // 13:00-16:00
  const probOf = (ev) => (boostActive && ev.npc_boost) ? Math.min(1, (ev.probability || 0) * 2) : (ev.probability || 0);
  const hits = cands.filter(ev => Math.random() < probOf(ev));
  if (!hits.length) return null;
  const ev = hits[Math.floor(Math.random() * hits.length)];
  return pack(ev);
}

// 真发出后标记（once_per_day / cooldown / 全局限频 / NPC 过场）。手动 force 不调这个（测试不消耗配额）。
export function markRandomEventFired(eventId, nowMs = Date.now()) {
  const ev = ALL_EVENTS[eventId];
  if (!ev) return;
  if (ev.once_per_day) triggeredToday.add(eventId);
  lastTriggeredTick[eventId] = tickCount;
  lastRandomRealMs = nowMs;
  if (ev.npc || ev.npcPool) todayWorkNpcEventSeen = true;
}

// 手动强制触发：拿到事件对象（绕过概率/once_per_day/限频），CC 忙时仍由 triggerWorldWake 挡。
export function forceRandomEvent(eventId) {
  const ev = ALL_EVENTS[eventId];
  if (!ev) return null;
  return pack(ev);
}

// 给 DevPanel 出按钮：随机事件 + 工作事件分组。
export function listEvents() {
  return {
    random: Object.values(RANDOM_EVENTS).map(e => ({ id: e.id, label: e.label })),
    work: Object.values(WORK_EVENTS).map(e => ({ id: e.id, label: e.label })),
  };
}
