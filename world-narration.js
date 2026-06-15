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
export async function appendNarration(actionName, meal = null, statInfo = null, extra = null) {
  if (!actionName) return;
  try {
    const { data } = await supabase.from('character_status_cheng').select('pending_narration').eq('name', '澄').limit(1);
    const cur = Array.isArray(data?.[0]?.pending_narration) ? data[0].pending_narration : [];
    const item = { action: actionName };
    if (meal) item.meal = meal;
    if (statInfo && statInfo.stat) { item.stat = statInfo.stat; item.after = statInfo.after; } // 改数值的动作带现状感受
    if (extra && typeof extra === 'object') Object.assign(item, extra); // 通勤步带 wx(天气) 等
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
// 固定搭配（6/13 用户定）：连续动作"整串缺一不可"才合并。贪婪匹配最长（按 seq 长度降序）。
// 通勤=公式拼接：[天气][跟小茉莉一起]乘[地铁/车][到公司/回家]，天气从序列 item.wx 拿、菜名从 item.meal 拿。
// 约见=固定短语。打车需先拆成"出门/走到公司楼下 + 打车 + 乘车"多步才匹配得到。
const COMBO_RULES = [
  { seq: ['去便利店', '去地铁站', '坐地铁', '从地铁站走到公司'], mode: 'subway', dir: 'to', store: true },
  { seq: ['去便利店', '坐地铁', '从地铁站走到公司'], mode: 'subway', dir: 'to', store: true },
  { seq: ['去地铁站', '坐地铁', '从地铁站走到公司'], mode: 'subway', dir: 'to' },
  { seq: ['坐地铁', '从地铁站走到公司'], mode: 'subway', dir: 'to' },
  { seq: ['从公司走到地铁站', '坐地铁', '从地铁站走回家'], mode: 'subway', dir: 'home' },
  { seq: ['出门', '打车', '乘车'], mode: 'taxi', dir: 'to' },
  { seq: ['走到公司楼下', '打车', '乘车'], mode: 'taxi', dir: 'home' },
  { seq: ['去找小茉莉', '到小茉莉休息室'], fixed: '去小茉莉休息室找她' },
].sort((a, b) => b.seq.length - a.seq.length);
function matchCombo(actNames, i) {
  for (const r of COMBO_RULES) {
    if (i + r.seq.length > actNames.length) continue;
    let ok = true;
    for (let k = 0; k < r.seq.length; k++) if (actNames[i + k] !== r.seq[k]) { ok = false; break; }
    if (ok) return r;
  }
  return null;
}
function comboPhrase(rule, items, i) {
  if (rule.fixed) return rule.fixed;
  let wx = '', meal = '', together = false;
  for (let k = 0; k < rule.seq.length; k++) {
    const it = items[i + k];
    if (it && typeof it === 'object') { if (it.wx && !wx) wx = it.wx; if (it.meal && !meal) meal = it.meal; if (it.together) together = true; }
  }
  const wxPre = wx === '雪' ? '下雪天' : wx === '雨' ? '下雨天' : '';
  const tPre = together ? '跟小茉莉一起' : '';
  const core = (rule.mode === 'taxi' ? '打车' : '坐地铁') + (rule.dir === 'home' ? '回家' : '到公司');
  if (rule.store) return wxPre + tPre + '在便利店买了' + (meal || '早饭') + '，' + core;
  return wxPre + tPre + core;
}

const recentActionPhraseIds = new Set();
function buildRecentActions(pending, actions, phrases) {
  const items = Array.isArray(pending) ? pending : [];
  if (!items.length) return { text: '', usedStats: [] };
  recentActionPhraseIds.clear();
  const actNames = items.map(it => (typeof it === 'string' ? it : it?.action));
  const parts = [], usedStats = [];
  let i = 0;
  while (i < items.length) {
    const combo = matchCombo(actNames, i);
    if (combo) { parts.push(comboPhrase(combo, items, i)); i += combo.seq.length; continue; }
    const it = items[i];
    const actName = actNames[i];
    if (!actName) { i++; continue; }
    const meal = (it && typeof it === 'object' && it.meal) ? it.meal : '';
    const matches = (actions || []).filter(a => a.action === actName);
    let phrase;
    if (matches.length) {
      const fresh = matches.filter(a => !recentActionPhraseIds.has(a.id));
      const pool = fresh.length ? fresh : matches;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      recentActionPhraseIds.add(pick.id);
      phrase = pick.phrase;
    } else { phrase = actName; }
    parts.push(phrase.replace(/\{meal\}/g, meal || '点东西'));
    if (it && typeof it === 'object' && it.stat && Number.isFinite(Number(it.after))) {
      const feel = pickOnePhrase(it.stat, Number(it.after), phrases);
      if (feel) { parts.push(feel.phrase); usedStats.push(it.stat); }
    }
    i++;
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

// 澄能否直接看见小茉莉 = 是否同一个房间（家同具体房间 / 同一间休息室）。口径同 index.js 的 canFaceToFace。
// ⚠️ 这是独立拷贝，只给下面这句文字用，不碰气泡逻辑（气泡走 index.js 的 canFaceToFace）；改房间规则两边都要改。
function sameRoomAsCheng(chengStatus, user) {
  const c = chengStatus && chengStatus.location, m = user && user.location;
  if (!c || !m) return false;
  if (c.startsWith('家 · ') && m.startsWith('家 · ')) return c === m;
  const LOUNGES = ['公司 · 澄休息室', '公司 · 小茉莉休息室'];
  if (LOUNGES.includes(c) && c === m) return true;
  return false;
}

// 小茉莉第三人称。同房间=澄直接看见「在我旁边，正X」；不同房间（异地/不同工位/不同屋）=澄看不见，
// 转述「说她在X地X事」——视角不穿帮（信息是小茉莉自己设状态告诉澄的，不是澄偷看到的）。
// activity 用户手填，原样拼不清洗；其中"澄"=对澄说→转"我"（如"和澄一起午休"→"和我一起午休"）。
export function formatUserStatus(user, chengStatus) {
  const u = user || {};
  const act = (u.activity || '休息').replace(/澄/g, '我');
  if (sameRoomAsCheng(chengStatus, u)) return `在我旁边，正${act}`;
  // 转述：不同房间，澄看不见。同一栋楼（都在公司/都在家）省掉楼名只说房间（"工位"）；
  // 不同栋楼保留全名（"公司的工位"），不然澄不知道她在哪栋。
  const uLoc = u.location || '家 · 客厅';
  const cBldg = ((chengStatus && chengStatus.location) || '').split(' · ')[0];
  const uBldg = uLoc.split(' · ')[0];
  const sameBldg = cBldg && uBldg && cBldg === uBldg;
  const locN = sameBldg ? (uLoc.split(' · ')[1] || formatNaturalLocation(uLoc)) : formatNaturalLocation(uLoc);
  return `说她在${locN}${act}`;
}

// <此刻> 内层内容（不含 <此刻> 标签壳）：澄自述 + 空行 + 小茉莉。两个入口共用。
export function buildNowInner(chengStatus, env, user, rules) {
  const cheng = generateChengSelfNarration(chengStatus, env, rules);
  const mol = formatUserStatus(user, chengStatus);
  // 不带「澄：」前缀（自述本来就是第一人称「我」）；小茉莉行去冒号拼成一句话（2026-06-12 用户定的格式）
  return `${cheng}\n\n小茉莉${mol}`;
}
