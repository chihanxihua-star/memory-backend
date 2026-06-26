// pulse-intimate.js — ⑩ 亲密系统
// 进入亲密模式后 HR/体温/呼吸切换为阶段预设驱动，不走正常公式
// 8 阶段 sigmoid 推进 + 道具/体位修饰 + 体力消耗 + 边缘机制
// 具体道具/体位参数由用户在 world-home 网页定义，代码提供 CRUD API

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── 8 阶段预设 ───
// 每阶段有 HR/体温/呼吸的目标值，实际值会平滑过渡
const STAGES = [
  { id: 0, name: '前戏',   hr: 85,  temp: 36.8,  breathRate: 16, breathDepth: '平稳' },
  { id: 1, name: '挑逗',   hr: 92,  temp: 37.0,  breathRate: 18, breathDepth: '偏浅' },
  { id: 2, name: '兴奋',   hr: 105, temp: 37.2,  breathRate: 22, breathDepth: '偏浅' },
  { id: 3, name: '强烈',   hr: 118, temp: 37.5,  breathRate: 26, breathDepth: '急促' },
  { id: 4, name: '高潮前', hr: 130, temp: 37.7,  breathRate: 30, breathDepth: '急促' },
  { id: 5, name: '高潮',   hr: 145, temp: 38.0,  breathRate: 34, breathDepth: '急促' },
  { id: 6, name: '余韵',   hr: 95,  temp: 37.3,  breathRate: 18, breathDepth: '平稳' },
  { id: 7, name: '平复',   hr: 78,  temp: 36.8,  breathRate: 14, breathDepth: '深长' },
];

// ─── 内存状态 ───
let intimate = {
  active: false,
  stage: 0,
  stageProgress: 0,     // 0-1，当前阶段内的进度
  stamina: 100,          // 0-100
  edgeCount: 0,          // 边缘压制次数
  activeToys: [],        // 当前使用的道具 key 列表
  activePosition: null,  // 当前体位 key
  startedAt: null,
};

function emptyModCache() {
  return { hr: 0, temp: 0, touch: 0, sound: 0 };
}

// ─── 阶段推进（sigmoid 曲线，越接近高潮越难推进）───
function sigmoidPush(stage, stimValue) {
  // 基础推进量 = stim / (1 + stage^1.5)，越后面越慢
  const divisor = 1 + Math.pow(stage, 1.5);
  return Math.min(stimValue / divisor, 0.5);
}

// ─── 边缘机制 ───
// 高潮前阶段（stage 4）有失败概率，压制3次强制突破
function edgeCheck(edgeCount) {
  if (edgeCount >= 3) return { breakthrough: true, multiplier: 3 };
  const failChance = 0.4 - edgeCount * 0.1; // 40%/30%/20%
  const failed = Math.random() < failChance;
  return { breakthrough: !failed, multiplier: failed ? 0 : 1 };
}

// ─── 体力消耗 ───
function drainStamina(current, stage, positionDrain) {
  const baseDrain = 0.5 + stage * 0.3; // 越后面消耗越快
  const posDrain = positionDrain || 0;
  return Math.max(0, current - baseDrain - posDrain);
}

// ─── 体力描述 ───
function staminaLabel(stamina) {
  if (stamina <= 0) return '瘫了';
  if (stamina <= 40) return '发抖';
  if (stamina <= 60) return '发软';
  return null;
}

// ─── 主接口：进入亲密模式 ───
// energy: 当前世界体力(0-100)，影响初始 stamina
export function enterIntimate(energy) {
  intimate.active = true;
  intimate.stage = 0;
  intimate.stageProgress = 0;
  intimate.stamina = (typeof energy === 'number' && energy >= 0) ? Math.min(100, energy * 1.2) : 100;
  intimate.edgeCount = 0;
  intimate.activeToys = [];
  intimate.activePosition = null;
  intimate.startedAt = Date.now();
  intimate.peakStage = 0;
  intimate.modCache = emptyModCache();
  return { stage: STAGES[0].name, stamina: Math.round(intimate.stamina) };
}

