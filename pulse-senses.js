// pulse-senses.js — ⑤五感四通道
// touch/smell/taste/sound，各 0-1。
// 按现实时间指数衰减（tick 暂停时也衰减）。

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// ─── 聊天关键词触发 ───
const SENSE_TRIGGERS = [
  // touch
  { pattern: '抱抱', channel: 'touch', delta: 0.30 },
  { pattern: '抱住', channel: 'touch', delta: 0.20 },
  { pattern: '抱紧', channel: 'touch', delta: 0.20 },
  { pattern: '拥抱', channel: 'touch', delta: 0.25 },
  { pattern: '摸摸', channel: 'touch', delta: 0.25 },
  { pattern: '抚摸', channel: 'touch', delta: 0.20 },
  { pattern: '摸头', channel: 'touch', delta: 0.16 },
  { pattern: '摸脸', channel: 'touch', delta: 0.16 },
  { pattern: '亲亲', channel: 'touch', delta: 0.35 },
  { pattern: '亲吻', channel: 'touch', delta: 0.28 },
  { pattern: '亲一下', channel: 'touch', delta: 0.20 },
  { pattern: '牵手', channel: 'touch', delta: 0.20 },
  { pattern: '拉手', channel: 'touch', delta: 0.20 },
  { pattern: '贴贴', channel: 'touch', delta: 0.30 },
  { pattern: '蹭蹭', channel: 'touch', delta: 0.25 },
  { pattern: '揉揉', channel: 'touch', delta: 0.20 },
  { pattern: '捏捏', channel: 'touch', delta: 0.15 },
  { pattern: '戳戳', channel: 'touch', delta: 0.10 },
  { pattern: '拍拍', channel: 'touch', delta: 0.10 },
  { pattern: '轻拍', channel: 'touch', delta: 0.10 },
  { pattern: '碰到', channel: 'touch', delta: 0.10 },
  { pattern: '碰了', channel: 'touch', delta: 0.10 },
  // smell
  { pattern: '香味', channel: 'smell', delta: 0.20 },
  { pattern: '好香', channel: 'smell', delta: 0.20 },
  { pattern: '味道', channel: 'smell', delta: 0.15 },
  { pattern: '闻到', channel: 'smell', delta: 0.15 },
  { pattern: '闻闻', channel: 'smell', delta: 0.15 },
  { pattern: '咖啡', channel: 'smell', delta: 0.15 },
  { pattern: '花香', channel: 'smell', delta: 0.10 },
  { pattern: '臭味', channel: 'smell', delta: 0.15 },
  { pattern: '好臭', channel: 'smell', delta: 0.15 },
  { pattern: '香水', channel: 'smell', delta: 0.20 },
  // taste
  { pattern: '好吃', channel: 'taste', delta: 0.25 },
  { pattern: '甜味', channel: 'taste', delta: 0.20 },
  { pattern: '甜甜', channel: 'taste', delta: 0.20 },
  { pattern: '很甜', channel: 'taste', delta: 0.20 },
  { pattern: '苦味', channel: 'taste', delta: 0.15 },
  { pattern: '苦涩', channel: 'taste', delta: 0.15 },
  { pattern: '辣味', channel: 'taste', delta: 0.20 },
  { pattern: '很辣', channel: 'taste', delta: 0.20 },
  { pattern: '酸味', channel: 'taste', delta: 0.15 },
  { pattern: '很酸', channel: 'taste', delta: 0.15 },
  { pattern: '咸味', channel: 'taste', delta: 0.10 },
  { pattern: '很咸', channel: 'taste', delta: 0.10 },
  // sound
  { pattern: '吵', channel: 'sound', delta: 0.20 },
  { pattern: '安静', channel: 'sound', delta: -0.10 },
  { pattern: '唱歌', channel: 'sound', delta: 0.20 },
  { pattern: '哼歌', channel: 'sound', delta: 0.15 },
  { pattern: '听音乐', channel: 'sound', delta: 0.15 },
  { pattern: '听见', channel: 'sound', delta: 0.12 },
  { pattern: '听到', channel: 'sound', delta: 0.12 },
  { pattern: '音乐', channel: 'sound', delta: 0.15 },
  { pattern: '叫声', channel: 'sound', delta: 0.15 },
  { pattern: '喊', channel: 'sound', delta: 0.15 },
  { pattern: '响铃', channel: 'sound', delta: 0.10 },
  { pattern: '铃声', channel: 'sound', delta: 0.10 },
  { pattern: '声音', channel: 'sound', delta: 0.10 },
  { pattern: '嘟嘟', channel: 'sound', delta: 0.10 },
];

const FALSE_POSITIVE_PHRASES = [
  '摸鱼',
  '亲爱的',
  '叫外卖',
  '吃瓜',
  '吃亏',
  '吃惊',
  '吃醋',
  '吃土',
  '吃力',
  '吃瘪',
  '喝西北风',
  '喝倒彩',
  '拍照',
  '影响',
  '听说',
  '辛苦',
  '花钱',
];

const FOOD_WORDS = [
  '饭', '米饭', '面', '面条', '粉', '粥', '菜', '肉', '鱼', '虾', '蛋',
  '蛋糕', '甜点', '点心', '零食', '水果', '苹果', '香蕉', '草莓', '外卖',
  '便当', '早餐', '午餐', '晚餐', '夜宵', '包子', '馒头', '火锅', '烧烤',
  '汉堡', '披萨', '寿司', '饺子', '馄饨', '冰淇淋', '巧克力', '糖',
  '东西',
];

