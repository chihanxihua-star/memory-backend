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
  if (loc.startsWith('公司 · ')) {
    const rest = loc.slice(5);
    // 过场地点（"去小茉莉休息室的路上"等）本身就是完整短语，别拼成"公司的去…路上"
    if (rest.includes('路上')) return rest;
    return '公司的' + rest;
  }
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

// 读启用的短语规则 + 模板 + 动作短语（小表，调用频率低，每次读一份即可，编辑后立即生效）。
export async function loadNarrationRules() {
  const [ph, tpl, act] = await Promise.all([
    supabase.from('world_self_narration_phrases').select('*').eq('enabled', true),
    supabase.from('world_self_narration_templates').select('*').eq('enabled', true),
    supabase.from('world_self_narration_actions').select('*').eq('enabled', true),
  ]);
  return { phrases: ph.data || [], templates: tpl.data || [], actions: act.data || [] };
}

// 待补叙队列：silent 动作（链步骤/作息切换）执行时入队，<此刻> 生成消费后清空。
// item = { action: activity名, meal?: 菜名 }。最多留最近 15 个防爆。
export async function appendNarration(actionName, meal = null, statInfo = null) {
  if (!actionName) return;
  try {
    const { data } = await supabase.from('character_status_cheng').select('pending_narration').eq('name', '澄').limit(1);
    const cur = Array.isArray(data?.[0]?.pending_narration) ? data[0].pending_narration : [];
    const item = { action: actionName };
    if (meal) item.meal = meal;
    if (statInfo && statInfo.stat) { item.stat = statInfo.stat; item.after = statInfo.after; } // 改数值的动作带现状感受
    cur.push(item);
    await supabase.from('character_status_cheng').update({ pending_narration: cur.slice(-15) }).eq('name', '澄');
  } catch (e) { console.warn('[NAR] appendNarration 失败:', e.message); }
}
// 生成 <此刻> 后清空队列（调用方在拿到 nowBlock 后调）。
export async function clearNarration() {
  try { await supabase.from('character_status_cheng').update({ pending_narration: [] }).eq('name', '澄'); }
  catch (e) { console.warn('[NAR] clearNarration 失败:', e.message); }
}

// 把队列动作串成「我A，B，C」回顾句。每个动作从 actions 库随机抽一句（含 {meal} 替换）。
// 改数值的动作（item 带 stat+after）后面接一句该数值现状短语（吃了麻辣香锅，肚子圆滚滚的）。
// 返回 { text, usedStats }：usedStats 给结尾 pickPhrases 排除，避免重复念叨同一个数值。
const recentActionPhraseIds = new Set();
function buildRecentActions(pending, actions, phrases) {
  const items = Array.isArray(pending) ? pending : [];
  if (!items.length) return { text: '', usedStats: [] };
  recentActionPhraseIds.clear();
  const parts = [], usedStats = [];
  for (const it of items) {
    const actName = typeof it === 'string' ? it : it?.action;
    if (!actName) continue;
    const meal = (it && typeof it === 'object' && it.meal) ? it.meal : '';
    const matches = (actions || []).filter(a => a.action === actName);
    let phrase;
    if (matches.length) {
      const fresh = matches.filter(a => !recentActionPhraseIds.has(a.id));
      const pool = fresh.length ? fresh : matches;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      recentActionPhraseIds.add(pick.id);
      phrase = pick.phrase;
    } else {
      phrase = actName; // 没配短语兜底用动作名
    }
    parts.push(phrase.replace(/\{meal\}/g, meal || '点东西'));
    // 改数值的动作：接一句该数值现状（"吃了X，肚子圆滚滚的"）
    if (it && typeof it === 'object' && it.stat && Number.isFinite(Number(it.after))) {
      const feel = pickOnePhrase(it.stat, Number(it.after), phrases);
      if (feel) { parts.push(feel.phrase); usedStats.push(it.stat); }
    }
  }
  recentActionPhraseIds.clear();
  return { text: parts.length ? '我' + parts.join('，') : '', usedStats };
}

