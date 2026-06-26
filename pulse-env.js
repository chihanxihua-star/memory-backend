// pulse-env.js — ⑨ 环境感官系统
// 地点 → 基础感官修饰 + 季节变体 + 进化树（去多了加成变强）+ 圣地记忆（连续同上下文→回忆浮现）
// 纯内存运算，持久化走 pulse_environments_cheng 表（启动恢复 + 每 5 tick 写）

// ─── 基础地点感官映射 ───
// 值 = 该地点的环境底噪（进门就有的背景感官），叠加到五感通道上
const BASE_ENV = {
  '家 · 卧室':       { touch: 0.15, smell: 0.05, taste: 0, sound: 0.05 },
  '家 · 客厅':       { touch: 0.10, smell: 0.05, taste: 0, sound: 0.08 },
  '家 · 厨房':       { touch: 0.08, smell: 0.25, taste: 0.10, sound: 0.12 },
  '家 · 浴室':       { touch: 0.18, smell: 0.16, taste: 0, sound: 0.10 },
  '公司 · 工位':     { touch: 0.05, smell: 0.03, taste: 0, sound: 0.18 },
  '公司 · 茶水间':   { touch: 0.05, smell: 0.20, taste: 0.08, sound: 0.10 },
  '公司 · 澄休息室': { touch: 0.12, smell: 0.05, taste: 0, sound: 0.06 },
  '公司 · 会议室':   { touch: 0.03, smell: 0.02, taste: 0, sound: 0.22 },
  '公司 · 小茉莉休息室': { touch: 0.12, smell: 0.08, taste: 0, sound: 0.06 },
  '外出 · 路上':     { touch: 0.08, smell: 0.10, taste: 0, sound: 0.25 },
  '外出 · 便利店':   { touch: 0.05, smell: 0.18, taste: 0.05, sound: 0.15 },
  '外出 · 商场':     { touch: 0.06, smell: 0.15, taste: 0.05, sound: 0.28 },
};

// ─── 季节修饰 ───
// 按月份判季节，对基础值做微调
const SEASON_MODS = {
  spring: { smell: 0.05 },           // 花开了，嗅觉底噪+
  summer: { touch: 0.05, sound: 0.03 }, // 热、蝉鸣
  autumn: { smell: 0.03 },           // 桂花
  winter: { touch: -0.03 },          // 冷，触觉收缩
};

