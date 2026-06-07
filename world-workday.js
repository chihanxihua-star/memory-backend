// world-workday.js — 11A：工作日作息 + 工资 + 加班（最小版）。
// 全部是「系统事件」：只更新 character_status + 写 daily_timeline(source=system)，
// 不 engage 澄、不发 Bark、不触发 WORLD_MESSAGE。工作随机事件/NPC 放 11B。
// world_time 仍是 tick 模拟时钟；date/weekday 来自现实 UTC+8(world_environment_cheng)。
import { supabase } from './memory.js';
import { computeDeltas, applyDeltas, buildEffectContext } from './world-effects.js';
import { readWorldConfig } from './world-tick.js';

const OVERTIME_HINT = [
  { stat: 'energy', direction: 'down', strength: 'small' },
  { stat: 'stress', direction: 'up', strength: 'small' },
  { stat: 'focus', direction: 'down', strength: 'tiny' },
];
const OVERTIME_PAY = 30;          // 加班费固定（不走 effects_hint）
const OVERTIME_PROB = 0.25;       // 下班判断：25% 加班 / 75% 正常下班

const WEEKDAYS_WORK = ['星期一', '星期二', '星期三', '星期四', '星期五'];
export function isWorkday(weekday) { return WEEKDAYS_WORK.includes(String(weekday || '').trim()); }

// 当日作息内存标记（跨午夜清空，重启清空可接受，不改 world_time）。
const marks = { on_work: false, lunch: false, afternoon: false, off_decision: false };
export function clearWorkMarks() {
  marks.on_work = marks.lunch = marks.afternoon = marks.off_decision = false;
  console.log('[WORK] 跨午夜，清空当日作息标记');
}

function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}
async function readStatus() {
  const { data } = await supabase.from('character_status_cheng').select('*').eq('name', '澄').limit(1);
  return data && data[0];
}
// 更新状态 + 写一条 system 行程。返回更新后状态。
async function setState(row, patch, action, detail) {
  const { data: up, error } = await supabase
    .from('character_status_cheng').update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', row.id).select().single();
  if (error) { console.warn('[WORK] 状态更新失败:', error.message); return row; }
  const st = up || row;
  try {
    await supabase.from('daily_timeline_cheng').insert({
      world_time: st.world_time, location: st.location, action, detail, source: 'system',
    });
  } catch (e) { console.warn('[WORK] 行程写入失败:', e.message); }
  return st;
}

const goToWork    = (row) => setState(row, { location: '公司 · 工位', activity: '工作' }, '上班', { reason: '工作日到点上班' });
const goLunch     = (row) => setState(row, { location: '公司 · 休息室', activity: '午休' }, '午休', { reason: '午休时间' });
const goAfternoon = (row) => setState(row, { location: '公司 · 工位', activity: '工作' }, '下午上班', { reason: '午休结束，下午上班' });
const goHomeNormal= (row) => setState(row, { location: '家 · 客厅', activity: '下班回家后休息' }, '下班回家', { overtime: false });

// 加班开始：effects_hint 走 resolveEffects；挂一条 0.5-2h（30-120 世界分钟）的加班结束 pending。
async function startOvertime(row) {
  const ctx = buildEffectContext(row, { eventId: 'overtime', eventType: 'work' });
  const { resolved } = computeDeltas(row, { effects_hint: OVERTIME_HINT }, ctx);
  const patch = { location: '公司 · 工位', activity: '加班', ...applyDeltas(row, resolved) };
  const st = await setState(row, patch, '临时加班', { overtime: true, effects_hint: OVERTIME_HINT, effects_resolved: resolved });

  const delayMin = 30 + Math.floor(Math.random() * 91); // 30-120 世界分钟
  const cfg = readWorldConfig();
  const delaySec = cfg.fast_test ? delayMin : delayMin * 60; // fast_test：世界分钟=现实秒
  const scheduledAt = new Date(Date.now() + delaySec * 1000).toISOString();
  try {
    await supabase.from('pending_wake_cheng').insert({
      wake_type: 'overtime_end', reason: '加班结束', scheduled_at: scheduledAt,
      status: 'queued', payload: { delay_world_minutes: delayMin },
    });
    console.log(`[WORK] 加班开始，${delayMin} 世界分钟后结束`);
  } catch (e) { console.warn('[WORK] 加班结束 pending 失败:', e.message); }
  return st;
}

