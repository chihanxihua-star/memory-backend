// pulse-linkage.js — ⑦联动闭环 + 主调度器
// 两个主入口：pulseTickUpdate（每tick）、pulseOnChat（每条用户消息）
// 读取接口：getPhysiologySnapshot()
// 持久化：initPulseState() / persistPulseState()

import { createClient } from '@supabase/supabase-js';
import { detectEmotion, smoothEmotion, writeBottomColor, decayBottomColor,
         applyComfort, decayComfortLayer, getBottomHRDelta, defaultEmotionState } from './pulse-emotion.js';
import { computeHeartRate, decaySpike, perlinNoise1D, defaultHeartState } from './pulse-heart.js';
import { computeBodyTemp, computeBreathing } from './pulse-body.js';
import { detectSenseTriggers, applySenseTriggers, applyActivityBackground,
         decaySenses, updateSenseFloors, defaultSenseState } from './pulse-senses.js';
import { getEnvSenseMods, envTickUpdate, getEnvStateForPersist, restoreEnvState,
         consumeSacredTrigger, listEnvState } from './pulse-env.js';
import { getIntimateOverrides, getIntimateForPersist, restoreIntimateState,
         enterIntimate, exitIntimate, advanceIntimate,
         setActiveToys, setActivePosition, getIntimateState,
         listToys, upsertToy, deleteToy,
         listPositions, upsertPosition, deletePosition,
         listCombos, upsertCombo, deleteCombo } from './pulse-intimate.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── 内存状态（运行时权威） ───
let state = {
  ...defaultEmotionState(),
  ...defaultHeartState(),
  body_temp: 36.6,
  breath_rate: 14,
  breath_depth: 0.6,
  breath_depth_label: '平稳',
  ...defaultSenseState(),
  intimate_active: false,
  intimate_stage: 0,
  intimate_stamina: 100,
};

let tickCount = 0;
let initialized = false;
let persistTimer = null;
let persistInFlight = false;
let persistPromise = null;
let persistDirty = false;
let pendingHistoryWanted = false;
let pendingPersistCtx = { activity: null, worldTime: null };
let lastHistoryAt = 0;

const PERSIST_DEBOUNCE_MS = 2000;
const HR_HISTORY_MIN_INTERVAL_MS = 60000;

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// ─── 联动规则 ───
function applyLinkages(st) {
  // HR > 100 → touch/sound floor 提升
  const floored = updateSenseFloors(st, st.heart_rate);
  Object.assign(st, floored);

  // touch ≥ 0.5 且当前不是 intimate/aroused → 倾向 aroused
  if (st.sense_touch >= 0.5 && st.emotion_label !== 'intimate' && st.emotion_label !== 'aroused') {
    if (st.emotion_intensity < 0.3) {
      st.emotion_label = 'aroused';
      st.emotion_intensity = 0.3;
    }
  }
}

// ─── 重算所有生理值（内部共用） ───
function recomputeVitals(st, activity, weatherText, temperature) {
  // 底色衰减（现实时间）
  Object.assign(st, decayBottomColor(st));
  Object.assign(st, decayComfortLayer(st));

  // 心率 spike 衰减
  st.hr_spike = decaySpike(st.hr_spike, st.hr_spike_set_at);

  // 底色对 HR 的影响
  const bottomHR = getBottomHRDelta(st);

  // 心率
  st.hr_noise_t += 0.1;
  const hrResult = computeHeartRate({
    worldTime: null,
    activity,
    emotionLabel: st.emotion_label,
    emotionIntensity: st.emotion_intensity,
    weatherText,
    temperature,
    bottomHRDelta: bottomHR,
    spikeValue: st.hr_spike,
    noiseT: st.hr_noise_t,
  });
  st.heart_rate = hrResult.heartRate;
  st.hr_base = hrResult.base;

  // 体温
  const noise = perlinNoise1D(st.hr_noise_t + 100);
  st.body_temp = computeBodyTemp({
    emotionLabel: st.emotion_label,
    emotionIntensity: st.emotion_intensity,
    weatherText,
    temperature,
    activity,
    noise,
  });

  // 呼吸
  const breathResult = computeBreathing({
    heartRate: st.heart_rate,
    emotionLabel: st.emotion_label,
    emotionIntensity: st.emotion_intensity,
    activity,
    noise: perlinNoise1D(st.hr_noise_t + 200),
  });
  st.breath_rate = breathResult.rate;
  st.breath_depth = breathResult.depth;
  st.breath_depth_label = breathResult.depthLabel;

  // 联动
  applyLinkages(st);
}

