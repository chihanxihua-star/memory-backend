// world-health.js — 13B：健康联动最小引擎。
// 健康(health)是慢变量：平时基本稳定，单次饿一点/累一点不掉；只有身体状态【长期】严重异常才缓慢下降，
// 身体【持续】稳定才缓慢恢复。挂在 world tick 上，每世界小时(每 tick)结算一次，用 tick 衰减【之后】的身体值判断。
// 幂等：靠 advanceOneTick 传进来的唯一 tickId（同一轮 tick 只生成一次、重试复用），同一 tick 不重复累计/扣血。
//
// 本版【不做】：随机生病、受伤、治疗、睡觉回血——留到后面。普通吃饭/洗澡/工作仍只影响 energy/satiety/cleanliness，
// 不直接动 health（health 只由本引擎按持续时间结算）。
import { supabase } from './memory.js';
import { realWorldTime } from './world-narration.js';

// ── 阈值集中放这里（别散到别处）──────────────────────────────────
export const HEALTH_BASELINE = 85;          // 体内基线：低于它回得快，到/超过它回得慢
const LOW_ENERGY = 10, LOW_SATIETY = 10, LOW_CLEAN = 15;   // 低值阈值
const ENERGY_HOURS = 6, SATIETY_HOURS = 6, CLEAN_HOURS = 24; // 连续低于阈值满多少世界小时扣 1（之后每再满一窗口再扣 1）
const STABLE_MIN = 30;                       // 稳定区间：三项身体值都 ≥ 才算"稳定"
const RECOVER_HOURS_BELOW = 12;              // health < 基线：连续稳定 12h 回 1
const RECOVER_HOURS_AT = 24;                 // health ≥ 基线：连续稳定 24h 回 1
const MAX_DROP_PER_TICK = 2;                 // 单 tick 最多扣 2（防三条件同 tick 到期骤降 3）

function nowISO() { return new Date().toISOString(); }

async function getState() {
  const { data } = await supabase.from('world_health_state_cheng').select('*').eq('name', '澄').limit(1);
  return data?.[0] || null;
}

// 结算一个 tick 的健康联动。row = 衰减后的 character_status 行（带 id/energy/satiety/cleanliness/health/location/world_time）；
// tickId = 本轮唯一标识。返回 { healthChanged, delta, reason, health } 或 null（跳过/出错）。
export async function evaluateHealth(row, tickId) {
  try {
    const st = await getState();
    if (!st) { console.warn('[HEALTH] world_health_state_cheng 没有澄那一行，跳过'); return null; }
    // 幂等：本 tick 已结算过 → 跳过（重试/重复调用复用同一 tickId）
    if (st.last_evaluated_tick_id && st.last_evaluated_tick_id === tickId) return null;

    const energy = Number(row.energy), satiety = Number(row.satiety), cleanliness = Number(row.cleanliness);
    const health = Number(row.health);

    // 1) 连续低值计时：低于阈值 +1，否则清零（中断即归零，不许断续拼接）
    const lowE = energy < LOW_ENERGY ? (st.low_energy_hours || 0) + 1 : 0;
    const lowS = satiety < LOW_SATIETY ? (st.low_satiety_hours || 0) + 1 : 0;
    const lowC = cleanliness < LOW_CLEAN ? (st.low_cleanliness_hours || 0) + 1 : 0;

    // 2) 稳定计时：三项都 ≥30 才 +1，任一不满足清零
    const stable = (energy >= STABLE_MIN && satiety >= STABLE_MIN && cleanliness >= STABLE_MIN)
      ? (st.stable_body_hours || 0) + 1 : 0;

    // 3) 扣血：连续低值每满整数个窗口扣 1（刚踩到窗口边界的这个 tick 触发）
    let drop = 0; const reasons = [];
    if (lowE >= ENERGY_HOURS && lowE % ENERGY_HOURS === 0) { drop++; reasons.push('体力长期过低'); }
    if (lowS >= SATIETY_HOURS && lowS % SATIETY_HOURS === 0) { drop++; reasons.push('饱腹长期过低'); }
    if (lowC >= CLEAN_HOURS && lowC % CLEAN_HOURS === 0) { drop++; reasons.push('清洁长期过低'); }
    if (drop > MAX_DROP_PER_TICK) drop = MAX_DROP_PER_TICK;

    // 4) 回血：仅当本 tick 没扣血时才考虑（扣血的 tick 不回血）。分段：低于基线回得快，到/超过基线回得慢。
    let gain = 0, stableAfter = stable, reason = '';
    if (drop > 0) {
      reason = reasons.join('、');
    } else if (health < 100 && stable > 0) {
      const need = health < HEALTH_BASELINE ? RECOVER_HOURS_BELOW : RECOVER_HOURS_AT;
      if (stable >= need) { gain = 1; stableAfter = 0; reason = '身体状态持续稳定'; } // 回血即重置稳定计时，下一点重新攒
    }

    const delta = gain - drop;
    const newHealth = delta !== 0 ? Math.max(0, Math.min(100, health + delta)) : health;
    const changed = delta !== 0 && newHealth !== health;

    // 5) 原子写 health_state：带 tickId 守门（IS DISTINCT FROM）——第二次同 tick 进来 0 行受影响 → 跳过，不重复结算。
    //    NULL（首跑）也要能写，所以用 or(is null, neq)；单进程下另有 advanceOneTick 串行锁兜底。
    const patch = {
      low_energy_hours: lowE, low_satiety_hours: lowS, low_cleanliness_hours: lowC,
      stable_body_hours: stableAfter,
      last_health_delta: delta,
      last_health_reason: delta !== 0 ? reason : (st.last_health_reason || null),
      last_evaluated_tick_id: tickId,
      last_evaluated_world_time: row.world_time || null,
      last_evaluated_at: nowISO(), updated_at: nowISO(),
    };
    const { data: upd, error } = await supabase.from('world_health_state_cheng')
      .update(patch).eq('name', '澄')
      .or(`last_evaluated_tick_id.is.null,last_evaluated_tick_id.neq.${tickId}`)
      .select();
    if (error) { console.warn('[HEALTH] state 更新失败:', error.message); return null; }
    if (!upd || !upd.length) return null; // 0 行=已被本 tick 结算过（并发兜底）

    // 6) health 真变了才写 character_status + timeline；纯计数累计不写行程（避免每 tick 刷屏）
    if (changed) {
      await supabase.from('character_status_cheng')
        .update({ health: newHealth, updated_at: nowISO() }).eq('id', row.id);
      try {
        await supabase.from('daily_timeline_cheng').insert({
          world_time: realWorldTime(),
          location: row.location || null,
          action: delta < 0 ? '健康下降' : '健康恢复',
          detail: {
            health_delta: delta, reason, before: health, after: newHealth, tick_id: tickId,
            low_energy_hours: lowE, low_satiety_hours: lowS, low_cleanliness_hours: lowC, stable_body_hours: stableAfter,
          },
          source: 'system',
        });
      } catch (e) { console.warn('[HEALTH] timeline 写入失败:', e.message); }
      console.log(`[HEALTH] ${delta < 0 ? '↓' : '↑'}${Math.abs(delta)} → ${newHealth} (${reason})`);
    }
    return { healthChanged: changed, delta, reason, health: newHealth };
  } catch (e) { console.error('[HEALTH] 结算异常:', e.message); return null; }
}