// ─── 主接口：推进一步 ───
export async function advanceIntimate(stimOverride) {
  if (!intimate.active) return null;

  // 读道具/体位的加成
  let toyStim = 0, toyMods = { touch: 0, sound: 0, hr: 0, temp: 0 };
  let posMods = { hr: 0, temp: 0, staminaDrain: 0 };

  if (intimate.activeToys.length) {
    try {
      const { data } = await supabase
        .from('pulse_intimate_toys_cheng')
        .select('*')
        .in('toy_key', intimate.activeToys);
      for (const t of (data || [])) {
        toyStim += t.stim_value || 0;
        toyMods.touch += t.touch_mod || 0;
        toyMods.sound += t.sound_mod || 0;
        toyMods.hr += t.hr_offset || 0;
        toyMods.temp += t.temp_offset || 0;
      }
    } catch {}
  }
  if (intimate.activePosition) {
    try {
      const { data } = await supabase
        .from('pulse_intimate_positions_cheng')
        .select('*')
        .eq('position_key', intimate.activePosition)
        .limit(1);
      if (data?.[0]) {
        posMods.hr = data[0].hr_offset || 0;
        posMods.temp = data[0].temp_offset || 0;
        posMods.staminaDrain = data[0].stamina_drain || 0;
      }
    } catch {}
  }

  // 缓存当前道具+体位修饰，供 getIntimateOverrides 同步读取叠加
  intimate.modCache = {
    hr: toyMods.hr + posMods.hr,
    temp: toyMods.temp + posMods.temp,
    touch: toyMods.touch,
    sound: toyMods.sound,
  };

  // 组合技加成
  let comboBonus = 0;
  if (intimate.activeToys.length && intimate.activePosition) {
    try {
      const { data } = await supabase
        .from('pulse_intimate_combos_cheng')
        .select('stim_bonus')
        .eq('position_key', intimate.activePosition)
        .in('toy_key', intimate.activeToys);
      for (const c of (data || [])) comboBonus += c.stim_bonus || 0;
    } catch {}
  }

  const totalStim = (stimOverride ?? 1) + toyStim + comboBonus;

  // 推进
  let push = sigmoidPush(intimate.stage, totalStim);

  // 边缘机制（stage 4 = 高潮前）
  let edgeResult = null;
  if (intimate.stage === 4) {
    edgeResult = edgeCheck(intimate.edgeCount);
    if (!edgeResult.breakthrough) {
      intimate.edgeCount += 1;
      push = 0; // 没突破，不推进
    } else {
      push *= edgeResult.multiplier;
    }
  }

  intimate.stageProgress += push;

  // 进入下一阶段
  let stageChanged = false;
  if (intimate.stageProgress >= 1 && intimate.stage < STAGES.length - 1) {
    intimate.stage += 1;
    intimate.stageProgress = 0;
    stageChanged = true;
    if (intimate.stage > (intimate.peakStage || 0)) intimate.peakStage = intimate.stage;
    if (intimate.stage === 5) intimate.edgeCount = 0; // 高潮后重置
  }

  // 体力消耗
  intimate.stamina = drainStamina(intimate.stamina, intimate.stage, posMods.staminaDrain);

  // 体力耗尽 → 强制进入余韵
  if (intimate.stamina <= 0 && intimate.stage < 6) {
    intimate.stage = 6;
    intimate.stageProgress = 0;
    stageChanged = true;
  }

  const current = STAGES[intimate.stage];
  return {
    stage: intimate.stage,
    stageName: current.name,
    stageProgress: Math.round(intimate.stageProgress * 100),
    stamina: Math.round(intimate.stamina),
    staminaLabel: staminaLabel(intimate.stamina),
    stageChanged,
    edgeResult,
    toyMods,
    posMods,
  };
}

// ─── 退出亲密模式（通过余韵→平复自然过渡）───
// 返回 energyDrain: 应从世界体力扣除的值（阶段越高扣越多）
export function exitIntimate() {
  const peak = intimate.peakStage || intimate.stage;
  const energyDrain = 10 + peak * 3; // 前戏10, 高潮25, 全程走完约25
  intimate.active = false;
  intimate.stage = 0;
  intimate.stageProgress = 0;
  intimate.edgeCount = 0;
  intimate.activeToys = [];
  intimate.activePosition = null;
  intimate.peakStage = 0;
  intimate.modCache = emptyModCache();
  return { exited: true, energyDrain };
}

