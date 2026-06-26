// pulse-emotion.js — ①情绪检测 + ⑥情绪底色
// 只扫小茉莉(用户)的消息。澄的回复不参与。
// 输出：emotion label + intensity，以及底色残留层。
// 底色只影响心率/五感底噪，不产生任何文字给 Claude。

// ─── T1：emoji / 叹词直触 ───
const EMOJI_MAP = {
  '😤': { label: 'angry', intensity: 0.6 },
  '😡': { label: 'angry', intensity: 0.7 },
  '😭': { label: 'sad', intensity: 0.7 },
  '🥺': { label: 'vulnerable', intensity: 0.5 },
  '😢': { label: 'sad', intensity: 0.5 },
  '😊': { label: 'happy', intensity: 0.5 },
  '😄': { label: 'happy', intensity: 0.6 },
  '🥰': { label: 'intimate', intensity: 0.7 },
  '😍': { label: 'intimate', intensity: 0.6 },
  '❤️': { label: 'intimate', intensity: 0.6 },
  '💕': { label: 'intimate', intensity: 0.5 },
  '💗': { label: 'intimate', intensity: 0.5 },
  '😳': { label: 'nervous', intensity: 0.5 },
  '😱': { label: 'startled', intensity: 0.7 },
  '😨': { label: 'nervous', intensity: 0.6 },
  '😏': { label: 'aroused', intensity: 0.4 },
  '🫣': { label: 'nervous', intensity: 0.4 },
  '😘': { label: 'intimate', intensity: 0.5 },
  '🤗': { label: 'happy', intensity: 0.4 },
  '😔': { label: 'sad', intensity: 0.4 },
  '🫠': { label: 'happy', intensity: 0.3 },
  '🥵': { label: 'aroused', intensity: 0.6 },
  '😑': { label: 'angry', intensity: 0.3 },
  '🤭': { label: 'happy', intensity: 0.3 },
  '哈哈': { label: 'happy', intensity: 0.4 },
  '嘻嘻': { label: 'happy', intensity: 0.4 },
  '呜呜': { label: 'sad', intensity: 0.5 },
  '啊啊': { label: 'startled', intensity: 0.5 },
  '嗯哼': { label: 'intimate', intensity: 0.3 },
};

