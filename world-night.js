// world-night.js - 14B-2 night interruptions: dream wake / morning erection wake.
// This module owns numeric state only. Prompt wording is intentionally left out.
import { supabase } from './memory.js';
import { realWorldTime } from './world-narration.js';
import { onWake } from './world-dream.js';

const TABLE = 'world_night_interruptions_cheng';
let missingTableWarned = false;
let nightWakeHandler = null;

export function setNightWakeHandler(handler) {
  nightWakeHandler = typeof handler === 'function' ? handler : null;
}

function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, Number.isFinite(Number(v)) ? Number(v) : lo));
}
function randInt(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function hmToMin(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function minToHM(min) {
  const n = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}
function nightAbsMin(hm) {
  const m = hmToMin(hm);
  if (m == null) return null;
  return m < 12 * 60 ? m + 1440 : m;
}
function isMissingTable(error) {
  const msg = String(error?.message || error || '');
  return /does not exist|schema cache|Could not find|relation .* not found/i.test(msg);
}
function warnMissing(error) {
  if (missingTableWarned || !isMissingTable(error)) return;
  missingTableWarned = true;
  console.warn(`[NIGHT] ${TABLE} 不存在，先运行 night-interruptions.sql`);
}
async function safeDb(fn, fallback = null) {
  try { return await fn(); }
  catch (e) {
    if (isMissingTable(e)) warnMissing(e);
    else console.warn('[NIGHT] DB 操作失败:', e?.message || e);
    return fallback;
  }
}

export function sleepinessBand(v) {
  const n = clamp(v);
  if (n < 20) return '清醒';
  if (n < 40) return '有点困';
  if (n < 60) return '困';
  if (n < 80) return '很困';
  return '半梦半醒';
}
export function arousalBand(v) {
  const n = clamp(v);
  if (n < 20) return '平复';
  if (n < 40) return '余温';
  if (n < 60) return '明显';
  if (n < 80) return '很明显';
  return '强烈';
}
function bodyIntensity(arousal) {
  if (arousal >= 80) return 'strong';
  if (arousal >= 40) return 'obvious';
  return 'mild';
}
function sleepDepth(sleepiness) {
  if (sleepiness >= 75) return 'heavy';
  if (sleepiness >= 45) return 'drowsy';
  return 'light';
}
function minutesToAlarm(worldTime) {
  const now = nightAbsMin(worldTime);
  if (now == null) return null;
  const alarm = 1440 + 8 * 60;
  return now <= alarm ? alarm - now : null;
}
function chooseMorningMinute(startWorldTime) {
  const start = nightAbsMin(startWorldTime);
  const lo = 1440 + 5 * 60;
  const hi = 1440 + 7 * 60;
  const from = Math.max(lo, start == null ? lo : start);
  if (from > hi) return null;
  return randInt(from, hi);
}
function computeSleepiness(sleptHours, eventType) {
  const h = Number(sleptHours) || 0;
  let v;
  if (h < 3) v = randInt(85, 100);
  else if (h < 5) v = randInt(65, 85);
  else if (h < 7) v = randInt(40, 65);
  else v = randInt(20, 45);
  if (eventType === 'dream_wake') v += randInt(5, 15);
  return Math.round(clamp(v));
}
function computeArousal(eventType, dreamType, sameRoom) {
  let v;
  if (eventType === 'dream_wake' && dreamType === 'erotic') v = randInt(80, 100);
  else if (eventType === 'dream_wake') v = randInt(65, 90);
  else v = randInt(60, 85);
  if (sameRoom) v += randInt(5, 10);
  return Math.round(clamp(v));
}

async function readCheng() {
  const { data } = await supabase.from('character_status_cheng').select('*').eq('name', '澄').limit(1);
  return data?.[0] || null;
}
async function readUser() {
  const { data } = await supabase.from('user_status_cheng').select('*').eq('name', 'user').limit(1);
  return data?.[0] || null;
}
async function readDreamBySession(sleepSessionId) {
  if (!sleepSessionId) return null;
  const { data } = await supabase.from('world_dreams_cheng').select('*').eq('sleep_session_id', sleepSessionId).limit(1);
  return data?.[0] || null;
}
async function readNightBySession(sleepSessionId) {
  if (!sleepSessionId) return null;
  return await safeDb(async () => {
    const { data, error } = await supabase.from(TABLE)
      .select('*').eq('sleep_session_id', sleepSessionId)
      .order('created_at', { ascending: false }).limit(1);
    if (error) throw error;
    return data?.[0] || null;
  }, null);
}
async function readLatestNight() {
  return await safeDb(async () => {
    const { data, error } = await supabase.from(TABLE)
      .select('*').order('created_at', { ascending: false }).limit(1);
    if (error) throw error;
    return data?.[0] || null;
  }, null);
}
async function readActiveNight() {
  return await safeDb(async () => {
    const { data, error } = await supabase.from(TABLE)
      .select('*').in('status', ['triggered'])
      .order('updated_at', { ascending: false }).limit(1);
    if (error) throw error;
    return data?.[0] || null;
  }, null);
}
async function writeTimeline(action, detail = {}, source = 'system') {
  try {
    const cheng = await readCheng();
    await supabase.from('daily_timeline_cheng').insert({
      world_time: realWorldTime(),
      location: cheng?.location || null,
      action,
      detail,
      source,
    });
  } catch (e) { console.warn('[NIGHT] timeline 写入失败:', e.message); }
}
async function applyPulse(arousal, kind = 'aroused') {
  try {
    const intensity = arousal >= 80 ? 0.75 : arousal >= 60 ? 0.55 : 0.35;
    const spike = arousal >= 80 ? 12 : arousal >= 60 ? 8 : 5;
    const { pulseOnEvent, flushScheduledPulsePersist } = await import('./pulse-linkage.js');
    pulseOnEvent({ emotion: kind, intensity, spike }, { activity: '夜间醒来', worldTime: realWorldTime() });
    await flushScheduledPulsePersist();
  } catch (e) { console.warn('[NIGHT] pulse 更新失败:', e.message); }
}
async function patchNight(id, patch) {
  return await safeDb(async () => {
    const { data, error } = await supabase.from(TABLE)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id).select().single();
    if (error) throw error;
    return data;
  }, null);
}

export async function scheduleNightMorningCheck({ sleepSessionId, kind, worldTime }) {
  if (kind !== 'night' || !sleepSessionId) return null;
  const scheduledMinute = chooseMorningMinute(worldTime);
  if (scheduledMinute == null) return null;
  const scheduledWorldTime = minToHM(scheduledMinute);
  return await safeDb(async () => {
    const existing = await readNightBySession(sleepSessionId);
    if (existing) return existing;
    const { data, error } = await supabase.from(TABLE).insert({
      sleep_session_id: sleepSessionId,
      event_type: 'morning_erection',
      status: 'scheduled',
      scheduled_world_time: scheduledWorldTime,
      scheduled_minute: scheduledMinute,
    }).select().single();
    if (error) throw error;
    console.log(`[NIGHT] 已排晨间身体检查 ${scheduledWorldTime}`);
    return data;
  }, null);
}

export async function cancelScheduledNightInterruption(sleepSessionId, reason = 'sleep_ended') {
  if (!sleepSessionId) return;
  await safeDb(async () => {
    const { error } = await supabase.from(TABLE)
      .update({ status: 'cancelled', phase: reason, updated_at: new Date().toISOString() })
      .eq('sleep_session_id', sleepSessionId).eq('status', 'scheduled');
    if (error) throw error;
  });
}

async function triggerNightInterruption({ sleep, eventType, dream = null, sleptHours }) {
  if (!sleep?.sleep_session_id || sleep.sleep_kind !== 'night') return null;
  const existing = await readNightBySession(sleep.sleep_session_id);
  if (existing && ['triggered', 'resolved'].includes(existing.status)) return null;

  const cheng = await readCheng();
  const user = await readUser();
  const sameRoom = !!(cheng && user && user.presence === '在家' && cheng.location === user.location);
  const userSleeping = !!(sameRoom && /睡|躺|休息/.test(String(user?.activity || '')));

  await onWake(sleep.sleep_session_id, eventType, sleptHours);
  const recalledDream = await readDreamBySession(sleep.sleep_session_id);
  const dreamForRow = recalledDream || dream;
  const dreamType = dreamForRow?.dream_type || dream?.dream_type || null;
  const sleepiness = computeSleepiness(sleptHours ?? sleep.slept_hours, eventType);
  const arousal = computeArousal(eventType, dreamType, sameRoom);
  const now = new Date().toISOString();

  const rowPatch = {
    sleep_session_id: sleep.sleep_session_id,
    event_type: eventType,
    status: 'triggered',
    phase: 'choice_pending',
    triggered_world_time: cheng?.world_time || realWorldTime(),
    triggered_at: now,
    dream_id: dreamForRow?.id || null,
    dream_type: dreamType,
    recall_level: dreamForRow?.recall_level || null,
    recalled_content: dreamForRow?.recalled_content || null,
    body_intensity: bodyIntensity(arousal),
    sleep_depth: sleepDepth(sleepiness),
    minutes_to_alarm: minutesToAlarm(cheng?.world_time),
    user_presence_snapshot: user ? { presence: user.presence, activity: user.activity } : null,
    cheng_location_snapshot: cheng?.location || null,
    user_location_snapshot: user?.location || null,
    user_sleeping: userSleeping,
    sleepiness_value: sleepiness,
    arousal_value: arousal,
    last_decay_at: now,
  };

  const row = await safeDb(async () => {
    if (existing) {
      const { data, error } = await supabase.from(TABLE)
        .update({ ...rowPatch, updated_at: now }).eq('id', existing.id).select().single();
      if (error) throw error;
      return data;
    }
    const { data, error } = await supabase.from(TABLE).insert(rowPatch).select().single();
    if (error) throw error;
    return data;
  }, null);
  if (!row) return null;

  await supabase.from('world_sleep_state_cheng').update({
    status: 'interrupted_awake',
    wake_reason: eventType,
    updated_at: now,
  }).eq('sleep_session_id', sleep.sleep_session_id);
  await supabase.from('character_status_cheng').update({ activity: '夜间醒来', updated_at: now }).eq('name', '澄');

  const note = eventType === 'dream_wake'
    ? '因梦境醒来，清晨身体反应也被带醒'
    : '临近清晨身体反应醒来';
  await writeTimeline('夜间醒来', {
    via: 'night_interruption',
    event_type: eventType,
    dream_type: dreamType,
    recall_level: row.recall_level,
    note,
    night_interruption_id: row.id,
  });
  await applyPulse(arousal, 'aroused');
  if (nightWakeHandler) {
    try { await nightWakeHandler(row); }
    catch (e) { console.warn('[NIGHT] 夜间唤醒包触发失败:', e.message); }
  }
  return row;
}

export async function maybeTriggerDreamWake({ sleep, dream, sleptHours }) {
  if (!sleep || sleep.sleep_kind !== 'night' || !dream) return null;
  const existing = await readNightBySession(sleep.sleep_session_id);
  if (existing && ['triggered', 'resolved'].includes(existing.status)) return null;
  const p = dream.dream_type === 'erotic' ? 0.35 : 0.10;
  if (Math.random() >= p) return null;
  return await triggerNightInterruption({ sleep, eventType: 'dream_wake', dream, sleptHours });
}

export async function maybeTriggerMorningErection({ sleep, worldTime, sleptHours }) {
  if (!sleep || sleep.sleep_kind !== 'night' || sleep.status !== 'sleeping') return null;
  const row = await readNightBySession(sleep.sleep_session_id);
  if (!row || row.status !== 'scheduled') return null;
  const nowAbs = nightAbsMin(worldTime);
  if (nowAbs == null || !row.scheduled_minute) return null;
  const alarmAbs = 1440 + 8 * 60;
  if (nowAbs >= alarmAbs) {
    await patchNight(row.id, { status: 'cancelled', phase: 'missed_before_alarm' });
    return null;
  }
  if (nowAbs < row.scheduled_minute) return null;
  return await triggerNightInterruption({ sleep, eventType: 'morning_erection', sleptHours });
}

async function updateSleep(status, activity, sleepSessionId) {
  const now = new Date().toISOString();
  await supabase.from('world_sleep_state_cheng').update({
    status,
    updated_at: now,
    ...(status === 'awake' ? { remaining_hours: 0, planned_hours: null, with_user: false } : {}),
  }).eq('sleep_session_id', sleepSessionId);
  await supabase.from('character_status_cheng').update({ activity, updated_at: now }).eq('name', '澄');
}
async function drainEnergy(lo, hi) {
  const drain = randInt(lo, hi);
  try {
    const { data } = await supabase.from('character_status_cheng').select('energy').eq('name', '澄').limit(1);
    const cur = data?.[0]?.energy ?? 50;
    await supabase.from('character_status_cheng').update({ energy: Math.max(0, cur - drain) }).eq('name', '澄');
  } catch (e) { console.warn('[NIGHT] 体力扣除失败:', e.message); }
  return drain;
}
async function scheduleDirectRound(rowId) {
  const delayMin = randInt(4, 7);
  const scheduledAt = new Date(Date.now() + delayMin * 60 * 1000).toISOString();
  try {
    await supabase.from('pending_wake_cheng').insert({
      wake_type: 'night_direct_round',
      reason: '清晨身体反应还没结束',
      status: 'queued',
      scheduled_at: scheduledAt,
      world_time: realWorldTime(),
      payload: { night_interruption_id: rowId, delay_world_minutes: delayMin },
      attempts: 0,
    });
  } catch (e) { console.warn('[NIGHT] 排直接做短流程失败:', e.message); }
}

export async function resolveNightChoice(decision) {
  const row = await readActiveNight();
  if (!row) return { ok: false, reason: 'no_active_night_interruption' };
  const now = new Date().toISOString();
  if (decision === 'cuddle_sleep') {
    const nextArousal = Math.round(clamp((row.arousal_value || 0) - randInt(12, 25)));
    const nextSleepiness = Math.round(clamp((row.sleepiness_value || 0) + randInt(10, 20)));
    const updated = await patchNight(row.id, {
      status: 'resolved',
      phase: 'cuddle_sleep',
      decision,
      arousal_value: nextArousal,
      sleepiness_value: nextSleepiness,
      resolved_at: now,
      last_decay_at: now,
    });
    await updateSleep('sleeping', '睡觉', row.sleep_session_id);
    await writeTimeline('清晨醒来后抱着小茉莉继续睡', { via: 'night_interruption', decision, night_interruption_id: row.id }, 'claude');
    await applyPulse(nextArousal, 'intimate');
    return { ok: true, night: updated };
  }
  if (decision === 'self_relief') {
    const nextArousal = randInt(5, 18);
    const nextSleepiness = Math.round(clamp((row.sleepiness_value || 0) + randInt(8, 18)));
    const energyDrain = await drainEnergy(3, 8);
    const updated = await patchNight(row.id, {
      status: 'resolved',
      phase: 'self_relief',
      decision,
      arousal_value: nextArousal,
      sleepiness_value: nextSleepiness,
      resolved_at: now,
      last_decay_at: now,
    });
    await updateSleep('sleeping', '睡觉', row.sleep_session_id);
    await writeTimeline('清晨醒来后自己处理了身体反应', { via: 'night_interruption', decision, energy_drain: energyDrain, night_interruption_id: row.id }, 'claude');
    await applyPulse(45, 'aroused');
    return { ok: true, night: updated, energyDrain };
  }
  if (decision === 'direct') {
    const user = await readUser();
    const cheng = await readCheng();
    const userSleeping = !!(user && cheng && user.presence === '在家' && user.location === cheng.location && /睡|躺|休息/.test(String(user.activity || '')));
    if (!userSleeping) {
      const updated = await patchNight(row.id, { status: 'resolved', phase: 'with_user', decision, resolved_at: now });
      await updateSleep('awake', '亲密', row.sleep_session_id);
      try {
        const { enterIntimate, flushScheduledPulsePersist } = await import('./pulse-linkage.js');
        enterIntimate(cheng?.energy ?? 50);
        await flushScheduledPulsePersist();
      } catch (e) { console.warn('[NIGHT] 进入普通亲密失败:', e.message); }
      await writeTimeline('清晨醒来后和小茉莉进入亲密', { via: 'night_interruption', decision, night_interruption_id: row.id }, 'claude');
      return { ok: true, night: updated, mode: 'with_user' };
    }
    const total = randInt(4, 6);
    const updated = await patchNight(row.id, {
      phase: 'direct_unanswered',
      decision,
      direct_round: 0,
      direct_total_rounds: total,
      last_decay_at: now,
    });
    await writeTimeline('清晨醒来后没有重新睡下', { via: 'night_interruption', decision, direct_total_rounds: total, night_interruption_id: row.id }, 'claude');
    await scheduleDirectRound(row.id);
    return { ok: true, night: updated, mode: 'direct_unanswered' };
  }
  return { ok: false, reason: 'unknown_decision' };
}

export async function advanceNightDirectRound(nightInterruptionId) {
  const row = nightInterruptionId
    ? await safeDb(async () => {
        const { data, error } = await supabase.from(TABLE).select('*').eq('id', nightInterruptionId).limit(1);
        if (error) throw error;
        return data?.[0] || null;
      }, null)
    : await readActiveNight();
  if (!row || row.phase !== 'direct_unanswered') return { ok: false, reason: 'no_active_direct_round' };

  const round = (row.direct_round || 0) + 1;
  const total = row.direct_total_rounds || randInt(4, 6);
  const arousal = Math.round(clamp((row.arousal_value || 0) + randInt(8, 14)));
  const sleepiness = Math.round(clamp((row.sleepiness_value || 0) - randInt(6, 12)));
  await applyPulse(arousal, 'aroused');

  if (round >= total) {
    const finalArousal = randInt(15, 30);
    const finalSleepiness = Math.round(clamp(sleepiness + randInt(5, 12)));
    const energyDrain = await drainEnergy(6, 12);
    const updated = await patchNight(row.id, {
      status: 'resolved',
      phase: 'direct_finished',
      direct_round: round,
      direct_total_rounds: total,
      arousal_value: finalArousal,
      sleepiness_value: finalSleepiness,
      resolved_at: new Date().toISOString(),
      last_decay_at: new Date().toISOString(),
    });
    await updateSleep('sleeping', '睡觉', row.sleep_session_id);
    await writeTimeline('清晨醒来后的身体反应慢慢平复', {
      via: 'night_interruption',
      decision: 'direct',
      direct_rounds: total,
      energy_drain: energyDrain,
      night_interruption_id: row.id,
    }, 'system');
    return { ok: true, done: true, night: updated, energyDrain };
  }

  const updated = await patchNight(row.id, {
    direct_round: round,
    direct_total_rounds: total,
    arousal_value: arousal,
    sleepiness_value: sleepiness,
    last_decay_at: new Date().toISOString(),
  });
  await scheduleDirectRound(row.id);
  return { ok: true, done: false, night: updated };
}

export async function nightOnUserReply(text) {
  if (!String(text || '').trim()) return null;
  const row = await readActiveNight();
  if (!row) return null;
  const now = new Date().toISOString();
  if (row.phase === 'direct_unanswered') {
    const cheng = await readCheng();
    const updated = await patchNight(row.id, {
      status: 'resolved',
      phase: 'with_user',
      resolved_at: now,
      last_decay_at: now,
    });
    await updateSleep('awake', '亲密', row.sleep_session_id);
    try {
      const { enterIntimate, flushScheduledPulsePersist } = await import('./pulse-linkage.js');
      enterIntimate(cheng?.energy ?? 50);
      await flushScheduledPulsePersist();
    } catch (e) { console.warn('[NIGHT] 用户回应后进入亲密失败:', e.message); }
    await writeTimeline('清晨醒来后小茉莉回应了他', { via: 'night_interruption', decision: 'direct', night_interruption_id: row.id }, 'system');
    return { ok: true, night: updated, mode: 'with_user' };
  }
  return null;
}

export async function decayNightArousal({ sleeping = false } = {}) {
  const row = await readLatestNight();
  if (!row || row.phase === 'direct_unanswered' || !row.arousal_value || row.arousal_value <= 20) return null;
  const last = new Date(row.last_decay_at || row.updated_at || row.created_at || Date.now()).getTime();
  const minutes = Math.max(0, Math.floor((Date.now() - last) / 60000));
  const step = sleeping ? 60 : 10;
  const chunks = Math.floor(minutes / step);
  if (chunks <= 0) return null;
  let drop = 0;
  for (let i = 0; i < chunks; i++) drop += sleeping ? randInt(12, 18) : randInt(3, 6);
  const next = Math.round(clamp(row.arousal_value - drop));
  return await patchNight(row.id, { arousal_value: next, last_decay_at: new Date().toISOString() });
}

export async function getNightState() {
  const night = await readLatestNight();
  return {
    night,
    sleepiness_band: night ? sleepinessBand(night.sleepiness_value) : null,
    arousal_band: night ? arousalBand(night.arousal_value) : null,
  };
}

export async function devTriggerNightInterruption(type = 'morning_erection', dreamType = null) {
  const { data } = await supabase.from('world_sleep_state_cheng').select('*').eq('name', '澄').limit(1);
  const sleep = data?.[0];
  if (!sleep?.sleep_session_id) return { ok: false, reason: 'no_sleep_session' };
  const dream = dreamType ? { dream_type: dreamType } : null;
  const row = await triggerNightInterruption({
    sleep: { ...sleep, sleep_kind: sleep.sleep_kind || 'night' },
    eventType: type,
    dream,
    sleptHours: sleep.slept_hours || 0,
  });
  return { ok: !!row, night: row };
}
