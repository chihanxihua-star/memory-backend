// [BARK:时间|内容] 标签解析、调度入库、定时轮询、Bark API 推送。
// 详见 /root/.claude/CLAUDE.md 与 schedules_cheng 表。
import { supabase } from './memory.js';

const BARK_TAG_RE = /\[BARK:([^|\]]+)\|([^\]]+)\]/g;
// strip 用宽松版：即使时间/内容缺失或非法也吃掉，避免漏给小茉莉看到
const BARK_STRIP_RE = /\[BARK:[^\]]*\]/g;
// 服务器跑 UTC，小茉莉在 +8。tomorrow / today / 绝对日期都按这个时区解析
const BARK_TZ_OFFSET_HOURS = Number(process.env.BARK_TZ_OFFSET_HOURS ?? 8);

// 把"中国时区下的 Y/M/D h:m"映射成对应的 UTC Date
function makeLocalDate(year, monthIdx, day, hour, minute) {
  return new Date(Date.UTC(year, monthIdx, day, hour - BARK_TZ_OFFSET_HOURS, minute, 0, 0));
}

// 把当前时刻投影到本地（中国）时区，拆出年月日
function localNowParts(now) {
  const local = new Date(now.getTime() + BARK_TZ_OFFSET_HOURS * 3_600_000);
  return {
    year: local.getUTCFullYear(),
    monthIdx: local.getUTCMonth(),
    day: local.getUTCDate(),
  };
}

export function parseBarkTags(text) {
  const out = [];
  if (!text) return out;
  BARK_TAG_RE.lastIndex = 0;
  let m;
  while ((m = BARK_TAG_RE.exec(text)) !== null) {
    const raw = m[1].trim();
    const hint = m[2].trim();
    if (!hint) continue;
    const triggerAt = parseBarkTime(raw);
    if (!triggerAt) {
      console.warn(`[BARK] 时间解析失败: "${raw}"`);
      continue;
    }
    if (triggerAt.getTime() < Date.now() - 60_000) {
      console.warn(`[BARK] 解析出过去时间，丢弃: "${raw}" -> ${triggerAt.toISOString()}`);
      continue;
    }
    out.push({ raw, trigger_at: triggerAt.toISOString(), hint });
  }
  return out;
}

export function removeBarkTags(text) {
  if (!text) return text;
  return text.replace(BARK_STRIP_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

// 支持：
//   30s / 30m / 2h / 3d
//   today 9:00 / tomorrow 9:00
//   2026-05-10 20:00 / 2026/05/10 20:00 / ISO
export function parseBarkTime(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  const now = new Date();

  const rel = /^(\d+)\s*(s|m|h|d)$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = unit === 's' ? n * 1000
      : unit === 'm' ? n * 60_000
      : unit === 'h' ? n * 3_600_000
      : n * 86_400_000;
    return new Date(now.getTime() + ms);
  }

  const dayRel = /^(today|tomorrow)\s+(\d{1,2}):(\d{2})$/.exec(s);
  if (dayRel) {
    const parts = localNowParts(now);
    const dayOffset = dayRel[1] === 'tomorrow' ? 1 : 0;
    return makeLocalDate(parts.year, parts.monthIdx, parts.day + dayOffset, Number(dayRel[2]), Number(dayRel[3]));
  }

  const abs = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[t\s]+(\d{1,2}):(\d{2}))?$/.exec(s);
  if (abs) {
    const d = makeLocalDate(
      Number(abs[1]), Number(abs[2]) - 1, Number(abs[3]),
      abs[4] ? Number(abs[4]) : 9, abs[5] ? Number(abs[5]) : 0
    );
    if (!isNaN(d.getTime())) return d;
  }

  // ISO（带 Z 或 +HH:MM）走原生解析；不带时区的字符串不进这里
  if (/[zZ]|[+-]\d{2}:\d{2}/.test(raw)) {
    const ts = Date.parse(raw);
    if (!isNaN(ts)) return new Date(ts);
  }

  return null;
}

export async function saveBarkSchedules(tags, sourceSession) {
  if (!tags || !tags.length) return [];
  const rows = tags.map(t => ({
    type: 'bark',
    trigger_at: t.trigger_at,
    hint: t.hint,
    source_session: sourceSession || null,
    status: 'pending',
  }));
  const { data, error } = await supabase
    .from('schedules_cheng')
    .insert(rows)
    .select('id, trigger_at, hint');
  if (error) {
    console.error('[BARK] 入库失败:', error.message);
    return [];
  }
  for (const r of data || []) {
    console.log(`[BARK] 已排程 ${r.id} @ ${r.trigger_at}: ${r.hint.slice(0, 30)}`);
  }
  return data || [];
}

export async function findDuePending() {
  const { data, error } = await supabase
    .from('schedules_cheng')
    .select('id, hint, trigger_at, source_session')
    .eq('status', 'pending')
    .eq('type', 'bark')
    .lte('trigger_at', new Date().toISOString())
    .order('trigger_at', { ascending: true })
    .limit(1);
  if (error) {
    console.error('[BARK] 查询失败:', error.message);
    return null;
  }
  return data && data[0] ? data[0] : null;
}

export async function markFired(id) {
  const { error } = await supabase
    .from('schedules_cheng')
    .update({ status: 'fired', fired_at: new Date().toISOString() })
    .eq('id', id);
  if (error) console.warn('[BARK] markFired 失败:', error.message);
}

export async function pushBark({ title, body }) {
  const key = process.env.BARK_DEVICE_KEY;
  if (!key) {
    console.warn('[BARK] BARK_DEVICE_KEY 未配置，跳过推送');
    return false;
  }
  const url = `https://api.day.app/${encodeURIComponent(key)}/${encodeURIComponent(title || '澄')}/${encodeURIComponent(body || '')}`;
  try {
    const r = await fetch(url, { method: 'POST' });
    if (!r.ok) {
      console.warn(`[BARK] 推送失败 status=${r.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[BARK] 推送异常:', e.message);
    return false;
  }
}

export async function fetchAppSummary() {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}/functions/v1/app-summary`, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) {
      console.warn(`[BARK] app-summary 拉取失败 status=${r.status}`);
      return null;
    }
    const text = (await r.text()).trim();
    return text || null;
  } catch (e) {
    console.warn('[BARK] app-summary 异常:', e.message);
    return null;
  }
}

export function buildFirePrompt(hint, appSummary) {
  const usageBlock = appSummary
    ? `\n\n【小茉莉手机最近用了什么】\n${appSummary}\n`
    : '';
  return `【系统任务·主动消息】\n你之前想在这个时候对小茉莉说：${hint}${usageBlock}\n\n现在判断一下：根据她现在在做什么/最近在做什么，这个时候打扰她合不合适？\n- 如果合适，用你自己的方式说一两句话，整段作为一条 Bark 推送发出（不要用 ---bubble--- 标记，也不要再写 [BARK:...] 标签）。\n- 如果不合适（比如她在专注做别的事、刚睡下、明显没必要打扰），就只输出 [SKIP] 三个字，后端会跳过推送。`;
}