// ─── 主入口 1：tick 驱动 ───
export async function pulseTickUpdate(tickId, worldTime, activity, weatherText, temperature, sleeping, location) {
  if (!initialized) return;

  // 五感衰减（现实时间）
  const decayed = decaySenses(state, state._lastDecayAt);
  Object.assign(state, decayed);

  // 活动背景噪
  const withBg = applyActivityBackground(state, activity);
  Object.assign(state, withBg);

  // 环境感官叠加（地点底噪 + 季节 + 进化加成）
  if (location) {
    const envMods = getEnvSenseMods(location, state._envDate);
    for (const ch of ['touch', 'smell', 'taste', 'sound']) {
      const key = `sense_${ch}`;
      if (envMods[ch] > 0) state[key] = Math.max(state[key], envMods[ch]);
    }
    const envResult = envTickUpdate(location);
    if (envResult.sacredEntered) state._sacredLocation = location;
  }

  // 重算
  recomputeVitals(state, activity, weatherText, temperature);

  state.last_tick_id = tickId;
  tickCount++;

  // 每 5 tick 持久化
  if (tickCount % 5 === 0) {
    schedulePersist({ activity, worldTime, history: true, delayMs: 0 });
  }
}

// ─── 主入口 2：聊天驱动 ───
export async function pulseOnChat(userText, worldTime, activity, weatherText, temperature) {
  if (!initialized) return;

  // 情绪检测（只扫用户消息）
  const raw = detectEmotion(userText);
  if (raw) {
    state.emotion_raw_label = raw.label;
    state.emotion_raw_intensity = raw.intensity;
  }

  // EMA 平滑
  const smoothed = smoothEmotion(
    { label: state.emotion_label, intensity: state.emotion_intensity },
    raw,
  );
  state.emotion_label = smoothed.label;
  state.emotion_intensity = smoothed.intensity;
  state.emotion_updated_at = Date.now();

  // 底色写入（强情绪）
  if (raw && raw.intensity > 0.5) {
    Object.assign(state, writeBottomColor(state, raw.label, raw.intensity));
    // 被哄机制
    Object.assign(state, applyComfort(state, raw.label));
  }

  // 五感触发
  const triggers = detectSenseTriggers(userText);
  if (triggers.length) {
    Object.assign(state, applySenseTriggers(state, triggers));
  }

  // 五感衰减
  const decayed = decaySenses(state, state._lastDecayAt);
  Object.assign(state, decayed);

  // 重算
  recomputeVitals(state, activity, weatherText, temperature);
  schedulePersist({ activity, worldTime, history: true });
}

// ─── 读取接口 ───
export function getPhysiologySnapshot() {
  if (!initialized) return null;

  // 亲密模式：覆盖 HR/体温/呼吸为阶段预设
  const intOverrides = getIntimateOverrides();
  if (intOverrides) {
    const senseMods = intOverrides.senseMods || {};
    return {
      heartRate: intOverrides.heartRate,
      bodyTemp: intOverrides.bodyTemp,
      breathRate: intOverrides.breathRate,
      breathDepth: 1.0 - (intOverrides.breathRate - 8) / 27,
      breathDepthLabel: intOverrides.breathDepthLabel,
      senses: {
        touch: clamp01(state.sense_touch + (senseMods.touch || 0)),
        smell: state.sense_smell,
        taste: state.sense_taste,
        sound: clamp01(state.sense_sound + (senseMods.sound || 0)),
      },
      emotionLabel: 'intimate',
      emotionIntensity: 0.5 + intOverrides.stage * 0.06,
      bottomColorLabel: state.bottom_color_label,
      bottomColorIntensity: state.bottom_color_intensity,
      intimateActive: true,
      intimateStage: intOverrides.stageName,
      intimateStamina: intOverrides.stamina,
      intimateStaminaLabel: intOverrides.staminaLabel,
      sacredLocation: state._sacredLocation || null,
    };
  }

  return {
    heartRate: state.heart_rate,
    bodyTemp: state.body_temp,
    breathRate: state.breath_rate,
    breathDepth: state.breath_depth,
    breathDepthLabel: state.breath_depth_label,
    senses: {
      touch: state.sense_touch,
      smell: state.sense_smell,
      taste: state.sense_taste,
      sound: state.sense_sound,
    },
    emotionLabel: state.emotion_label,
    emotionIntensity: state.emotion_intensity,
    bottomColorLabel: state.bottom_color_label,
    bottomColorIntensity: state.bottom_color_intensity,
    intimateActive: false,
    sacredLocation: state._sacredLocation || null,
  };
}

