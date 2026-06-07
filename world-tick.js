// world-home 第 2 步：世界时钟 + 最小自然衰减。
// 让小世界"自己会动"——时间在走、4 项基础状态在变。
// 不接 AI、不加事件、不加地点、不做复杂联动。
import { supabase } from './memory.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'world-config.json');
const DEFAULT_CONFIG = { world_tick_enabled: false, fast_test: false };

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── 世界事件（第 4 步）─────────────────────────────────
// 先写死在代码里，以后再抽成配置。trigger 命中就把状态打包唤醒澄做选择。
// "状态只是权重，不直接操控 Claude"：这里只给选项+预设 effects，澄选哪个、后端结算。
export const WORLD_EVENTS = {
  hungry: {
    trigger: (status) => status.satiety < 30,
    reason: '饱腹过低（饿了）',
    // 第8步：选项按澄当前 location 生成，绑定 action_id（effects/移动由 ACTIONS 在 index.js 结算）。
    // 「先忍」走 pending（第5步逻辑不变）。「去厨房看看」只移动、不吃，且排一条3分钟短 pending 回来重判。
    optionsFor: (status) => {
      const loc = status.location || '';
      const wait10 = {
        id: 4, label: '先忍 10 分钟，等会儿再看', effects: {},
        pending: { wake_type: 'hungry', delay_world_minutes: 10, reason: '刚才选择先忍着，10分钟后再判断要不要吃东西' },
      };
      if (loc.startsWith('公司')) {
        return [
          { id: 1, label: '吃零食', action_id: 'eat_snack' },
          { id: 2, label: '点外卖', action_id: 'order_takeout' },
          { id: 3, label: '去茶水间找点吃的', action_id: 'go_tea_room' },
          wait10,
        ];
      }
      if (loc === '家 · 厨房') {
        return [
          { id: 1, label: '自己做饭', action_id: 'cook_simple_meal' },
          { id: 2, label: '吃零食', action_id: 'eat_snack' },
          { id: 3, label: '点外卖', action_id: 'order_takeout' },
          wait10,
        ];
      }
      // 在家但不在厨房（卧室/客厅/浴室等）：去厨房看看（只移动）→ 3分钟后回来重判（补充1）
      return [
        {
          id: 1, label: '去厨房看看', action_id: 'go_kitchen',
          pending: {
            wake_type: 'hungry', delay_world_minutes: 3,
            reason: '刚才饿了，先去了厨房，现在到厨房后重新判断要不要吃东西',
            payload_extra: { from_action: 'go_kitchen' },
          },
        },
        { id: 2, label: '吃零食', action_id: 'eat_snack' },
        { id: 3, label: '点外卖', action_id: 'order_takeout' },
        wait10,
      ];
    },
  },
};

// 遍历事件，返回第一个命中的（带 key），无则 null。trigger 抛错不崩。
export function detectWorldEvent(status) {
  for (const [key, ev] of Object.entries(WORLD_EVENTS)) {
    try { if (ev.trigger(status)) return { key, ...ev }; }
    catch (e) { console.error(`[WORLD] 事件 ${key} trigger 异常:`, e.message); }
  }
  return null;
}

// world_time 只处理 HH:mm 文本，前进 1 小时；23:30 → 00:30 循环，不管日期。
function advanceHour(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m) return t; // 格式不对就原样返回，不崩
  const h = (parseInt(m[1], 10) + 1) % 24;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

// ── 核心：推进一个 tick ─────────────────────────────────
// 读澄那一行 → 时间 +1h → 4 项衰减/增长（带上下限）→ updated_at → 写回。
export async function advanceOneTick() {
  const { data: rows, error } = await supabase
    .from('character_status_cheng')
    .select('*')
    .eq('name', '澄')
    .limit(1);
  if (error) throw error;
  const row = rows && rows[0];
  if (!row) throw new Error('character_status_cheng 没有澄那一行');

  const patch = {
    world_time: advanceHour(row.world_time),
    energy: clamp(row.energy - 2, 0, 100),      // 体力 下限 0
    satiety: clamp(row.satiety - 3, 0, 100),    // 饱腹 下限 0
    cleanliness: clamp(row.cleanliness - 1, 0, 100), // 清洁 下限 0
    longing: clamp(row.longing + 1, 0, 100),    // 想念 上限 100
    updated_at: new Date().toISOString(),
  };

  const { data: updated, error: e2 } = await supabase
    .from('character_status_cheng')
    .update(patch)
    .eq('id', row.id)
    .select()
    .single();
  if (e2) throw e2;

  // 第 3 步：每个 tick 往行程表留一条客观记录（source=tick，固定"自然衰减"）。
  // 写失败不影响 tick 主流程，只打日志。
  const { error: e3 } = await supabase
    .from('daily_timeline_cheng')
    .insert({
      world_time: updated.world_time,
      location: row.location,
      action: '自然衰减',
      detail: { energy: -2, satiety: -3, cleanliness: -1, longing: 1 },
      source: 'tick',
    });
  if (e3) console.error('[WORLD] 行程表写入失败:', e3.message);

  return updated;
}

