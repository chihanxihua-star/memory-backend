// world-actions.js — 第8步：基础地点 + 行为结算。
// 根据澄当前 location 给可执行行为，执行后改状态/location/activity + 写 daily_timeline(source=action)。
// 第一版只做澄(actor=cheng)；保留 actor 字段方便以后扩展 user/both。
// 行为瞬间完成，不消耗世界时间（行为耗时系统以后再做）。
import { supabase } from './memory.js';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// 行为定义。allowed=允许执行的当前 location；target_location/activity=执行后移动到/变成；effects=状态变化。
export const ACTIONS = {
  go_kitchen:       { label: '去厨房',     allowed: ['家 · 卧室', '家 · 客厅', '家 · 浴室'],                                    target_location: '家 · 厨房',   target_activity: '在厨房', effects: {} },
  go_bathroom:      { label: '去浴室',     allowed: ['家 · 卧室', '家 · 客厅', '家 · 厨房'],                                    target_location: '家 · 浴室',   target_activity: '洗漱',   effects: {} },
  go_living_room:   { label: '去客厅',     allowed: ['家 · 卧室', '家 · 厨房', '家 · 浴室'],                                    target_location: '家 · 客厅',   target_activity: '休息',   effects: {} },
  go_breakroom:     { label: '去休息室',   allowed: ['公司 · 工位', '公司 · 茶水间'],                                           target_location: '公司 · 休息室', target_activity: '休息',  effects: {} },
  go_workstation:   { label: '回工位',     allowed: ['公司 · 休息室', '公司 · 茶水间'],                                         target_location: '公司 · 工位', target_activity: '工作',   effects: {} },
  go_tea_room:      { label: '去茶水间',   allowed: ['公司 · 工位', '公司 · 休息室'],                                           target_location: '公司 · 茶水间', target_activity: '倒水',  effects: {} },
  eat_snack:        { label: '吃零食',     allowed: ['家 · 卧室', '家 · 客厅', '家 · 厨房', '公司 · 工位', '公司 · 休息室', '公司 · 茶水间'], target_activity: '吃零食', effects: { satiety: 15, mood: 3 } },
  order_takeout:    { label: '点外卖',     allowed: ['家 · 卧室', '家 · 客厅', '家 · 厨房', '公司 · 工位', '公司 · 休息室', '公司 · 茶水间'], target_activity: '点外卖', effects: { satiety: 25, wallet_balance: -30, mood: 2 } },
  cook_simple_meal: { label: '自己做饭',   allowed: ['家 · 厨房'],                                                             target_activity: '做饭',   effects: { satiety: 30, energy: -8, cleanliness: -3, mood: 5 } },
  shower:           { label: '洗澡',       allowed: ['家 · 浴室'],                                                             target_activity: '洗澡',   effects: { cleanliness: 30, energy: -5, stress: -5, mood: 3 } },
  rest:             { label: '休息一会儿', allowed: ['家 · 卧室', '家 · 客厅', '公司 · 休息室'],                                target_activity: '休息',   effects: { energy: 10, stress: -5, mood: 3 } },
};

// 当前 location 下可执行的行为 → [{id,label}]
export function getAvailableActions(location) {
  return Object.entries(ACTIONS)
    .filter(([, a]) => a.allowed.includes(location))
    .map(([id, a]) => ({ id, label: a.label }));
}

// 把 action 的 effects/location/activity 算成 character_status patch（不写库）。
// 普通项 0-100 钳位；wallet_balance 只封底 0、不封顶。
export function computeActionPatch(action, row) {
  const patch = { updated_at: new Date().toISOString() };
  for (const [k, delta] of Object.entries(action.effects || {})) {
    const cur = Number(row[k]) || 0;
    patch[k] = k === 'wallet_balance' ? Math.max(0, cur + delta) : clamp(cur + delta, 0, 100);
  }
  if (action.target_location) patch.location = action.target_location;
  if (action.target_activity) patch.activity = action.target_activity;
  return patch;
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

  const patch = computeActionPatch(action, row);
  const { data: up, error: e2 } = await supabase
    .from('character_status_cheng').update(patch).eq('id', row.id).select().single();
  if (e2) throw e2;

  try {
    await supabase.from('daily_timeline_cheng').insert({
      world_time: up.world_time,
      location: up.location,
      action: action.label,
      detail: {
        action_id: actionId, actor,
        effects: action.effects || {},
        from_location: fromLoc, to_location: up.location, activity: up.activity,
      },
      source: 'action',
    });
  } catch (e) { console.error('[ACTION] 行程写入失败（不连累主流程）:', e.message); }

  console.log(`[ACTION] ${actor} 执行「${action.label}」(${source}): ${fromLoc} → ${up.location}`);
  return up;
}
