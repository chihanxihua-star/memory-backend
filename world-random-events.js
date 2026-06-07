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
    options: [
      { id: 1, label: '去茶水间倒杯咖啡', effects: { energy: 8, focus: 6, stress: 2 }, target_location: '公司 · 茶水间', target_activity: '倒咖啡' },
      { id: 2, label: '去休息室眯一会儿', effects: { energy: 12, stress: -5, focus: 3 }, target_location: '公司 · 休息室', target_activity: '休息' },
      { id: 3, label: '硬撑继续工作', effects: { energy: -6, focus: -8, stress: 5 }, target_activity: '工作' },
    ],
  },
  tea_restock: {
    id: 'tea_restock', label: '茶水间补货', reason: '茶水间刚补了货，零食饮料满满当当',
    locations: ['公司 · 工位', '公司 · 休息室'], time_range: ['09:00', '18:00'],
    probability: 0.2, cooldown_world_minutes: 240, once_per_day: true,
    options: [
      { id: 1, label: '去拿杯热饮', effects: { energy: 5, mood: 4, comfort: 3 }, target_location: '公司 · 茶水间', target_activity: '倒水' },
      { id: 2, label: '顺手抓把零食垫垫', effects: { satiety: 10, mood: 3 }, target_location: '公司 · 茶水间', target_activity: '吃零食' },
      { id: 3, label: '不去，专心干活', effects: { focus: 2 }, target_activity: '工作' },
    ],
  },
  rain_offwork: {
    id: 'rain_offwork', label: '下班下雨', reason: '到点下班了，外面正下着雨',
    locations: ['公司 · 工位', '公司 · 休息室', '公司 · 茶水间'], time_range: ['17:30', '20:00'],
    weather_required: '雨', // weather_text 含「雨」才自动触发（手动测试绕过）
    probability: 0.6, cooldown_world_minutes: 720, once_per_day: true,
    options: [
      { id: 1, label: '在休息室等雨小点再走', effects: { stress: 3, energy: -2 }, target_location: '公司 · 休息室', target_activity: '等雨' },
      { id: 2, label: '冒雨跑回家', effects: { cleanliness: -12, energy: -8, stress: 5 }, target_activity: '冒雨赶路' },
      { id: 3, label: '打车回家', effects: { wallet_balance: -25, comfort: 6, stress: -3 }, target_activity: '打车回家' },
    ],
  },
  convenience_newproduct: {
    id: 'convenience_newproduct', label: '便利店新品', reason: '路过便利店，看到上了新品',
    locations: ['外出 · 商场', '外出 · 路上', '家 · 客厅'],
    probability: 0.18, cooldown_world_minutes: 360, once_per_day: true,
    options: [
      { id: 1, label: '买来尝尝', effects: { wallet_balance: -12, mood: 5, satiety: 8 }, target_activity: '吃东西' },
      { id: 2, label: '拍给小茉莉看看', effects: { mood: 4 } },
      { id: 3, label: '算了，省钱', effects: { stress: 1 } },
    ],
  },
  boss_perk: {
    id: 'boss_perk', label: '老板发福利', reason: '老板今天发了点福利',
    locations: ['公司 · 工位', '公司 · 休息室'], time_range: ['09:00', '18:00'],
    probability: 0.12, cooldown_world_minutes: 1440, once_per_day: true,
    options: [
      { id: 1, label: '开心收下', effects: { mood: 8, stress: -4 } },
      { id: 2, label: '想着带回家给小茉莉', effects: { mood: 6, longing: 4 } },
      { id: 3, label: '转手送同事', effects: { social: 5, mood: 2 } },
    ],
  },
  stray_animal: {
    id: 'stray_animal', label: '门口遇到流浪动物', reason: '公司门口蹲着只流浪小动物',
    locations: ['公司 · 工位', '外出 · 路上', '外出 · 商场'],
    probability: 0.15, cooldown_world_minutes: 360, once_per_day: true,
    options: [
      { id: 1, label: '蹲下喂点吃的', effects: { mood: 7, stress: -5 } },
      { id: 2, label: '撸两下、拍张照', effects: { mood: 6 } },
      { id: 3, label: '没带吃的，看两眼走开', effects: { mood: -2 } },
    ],
  },
};

// ── 内存状态 ──────────────────────────────────────────
const triggeredToday = new Set();   // once_per_day 标记（世界跨午夜清空）
const lastTriggeredTick = {};       // eventId → 触发时的 tickCount（cooldown 用）
let tickCount = 0;
let lastRandomRealMs = 0;           // 上次普通随机事件触发的现实时间（全局限频）
const GLOBAL_RATE_MS = 60 * 60 * 1000; // 每现实小时最多 1 次普通随机事件

export function bumpRandomTick() { tickCount += 1; }
export function onMidnightCross() { triggeredToday.clear(); console.log('[RANDOM] 跨午夜，清空 once_per_day 标记'); }

function toMin(hhmm) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim()); return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null; }
function inTimeRange(worldTime, [a, b]) {
  const t = toMin(worldTime), lo = toMin(a), hi = toMin(b);
  if (t == null || lo == null || hi == null) return true;
  return t >= lo && t <= hi;
}
function eligible(ev, status, envWeatherText) {
  const loc = status.location || '';
  if (ev.locations && !ev.locations.includes(loc)) return false;
  if (ev.time_range && !inTimeRange(status.world_time, ev.time_range)) return false;
  if (ev.once_per_day && triggeredToday.has(ev.id)) return false;
  if (ev.cooldown_world_minutes && lastTriggeredTick[ev.id] != null) {
    const cdTicks = Math.ceil(ev.cooldown_world_minutes / 60); // 每 tick = 1 世界小时 = 60 世界分钟
    if (tickCount - lastTriggeredTick[ev.id] < cdTicks) return false;
  }
  if (ev.weather_required && !String(envWeatherText || '').includes(ev.weather_required)) return false;
  return true;
}

// 检测一个随机事件（不标记，等真发出后再 markRandomEventFired）。返回 {key,isRandom,reason,options,...} 或 null。
// 全局限频：上次触发距今不足 1 现实小时 → 不出（保护 Max 用量；fast_test 下也按现实时间限）。
export function detectRandomEvent(status, { envWeatherText = '', nowMs = Date.now() } = {}) {
  if (nowMs - lastRandomRealMs < GLOBAL_RATE_MS) return null;
  const cands = Object.values(RANDOM_EVENTS).filter(ev => eligible(ev, status, envWeatherText));
  if (!cands.length) return null;
  const hits = cands.filter(ev => Math.random() < ev.probability);
  if (!hits.length) return null;
  const ev = hits[Math.floor(Math.random() * hits.length)];
  return { key: ev.id, isRandom: true, reason: ev.reason, options: ev.options, label: ev.label };
}

// 真发出后标记（once_per_day / cooldown / 全局限频）。手动 force 不调这个（测试不消耗配额）。
export function markRandomEventFired(eventId, nowMs = Date.now()) {
  const ev = RANDOM_EVENTS[eventId];
  if (!ev) return;
  if (ev.once_per_day) triggeredToday.add(eventId);
  lastTriggeredTick[eventId] = tickCount;
  lastRandomRealMs = nowMs;
}

// 手动强制触发：拿到事件对象（绕过概率/once_per_day/限频），CC 忙时仍由 triggerWorldWake 挡。
export function forceRandomEvent(eventId) {
  const ev = RANDOM_EVENTS[eventId];
  if (!ev) return null;
  return { key: ev.id, isRandom: true, reason: ev.reason, options: ev.options, label: ev.label };
}
