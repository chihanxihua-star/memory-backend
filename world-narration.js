// world-narration.js — 12A：澄的「此刻」第一人称身体/环境自述（统一生成）。
// 同一套逻辑同时用于：聊天 md 的 <此刻>（surfacing.js）和世界唤醒包里的 <此刻>（index.js）。不做两套。
// 只用 4 个身体/生活状态(energy/satiety/cleanliness/health) + location/activity/world_time/date。
// 不读 mood/longing/libido/social/stress/focus/comfort/数字，不输出感受判断。
import { supabase } from './memory.js';
import { BODY_STATS } from './world-effects.js';

// location → 自然语言（不带「在」，模板/小茉莉行各自补）。家 · 卧室 → 家的卧室；公司 · 工位 → 公司的工位。
export function formatNaturalLocation(location) {
  const loc = String(location || '').trim();
  if (loc.startsWith('家 · ')) return '家的' + loc.slice(4);
  if (loc.startsWith('公司 · ')) return '公司的' + loc.slice(5);
  if (loc.startsWith('外出 · ')) return loc.slice(5);
  return loc || '家的客厅';
}

// world_time 现算：始终取现实 Asia/Shanghai 当前 HH:mm（不再依赖 tick 累加进库的旧值）。
// 时间来源 = 真时间；存库的 world_time 不再作为显示/自述的依据。
export function realWorldTime() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

// activity 已是中文就直接用；万一存了英文枚举给个映射，绝不输出 "正在 resting"。
const ACT_MAP = { resting: '休息', working: '工作', lunch_break: '午休', overtime: '加班', showering: '洗澡', eating: '吃东西' };
function mapActivity(a) { return ACT_MAP[a] || a || '闲着'; }

// 读启用的短语规则 + 模板（小表，调用频率低，每次读一份即可，编辑后立即生效）。
export async function loadNarrationRules() {
  const [ph, tpl] = await Promise.all([
    supabase.from('world_self_narration_phrases').select('*').eq('enabled', true),
    supabase.from('world_self_narration_templates').select('*').eq('enabled', true),
  ]);
  return { phrases: ph.data || [], templates: tpl.data || [] };
}

// 避免连续两次抽到同一句。
const recentPhraseIds = new Set();
// 只看 4 个身体状态，命中启用 phrase 就可出现；每状态命中多条随机抽一条；最多 3 条。
// 返回拼好的字符串（非空时自带句号结尾），全平静则返回 ''。
function pickPhrases(status, phrases) {
  const picked = [];
  for (const stat of BODY_STATS) {
    if (picked.length >= 3) break;
    const v = Number(status?.[stat]);
    if (!Number.isFinite(v)) continue;
    const matches = (phrases || []).filter(p => p.stat === stat && v >= Number(p.min_value) && v <= Number(p.max_value));
    if (!matches.length) continue;
    const fresh = matches.filter(p => !recentPhraseIds.has(p.id));
    const pool = fresh.length ? fresh : matches; // 全是刚用过的也还是出，别空着
    picked.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  recentPhraseIds.clear();
  picked.forEach(p => recentPhraseIds.add(p.id));
  const strs = picked.map(p => p.phrase).filter(Boolean);
  return strs.length ? strs.join('，') + '。' : '';
}

// 澄第一人称自述。env 给 date；空 phrases 收干净不留多余标点。
export function generateChengSelfNarration(status, env, phrases, templates) {
  const tpls = (templates || []).filter(t => t.template);
  const tpl = tpls.length
    ? tpls[Math.floor(Math.random() * tpls.length)].template
    : '现在是 {date} {time}。我在{location_natural}，正在{activity}。{phrases}';
  const date = (env && env.date) || '';
  const time = realWorldTime();
  const locN = formatNaturalLocation(status?.location);
  const act = mapActivity(status?.activity);
  const ph = pickPhrases(status, phrases);
  let s = tpl
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time)
    .replace(/\{weather\}/g, (env && env.weather) || '') // 默认 seed 模板不含；想让澄提天气就在模板加 {weather}
    .replace(/\{location_natural\}/g, locN)
    .replace(/\{activity\}/g, act)
    .replace(/\{phrases\}/g, ph);
  return s.replace(/ {2,}/g, ' ').trim();
}

// 小茉莉第三人称客观描述。activity 是用户手填，允许长/换行/引号，原样拼，不清洗。
export function formatUserStatus(user) {
  const u = user || {};
  const locN = formatNaturalLocation(u.location || '家 · 客厅');
  const act = u.activity || '休息';
  return `在${locN}，正在${act}`;
}

// <此刻> 内层内容（不含 <此刻> 标签壳）：澄自述 + 空行 + 小茉莉。两个入口共用。
export function buildNowInner(chengStatus, env, user, phrases, templates) {
  const cheng = generateChengSelfNarration(chengStatus, env, phrases, templates);
  const mol = formatUserStatus(user);
  // 不带「澄：」前缀（自述本来就是第一人称「我」）；小茉莉行去冒号拼成一句话（2026-06-12 用户定的格式）
  return `${cheng}\n\n小茉莉${mol}`;
}
