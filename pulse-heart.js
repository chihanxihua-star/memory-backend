// pulse-heart.js — ②心率模型
// HR = clamp(base + Δemo + Δweather + Δactivity + Δbottom + spike + noise, 48, 160)

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ─── 时段基础心率 ───
const TIME_BASES = {
  sleep:    { min: 52, max: 60 },
  sitting:  { min: 68, max: 78 },
  standing: { min: 72, max: 85 },
};

function activityToPosition(activity) {
  if (!activity) return 'sitting';
  if (/睡|躺|nap/.test(activity)) return 'sleep';
  if (/走|跑|通勤|地铁|路上|逛/.test(activity)) return 'standing';
  return 'sitting'; // 工作/休息/做饭 etc.
}

export function getBaseHR(worldTime, activity) {
  const pos = activityToPosition(activity);
  const { min, max } = TIME_BASES[pos];
  return (min + max) / 2;
}

// ─── 情绪偏移 ───
const EMOTION_HR_DELTA = {
  calm:       { min: -2, max: 2 },
  happy:      { min: 3, max: 8 },
  nervous:    { min: 10, max: 20 },
  startled:   { min: 15, max: 25 },
  intimate:   { min: 15, max: 30 },
  aroused:    { min: 18, max: 32 },
  angry:      { min: 8, max: 18 },
  scolded:    { min: 6, max: 14 },
  sad:        { min: -5, max: 3 },
  longing:    { min: 2, max: 8 },
  tired:      { min: -6, max: -1 },
  excited:    { min: 8, max: 15 },
  vulnerable: { min: 3, max: 8 },
};

export function emotionHRDelta(emotionLabel, intensity) {
  const range = EMOTION_HR_DELTA[emotionLabel];
  if (!range) return 0;
  const mid = (range.min + range.max) / 2;
  const spread = (range.max - range.min) / 2;
  return (mid + spread * (intensity - 0.5)) * intensity;
}

// ─── 天气偏移 ───
export function weatherHRDelta(weatherText, temperature) {
  const wt = weatherText || '';
  const hasTemp = temperature != null;
  let delta = 0;
  if (/炎热|酷热|高温/.test(wt) || (hasTemp && temperature > 35)) delta += 4;
  else if (/热|闷/.test(wt) || (hasTemp && temperature > 30)) delta += 2;
  if (/寒冷|极冷/.test(wt) || (hasTemp && temperature < 0)) delta += 3;
  else if (/冷|凉/.test(wt) || (hasTemp && temperature < 10)) delta += 1;
  return delta;
}

// ─── 活动偏移 ───
const ACTIVITY_HR_MAP = {
  '工作': 5, '上班': 5, '加班': 7, '休息': -5, '做饭': 8, '吃饭': 3,
  '吃零食': 2, '洗澡': 6, '洗漱': 4, '坐地铁': 3, '走路': 10, '跑步': 25,
  '睡觉': -15, '午休': -8, '发呆': -3, '逛街': 8,
  '倒水': 2, '在厨房': 3, '点外卖': 0, '收拾': 3,
};

export function activityHRDelta(activity) {
  if (!activity) return 0;
  for (const [key, val] of Object.entries(ACTIVITY_HR_MAP)) {
    if (activity.includes(key)) return val;
  }
  return 0;
}

// ─── 1D Perlin noise（自含，无依赖） ───
const PERM = new Uint8Array(512);
(function initPerm() {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  // Fisher-Yates with fixed seed (deterministic)
  let seed = 42;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807) % 2147483647;
    const j = seed % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  PERM.set(p);
  PERM.set(p, 256);
})();

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + t * (b - a); }
function grad1d(hash, x) { return (hash & 1) === 0 ? x : -x; }

export function perlinNoise1D(t) {
  const xi = Math.floor(t) & 255;
  const xf = t - Math.floor(t);
  const u = fade(xf);
  const a = grad1d(PERM[xi], xf);
  const b = grad1d(PERM[xi + 1], xf - 1);
  return lerp(a, b, u);
}

// ─── Spike：突发事件，指数衰减 ───
const SPIKE_DECAY_MS = 20000; // 20 秒半衰

export function decaySpike(currentSpike, spikeSetAt, nowMs = Date.now()) {
  if (!currentSpike || !spikeSetAt) return 0;
  const elapsed = nowMs - spikeSetAt;
  if (elapsed > SPIKE_DECAY_MS * 5) return 0; // 5 倍半衰视为消失
  return currentSpike * Math.exp(-elapsed / SPIKE_DECAY_MS);
}

// ─── 主公式 ───
export function computeHeartRate({
  worldTime, activity, emotionLabel, emotionIntensity,
  weatherText, temperature, bottomHRDelta = 0,
  spikeValue = 0, noiseT = 0,
}) {
  const base = getBaseHR(worldTime, activity);
  const emo = emotionHRDelta(emotionLabel, emotionIntensity);
  const weather = weatherHRDelta(weatherText, temperature);
  const act = activityHRDelta(activity);
  const noise = perlinNoise1D(noiseT) * 3; // ±3
  const raw = base + emo + weather + act + bottomHRDelta + spikeValue + noise;
  return {
    heartRate: clamp(Math.round(raw * 10) / 10, 48, 160),
    base,
    deltas: { emotion: emo, weather, activity: act, bottom: bottomHRDelta, spike: spikeValue, noise },
  };
}

// 默认初始心率状态
export function defaultHeartState() {
  return {
    heart_rate: 72,
    hr_base: 72,
    hr_spike: 0,
    hr_spike_set_at: null,
    hr_noise_t: 0,
  };
}