// 加班结束（pending 到点 / 手动）：回家 + 固定加班费。导出给 firePendingWake 的 overtime_end 分支用。
export async function endOvertime() {
  const row = await readStatus();
  if (!row) return null;
  const cur = Number(row.wallet_balance) || 0;
  return setState(row,
    { location: '家 · 客厅', activity: '加班后回家休息', wallet_balance: Math.max(0, cur + OVERTIME_PAY) },
    '加班结束', { overtime_pay: OVERTIME_PAY, reason: '加班结束，结算加班费', effects_fixed: { wallet_balance: OVERTIME_PAY } });
}

const offWorkDecision = (row, force) => {
  const overtime = force === 'overtime' ? true : force === 'normal' ? false : (Math.random() < OVERTIME_PROB);
  return overtime ? startOvertime(row) : goHomeNormal(row);
};

// 月薪：现实 UTC+8 日期 == salary_day 且本月没发过 → 发。force 绕过日期但仍守"本月已发不重复"。
export async function maybePaySalary({ force = false } = {}) {
  const { data: profs } = await supabase.from('work_profile_cheng').select('*').eq('actor', 'cheng').limit(1);
  const prof = profs && profs[0];
  if (!prof) return null;
  const shDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const day = parseInt(shDate.slice(8, 10), 10);
  const yearMonth = shDate.slice(0, 7); // YYYY-MM
  if (prof.last_salary_paid_month === yearMonth) return null;     // 本月已发
  if (!force && day !== (prof.salary_day || 15)) return null;     // 不是发薪日（force 绕过）
  const row = await readStatus();
  if (!row) return null;
  const amount = Number(prof.salary_amount) || 2500;
  const cur = Number(row.wallet_balance) || 0;
  await supabase.from('work_profile_cheng').update({ last_salary_paid_month: yearMonth, updated_at: new Date().toISOString() }).eq('actor', 'cheng');
  console.log(`[WORK] 发工资 ${amount}（${yearMonth}）`);
  return setState(row, { wallet_balance: cur + amount }, '发工资',
    { amount, type: 'intern_salary', department: prof.department, role: prof.role, effects_fixed: { wallet_balance: amount } });
}

// tick：自动作息（工作日 + world_time 阈值，同一天每段一次）+ 工资。系统更新，不 engage。返回(可能更新的) status。
export async function workdayTick(status, env) {
  let cur = status;
  const paid = await maybePaySalary();       // 工资按现实日期，跟工作日无关
  if (paid) cur = paid;
  if (!isWorkday(env?.weekday)) return cur;   // 非工作日不自动作息
  const t = toMin(cur.world_time);
  if (t == null) return cur;
  const atCompany = String(cur.location || '').startsWith('公司');
  if (t >= 540 && t < 660 && !marks.on_work && !atCompany) { marks.on_work = true; return await goToWork(cur); }       // 09:00-11:00 上班
  if (t >= 660 && t < 780 && !marks.lunch) { marks.lunch = true; return await goLunch(cur); }                          // 11:00-13:00 午休
  if (t >= 780 && t < 960 && !marks.afternoon && cur.location === '公司 · 休息室') { marks.afternoon = true; return await goAfternoon(cur); } // 13:00-16:00 下午上班
  if (t >= 960 && !marks.off_decision) { marks.off_decision = true; return await offWorkDecision(cur); }               // 16:00+ 下班判断
  return cur;
}

// 手动 force（DevPanel）：绕过 marks/workday/概率/日期；工资仍守"本月已发不重复"。
export async function forceWorkOp(op) {
  const row = await readStatus();
  if (!row) return { ok: false, error: 'no_status' };
  switch (op) {
    case 'go_work':     return { ok: true, status: await goToWork(row) };
    case 'lunch':       return { ok: true, status: await goLunch(row) };
    case 'afternoon':   return { ok: true, status: await goAfternoon(row) };
    case 'off_decision':return { ok: true, status: await offWorkDecision(row) };
    case 'off_normal':  return { ok: true, status: await goHomeNormal(row) };
    case 'overtime':    return { ok: true, status: await startOvertime(row) };
    case 'end_overtime':return { ok: true, status: await endOvertime() };
    case 'salary': {
      const s = await maybePaySalary({ force: true });
      return s ? { ok: true, status: s } : { ok: false, error: '本月已发过工资' };
    }
    default: return { ok: false, error: 'unknown_op:' + op };
  }
}
