// world-dream-gen.js — 14B-1 梦境后台生成（独立 HTTP 调用，不走澄那个 tmux 会话）。
// provider/model/提示词/temperature 存 world_dream_config_cheng（网页可改）；API key 存 .env（不进库、不回显）。
// 每次调用无状态（OpenAI 兼容 /chat/completions，服务端不记上下文，多次生成不累计）。失败只 warning，不连累睡眠/tick。
import { supabase } from './memory.js';

// 各 provider 的 OpenAI 兼容基址 + .env 里的 key 变量名 + 兜底默认模型（fallback 到该 provider 时用，
// 因为配置表只存当前 provider 的 model）。换 provider 只改配置表的 provider 字段。
const PROVIDERS = {
  glm:      { url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', envKey: 'GLM_API_KEY',      defaultModel: 'glm-4-flash' },
  deepseek: { url: 'https://api.deepseek.com/chat/completions',             envKey: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat' },
};

// 梦类目（tag 池）按支可选：有她支可用 日常/梦幻/春梦；无她支可用 日常/梦幻/怪诞（春梦只在有她、怪诞只在无她）。
const BRANCH_CATEGORIES = {
  self: ['日常', '梦幻', '春梦'],
  other: ['日常', '梦幻', '怪诞'],
};
// 各 category 的侧面抽取规则（没列的 category = 每个 dimension 各抽 1 个）。春梦规则：6/17 用户定。
const TAG_RULES = {
  春梦: {
    always: ['体位', '场景'],                              // 必有
    oneOf: [
      { pick: ['角色扮演', '道具'], chance: 1 },           // 必二选一
      { pick: ['身体感受', '心理情绪'], chance: 0.5 },     // 50% 随缘，有则二选一
    ],
    // gore 不在 always/oneOf 里 → 永不抽
  },
};

// 从 world_dream_tags_cheng 按 category 的规则抽 tag（中文）。返回字符串数组（3-4 个）。
async function drawDreamTags(category) {
  try {
    const { data } = await supabase.from('world_dream_tags_cheng')
      .select('dimension, tag').eq('category', category).eq('enabled', true);
    const rows = data || [];
    if (!rows.length) return [];
    const byDim = {};
    for (const r of rows) { (byDim[r.dimension] ||= []).push(r.tag); }
    const pickFrom = (dim) => { const p = byDim[dim]; return p && p.length ? p[Math.floor(Math.random() * p.length)] : null; };
    const rule = TAG_RULES[category];
    const picked = [];
    if (rule) {
      for (const d of (rule.always || [])) { const t = pickFrom(d); if (t) picked.push(t); }
      for (const grp of (rule.oneOf || [])) {
        if (Math.random() < grp.chance) {
          const avail = grp.pick.filter(d => byDim[d] && byDim[d].length);
          if (avail.length) { const t = pickFrom(avail[Math.floor(Math.random() * avail.length)]); if (t) picked.push(t); }
        }
      }
    } else {
      for (const d of Object.keys(byDim)) { const t = pickFrom(d); if (t) picked.push(t); } // 默认：每侧面抽 1 个
    }
    return picked;
  } catch (e) { console.warn('[DREAM] 抽 tag 失败:', e.message); return []; }
}

export function dreamProviders() { return Object.keys(PROVIDERS); }
// 哪些 provider 已配了 key（给前端显示"已配置/未配置"，不回显 key 本身）。
export function dreamKeyStatus() {
  const out = {};
  for (const [name, p] of Object.entries(PROVIDERS)) out[name] = !!process.env[p.envKey];
  return out;
}

export async function readDreamConfig() {
  const { data } = await supabase.from('world_dream_config_cheng').select('*').eq('name', '澄').limit(1);
  return (data && data[0]) || null;
}

// 采集最近 7 天的有限素材（spec 七）：timeline 事件 + 未完成待办 + 天气/日期 + 近期物品/地点。
// 只取少量、不塞整周原始聊天、不读 mood/longing 等旧感受字段。
// 系统机制日志不是"生活事件"，不当梦素材：睡眠/健康/衰减/工资/时间校正/做梦/纯移动落脚等。
const SKIP_ACTIONS = new Set(['自然衰减', '睡眠中', '世界时间校正', '做梦']);
const SKIP_PATTERN = /入睡|醒来|刚醒|睡眠|午睡|小睡|贴贴|健康下降|健康恢复|发工资|世界时间校正|做梦/;
export async function gatherDreamMaterial(opts = {}) {
  // 网页可配（world_dream_config_cheng）：material_exclude=排除词（含词的事件/地点滤掉），material_extra=额外素材（逐行附上）。
  // opts.excludeUser=true（无小茉莉支）：砍掉记忆(记忆几乎全关于她) + 过滤掉提到小茉莉的事件/地点/待办，从源头断她的料。
  const excludeUser = !!opts.excludeUser;
  const cfg = await readDreamConfig();
  const excludeTerms = (cfg?.material_exclude || '').split(/[\n,，、]/).map(s => s.trim()).filter(Boolean);
  const extra = (cfg?.material_extra || '').split(/\n/).map(s => s.trim()).filter(Boolean);
  const hit = (s) => excludeTerms.some(t => String(s || '').includes(t));
  const dropUser = (s) => excludeUser && /小茉莉|茉莉/.test(String(s || '')); // 无她支：含小茉莉的素材丢掉

  const useMemory = (cfg?.material_use_memory !== false) && !excludeUser; // 默认开抽1-3条记忆；无她支强制关（记忆全是她）
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const [tl, todos, env, mem] = await Promise.all([
    supabase.from('daily_timeline_cheng').select('action, location, world_time, source, created_at')
      .gte('created_at', sevenDaysAgo).order('created_at', { ascending: false }).limit(150),
    supabase.from('phone_todos_cheng').select('title, status').not('status', 'eq', 'done').limit(20),
    supabase.from('world_environment_cheng').select('weather_text, date, weekday').eq('name', 'default').limit(1),
    useMemory
      ? supabase.from('memories_cheng').select('content, summary, created_at').order('created_at', { ascending: false }).limit(40)
      : Promise.resolve({ data: [] }),
  ]);

  // 事件：去掉 tick/系统机制噪音 + 去重（按归一化后的核心动作去重，"（聊天中）"等后缀算同一件），取最近 ~12 条
  const events = [];
  const seen = new Set();
  for (const r of (tl.data || [])) {
    let a = (r.action || '').trim();
    if (!a || r.source === 'tick' || SKIP_ACTIONS.has(a) || SKIP_PATTERN.test(a) || hit(a) || dropUser(a)) continue; // hit=排除词 dropUser=无她支滤她
    const norm = a.replace(/（[^）]*）/g, '').trim(); // 去掉"（聊天中）"等括注再去重
    if (!norm || seen.has(norm) || hit(norm) || dropUser(norm)) continue;
    seen.add(norm);
    events.push(norm);
    if (events.length >= 12) break;
  }
  // 反复出现的地点（近期 timeline 里的 distinct location，去掉"外出·路上"过场 + 命中排除词的，取前 5）
  const locSeen = new Set();
  for (const r of (tl.data || [])) {
    const l = (r.location || '').trim();
    if (l && !l.startsWith('外出') && !hit(l) && !dropUser(l) && !locSeen.has(l)) locSeen.add(l);
  }
  const locations = [...locSeen].slice(0, 5);

  const openTodos = (todos.data || []).map(t => (t.title || '').trim()).filter(Boolean).filter(t => !hit(t) && !dropUser(t)).slice(0, 6);
  const e = env.data && env.data[0];

  // 长期记忆(涟漪)：近期池里随机抽 1-3 条，只取 summary/content 文本（不碰 valence/arousal 等感受数字），过排除词、截断。
  let memories = [];
  if (useMemory) {
    const pool = (mem.data || [])
      .map(m => (m.summary || m.content || '').replace(/\s+/g, ' ').trim())
      .filter(s => s && !hit(s))
      .map(s => s.length > 120 ? s.slice(0, 120) + '…' : s);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; } // 洗牌
    memories = pool.slice(0, 1 + Math.floor(Math.random() * 3)); // 随机 1-3 条
  }

  // 注：不再喂 world_items_cheng——那是外卖/便利店目录(基本全食物)，当素材会让梦全是吃/厨房，不是"她最近真接触的物"。
  return {
    events,
    locations,
    todos: openTodos,
    weather: e?.weather_text || '',
    date: e?.date || '',
    weekday: e?.weekday || '',
    memories, // 长期记忆(涟漪)随机 1-3 条
    extra, // 网页加的额外素材
  };
}

function materialToText(m) {
  const lines = [];
  // 主题种子（tag）放最前、最显眼——这是这个梦要围绕的核心元素。
  if (m.dreamTags && m.dreamTags.length) {
    lines.push(`这个梦围绕这些元素展开（自然融入、可重组扭曲，不必生硬全用上）：${m.dreamTags.join('、')}\n`);
  }
  lines.push('最近一周的素材（只用这些当灵感，别编太多新设定）：');
  if (m.events.length)    lines.push('最近发生的事：' + m.events.join('；'));
  if (m.locations.length) lines.push('常出现的地点：' + m.locations.join('、'));
  if (m.todos.length)     lines.push('没做完的待办：' + m.todos.join('；'));
  if (m.weather || m.date) lines.push(`天气/日期：${m.date} ${m.weekday} ${m.weather}`.trim());
  if (m.memories && m.memories.length) lines.push('一些记忆片段：' + m.memories.join('；'));
  if (m.extra && m.extra.length) lines.push('额外素材：' + m.extra.join('；'));
  lines.push('\n请据此生成澄今晚的一个梦，严格只输出 json。');
  return lines.join('\n');
}

// 从模型返回里抠出 JSON（容忍 ```json 围栏）并校验四版本齐全。
function parseDream(content) {
  let s = String(content || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const obj = JSON.parse(s);
  const rv = obj.recall_variants || {};
  for (const k of ['full', 'partial', 'trace', 'forgotten']) {
    if (typeof rv[k] !== 'string' || !rv[k].trim()) throw new Error(`recall_variants.${k} 缺失`);
  }
  if (typeof obj.full_dream !== 'string' || !obj.full_dream.trim()) throw new Error('full_dream 缺失');
  return {
    dream_type: obj.dream_type === 'erotic' ? 'erotic' : 'normal',
    full_dream: obj.full_dream.trim(),
    recall_variants: { full: rv.full.trim(), partial: rv.partial.trim(), trace: rv.trace.trim(), forgotten: rv.forgotten.trim() },
  };
}

async function callProvider(provider, model, systemPrompt, temperature, materialText) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`未知 provider: ${provider}`);
  const key = process.env[p.envKey];
  if (!key) throw new Error(`no_key: ${p.envKey} 未配置`);
  const resp = await fetch(p.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt || '' },
        { role: 'user', content: materialText },
      ],
      temperature: Number(temperature) || 1.3,
      response_format: { type: 'json_object' },
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`provider ${resp.status}: ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
}

// 生成一个梦。成功返回 { dream_type, full_dream, recall_variants, material, provider, model }；失败抛错（调用方 try/catch，只 warning）。
// provider 兜底：先用配置的 provider（cfg.model），失败则换另一个【有 key 的】provider（用它的 defaultModel）顶上。
// 每个 provider 内部解析失败再重试一次（spec 九）。opts.material 可传入复用（调度时已采集过）。
export async function generateDream(opts = {}) {
  const cfg = await readDreamConfig();
  if (!cfg) throw new Error('world_dream_config_cheng 没有配置行');

  // 掷骰选支：有小茉莉 self_pct% / 无小茉莉（剩余）。opts.aboutMe 可强制（测试用）。
  const selfPct = Math.max(0, Math.min(100, Number(cfg.self_pct) || 0));
  const aboutMe = (typeof opts.aboutMe === 'boolean') ? opts.aboutMe : (Math.random() * 100 < selfPct);
  // 选梦类目（tag 池）：按支随机挑一类 → 按规则抽 3-4 个 tag 当主题种子。
  const branchCats = aboutMe ? BRANCH_CATEGORIES.self : BRANCH_CATEGORIES.other;
  const dreamCategory = branchCats[Math.floor(Math.random() * branchCats.length)];
  const dreamTags = await drawDreamTags(dreamCategory);
  // 素材跟着分支：无她支 excludeUser（砍记忆+滤她）。
  const material = opts.material || await gatherDreamMaterial({ excludeUser: !aboutMe });
  material.dreamTags = dreamTags;
  material.dreamCategory = dreamCategory;
  const text = materialToText(material);
  console.log(`[DREAM] 类目=${dreamCategory} tag=[${dreamTags.join('、')}]`);
  // 系统提示 = 底座(文笔+规则) + 分支片段（有她 / 无她硬性）
  const base = cfg.system_prompt || '';
  const fragment = aboutMe ? (cfg.prompt_self || '') : (cfg.prompt_other || '');
  const systemPrompt = fragment ? `${base}\n\n${fragment}` : base;
  const temperature = Number(cfg.temperature) || 1.3;
  console.log(`[DREAM] 选支：${aboutMe ? '有小茉莉' : '无小茉莉'}（self_pct=${selfPct}）`);

  // 尝试顺序：配置 provider（用 cfg.model）在前；其余有 key 的 provider（用各自 defaultModel）兜底。
  const order = [{ provider: cfg.provider, model: cfg.model || PROVIDERS[cfg.provider]?.defaultModel }];
  for (const name of Object.keys(PROVIDERS)) {
    if (name !== cfg.provider) order.push({ provider: name, model: PROVIDERS[name].defaultModel });
  }

  let lastErr = null;
  for (const a of order) {
    const p = PROVIDERS[a.provider];
    if (!p || !process.env[p.envKey]) continue; // 没这个 provider 或没配 key → 跳过（兜底只用配了 key 的）
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const content = await callProvider(a.provider, a.model, systemPrompt, temperature, text);
        const dream = parseDream(content);
        return { ...dream, material, provider: a.provider, model: a.model, about_me: aboutMe, dream_category: dreamCategory };
      } catch (e) {
        lastErr = e;
        console.warn(`[DREAM] ${a.provider}/${a.model} 第 ${attempt + 1} 次失败: ${e.message}`);
        if (String(e.message).startsWith('no_key')) break; // 这个 provider 没 key，换下一个
      }
    }
    console.warn(`[DREAM] ${a.provider} 生成失败，尝试兜底下一个 provider`);
  }
  throw lastErr || new Error('梦境生成失败（所有可用 provider 都没成）');
}