// 避免连续两次抽到同一句。
const recentPhraseIds = new Set();
// 抽某 stat 在当前值档位的一句短语（避连抽同句）。无命中返回 null。
function pickOnePhrase(stat, v, phrases) {
  const matches = (phrases || []).filter(p => p.stat === stat && v >= Number(p.min_value) && v <= Number(p.max_value));
  if (!matches.length) return null;
  const fresh = matches.filter(p => !recentPhraseIds.has(p.id));
  const pool = fresh.length ? fresh : matches;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  recentPhraseIds.add(pick.id);
  return pick;
}
// 身体短语（6/13 用户定规则）：4 状态 ≤50 才出现（差状态优先）；都 >50 随机挑 2-3 个组句（不然全空）。
// excludeStats = 已在动作补叙里带过感受的 stat（如吃完已说"肚子圆滚滚"），结尾不重复。
function pickPhrases(status, phrases, excludeStats = []) {
  recentPhraseIds.clear();
  const stats = BODY_STATS.filter(s => !excludeStats.includes(s));
  const low = [], high = [];
  for (const stat of stats) {
    const v = Number(status?.[stat]);
    if (!Number.isFinite(v)) continue;
    (v <= 50 ? low : high).push(stat);
  }
  let chosen;
  if (low.length) chosen = low.slice(0, 3);            // 有差状态：优先显示（最多3）
  else {                                                // 都 >50：随机挑 2-3 个
    const sh = high.slice();
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    chosen = sh.slice(0, Math.min(sh.length, 2 + Math.floor(Math.random() * 2)));
  }
  const strs = chosen.map(stat => pickOnePhrase(stat, Number(status[stat]), phrases)).filter(Boolean).map(p => p.phrase);
  return strs.length ? strs.join('，') + '。' : '';
}

// 澄第一人称自述。rules = { phrases, templates, actions }。
// 队列非空 → 动作版（kind=action 模板 + {recent_actions} 回顾串）；空 → 普通版（kind=normal）。
// 注意：本函数纯生成不清队列，清空由调用方拿到 nowBlock 后调 clearNarration()。
export function generateChengSelfNarration(status, env, rules) {
  const phrases = rules?.phrases || [];
  const allTpls = (rules?.templates || []).filter(t => t.template);
  const actions = rules?.actions || [];
  const pending = Array.isArray(status?.pending_narration) ? status.pending_narration : [];
  const useAction = pending.length > 0;
  const kind = useAction ? 'action' : 'normal';
  let tpls = allTpls.filter(t => (t.kind || 'normal') === kind);
  if (!tpls.length) tpls = allTpls.filter(t => (t.kind || 'normal') === 'normal'); // 动作模板没配就退普通
  const tpl = tpls.length
    ? tpls[Math.floor(Math.random() * tpls.length)].template
    : (useAction ? '现在是 {date} {time}。{recent_actions}，在{location_natural}。{phrases}'
                 : '现在是 {date} {time}。我在{location_natural}，正在{activity}。{phrases}');
  const date = (env && env.date) || '';
  const time = realWorldTime();
  const locN = formatNaturalLocation(status?.location);
  const act = mapActivity(status?.activity);
  const ra = useAction ? buildRecentActions(pending, actions, phrases) : { text: '', usedStats: [] };
  const recentActions = ra.text;
  const ph = pickPhrases(status, phrases, ra.usedStats); // 排除动作里已带感受的数值，不重复
  let s = tpl
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time)
    .replace(/\{weather\}/g, (env && env.weather) || '')
    .replace(/\{location_natural\}/g, locN)
    .replace(/\{activity\}/g, act)
    .replace(/\{recent_actions\}/g, recentActions)
    .replace(/\{phrases\}/g, ph);
  return s.replace(/ {2,}/g, ' ').replace(/，。/g, '。').trim();
}

// 小茉莉第三人称客观描述。activity 是用户手填，允许长/换行/引号，原样拼，不清洗。
export function formatUserStatus(user) {
  const u = user || {};
  const locN = formatNaturalLocation(u.location || '家 · 客厅');
  // <此刻> 是给澄看的：小茉莉状态里的"澄"=在对澄说，转成"我"（如"和澄一起午休"→"和我一起午休"）
  const act = (u.activity || '休息').replace(/澄/g, '我');
  return `在${locN}，正在${act}`;
}

// <此刻> 内层内容（不含 <此刻> 标签壳）：澄自述 + 空行 + 小茉莉。两个入口共用。
export function buildNowInner(chengStatus, env, user, rules) {
  const cheng = generateChengSelfNarration(chengStatus, env, rules);
  const mol = formatUserStatus(user);
  // 不带「澄：」前缀（自述本来就是第一人称「我」）；小茉莉行去冒号拼成一句话（2026-06-12 用户定的格式）
  return `${cheng}\n\n小茉莉${mol}`;
}
