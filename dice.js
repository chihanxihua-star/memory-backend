import { supabase } from './memory.js';
import { fetchAppSummary, pushBark } from './bark.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FORGE_CONFIG_PATH = path.join('/root/forge-reload', 'config.json');
const TZ_OFFSET = 8;

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(FORGE_CONFIG_PATH, 'utf-8'));
  } catch { return {}; }
}

function getLocalHour() {
  const now = new Date(Date.now() + TZ_OFFSET * 3600000);
  return now.getUTCHours();
}

function formatLocalTime() {
  const now = new Date(Date.now() + TZ_OFFSET * 3600000);
  const h = String(now.getUTCHours()).padStart(2, '0');
  const m = String(now.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

async function getLastMessageTime() {
  const { data, error } = await supabase
    .from('messages')
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error || !data || !data.length) return null;
  return new Date(data[0].created_at);
}

async function writeSighLog(entry) {
  const { error } = await supabase.from('sigh_log_cheng').insert(entry);
  if (error) console.error('[DICE] sigh_log 写入失败:', error.message);
}

export function buildDicePrompt(appStatus, tHours) {
  const time = formatLocalTime();
  const gap = tHours != null
    ? (tHours >= 1 ? `${tHours.toFixed(1)} 小时` : `${Math.round(tHours * 60)} 分钟`)
    : '一阵子';
  const appLine = appStatus ? `，上次聊完之后，她用了 ${appStatus}` : '';
  return `已经 ${gap} 没跟小茉莉说话啦~现在是 ${time}${appLine}。如果你想说点什么就说，不想说就回复 [SKIP]。`;
}

export class DiceDaemon {
  constructor({ getActiveTurn, getPendingBuffer, isRunning, sendToCC, broadcast, getLastActiveConvId }) {
    this._getActiveTurn = getActiveTurn;
    this._getPendingBuffer = getPendingBuffer;
    this._isRunning = isRunning;
    this._sendToCC = sendToCC;
    this._broadcast = broadcast;
    this._getLastActiveConvId = getLastActiveConvId;
    this._timer = null;
    this._busy = false;
    this._pendingFire = null;
  }

  start() {
    const cfg = readConfig();
    if (cfg.dice_enabled === false) {
      console.log('[DICE] 已禁用，不启动');
      return;
    }
    console.log('[DICE] daemon 启动');
    this._scheduleNext();
  }

  stop() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  resetOnMessage() {
    const cfg = readConfig();
    if (cfg.dice_enabled === false) return;
    this.stop();
    this._scheduleNext();
  }

  _scheduleNext() {
    const cfg = readConfig();
    if (cfg.dice_enabled === false) return;
    const minMs = (cfg.dice_interval_min || 30) * 60000;
    const maxMs = (cfg.dice_interval_max || 50) * 60000;
    const delay = minMs + Math.random() * (maxMs - minMs);
    this._timer = setTimeout(() => this._tick(), delay);
    const mins = Math.round(delay / 60000);
    console.log(`[DICE] 下一轮 ${mins} 分钟后`);
  }

  async _tick() {
    this._timer = null;
    const cfg = readConfig();
    if (cfg.dice_enabled === false) {
      return;
    }

    try {
      await this._roll(cfg);
    } catch (e) {
      console.error('[DICE] tick 异常:', e);
    }

    this._scheduleNext();
  }

  async _roll(cfg) {
    if (this._busy) return;
    this._busy = true;
    try {
      // 安静时段（dice_quiet_hours，默认 [1,8]，+8 时区，见 getLocalHour）：这段不主动打扰小茉莉，
      // 直接跳过本轮（_tick 在 _roll 之后照常 _scheduleNext 重排下一轮）。区间含起点不含终点，支持跨午夜。
      const qh = cfg.dice_quiet_hours;
      if (Array.isArray(qh) && qh.length === 2) {
        const h = getLocalHour();
        const [qs, qe] = qh;
        const inQuiet = qs <= qe ? (h >= qs && h < qe) : (h >= qs || h < qe);
        if (inQuiet) { console.log(`[DICE] 安静时段(${qs}-${qe}点, 现在${h}点 +8)，跳过本轮`); return; }
      }
      const lastMsg = await getLastMessageTime();
      const tHours = lastMsg ? (Date.now() - lastMsg.getTime()) / 3600000 : 24;
      const lambda = cfg.lambda || 0.15;
      const prob = 1 - Math.exp(-lambda * tHours);
      const roll = Math.random();

      if (roll >= prob) {
        console.log(`[DICE] 未命中 (t=${tHours.toFixed(1)}h, P=${prob.toFixed(2)}, roll=${roll.toFixed(2)})`);
        await writeSighLog({
          t_hours: Math.round(tHours * 100) / 100,
          lambda,
          probability: Math.round(prob * 1000) / 1000,
          roll: Math.round(roll * 1000) / 1000,
          hit: false,
          judgment: 'skip_roll',
        });
        return;
      }

      console.log(`[DICE] 命中! (t=${tHours.toFixed(1)}h, P=${prob.toFixed(2)}, roll=${roll.toFixed(2)})`);

      const appSummary = await fetchAppSummary(lastMsg);
      const judgment = this._judge(cfg, appSummary);

      if (judgment.skip) {
        console.log(`[DICE] 裁决跳过: ${judgment.reason}`);
        await writeSighLog({
          t_hours: Math.round(tHours * 100) / 100,
          lambda,
          probability: Math.round(prob * 1000) / 1000,
          roll: Math.round(roll * 1000) / 1000,
          hit: true,
          judgment: judgment.code,
          reason: judgment.reason,
          app_status: appSummary || null,
        });
        return;
      }

      if (!this._isRunning() || this._getActiveTurn() || this._getPendingBuffer()) {
        console.log('[DICE] CC 忙或未运行，跳过');
        await writeSighLog({
          t_hours: Math.round(tHours * 100) / 100,
          lambda,
          probability: Math.round(prob * 1000) / 1000,
          roll: Math.round(roll * 1000) / 1000,
          hit: true,
          judgment: 'skip_busy_cc',
          reason: 'CC 正忙或未运行',
          app_status: appSummary || null,
        });
        return;
      }

      this._pendingFire = {
        t_hours: Math.round(tHours * 100) / 100,
        lambda,
        probability: Math.round(prob * 1000) / 1000,
        roll: Math.round(roll * 1000) / 1000,
        app_status: appSummary || null,
      };

      const prompt = buildDicePrompt(appSummary, tHours);
      this._sendToCC(prompt);
      console.log('[DICE] 已注入 CC prompt');

    } finally {
      this._busy = false;
    }
  }

  _judge(cfg, appSummary) {
    if (appSummary) {
      const busyApps = /学习|作业|备忘录|笔记|office|word|excel|ppt|wps|钉钉|飞书|企业微信|考试|题库/i;
      if (busyApps.test(appSummary)) {
        return { skip: true, code: 'skip_busy', reason: `她在忙：${appSummary.slice(0, 50)}` };
      }
    }

    return { skip: false };
  }

  async handleDiceTurnDone(text, thinking) {
    const fire = this._pendingFire;
    if (!fire) return false;
    this._pendingFire = null;

    // dice 是普通主动消息，不走世界 WORLD_MESSAGE 管线；但澄偶尔会误用该标签
    // （系统提示「世界唤醒区」教过"想跟小茉莉说话用 [WORLD_MESSAGE:phone/face]"，dice 这句"好久没说话了想说就说"
    //  太像世界消息触发）。只剥 phone/face 两种壳、保留里面要说的话，避免裸标签漏进聊天消息/Bark。
    //  其它标签（TODO/MOVE/OPEN_TODOS 等）dice 实测用不到，不处理。
    text = String(text || '').replace(/\[\/?WORLD_MESSAGE(?::(?:phone|face))?\]/gi, '');

    const clean = text.replace(/\[SKIP\]/gi, '').trim();
    const skip = /\[SKIP\]/i.test(text);

    if (skip) {
      console.log('[DICE] CC 选择跳过');
      await writeSighLog({
        ...fire,
        hit: true,
        judgment: 'skip_cc',
        thinking: thinking || null,
        app_status: fire.app_status || null,
      });
      return true;
    }

    const body = clean
      .replace(/---bubble---/g, ' ')
      .replace(/\n+/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();

    if (!body) {
      console.log('[DICE] CC 生成空消息，跳过');
      await writeSighLog({
        ...fire,
        hit: true,
        judgment: 'skip_cc',
        reason: '空消息',
        thinking: thinking || null,
        app_status: fire.app_status || null,
      });
      return true;
    }

    const ok = await pushBark({ title: '澄', body });
    console.log(`[DICE] 推送 ${ok ? 'ok' : 'failed'}: ${body.slice(0, 40)}`);

    const convId = this._getLastActiveConvId();
    if (convId) {
      try {
        const { data: row } = await supabase.from('messages').insert({
          conversation_id: convId,
          role: 'assistant',
          content: text,
          thinking: thinking || null,
          event: 'dice',
        }).select('id, created_at').single();
        this._broadcast({
          type: 'bark_msg',
          conversation_id: convId,
          message: {
            id: row?.id || 'dice-' + Date.now(),
            role: 'assistant',
            content: clean,
            event: 'dice',
            created_at: row?.created_at || new Date().toISOString(),
          },
        });
      } catch (e) { console.error('[DICE] 存消息/广播失败:', e); }
    }

    await writeSighLog({
      ...fire,
      hit: true,
      judgment: 'send',
      message_sent: body,
      thinking: thinking || null,
      app_status: fire.app_status || null,
    });

    return true;
  }

  hasPendingFire() {
    return !!this._pendingFire;
  }
}