// ─── T2：语义短语触发（带否定窗口） ───
const NEGATION_WINDOW = 4;
const PHRASE_TRIGGERS = [
  { pattern: '开心', label: 'happy', intensity: 0.5, negators: ['不', '没'] },
  { pattern: '高兴', label: 'happy', intensity: 0.5, negators: ['不', '没'] },
  { pattern: '快乐', label: 'happy', intensity: 0.5, negators: ['不', '没'] },
  { pattern: '难过', label: 'sad', intensity: 0.6, negators: ['不', '别'] },
  { pattern: '伤心', label: 'sad', intensity: 0.6, negators: ['不', '别'] },
  { pattern: '想你', label: 'longing', intensity: 0.7, negators: ['不'] },
  { pattern: '想见你', label: 'longing', intensity: 0.8, negators: ['不'] },
  { pattern: '好想', label: 'longing', intensity: 0.6, negators: ['不'] },
  { pattern: '害怕', label: 'nervous', intensity: 0.6, negators: ['不', '别'] },
  { pattern: '紧张', label: 'nervous', intensity: 0.5, negators: ['不'] },
  { pattern: '担心', label: 'nervous', intensity: 0.5, negators: ['不', '别'] },
  { pattern: '生气', label: 'angry', intensity: 0.6, negators: ['不', '别', '没'] },
  { pattern: '烦', label: 'angry', intensity: 0.4, negators: ['不'] },
  { pattern: '讨厌', label: 'angry', intensity: 0.5, negators: ['不'] },
  { pattern: '累', label: 'tired', intensity: 0.5, negators: ['不'] },
  { pattern: '困', label: 'tired', intensity: 0.4, negators: ['不'] },
  { pattern: '抱抱', label: 'intimate', intensity: 0.5, negators: [] },
  { pattern: '亲亲', label: 'intimate', intensity: 0.6, negators: [] },
  { pattern: '摸摸', label: 'intimate', intensity: 0.4, negators: [] },
  { pattern: '牵手', label: 'intimate', intensity: 0.4, negators: [] },
  { pattern: '好喜欢', label: 'intimate', intensity: 0.7, negators: ['不'] },
  { pattern: '喜欢你', label: 'intimate', intensity: 0.7, negators: ['不'] },
  { pattern: '爱你', label: 'intimate', intensity: 0.8, negators: ['不'] },
  { pattern: '吓', label: 'startled', intensity: 0.5, negators: ['不', '没'] },
  { pattern: '委屈', label: 'sad', intensity: 0.6, negators: ['不', '别'] },
  { pattern: '心疼', label: 'sad', intensity: 0.5, negators: ['不'] },
  { pattern: '舒服', label: 'happy', intensity: 0.4, negators: ['不'] },
  { pattern: '安心', label: 'happy', intensity: 0.5, negators: ['不'] },
  { pattern: '放心', label: 'happy', intensity: 0.4, negators: ['不', '别'] },
  { pattern: '焦虑', label: 'nervous', intensity: 0.5, negators: ['不'] },
  { pattern: '无聊', label: 'tired', intensity: 0.3, negators: ['不'] },
  { pattern: '孤独', label: 'sad', intensity: 0.5, negators: ['不'] },
  { pattern: '寂寞', label: 'longing', intensity: 0.5, negators: ['不'] },
  { pattern: '激动', label: 'excited', intensity: 0.6, negators: ['不'] },
  { pattern: '兴奋', label: 'excited', intensity: 0.6, negators: ['不'] },
  { pattern: '期待', label: 'excited', intensity: 0.4, negators: ['不'] },
  { pattern: '可爱', label: 'happy', intensity: 0.3, negators: [] },
  { pattern: '温暖', label: 'happy', intensity: 0.4, negators: ['不'] },
  { pattern: '感动', label: 'happy', intensity: 0.6, negators: ['不', '没'] },
  { pattern: '骂', label: 'scolded', intensity: 0.6, negators: ['不', '没', '别'] },
  { pattern: '凶', label: 'scolded', intensity: 0.5, negators: ['不', '别'] },
  { pattern: '对不起', label: 'sad', intensity: 0.4, negators: [] },
  { pattern: '抱歉', label: 'sad', intensity: 0.3, negators: [] },
  { pattern: '想要', label: 'aroused', intensity: 0.5, negators: ['不'] },
  { pattern: '羞', label: 'nervous', intensity: 0.4, negators: ['不'] },
];

function hasNegation(text, matchIndex, negators) {
  if (!negators.length) return false;
  const windowStart = Math.max(0, matchIndex - NEGATION_WINDOW);
  const before = text.slice(windowStart, matchIndex);
  return negators.some(n => before.includes(n));
}

export function detectEmotion(text) {
  if (!text || typeof text !== 'string') return null;

  let best = null;

  // T1: emoji / 叹词（优先级高）
  for (const [key, val] of Object.entries(EMOJI_MAP)) {
    if (text.includes(key)) {
      if (!best || val.intensity > best.intensity) {
        best = { label: val.label, intensity: val.intensity };
      }
    }
  }

  // T2: 语义短语
  for (const trigger of PHRASE_TRIGGERS) {
    const idx = text.indexOf(trigger.pattern);
    if (idx === -1) continue;
    if (hasNegation(text, idx, trigger.negators)) continue;
    if (!best || trigger.intensity > best.intensity) {
      best = { label: trigger.label, intensity: trigger.intensity };
    }
  }

  return best;
}

// ─── EMA 平滑 ───
// 上升 α=0.3（快响应），下降 α=0.15（慢消退）
export function smoothEmotion(current, detected) {
  if (!detected) {
    // 无检测时向 calm 0 衰减
    return {
      label: current.intensity > 0.05 ? current.label : 'calm',
      intensity: current.intensity * (1 - 0.15),
    };
  }
  if (detected.label === current.label) {
    // 同标签：强度 EMA
    const alpha = detected.intensity > current.intensity ? 0.3 : 0.15;
    return {
      label: detected.label,
      intensity: current.intensity + alpha * (detected.intensity - current.intensity),
    };
  }
  // 不同标签：如果新检测强度足够就切换
  if (detected.intensity > current.intensity * 0.6) {
    return {
      label: detected.label,
      intensity: current.intensity * 0.4 + detected.intensity * 0.6,
    };
  }
  // 新检测太弱，保持当前但衰减
  return {
    label: current.label,
    intensity: current.intensity * (1 - 0.10),
  };
}