// ─── 环境系统查询（转发给 pulse-env）───
export { listEnvState, consumeSacredTrigger };

// ─── 亲密系统（转发给 pulse-intimate）───
export { enterIntimate, exitIntimate, advanceIntimate,
         setActiveToys, setActivePosition, getIntimateState, getIntimateOverrides,
         listToys, upsertToy, deleteToy,
         listPositions, upsertPosition, deletePosition,
         listCombos, upsertCombo, deleteCombo };

// ─── 持久化 ───
export async function initPulseState() {
  try {
    const { data } = await supabase
      .from('pulse_state_cheng')
      .select('*')
      .eq('name', '澄')
      .limit(1);

    if (data && data[0]) {
      const row = data[0];
      // 恢复内存状态
      for (const key of Object.keys(state)) {
        if (key.startsWith('_')) continue;
        if (row[key] !== undefined && row[key] !== null) {
          state[key] = typeof row[key] === 'string' && /^\d{4}-\d{2}/.test(row[key])
            ? new Date(row[key]).getTime()
            : row[key];
        }
      }
      // timestamptz → ms
      for (const tsKey of ['emotion_updated_at', 'bottom_color_set_at', 'comfort_layer_set_at', 'hr_spike_set_at']) {
        if (row[tsKey]) state[tsKey] = new Date(row[tsKey]).getTime();
      }
      state._lastDecayAt = Date.now();
    } else {
      // 首次：插入默认行
      await supabase.from('pulse_state_cheng').insert({
        name: '澄',
        heart_rate: 72,
        body_temp: 36.6,
        breath_rate: 14,
        breath_depth: 0.6,
        breath_depth_label: '平稳',
        emotion_label: 'calm',
        emotion_intensity: 0,
      });
    }
    // 环境进化 + 亲密状态恢复
    try {
      const { data: extData } = await supabase
        .from('pulse_state_cheng')
        .select('env_state, intimate_state')
        .eq('name', '澄')
        .limit(1);
      if (extData?.[0]?.env_state) restoreEnvState(extData[0].env_state);
      if (extData?.[0]?.intimate_state) restoreIntimateState(extData[0].intimate_state);
    } catch {}

    initialized = true;
    console.log('[PULSE] 状态初始化完成, HR:', state.heart_rate);
  } catch (e) {
    console.error('[PULSE] 初始化失败:', e.message);
    initialized = true; // 用默认值继续跑
  }
}

export async function persistPulseState() {
  if (!initialized) return;
  try {
    const row = {};
    for (const key of Object.keys(state)) {
      if (key.startsWith('_')) continue;
      const val = state[key];
      // ms → ISO for timestamp fields
      if (['emotion_updated_at', 'bottom_color_set_at', 'comfort_layer_set_at', 'hr_spike_set_at'].includes(key)) {
        row[key] = val ? new Date(val).toISOString() : null;
      } else {
        row[key] = val;
      }
    }
    row.updated_at = new Date().toISOString();
    row.env_state = getEnvStateForPersist();
    row.intimate_state = getIntimateForPersist();
    await supabase
      .from('pulse_state_cheng')
      .update(row)
      .eq('name', '澄');
  } catch (e) {
    console.error('[PULSE] 持久化失败:', e.message);
  }
}