// 紧急修正：把 character_status_cheng.world_time 同步到当前 UTC+8(Asia/Shanghai)的 HH:mm。
// 只动 world_time，不碰 location/activity/天气/date，不读城市名，不影响 weather-fetcher。
// 不 engage 澄、不触发事件、不发消息——纯数据校正。
export async function syncWorldTimeToRealTime() {
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const { data, error } = await supabase
    .from('character_status_cheng')
    .update({ world_time: hhmm, updated_at: new Date().toISOString() })
    .eq('name', '澄')
    .select('world_time, location, activity')
    .limit(1);
  if (error) throw error;
  return data?.[0] || { world_time: hhmm };
}

// ── 配置读写 ────────────────────────────────────────────
export function readWorldConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// 串行写锁：所有配置写入排队执行，避免并发写坏 world-config.json。
let _writeChain = Promise.resolve();
export function writeWorldConfig(patch) {
  const run = async () => {
    const next = { ...readWorldConfig(), ...patch };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf-8');
    return next;
  };
  const result = _writeChain.then(run, run); // 上一个失败也继续排队
  _writeChain = result.catch(() => {});       // 链不被 reject 卡死
  return result;
}

// ── Daemon（结构参考 dice.js 的 DiceDaemon）────────────
export class WorldTickDaemon {
  // onEvent(event, status)：tick 完成且检测到事件命中时回调（冷却/CC 空闲判定交给 index.js，
  // 这里不碰 CC 会话逻辑，避免 tick 和 activeTurn 缠死）。
  constructor(opts = {}) {
    this._timer = null;
    this._busy = false;
    this._onEvent = opts.onEvent || null;
    this._detectRandom = opts.detectRandom || null; // 10B：(status)=>随机事件|null（hungry 没命中才用）
    this._onMidnight = opts.onMidnight || null;       // 世界跨午夜回调（清 once_per_day）
    this._bumpTick = opts.bumpTick || null;            // 每 tick 自增随机事件计数（cooldown 用）
    this._lastHour = null;
  }

  // 读配置决定是否启动 + 用哪种速度。start 自带 stop，可反复调。
  start() {
    this.stop();
    const cfg = readWorldConfig();
    if (!cfg.world_tick_enabled) {
      console.log('[WORLD] 世界时钟关闭，不启动');
      return;
    }
    const intervalMs = cfg.fast_test ? 60_000 : 3_600_000; // fast_test=1分钟，normal=1小时
    console.log(`[WORLD] 世界时钟启动，每 ${intervalMs / 1000}s 一次 tick（fast_test=${!!cfg.fast_test}）`);
    this._timer = setInterval(() => this._tick(), intervalMs);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  // 配置变了即时生效：清旧 interval + 按新配置重新决定。
  reload() {
    console.log('[WORLD] reload 配置');
    this.start();
  }

  async _tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      const row = await advanceOneTick();
      console.log(`[WORLD] tick → ${row.world_time} | 体力${row.energy} 饱腹${row.satiety} 清洁${row.cleanliness} 想念${row.longing}`);
      // 跨午夜（新小时 < 旧小时，如 23→00）→ 清 once_per_day；每 tick 自增随机计数。
      const newHour = parseInt(String(row.world_time || '').split(':')[0], 10);
      if (this._lastHour != null && !Number.isNaN(newHour) && newHour < this._lastHour && this._onMidnight) this._onMidnight();
      if (!Number.isNaN(newHour)) this._lastHour = newHour;
      if (this._bumpTick) this._bumpTick();
      // 事件优先级：hungry 命中就只走 hungry；否则才轮普通随机事件。同一 tick 最多一个。
      if (this._onEvent) {
        const ev = detectWorldEvent(row);
        if (ev) {
          try { await this._onEvent(ev, row); }
          catch (e) { console.error('[WORLD] onEvent 异常:', e.message); }
        } else if (this._detectRandom) {
          try {
            const re = await this._detectRandom(row);
            if (re) await this._onEvent(re, row);
          } catch (e) { console.error('[WORLD] 随机事件异常:', e.message); }
        }
      }
    } catch (e) {
      console.error('[WORLD] tick 异常:', e.message);
    } finally {
      this._busy = false;
    }
  }
}