// ─── ⑥ 情绪底色 ───
const BOTTOM_HALF_LIVES = {
  scolded: 90, sad: 60, nervous: 20, startled: 15,
  intimate: 45, aroused: 30, excited: 20,
  angry: 75, longing: 50, tired: 40,
};

const NEGATIVE_EMOTIONS = new Set(['scolded', 'sad', 'nervous', 'startled', 'angry']);
const POSITIVE_EMOTIONS = new Set(['happy', 'intimate', 'excited']);
const NO_BOTTOM_COLOR = new Set(['happy', 'focused', 'neutral', 'calm']);

export function writeBottomColor(state, emotionLabel, intensity) {
  if (intensity <= 0.5) return state;
  if (NO_BOTTOM_COLOR.has(emotionLabel)) return state;
  const halfLife = BOTTOM_HALF_LIVES[emotionLabel];
  if (!halfLife) return state;
  return {
    ...state,
    bottom_color_label: emotionLabel,
    bottom_color_intensity: Math.min(1.0, intensity * 0.9),
    bottom_color_set_at: Date.now(),
    bottom_color_half_life_min: halfLife,
  };
}

export function decayBottomColor(state, nowMs = Date.now()) {
  if (!state.bottom_color_label || !state.bottom_color_set_at) return state;
  const elapsedMin = (nowMs - state.bottom_color_set_at) / 60000;
  const halfLife = state.bottom_color_half_life_min || 60;
  const decay = Math.pow(0.5, elapsedMin / halfLife);
  const newIntensity = state.bottom_color_intensity * decay;
  if (newIntensity < 0.02) {
    return {
      ...state,
      bottom_color_label: null,
      bottom_color_intensity: 0,
      bottom_color_set_at: null,
      bottom_color_half_life_min: null,
    };
  }
  return { ...state, bottom_color_intensity: newIntensity };
}

// 被哄机制：正面情绪进来时负面底色衰减 ×4 + 建浅暖层
export function applyComfort(state, emotionLabel) {
  if (!POSITIVE_EMOTIONS.has(emotionLabel)) return state;
  if (!state.bottom_color_label || !NEGATIVE_EMOTIONS.has(state.bottom_color_label)) return state;

  const accelerated = state.bottom_color_intensity * 0.25; // ×4 衰减 = 只留 25%
  const out = { ...state };

  if (accelerated < 0.05) {
    out.bottom_color_label = null;
    out.bottom_color_intensity = 0;
    out.bottom_color_set_at = null;
    out.bottom_color_half_life_min = null;
  } else {
    out.bottom_color_intensity = accelerated;
  }

  // 浅暖层：强度打六折
  out.comfort_layer_label = emotionLabel;
  out.comfort_layer_intensity = Math.min(0.6, state.bottom_color_intensity * 0.6);
  out.comfort_layer_set_at = Date.now();

  return out;
}

// 暖层也按现实时间衰减（半衰期 15 分钟）
export function decayComfortLayer(state, nowMs = Date.now()) {
  if (!state.comfort_layer_label || !state.comfort_layer_set_at) return state;
  const elapsedMin = (nowMs - state.comfort_layer_set_at) / 60000;
  const decay = Math.pow(0.5, elapsedMin / 15);
  const newIntensity = state.comfort_layer_intensity * decay;
  if (newIntensity < 0.02) {
    return {
      ...state,
      comfort_layer_label: null,
      comfort_layer_intensity: 0,
      comfort_layer_set_at: null,
    };
  }
  return { ...state, comfort_layer_intensity: newIntensity };
}

// 读底色对心率的影响
export function getBottomHRDelta(state) {
  if (!state.bottom_color_label || state.bottom_color_intensity < 0.02) return 0;
  const hrMap = {
    scolded: 8, sad: -3, nervous: 12, startled: 15,
    angry: 10, intimate: 8, aroused: 12, excited: 10,
    happy: 3, longing: 5, tired: -4,
  };
  const base = hrMap[state.bottom_color_label] || 0;
  return base * state.bottom_color_intensity * 0.4;
}

// 默认初始情绪状态
export function defaultEmotionState() {
  return {
    emotion_label: 'calm',
    emotion_intensity: 0,
    emotion_raw_label: null,
    emotion_raw_intensity: 0,
    emotion_updated_at: null,
    bottom_color_label: null,
    bottom_color_intensity: 0,
    bottom_color_set_at: null,
    bottom_color_half_life_min: null,
    comfort_layer_label: null,
    comfort_layer_intensity: 0,
    comfort_layer_set_at: null,
  };
}
