// world-effects.js — 10C：全局状态结算器。
// 事件/行为只表达「影响哪个状态、方向、力度」(effects_hint)，具体数值由 resolveEffects 统一 roll。
// Claude 只选编号、不决定数值。固定金额(工资/外卖/商品价)继续走 effects(fixed)，不进 hint。

// 力度基础区间（只在这里定义，不分散到各事件）。每次在区间内 roll 一个整数（唯一随机来源）。
export const STRENGTH_RANGE = { tiny: [1, 3], small: [4, 7], medium: [8, 13], large: [14, 20] };

// 状态英文 key → 中文名（前端/timeline/prompt 展示用，不露英文）。
export const STAT_NAMES_CN = {
  energy: '体力', satiety: '饱腹', cleanliness: '清洁', health: '健康',
  stress: '压力', focus: '注意力', social: '社交', comfort: '舒适',
  mood: '心情', longing: '想念', libido: '性欲', wallet_balance: '钱包',
};

function rollInt([lo, hi]) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }

// 把 effects_hint 解析成实际数值 deltas。随机只来自 strength 区间 roll；再按当前状态轻微修正(±1~2)。
// direction 决定正负号；不在这里钳位（钳位在 applyDeltas 落库时做）。
export function resolveEffects(status, effectsHint, context = {}) {
  const out = {};
  for (const h of (effectsHint || [])) {
    if (!h || !h.stat) continue;
    const range = STRENGTH_RANGE[h.strength];
    if (!range) continue;
    let mag = rollInt(range);
    const cur = Number(status?.[h.stat]);
    // 只对 up（恢复/增益类）按当前状态轻微修正：很高→钝化，很低→增强（压力不享受"很低更强"）。
    if (h.direction === 'up' && Number.isFinite(cur)) {
      if (cur >= 85) mag -= 2;
      else if (cur >= 70) mag -= 1;
      else if (h.stat !== 'stress') {
        if (cur <= 20) mag += 2;
        else if (cur <= 35) mag += 1;
      }
    }
    mag = Math.max(1, mag); // 修正后仍≥1，且 ±2 不会把 small 变 large
    out[h.stat] = (out[h.stat] || 0) + (h.direction === 'down' ? -mag : mag);
  }
  return out;
}

// 12A 止血：只让身体/生活字段进状态栏结算。感受字段（mood/longing/libido/social/stress/focus/comfort）
// 不再更新 character_status，但把原始 hint 方向收进 ignored，写 timeline.detail.ignored_effects 供 12B 回收。
export const BODY_STATS = ['energy', 'satiety', 'cleanliness', 'health'];
const IGNORED_STATS = ['mood', 'longing', 'libido', 'social', 'stress', 'focus', 'comfort'];

// 从事件/行为里拆出 hint + fixed，算出 resolved(只身体)/fixed/merged/ignored。
// 优先级：有 effects_hint → resolveEffects 管身体状态；effects 只当固定值(钱包等)。无 hint → effects 当旧逻辑(fixed)。
export function computeDeltas(status, source, context = {}) {
  const hint = (source && source.effects_hint) || [];
  const fixed = (source && source.effects) || {};
  const bodyHint = hint.filter(h => h && BODY_STATS.includes(h.stat));
  const resolved = bodyHint.length ? resolveEffects(status, bodyHint, context) : {};
  // 被忽略的感受字段：记原始方向（不 roll、不更新状态）
  const ignored = {};
  for (const h of hint) if (h && IGNORED_STATS.includes(h.stat)) ignored[h.stat] = h.direction;
  // merged 只放身体 resolved + 允许的固定值（wallet_balance / 身体字段）；感受类固定值也忽略
  const merged = { ...resolved };
  for (const [k, v] of Object.entries(fixed)) {
    if (k === 'wallet_balance' || BODY_STATS.includes(k)) merged[k] = (merged[k] || 0) + v;
    else if (IGNORED_STATS.includes(k)) ignored[k] = v > 0 ? 'up' : 'down';
  }
  return { resolved, fixed, merged, ignored };
}

// deltas → character_status patch（普通项 0-100 钳位；wallet_balance 只封底 0）。
export function applyDeltas(status, merged) {
  const patch = {};
  for (const [k, delta] of Object.entries(merged || {})) {
    const cur = Number(status?.[k]) || 0;
    patch[k] = k === 'wallet_balance' ? Math.max(0, cur + delta) : Math.max(0, Math.min(100, cur + delta));
  }
  return patch;
}

// context（部分字段现在不一定用，是以后工作系统/天气影响/时间段影响的钩子）。
export function buildEffectContext(status, extra = {}) {
  const wt = (status && status.world_time) || '';
  const h = parseInt(String(wt).split(':')[0], 10);
  const valid = Number.isFinite(h);
  return {
    eventId: extra.eventId || null,
    eventType: extra.eventType || null,
    worldTime: wt,
    location: status?.location || null,
    activity: status?.activity || null,
    isWorkTime: valid ? (h >= 9 && h < 18) : false,
    isLunchTime: valid ? (h === 12) : false,
    isAfterWork: valid ? (h >= 18) : false,
    weatherText: extra.weatherText || status?.weather || '',
  };
}
