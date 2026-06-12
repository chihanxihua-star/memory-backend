// world-workday.js — 11A：工作日作息 + 工资 + 加班（最小版）。
// 全部是「系统事件」：只更新 character_status + 写 daily_timeline(source=system)，
// 不 engage 澄、不发 Bark、不触发 WORLD_MESSAGE。工作随机事件/NPC 放 11B。
// world_time 仍是 tick 模拟时钟；date/weekday 来自现实 UTC+8(world_environment_cheng)。
import { supabase } from './memory.js';
import { computeDeltas, applyDeltas, buildEffectContext } from './world-effects.js';
import { readWorldConfig } from './world-tick.js';
import { realWorldTime } from './world-narration.js';

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
const marks = { alarm: false, on_work: false, lunch: false, afternoon: false, off_decision: false };
export function clearWorkMarks() {
  marks.alarm = marks.on_work = marks.lunch = marks.afternoon = marks.off_decision = false;
  console.log('[WORK] 跨午夜，清空当日作息标记');
}

// 早晨流程是否在途：队列里有 morning_wakeup（含赖床续）或早晨链的 routine_step。
// 用途：①闹钟去重（重启清 marks 后别二次上闹钟）②9:10 上班瞬移让位给链。
async function hasMorningFlow() {
  try {
    const { data } = await supabase.from('pending_wake_cheng')
      .select('wake_type, payload').eq('status', 'queued')
      .in('wake_type', ['morning_wakeup', 'routine_step']).limit(10);
    return (data || []).some(r => r.wake_type === 'morning_wakeup' || r.payload?.routine === 'morning');
  } catch { return false; }
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
      world_time: realWorldTime(), location: st.location, action, detail, source: 'system',
    });
  } catch (e) { console.warn('[WORK] 行程写入失败:', e.message); }
  return st;
}

const goToWork    = (row) => setState(row, { location: '公司 · 工位', activity: '工作' }, '上班', { reason: '工作日到点上班' });
const goLunch     = (row) => setState(row, { location: '公司 · 休息室', activity: '午休' }, '午休', { reason: '午休时间' });
const goAfternoon = (row) => setState(row, { location: '公司 · 工位', activity: '工作' }, '下午上班', { reason: '午休结束，下午上班' });
const goHomeNormal= (row) => setState(row, { location: '家 · 客厅', activity: '下班回家后休息' }, '下班回家', { overtime: false });

// 挂一条 0.5-2h（30-120 世界分钟）的加班结束 pending。导出给 11B「下班前加任务→加班」复用
// （那条选项的状态变化由事件自己的 effects_hint 结算，这里只负责排加班结束触发器）。
export async function scheduleOvertimeEnd() {
  const delayMin = 30 + Math.floor(Math.random() * 61); // 30-90 世界分钟（用户 6/12 定）
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
}

// 加班开始（11A 下班判断走这条）：effects_hint 走 resolveEffects + 挂加班结束 pending。
async function startOvertime(row) {
  const ctx = buildEffectContext(row, { eventId: 'overtime', eventType: 'work' });
  const { resolved } = computeDeltas(row, { effects_hint: OVERTIME_HINT }, ctx);
  const patch = { location: '公司 · 工位', activity: '加班', ...applyDeltas(row, resolved) };
  const st = await setState(row, patch, '临时加班', { overtime: true, effects_hint: OVERTIME_HINT, effects_resolved: resolved });
  await scheduleOvertimeEnd();
  return st;
}

// 下班链（用户 6/12 定）：到点不再瞬移。index.js 注入两个钩子——
// offWorkHandler(row,{overtime})：加班=提示型唤醒(best-effort)；正常下班=排 offwork_choice pending 弹选择包。
// eveningStarter()：加班结束后静默走 evening 通勤链回家（雨天自动打车）。
// 钩子没注入/出错时都退回旧瞬移，保证她不会卡在公司。
let offWorkHandler = null;
let eveningStarter = null;
export function setOffWorkHandler(fn) { offWorkHandler = fn; }
export function setEveningStarter(fn) { eveningStarter = fn; }

// 加班结束（pending 到点 / 手动）：发加班费 + 走 evening 链回家。导出给 firePendingWake 的 overtime_end 分支用。
export async function endOvertime() {
  const row = await readStatus();
  if (!row) return null;
  const cur = Number(row.wallet_balance) || 0;
  const paid = await setState(row,
    { activity: '收拾东西准备回家', wallet_balance: Math.max(0, cur + OVERTIME_PAY) },
    '加班结束', { overtime_pay: OVERTIME_PAY, reason: '加班结束，结算加班费', effects_fixed: { wallet_balance: OVERTIME_PAY } });
  if (eveningStarter) {
    try { await eveningStarter(); return paid; }
    catch (e) { console.warn('[WORK] 加班后回家链启动失败，退回瞬移:', e.message); }
  }
  return setState(paid, { location: '家 · 客厅', activity: '加班后回家休息' }, '下班回家', { overtime: true });
}

const offWorkDecision = async (row, force) => {
  const overtime = force === 'overtime' ? true : force === 'normal' ? false : (Math.random() < OVERTIME_PROB);
  if (overtime) {
    const st = await startOvertime(row);
    // 加班=直接提示不可选（CC 忙就不提示，加班照走）
    if (offWorkHandler) { try { await offWorkHandler(st, { overtime: true }); } catch (e) { console.warn('[WORK] 加班提示失败:', e.message); } }
    return st;
  }
  if (offWorkHandler) {
    try { await offWorkHandler(row, { overtime: false }); return row; } // 选择包走 pending，到家由 evening 链负责
    catch (e) { console.warn('[WORK] 下班选择包排队失败，退回瞬移:', e.message); }
  }
  return goHomeNormal(row);
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
  // 自动闹钟（6/12）：8:00-9:10 窗口、当天没响过、人在家、没有在途早晨流程 → 排 morning_wakeup pending
  // （起床/贴贴或再睡/翘班三选在 firePendingWake 弹）。pending daemon 自带 CC 忙重试。
  if (t >= 480 && t < 550 && !marks.alarm && String(cur.location || '').startsWith('家')) {
    marks.alarm = true;
    if (!(await hasMorningFlow())) {
      try {
        await supabase.from('pending_wake_cheng').insert({
          wake_type: 'morning_wakeup', reason: '闹钟到点', status: 'queued',
          scheduled_at: new Date().toISOString(), payload: {}, attempts: 0,
        });
        console.log('[WORK] 已上闹钟（morning_wakeup pending）');
      } catch (e) { console.warn('[WORK] 上闹钟失败:', e.message); }
    }
    return cur;
  }
  if (t >= 550 && t < 660 && !marks.on_work && !atCompany) {                                                          // 09:10-11:00 上班（6/12 9:00→9:10）
    if ((cur.activity || '') === '翘班在家') { marks.on_work = true; return cur; }  // 翘班=花了120买的，别瞬移去公司
    if (await hasMorningFlow()) return cur;  // 早晨链在途：不瞬移不耗 mark，她自己会到岗（链断档时下个tick自然兜底）
    marks.on_work = true; return await goToWork(cur);
  }
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
