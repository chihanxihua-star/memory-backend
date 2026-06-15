// world-move.js — 聊天里的位置标签：地点白名单 + 共同移动结算。
// 单人移动 [MOVE:…] 仍在 index.js 的 processChatMoveTag；这里放共享白名单 + 共同移动 [MOVE_BOTH:…]。
// 共同移动只改 location/activity，不结算数值、不代表两人进入睡眠（睡眠链以后单独做，可复用本步的位置同步）。
import { supabase } from './memory.js';
import { realWorldTime } from './world-narration.js';
import { scheduleActivityEnd } from './world-actions.js';

// 聊天可移动地点白名单（房间名在两栋楼里不重名，故可省「家/公司」前缀）。单人/共同移动共用。
export const CHAT_MOVE_LOCATIONS = ['家 · 卧室', '家 · 客厅', '家 · 厨房', '家 · 浴室', '公司 · 工位', '公司 · 澄休息室', '公司 · 小茉莉休息室', '公司 · 茶水间'];

// 地点 token → 白名单全名（去「家/公司」前缀）。找不到返回 null。
export function resolveMoveRoom(locToken) {
  const parts = String(locToken || '').split(/[·・]/).map(s => s.trim()).filter(Boolean);
  if (parts[0] === '家' || parts[0] === '公司') parts.shift();
  const room = parts.shift();
  const target = CHAT_MOVE_LOCATIONS.find(l => l.split(' · ')[1] === room);
  return target ? { target, room } : null;
}

// 共同移动结算 [MOVE_BOTH:地点|澄行为|小茉莉行为]：校验（同栋楼 + 小茉莉在场 + 两人当前同地点 + 防旧覆盖）
// → 同时写 character_status_cheng + user_status_cheng + 一条 timeline。段间用 | 不用 ·（地点/行为本身可能含 ·）。
// 只认明确标签、不猜正文；小茉莉 presence 不动；写入做失败检测 + 尽力回滚，避免只成功一个人→位置分裂。
// 返回 { ok, reason }：ok=true 成功；ok=false 时 reason 说明拒绝/失败原因（也已打日志）。
export async function processJointMove(payload, turnStartedAt = null) {
  const segs = String(payload).split('|').map(s => s.trim());
  const resolved = resolveMoveRoom(segs[0]);
  if (!resolved) { console.log(`[MOVE_BOTH] 不认识的地点「${segs[0]}」，忽略`); return { ok: false, reason: 'unknown_location' }; }
  const { target, room } = resolved;
  const chengAct = segs[1] || `在${room}`;
  const userAct = segs[2] || `在${room}`;

  const [{ data: cr }, { data: ur }] = await Promise.all([
    supabase.from('character_status_cheng').select('*').eq('name', '澄').limit(1),
    supabase.from('user_status_cheng').select('*').eq('name', 'user').limit(1),
  ]);
  const cheng = cr && cr[0]; const user = ur && ur[0];
  if (!cheng || !user) { console.warn('[MOVE_BOTH] 读状态失败，忽略'); return { ok: false, reason: 'read_failed' }; }
  const fromLoc = cheng.location || '';

  // 校验 1：同栋楼（跟单人 MOVE 一致，跨楼忽略）
  if (fromLoc.split(' · ')[0] !== target.split(' · ')[0]) {
    console.warn(`[MOVE_BOTH] 拒绝：跨楼移动（${fromLoc} → ${target}）`); return { ok: false, reason: 'cross_building' };
  }
  // 校验 2：小茉莉必须在场（不在家/外出/离线一律拒绝）
  if (['不在家', '外出', '离线'].includes(String(user.presence || '').trim())) {
    console.warn(`[MOVE_BOTH] 拒绝：小茉莉 presence=${user.presence}，不在场`); return { ok: false, reason: 'user_absent' };
  }
  // 校验 3：两人当前必须同地点（"抱着一起去"=从同一个房间一起挪）
  if ((user.location || '') !== fromLoc) {
    console.warn(`[MOVE_BOTH] 拒绝：两人不在同一地点（澄 ${fromLoc} / 小茉莉 ${user.location}）`); return { ok: false, reason: 'not_colocated' };
  }
  // 校验 4：轻量防旧覆盖——本轮回复开始后，小茉莉若被手动改过（updated_at 更晚），手动优先，拒绝覆盖她
  if (turnStartedAt && user.updated_at && new Date(user.updated_at) > new Date(turnStartedAt)) {
    console.warn(`[MOVE_BOTH] 拒绝改小茉莉：状态在本轮之后被手动更新（${user.updated_at} > ${turnStartedAt}）`); return { ok: false, reason: 'user_stale_guard' };
  }

  const moveId = `jm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  // 先更新澄（存旧值备回滚），再更新小茉莉；小茉莉失败则回滚澄，避免只成功一个人→位置分裂。
  const { error: ce } = await supabase.from('character_status_cheng')
    .update({ location: target, activity: chengAct, updated_at: now }).eq('id', cheng.id);
  if (ce) { console.error('[MOVE_BOTH] 更新澄失败，整条放弃:', ce.message); return { ok: false, reason: 'cheng_write_failed' }; }

  const { error: ue } = await supabase.from('user_status_cheng')
    .update({ location: target, activity: userAct, updated_at: now }).eq('name', 'user'); // presence 不动
  if (ue) {
    console.error('[MOVE_BOTH] 更新小茉莉失败，回滚澄:', ue.message);
    const { error: re } = await supabase.from('character_status_cheng')
      .update({ location: cheng.location, activity: cheng.activity, updated_at: now }).eq('id', cheng.id);
    if (re) console.error('[MOVE_BOTH] 回滚澄也失败（位置可能分裂，需手动核对）:', re.message);
    return { ok: false, reason: 'user_write_failed_reverted' };
  }

  await scheduleActivityEnd(chengAct); // 澄的行为自动收尾（跟单人 MOVE 一致；小茉莉作息另管，不排收尾）

  try {
    await supabase.from('daily_timeline_cheng').insert({
      world_time: realWorldTime(), location: target,
      action: fromLoc === target ? `和小茉莉一起${chengAct}（聊天中）` : `和小茉莉一起去了${room}（聊天中）`,
      detail: { via: 'joint_move', move_id: moveId, from_location: fromLoc, to_location: target, cheng_activity: chengAct, user_activity: userAct },
      source: 'action',
    });
  } catch (e) { console.error('[MOVE_BOTH] 行程写入失败（不连累主流程）:', e.message); }

  console.log(`[MOVE_BOTH] 共同移动: ${fromLoc} → ${target} | 澄:${chengAct} / 小茉莉:${userAct}`);
  return { ok: true, reason: 'moved', target, room, chengAct, userAct };
}