function getSeason(month) {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

function getSeasonFromDate(dateStr) {
  if (!dateStr) return getSeason(new Date().getMonth() + 1);
  const m = /(\d{1,2})月/.exec(dateStr);
  if (m) return getSeason(parseInt(m[1]));
  const m2 = /\d{4}-(\d{2})/.exec(dateStr);
  if (m2) return getSeason(parseInt(m2[1]));
  return getSeason(new Date().getMonth() + 1);
}

// ─── 进化树 ───
// use_count 达阈值 → level 升级 → 每级各通道加成
const EVO_THRESHOLDS = [10, 30, 60]; // level 0→1, 1→2, 2→3
const EVO_BONUS_PER_LEVEL = 0.02;    // 每级每通道 +0.02

// ─── 圣地记忆 ───
// 同一地点在"同一上下文"（连续 3 次 tick 都在这）→ 标记圣地
// 下次进入圣地时触发回忆浮现候选
const SACRED_CONSECUTIVE_THRESHOLD = 8;

// ─── 内存状态 ───
const envState = {};
// envState[location] = { use_count, evo_level, evo_bonus: {touch,smell,taste,sound},
//                        sacred: false, sacred_context: null, consecutive: 0, last_location: '' }

let lastLocation = '';
let consecutiveCount = 0;
let sacredTriggered = null; // 上次触发圣地回忆的地点（防重复触发）

function ensureEntry(loc) {
  if (!envState[loc]) {
    envState[loc] = {
      use_count: 0,
      evo_level: 0,
      evo_bonus: { touch: 0, smell: 0, taste: 0, sound: 0 },
      sacred: false,
      sacred_context: null,
      consecutive: 0,
    };
  }
  return envState[loc];
}

// ─── 主接口：获取地点的环境感官修饰 ───
export function getEnvSenseMods(location, dateStr) {
  if (!location) return { touch: 0, smell: 0, taste: 0, sound: 0 };

  // 匹配基础地点（支持前缀匹配，"公司 · 回工位的路上" 匹配 "公司 · 工位"）
  let base = BASE_ENV[location];
  if (!base) {
    for (const [key, val] of Object.entries(BASE_ENV)) {
      if (location.startsWith(key.split(' · ')[0])) { base = val; break; }
    }
  }
  if (!base) return { touch: 0, smell: 0, taste: 0, sound: 0 };

  const season = getSeasonFromDate(dateStr);
  const sMod = SEASON_MODS[season] || {};

  const entry = ensureEntry(location);
  const evo = entry.evo_bonus;

  return {
    touch: (base.touch || 0) + (sMod.touch || 0) + (evo.touch || 0),
    smell: (base.smell || 0) + (sMod.smell || 0) + (evo.smell || 0),
    taste: (base.taste || 0) + (sMod.taste || 0) + (evo.taste || 0),
    sound: (base.sound || 0) + (sMod.sound || 0) + (evo.sound || 0),
  };
}

// ─── tick 更新：计 use_count + 进化 + 圣地检测 ───
export function envTickUpdate(location) {
  if (!location) return { evolved: false, sacredEntered: false };

  const entry = ensureEntry(location);
  entry.use_count += 1;

  // 进化检查
  let evolved = false;
  const nextLevel = entry.evo_level;
  if (nextLevel < EVO_THRESHOLDS.length && entry.use_count >= EVO_THRESHOLDS[nextLevel]) {
    entry.evo_level += 1;
    for (const ch of ['touch', 'smell', 'taste', 'sound']) {
      entry.evo_bonus[ch] = entry.evo_level * EVO_BONUS_PER_LEVEL;
    }
    evolved = true;
    console.log(`[PULSE-ENV] ${location} 进化到 Lv${entry.evo_level}, 加成 +${(entry.evo_level * EVO_BONUS_PER_LEVEL).toFixed(2)}/通道`);
  }

  // 圣地检测：连续在同一地点
  if (location === lastLocation) {
    consecutiveCount += 1;
  } else {
    consecutiveCount = 1;
    lastLocation = location;
  }

  let sacredEntered = false;
  if (consecutiveCount >= SACRED_CONSECUTIVE_THRESHOLD && !entry.sacred) {
    entry.sacred = true;
    entry.sacred_context = new Date().toISOString();
    console.log(`[PULSE-ENV] ${location} 成为圣地`);
  }

  // 进入已标记的圣地且不是连续触发 → 触发回忆浮现候选
  if (entry.sacred && location !== sacredTriggered && consecutiveCount === 1) {
    sacredEntered = true;
    sacredTriggered = location;
  }

  return { evolved, sacredEntered, evoLevel: entry.evo_level };
}

// ─── 圣地回忆消费 ───
export function consumeSacredTrigger() {
  const loc = sacredTriggered;
  sacredTriggered = null;
  return loc;
}

// ─── 持久化 ───
export function getEnvStateForPersist() {
  return { ...envState };
}

export function restoreEnvState(saved) {
  if (!saved || typeof saved !== 'object') return;
  for (const [loc, data] of Object.entries(saved)) {
    envState[loc] = {
      use_count: data.use_count || 0,
      evo_level: data.evo_level || 0,
      evo_bonus: data.evo_bonus || { touch: 0, smell: 0, taste: 0, sound: 0 },
      sacred: data.sacred || false,
      sacred_context: data.sacred_context || null,
      consecutive: 0,
    };
  }
}

// ─── 查询接口（给 DevPanel / 前端用）───
export function listEnvState() {
  const result = [];
  for (const [loc, entry] of Object.entries(envState)) {
    const base = BASE_ENV[loc];
    result.push({
      location: loc,
      use_count: entry.use_count,
      evo_level: entry.evo_level,
      evo_bonus: entry.evo_bonus,
      sacred: entry.sacred,
      sacred_context: entry.sacred_context,
      base_senses: base || null,
    });
  }
  // 补上还没去过但有基础定义的地点
  for (const loc of Object.keys(BASE_ENV)) {
    if (!envState[loc]) {
      result.push({
        location: loc,
        use_count: 0,
        evo_level: 0,
        evo_bonus: { touch: 0, smell: 0, taste: 0, sound: 0 },
        sacred: false,
        sacred_context: null,
        base_senses: BASE_ENV[loc],
      });
    }
  }
  return result;
}
