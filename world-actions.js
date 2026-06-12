// world-actions.js — 第8步：基础地点 + 行为结算。
// 根据澄当前 location 给可执行行为，执行后改状态/location/activity + 写 daily_timeline(source=action)。
// 第一版只做澄(actor=cheng)；保留 actor 字段方便以后扩展 user/both。
// 行为瞬间完成，不消耗世界时间（行为耗时系统以后再做）。
import { supabase } from './memory.js';
import { computeDeltas, applyDeltas, buildEffectContext } from './world-effects.js';
import { realWorldTime } from './world-narration.js';
import { readWorldConfig } from './world-tick.js';

// ── 行为自动结束（第二步·地基）────────────────────────────
// 她进入的「行为」（activity）会有时长，到点静默收尾（清成闲着/工作），治"卡死在一个行为上"。
// 时长分长/中/短三桶（世界分钟≈现实分钟），随机抽；豁免=作息/加班自管的状态，不自动结束。
const ACTIVITY_EXEMPT = new Set(['工作', '午休', '加班', '加班处理任务', '等小茉莉', '预制早餐']);
const ACTIVITY_LONG  = new Set(['休息', '做饭', '点外卖', '开会', '走神开会', '下班回家后休息', '加班后回家休息']);
const ACTIVITY_SHORT = new Set(['吃零食', '倒水', '倒咖啡', '泡茶', '拿饼干', '吃小蛋糕', '看小手机', '挑选公司福利', '记录福利信息', '记录新品想法', '和老板确认任务', '在厨房']);
// 其余 → 默认「中」。

// 返回 [min,max] 世界分钟；豁免/空 → null（不排结束）。
export function activityDuration(activity) {
  const a = String(activity || '').trim();
  if (!a || ACTIVITY_EXEMPT.has(a)) return null;
  if (ACTIVITY_LONG.has(a)) return [30, 50];
  if (ACTIVITY_SHORT.has(a)) return [3, 9];
  return [10, 29]; // 中（默认）
}

// 给"她进入的行为"排一条 action_end 续唤醒：到点静默收尾。防串档=把 expected_activity 塞进 payload，
// 到点比对当前 activity 没变才收（变了说明被别的行为/作息顶替，跳过）。豁免行为直接不排。
// 返回 roll 出的世界分钟数（行程表记「持续多久」用）；豁免行为/失败返回 null。
export async function scheduleActivityEnd(activity) {
  const range = activityDuration(activity);
  if (!range) return null;
  const [lo, hi] = range;
  const delayMin = lo + Math.floor(Math.random() * (hi - lo + 1));
  const cfg = readWorldConfig();
  const delaySec = cfg.fast_test ? delayMin : delayMin * 60; // fast_test：世界分钟=现实秒
  const scheduledAt = new Date(Date.now() + delaySec * 1000).toISOString();
  try {
    await supabase.from('pending_wake_cheng').insert({
      wake_type: 'action_end', reason: '行为结束', status: 'queued',
      scheduled_at: scheduledAt,
      payload: { expected_activity: String(activity).trim(), delay_world_minutes: delayMin },
      attempts: 0,
    });
    console.log(`[ACTION_END] 排了「${activity}」结束，${delayMin} 世界分钟后`);
    return delayMin;
  } catch (e) { console.warn('[ACTION_END] 排程失败:', e.message); return null; }
}