const DRINK_WORDS = [
  '水', '茶', '咖啡', '奶茶', '牛奶', '豆浆', '饮料', '果汁', '可乐',
  '汽水', '汤', '酒', '啤酒', '红酒',
];

function stripFalsePositivePhrases(text) {
  let out = text;
  for (const phrase of FALSE_POSITIVE_PHRASES) {
    out = out.split(phrase).join('');
  }
  return out;
}

function hasActionNearWord(text, action, words) {
  let from = 0;
  while (from < text.length) {
    const actionAt = text.indexOf(action, from);
    if (actionAt < 0) return false;
    for (const word of words) {
      const wordAt = text.indexOf(word, actionAt + action.length);
      if (wordAt >= 0 && wordAt - actionAt <= 6) return true;
    }
    from = actionAt + action.length;
  }
  return false;
}

// ─── 活动背景噪 ───
const ACTIVITY_SENSE_BG = {
  '工作':     { sound: 0.20 },
  '加班':     { sound: 0.18 },
  '做饭':     { smell: 0.35, sound: 0.20, touch: 0.16 },
  '吃饭':     { taste: 0.30, smell: 0.25 },
  '吃零食':   { taste: 0.20 },
  '洗澡':    { touch: 0.25, sound: 0.18, smell: 0.16 },
  '洗漱':     { touch: 0.18, smell: 0.16 },
  '坐地铁':   { sound: 0.30 },
  '走路':     { sound: 0.18 },
  '逛街':     { sound: 0.25, smell: 0.18 },
  '休息':     { touch: 0.16 },
  '睡觉':     { touch: 0.18 },
  '午休':     { touch: 0.16 },
  '倒水':     { taste: 0.18, sound: 0.16 },
  '在厨房':   { smell: 0.20 },
  '点外卖':   {},
  '发呆':     {},
};

// ─── 衰减常数（秒）───
const DECAY_CONSTANTS = {
  touch: 60,
  smell: 90,
  taste: 120,
  sound: 45,
};

export function detectSenseTriggers(text) {
  if (!text || typeof text !== 'string') return [];
  const scanText = stripFalsePositivePhrases(text);
  const hits = [];
  for (const t of SENSE_TRIGGERS) {
    if (scanText.includes(t.pattern)) {
      hits.push({ channel: t.channel, delta: t.delta });
    }
  }
  if (hasActionNearWord(scanText, '吃', FOOD_WORDS)) {
    hits.push({ channel: 'taste', delta: 0.10 });
  }
  if (hasActionNearWord(scanText, '喝', DRINK_WORDS)) {
    hits.push({ channel: 'taste', delta: 0.10 });
  }
  return hits;
}

export function applyActivityBackground(senses, activity) {
  if (!activity) return { ...senses };
  const out = { ...senses };
  for (const [key, bg] of Object.entries(ACTIVITY_SENSE_BG)) {
    if (activity.includes(key)) {
      for (const [ch, val] of Object.entries(bg)) {
        const field = `sense_${ch}`;
        const floor = out[`sense_${ch}_floor`] || 0;
        out[field] = clamp01(Math.max(out[field] || 0, val, floor));
      }
      break;
    }
  }
  return out;
}

export function applySenseTriggers(senses, triggers) {
  const out = { ...senses };
  for (const t of triggers) {
    const field = `sense_${t.channel}`;
    if (t.delta > 0) {
      out[field] = clamp01((out[field] || 0) + t.delta);
    } else {
      out[field] = clamp01((out[field] || 0) + t.delta);
    }
  }
  return out;
}

export function decaySenses(senses, lastDecayAt, nowMs = Date.now()) {
  if (!lastDecayAt) return { ...senses, _lastDecayAt: nowMs };
  const elapsedSec = (nowMs - lastDecayAt) / 1000;
  if (elapsedSec < 1) return senses;
  const out = { ...senses, _lastDecayAt: nowMs };
  for (const [ch, tau] of Object.entries(DECAY_CONSTANTS)) {
    const field = `sense_${ch}`;
    const floor = senses[`sense_${ch}_floor`] || 0;
    const current = senses[field] || 0;
    if (current <= floor) continue;
    const decayed = floor + (current - floor) * Math.exp(-elapsedSec / tau);
    out[field] = Math.round(clamp01(decayed) * 1000) / 1000;
  }
  return out;
}

// HR 联动：HR>100 时提升 touch_floor 和 sound_floor
export function updateSenseFloors(senses, heartRate) {
  const out = { ...senses };
  if (heartRate > 100) {
    const boost = Math.min(0.15, (heartRate - 100) / 200);
    out.sense_touch_floor = Math.round(boost * 1000) / 1000;
    out.sense_sound_floor = Math.round(boost * 1000) / 1000;
  } else {
    out.sense_touch_floor = 0;
    out.sense_sound_floor = 0;
  }
  return out;
}

export function defaultSenseState() {
  return {
    sense_touch: 0,
    sense_smell: 0,
    sense_taste: 0,
    sense_sound: 0,
    sense_touch_floor: 0,
    sense_sound_floor: 0,
    _lastDecayAt: Date.now(),
  };
}