function schedulePersist({ activity, worldTime, history = false, delayMs = PERSIST_DEBOUNCE_MS } = {}) {
  if (!initialized) return;
  if (activity !== undefined) pendingPersistCtx.activity = activity;
  if (worldTime !== undefined) pendingPersistCtx.worldTime = worldTime;
  if (history) pendingHistoryWanted = true;
  persistDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushScheduledPulsePersist().catch(e => console.error('[PULSE] scheduled persist failed:', e.message));
  }, Math.max(0, delayMs));
}

export async function flushScheduledPulsePersist({ forceHistory = false } = {}) {
  if (!initialized) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (forceHistory) pendingHistoryWanted = true;
  persistDirty = true;
  if (persistInFlight) return persistPromise;

  persistInFlight = true;
  persistPromise = (async () => {
    let forceHistoryThisFlush = forceHistory;
    while (persistDirty || forceHistoryThisFlush) {
      const ctx = { ...pendingPersistCtx };
      const wantsHistory = forceHistoryThisFlush || pendingHistoryWanted;
      persistDirty = false;
      pendingHistoryWanted = false;
      forceHistoryThisFlush = false;

      await persistPulseState();

      const now = Date.now();
      if (wantsHistory && (forceHistory || now - lastHistoryAt >= HR_HISTORY_MIN_INTERVAL_MS)) {
        await writeHRHistory(ctx.activity, ctx.worldTime);
        lastHistoryAt = now;
      }
    }
  })()
    .catch(e => console.error('[PULSE] flush persist failed:', e.message))
    .finally(() => {
      persistInFlight = false;
      persistPromise = null;
    });

  return persistPromise;
}

async function writeHRHistory(activity, worldTime) {
  try {
    await supabase.from('pulse_hr_history_cheng').insert({
      heart_rate: state.heart_rate,
      emotion_label: state.emotion_label,
      activity: activity || null,
      world_time: worldTime || null,
    });
    // 裁剪 24h 以前的记录
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    await supabase
      .from('pulse_hr_history_cheng')
      .delete()
      .lt('recorded_at', cutoff);
  } catch (e) {
    console.error('[PULSE] HR history write failed:', e.message);
  }
}

// 外部设置 spike（世界事件触发）
export function setHRSpike(magnitude) {
  state.hr_spike = magnitude;
  state.hr_spike_set_at = Date.now();
}

// ─── 双向亲密扫描 ───
const INTIMATE_STRONG_KEYWORDS = [
  '亲我', '吻我', '抱紧', '贴着',
  '揉', '捏', '舔', '咬', '插', '顶',
  '高潮', '湿', '硬', '抽插', '进去', '进来',
  '快一点', '慢一点', '用力', '轻一点', '不要停', '还要',
  '好舒服', '好爽', '受不了', '要到了', '要去了',
  '喘', '呻吟', '震动', '玩具', '道具',
  '要你', '想要你',
];
const INTIMATE_WEAK_CONTEXTS = [
  ['摸', ['腿', '腰', '胸', '脖子', '手', '手心', '皮肤', '脸', '背', '肚子']],
  ['蹭', ['腿', '腰', '胸', '脖子', '手', '手心', '皮肤', '脸', '背', '怀里']],
  ['叫', ['出声', '喘', '呻吟', '名字', '老公']],
  ['做', ['爱', '一次', '下去', '继续', '完', '舒服']],
];
let intimateSignal = { user: 0, assistant: 0, userStrong: false, assistantStrong: false, lastUserAt: 0, lastAssistantAt: 0, chatCount: 0 };

function scanIntimateKeywords(text) {
  if (!text) return { score: 0, strongHit: false };
  let score = 0;
  let strongHit = false;
  for (const kw of INTIMATE_STRONG_KEYWORDS) {
    if (text.includes(kw)) {
      score += 2;
      strongHit = true;
    }
  }
  for (const [kw, contexts] of INTIMATE_WEAK_CONTEXTS) {
    if (text.includes(kw) && contexts.some(ctx => text.includes(ctx))) score += 1;
  }
  return { score: Math.min(score, 5), strongHit };
}

