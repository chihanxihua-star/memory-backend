// pulse-body.js — ③体温 + ④呼吸
// 都从心率/情绪/活动/天气派生。

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ─── ③ 体温 ───
const EMOTION_TEMP_DELTA = {
  calm: 0, happy: 0.1, nervous: 0.3, startled: 0.2,
  intimate: 0.5, aroused: 0.6, angry: 0.4, scolded: 0.2,
  sad: -0.2, longing: 0.1, tired: -0.1, excited: 0.3, vulnerable: 0.1,
};

const ACTIVITY_TEMP_DELTA = {
  '工作': 0.1, '上班': 0.1, '加班': 0.15, '休息': -0.1, '做饭': 0.3, '吃饭': 0.1,
  '吃零食': 0.05, '洗澡': 0.2, '洗漱': 0.1, '坐地铁': 0.05, '走路': 0.4, '跑步': 0.7,
  '睡觉': -0.3, '午休': -0.2, '发呆': -0.05, '逛街': 0.3,
  '倒水': 0, '在厨房': 0.1, '点外卖': 0, '收拾': 0.1,
};

function weatherTempDelta(weatherText, temperature) {
  const wt = weatherText || '';
  const hasTemp = temperature != null;
  let delta = 0;
  if (/炎热|酷热/.test(wt) || (hasTemp && temperature > 35)) delta += 0.3;
  else if (/热|闷/.test(wt) || (hasTemp && temperature > 30)) delta += 0.15;
  if (/寒冷|极冷/.test(wt) || (hasTemp && temperature < 0)) delta -= 0.4;
  else if (/冷|凉/.test(wt) || (hasTemp && temperature < 10)) delta -= 0.2;
  return delta;
}

function activityTempDelta(activity) {
  if (!activity) return 0;
  for (const [key, val] of Object.entries(ACTIVITY_TEMP_DELTA)) {
    if (activity.includes(key)) return val;
  }
  return 0;
}

export function computeBodyTemp({ emotionLabel, emotionIntensity, weatherText, temperature, activity, noise = 0 }) {
  const emo = (EMOTION_TEMP_DELTA[emotionLabel] || 0) * emotionIntensity;
  const weather = weatherTempDelta(weatherText, temperature);
  const act = activityTempDelta(activity);
  const raw = 36.6 + emo + weather + act + noise * 0.1;
  return Math.round(clamp(raw, 35.5, 40.0) * 100) / 100;
}

// ─── ④ 呼吸 ───
const EMOTION_BREATH_DELTA = {
  calm: 0, happy: 1, nervous: 4, startled: 6,
  intimate: 3, aroused: 5, angry: 3, scolded: 2,
  sad: -1, longing: 1, tired: -2, excited: 3, vulnerable: 1,
};

const ACTIVITY_BREATH_BASE = {
  '睡觉': 10, '午休': 11, '休息': 12, '发呆': 12,
  '工作': 14, '上班': 14, '加班': 15, '做饭': 15, '吃饭': 13,
  '吃零食': 13, '洗澡': 14, '洗漱': 13, '坐地铁': 14,
  '走路': 18, '跑步': 24, '逛街': 16,
  '倒水': 13, '在厨房': 14, '点外卖': 13, '收拾': 14,
};

const DEPTH_LABELS = [
  { max: 0.15, label: '急促' },
  { max: 0.35, label: '偏浅' },
  { max: 0.65, label: '平稳' },
  { max: 0.85, label: '深长' },
  { max: 1.01, label: '很深很长' },
];

function getBreathBase(activity) {
  if (!activity) return 14;
  for (const [key, val] of Object.entries(ACTIVITY_BREATH_BASE)) {
    if (activity.includes(key)) return val;
  }
  return 14;
}

function depthLabel(depth) {
  for (const d of DEPTH_LABELS) {
    if (depth <= d.max) return d.label;
  }
  return '平稳';
}

export function computeBreathing({ heartRate, emotionLabel, emotionIntensity, activity, noise = 0 }) {
  const base = getBreathBase(activity);
  const hrSync = (heartRate - 70) * 0.15;
  const emo = (EMOTION_BREATH_DELTA[emotionLabel] || 0) * emotionIntensity;
  const rate = clamp(Math.round((base + hrSync + emo + noise) * 10) / 10, 8, 35);
  const depth = clamp(1.0 - (rate - 8) / 27, 0, 1);
  return {
    rate,
    depth: Math.round(depth * 100) / 100,
    depthLabel: depthLabel(depth),
  };
}