// 行为定义。allowed=允许执行的当前 location；target_location/activity=执行后移动到/变成；effects=状态变化。
export const ACTIONS = {
  go_kitchen:       { label: '去厨房',     allowed: ['家 · 卧室', '家 · 客厅', '家 · 浴室'],                                    target_location: '家 · 厨房',   target_activity: '在厨房', effects: {} },
  go_bathroom:      { label: '去浴室',     allowed: ['家 · 卧室', '家 · 客厅', '家 · 厨房'],                                    target_location: '家 · 浴室',   target_activity: '洗漱',   effects: {} },
  go_living_room:   { label: '去客厅',     allowed: ['家 · 卧室', '家 · 厨房', '家 · 浴室'],                                    target_location: '家 · 客厅',   target_activity: '休息',   effects: {} },
  go_breakroom:     { label: '去休息室',   allowed: ['公司 · 工位', '公司 · 茶水间'],                                           target_location: '公司 · 休息室', target_activity: '休息',  effects: {} },
  go_workstation:   { label: '回工位',     allowed: ['公司 · 休息室', '公司 · 茶水间'],                                         target_location: '公司 · 工位', target_activity: '工作',   effects: {} },
  go_tea_room:      { label: '去茶水间',   allowed: ['公司 · 工位', '公司 · 休息室'],                                           target_location: '公司 · 茶水间', target_activity: '倒水',  effects: {} },
  eat_snack:        { label: '吃零食',     allowed: ['家 · 卧室', '家 · 客厅', '家 · 厨房', '公司 · 工位', '公司 · 休息室', '公司 · 茶水间'], target_activity: '吃零食',
    effects_hint: [{ stat: 'satiety', direction: 'up', strength: 'small' }, { stat: 'mood', direction: 'up', strength: 'tiny' }] },
  order_takeout:    { label: '点外卖',     allowed: ['家 · 卧室', '家 · 客厅', '家 · 厨房', '公司 · 工位', '公司 · 休息室', '公司 · 茶水间'], target_activity: '点外卖',
    effects_hint: [{ stat: 'satiety', direction: 'up', strength: 'medium' }, { stat: 'mood', direction: 'up', strength: 'tiny' }], effects: { wallet_balance: -30 } },
  cook_simple_meal: { label: '自己做饭',   allowed: ['家 · 厨房'],                                                             target_activity: '做饭',
    effects_hint: [{ stat: 'satiety', direction: 'up', strength: 'large' }, { stat: 'energy', direction: 'down', strength: 'small' }, { stat: 'cleanliness', direction: 'down', strength: 'tiny' }, { stat: 'mood', direction: 'up', strength: 'small' }] },
  shower:           { label: '洗澡',       allowed: ['家 · 浴室'],                                                             target_activity: '洗澡',
    effects_hint: [{ stat: 'cleanliness', direction: 'up', strength: 'large' }, { stat: 'energy', direction: 'down', strength: 'small' }, { stat: 'stress', direction: 'down', strength: 'small' }, { stat: 'mood', direction: 'up', strength: 'small' }] },
  rest:             { label: '休息一会儿', allowed: ['家 · 卧室', '家 · 客厅', '公司 · 休息室'],                                target_activity: '休息',
    effects_hint: [{ stat: 'energy', direction: 'up', strength: 'medium' }, { stat: 'stress', direction: 'down', strength: 'small' }, { stat: 'mood', direction: 'up', strength: 'small' }] },
};

// 当前 location 下可执行的行为 → [{id,label}]
export function getAvailableActions(location) {
  return Object.entries(ACTIONS)
    .filter(([, a]) => a.allowed.includes(location))
    .map(([id, a]) => ({ id, label: a.label }));
}

// 10C：用全局结算器把 action 的 effects_hint(生活状态) + effects(固定金额) 算成 patch（不写库）。
// 返回 { patch, resolved, fixed }：patch 落库；resolved/fixed 进 timeline detail。普通项 0-100 钳位、wallet 封底 0。
export function computeActionPatch(action, row, context) {
  const { resolved, fixed, merged, ignored } = computeDeltas(row, action, context || buildEffectContext(row, { eventId: null, eventType: 'action' }));
  const patch = { updated_at: new Date().toISOString(), ...applyDeltas(row, merged) };
  if (action.target_location) patch.location = action.target_location;
  if (action.target_activity) patch.activity = action.target_activity;
  return { patch, resolved, fixed, ignored };
}

// 执行一个行为：检查 allowed → 应用 → 写 character_status + daily_timeline(source=action)。
// 返回更新后状态；不允许时 throw（err.code='not_allowed'）。
export async function executeWorldAction(actionId, { actor = 'cheng', source = 'manual' } = {}) {
  const action = ACTIONS[actionId];
  if (!action) { const e = new Error(`未知行为: ${actionId}`); e.code = 'unknown_action'; throw e; }

  const { data: rows, error } = await supabase
    .from('character_status_cheng').select('*').eq('name', '澄').limit(1);
  if (error) throw error;
  const row = rows && rows[0];
  if (!row) throw new Error('character_status_cheng 没有澄那一行');

  const fromLoc = row.location;
  if (!action.allowed.includes(fromLoc)) {
    const e = new Error(`「${action.label}」在当前位置（${fromLoc}）不可用`);
    e.code = 'not_allowed';
    throw e;
  }

  const { patch, resolved, fixed, ignored } = computeActionPatch(action, row);
  const { data: up, error: e2 } = await supabase
    .from('character_status_cheng').update(patch).eq('id', row.id).select().single();
  if (e2) throw e2;

  // 第二步：先排自动结束，拿到 roll 出的时长给行程表记「持续多久」（豁免行为=null）。失败不连累主流程。
  let durationMin = null;
  if (actor === 'cheng') durationMin = await scheduleActivityEnd(up.activity);

  try {
    await supabase.from('daily_timeline_cheng').insert({
      world_time: realWorldTime(),
      location: up.location,
      action: action.label,
      detail: {
        action_id: actionId, actor,
        effects_hint: action.effects_hint || [],
        effects_resolved: resolved,
        effects_fixed: fixed,
        ignored_effects: ignored,
        from_location: fromLoc, to_location: up.location, activity: up.activity,
        duration_min: durationMin,
      },
      source: 'action',
    });
  } catch (e) { console.error('[ACTION] 行程写入失败（不连累主流程）:', e.message); }

  console.log(`[ACTION] ${actor} 执行「${action.label}」(${source}): ${fromLoc} → ${up.location}`);
  return up;
}