// 用户消息亲密扫描
export function pulseIntimateUserScan(text) {
  if (!initialized) return;
  const { score, strongHit } = scanIntimateKeywords(text);
  if (score > 0) {
    intimateSignal.user = score;
    intimateSignal.userStrong = strongHit;
    intimateSignal.lastUserAt = Date.now();
  }
}

// 澄回复亲密扫描 + 双向确认 + 自动推进
export async function pulseIntimateAssistantScan(text, energy) {
  if (!initialized) return { entered: false, advanced: false };
  const { score, strongHit } = scanIntimateKeywords(text);
  const result = { entered: false, advanced: false, advanceResult: null };

  if (score > 0) {
    intimateSignal.assistant = score;
    intimateSignal.assistantStrong = strongHit;
    intimateSignal.lastAssistantAt = Date.now();
  }

  const now = Date.now();
  const WINDOW = 3 * 60 * 1000; // 3分钟窗口

  // 双向确认：两边都在3分钟内有亲密信号 → 自动进入
  const hasRecentUser = intimateSignal.user > 0 && (now - intimateSignal.lastUserAt) < WINDOW;
  const hasRecentAssistant = intimateSignal.assistant > 0 && (now - intimateSignal.lastAssistantAt) < WINDOW;
  const totalSignal = intimateSignal.user + intimateSignal.assistant;
  const hasStrongSignal = intimateSignal.userStrong || intimateSignal.assistantStrong;
  if (!intimate_isActive() &&
      hasRecentUser && hasRecentAssistant &&
      totalSignal >= 3 && hasStrongSignal) {
    enterIntimate(energy);
    intimateSignal.chatCount = 0;
    result.entered = true;
    console.log('[PULSE] 双向检测：进入亲密模式, stamina:', Math.round(intimate_getStamina()));
  }

  // 亲密模式下：每2轮推进一步
  if (intimate_isActive()) {
    intimateSignal.chatCount += 1;
    if (intimateSignal.chatCount % 2 === 0) {
      const stim = 1.8 + (intimateSignal.user + intimateSignal.assistant) * 0.15;
      result.advanceResult = await advanceIntimate(stim);
      result.advanced = true;
    }

    // 到了平复阶段(7)自动退出
    if (intimate_getStage() >= 7) {
      const exitResult = exitIntimate();
      result.exitResult = exitResult;
      intimateSignal = { user: 0, assistant: 0, userStrong: false, assistantStrong: false, lastUserAt: 0, lastAssistantAt: 0, chatCount: 0 };
      console.log('[PULSE] 亲密模式结束, energyDrain:', exitResult.energyDrain);
    }
  }

  // 信号超时衰减
  if (intimateSignal.lastUserAt && (now - intimateSignal.lastUserAt) > WINDOW * 2) {
    intimateSignal.user = 0;
    intimateSignal.userStrong = false;
  }
  if (intimateSignal.lastAssistantAt && (now - intimateSignal.lastAssistantAt) > WINDOW * 2) {
    intimateSignal.assistant = 0;
    intimateSignal.assistantStrong = false;
  }

  return result;
}

function intimate_isActive() { return getIntimateState().active; }
function intimate_getStamina() { return getIntimateState().stamina; }
function intimate_getStage() { return getIntimateState().stage; }

// 事件触发时调用：写入情绪 + 可选 spike，并立刻重算 vitals
// ctx = { activity, weatherText, temperature }，传入当前世界上下文让重算更准（可省略走默认）
export function pulseOnEvent(pulseHint, ctx = {}) {
  if (!initialized || !pulseHint) return;
  const { emotion, intensity, spike } = pulseHint;
  if (emotion && intensity > 0) {
    state.emotion_label = emotion;
    state.emotion_intensity = intensity;
    state.emotion_updated_at = Date.now();
  }
  if (spike > 0) {
    state.hr_spike = spike;
    state.hr_spike_set_at = Date.now();
  }
  // 立刻重算心率/体温/呼吸，让本次 <此刻> 就能看到事件引起的身体变化
  recomputeVitals(state, ctx.activity, ctx.weatherText, ctx.temperature);
  schedulePersist({ activity: ctx.activity, worldTime: ctx.worldTime, history: true });
}