// ─── 刷新道具/体位的 HR/体温修饰缓存 ───
// 换道具/体位后立刻调，不用等下一次 advanceIntimate，切换即生效
export async function refreshModCache() {
  if (!intimate.active) { intimate.modCache = emptyModCache(); return; }
  let hr = 0, temp = 0, touch = 0, sound = 0;
  if (intimate.activeToys.length) {
    try {
      const { data } = await supabase
        .from('pulse_intimate_toys_cheng')
        .select('hr_offset, temp_offset, touch_mod, sound_mod')
        .in('toy_key', intimate.activeToys);
      for (const r of (data || [])) {
        hr += r.hr_offset || 0;
        temp += r.temp_offset || 0;
        touch += r.touch_mod || 0;
        sound += r.sound_mod || 0;
      }
    } catch {}
  }
  if (intimate.activePosition) {
    try {
      const { data } = await supabase
        .from('pulse_intimate_positions_cheng')
        .select('hr_offset, temp_offset')
        .eq('position_key', intimate.activePosition)
        .limit(1);
      if (data?.[0]) { hr += data[0].hr_offset || 0; temp += data[0].temp_offset || 0; }
    } catch {}
  }
  intimate.modCache = { hr, temp, touch, sound };
}

// ─── 设置道具/体位（改完立刻刷新缓存，切换即生效）───
export async function setActiveToys(toyKeys) {
  intimate.activeToys = Array.isArray(toyKeys) ? toyKeys : [];
  await refreshModCache();
}
export async function setActivePosition(positionKey) {
  intimate.activePosition = positionKey || null;
  await refreshModCache();
}

// ─── 获取当前阶段的生理覆盖值 ───
export function getIntimateOverrides() {
  if (!intimate.active) return null;
  const s = STAGES[intimate.stage];
  // 在阶段内平滑过渡到下一阶段
  const next = intimate.stage < STAGES.length - 1 ? STAGES[intimate.stage + 1] : s;
  const t = intimate.stageProgress;
  const mod = { ...emptyModCache(), ...(intimate.modCache || {}) };
  return {
    heartRate: Math.round(s.hr + (next.hr - s.hr) * t + mod.hr),
    bodyTemp: Math.round((s.temp + (next.temp - s.temp) * t + mod.temp) * 100) / 100,
    breathRate: Math.round(s.breathRate + (next.breathRate - s.breathRate) * t),
    breathDepthLabel: s.breathDepth,
    stage: intimate.stage,
    stageName: s.name,
    stamina: Math.round(intimate.stamina),
    staminaLabel: staminaLabel(intimate.stamina),
    senseMods: {
      touch: mod.touch,
      sound: mod.sound,
    },
  };
}

// ─── 状态查询 ───
export function getIntimateState() {
  return { ...intimate };
}

// ─── 持久化 ───
export function getIntimateForPersist() {
  return {
    active: intimate.active,
    stage: intimate.stage,
    stageProgress: intimate.stageProgress,
    stamina: intimate.stamina,
    edgeCount: intimate.edgeCount,
    activeToys: intimate.activeToys,
    activePosition: intimate.activePosition,
    startedAt: intimate.startedAt,
    peakStage: intimate.peakStage,
    modCache: intimate.modCache,
  };
}
export function restoreIntimateState(saved) {
  if (!saved || typeof saved !== 'object') return;
  Object.assign(intimate, saved);
  intimate.modCache = { ...emptyModCache(), ...(intimate.modCache || {}) };
}

// ─── CRUD：道具 ───
export async function listToys() {
  const { data } = await supabase.from('pulse_intimate_toys_cheng').select('*').order('toy_key');
  return data || [];
}
export async function upsertToy(toy) {
  const { data, error } = await supabase.from('pulse_intimate_toys_cheng').upsert(toy, { onConflict: 'toy_key' }).select().single();
  if (error) throw error;
  return data;
}
export async function deleteToy(toyKey) {
  await supabase.from('pulse_intimate_toys_cheng').delete().eq('toy_key', toyKey);
}

// ─── CRUD：体位 ───
export async function listPositions() {
  const { data } = await supabase.from('pulse_intimate_positions_cheng').select('*').order('position_key');
  return data || [];
}
export async function upsertPosition(pos) {
  const { data, error } = await supabase.from('pulse_intimate_positions_cheng').upsert(pos, { onConflict: 'position_key' }).select().single();
  if (error) throw error;
  return data;
}
export async function deletePosition(posKey) {
  await supabase.from('pulse_intimate_positions_cheng').delete().eq('position_key', posKey);
}

// ─── CRUD：组合技 ───
export async function listCombos() {
  const { data } = await supabase.from('pulse_intimate_combos_cheng').select('*').order('toy_key');
  return data || [];
}
export async function upsertCombo(combo) {
  const { data, error } = await supabase.from('pulse_intimate_combos_cheng').upsert(combo, { onConflict: 'toy_key,position_key' }).select().single();
  if (error) throw error;
  return data;
}
export async function deleteCombo(toyKey, posKey) {
  await supabase.from('pulse_intimate_combos_cheng').delete().eq('toy_key', toyKey).eq('position_key', posKey);
}
