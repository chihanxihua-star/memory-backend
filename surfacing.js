// surfacing.js — 浮现机制
// 用户每条消息进来时：
//   1. 检查冷却 (turns since last surface ≥ SURFACING_COOLDOWN)
//   2. 调 search-memory-cheng / 看 board_cheng 未读 / 5% 抽 L2 记忆
//   3. 命中 → 写 /home/claude-user/.claude/CLAUDE.md 的 <浮现> 区域
//   4. 没命中 → 清空标签，但不重置冷却（下一轮还能再试）

import fs from 'fs';
import path from 'path';
import { supabase } from './memory.js';

const FUXIAN_PATH = '/home/claude-user/.claude/CLAUDE.md';
const FUXIAN_OPEN = '<浮现>';
const FUXIAN_CLOSE = '</浮现>';
const RECENT_IDS_CAP = 20;

const COOLDOWN = parseInt(process.env.SURFACING_COOLDOWN || '5', 10);
const MAX_ITEMS = parseInt(process.env.SURFACING_MAX_ITEMS || '3', 10);
const ECHO_CHANCE = parseFloat(process.env.SURFACING_ECHO_CHANCE || '0.05');
const SELF_AUTHOR = process.env.SURFACING_SELF_AUTHOR || '澄';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

// 模块状态（进程内）
let turnsSinceLast = COOLDOWN; // 启动后第一条就可触发
const recentIds = [];

function pushRecent(id) {
  if (!id) return;
  recentIds.push(id);
  if (recentIds.length > RECENT_IDS_CAP) recentIds.length = 0;
}

// ─────── 数据源 ───────
async function searchMemory(query) {
  try {
    const r = await fetch(`${SB_URL}/functions/v1/search-memory-cheng`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${SB_KEY}`,
      },
      body: JSON.stringify({ query, limit: MAX_ITEMS, target: 'cc' }),
    });
    if (!r.ok) return [];
    const j = await r.json();
    const rows = Array.isArray(j) ? j : (j.results || j.data || []);
    return rows
      .filter(row => row && row.id && !recentIds.includes(row.id))
      .map(row => ({
        id: row.id,
        summary: (row.summary || row.content || '').trim(),
        created_at: row.created_at,
        source: 'search',
      }))
      .filter(it => it.summary);
  } catch (e) {
    console.error('[surfacing] searchMemory failed:', e.message);
    return [];
  }
}

async function getUnreadBoard() {
  try {
    const { data, error } = await supabase
      .from('board_cheng')
      .select('id, author, content, created_at')
      .eq('is_read', false)
      .neq('author', SELF_AUTHOR)
      .order('created_at', { ascending: false })
      .limit(MAX_ITEMS);
    if (error) return [];
    return (data || [])
      .filter(row => (row.content || '').trim())
      .map(row => ({
        id: row.id,
        author: row.author || '某位访客',
        content: (row.content || '').trim(),
        created_at: row.created_at,
        source: 'board',
      }));
  } catch (e) {
    console.error('[surfacing] getUnreadBoard failed:', e.message);
    return [];
  }
}

async function getRandomL2() {
  if (Math.random() >= ECHO_CHANCE) return null;
  try {
    // 抽 N 条 L2，过滤掉最近浮现过的，随机选一条
    const { data, error } = await supabase
      .from('memories_cheng')
      .select('id, summary, content, created_at')
      .eq('level', 2)
      .order('ref_count', { ascending: true, nullsFirst: true })
      .limit(15);
    if (error) return null;
    const pool = (data || []).filter(row => row.id && !recentIds.includes(row.id));
    if (pool.length === 0) return null;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const text = (pick.summary || pick.content || '').trim();
    if (!text) return null;
    return {
      id: pick.id,
      summary: text,
      created_at: pick.created_at,
      source: 'rumination',
    };
  } catch (e) {
    console.error('[surfacing] getRandomL2 failed:', e.message);
    return null;
  }
}

// ─────── 渲染 ───────
function fuzzyTime(createdAt) {
  if (!createdAt) return '之前';
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86400000;
  if (ageDays < 7) return '前几天';
  if (ageDays < 30) return '前阵子';
  if (ageDays < 180) return '之前';
  return '很久以前';
}

function renderItem(item) {
  if (item.source === 'board') {
    return `${item.author}在留言板说了什么……${item.content}`;
  }
  if (item.source === 'rumination') {
    return `有一次……${item.summary}`;
  }
  return `${fuzzyTime(item.created_at)}……${item.summary}`;
}

function renderBlock(items) {
  if (!items.length) return `${FUXIAN_OPEN}\n${FUXIAN_CLOSE}`;
  const lines = items.map(renderItem);
  return `${FUXIAN_OPEN}\n${lines.join('\n')}\n${FUXIAN_CLOSE}`;
}

// ─────── 写文件 ───────
function getClaudeUserIds() {
  try {
    const st = fs.statSync('/home/claude-user');
    return [st.uid, st.gid];
  } catch {
    return null;
  }
}

async function writeBlock(blockText) {
  const dir = path.dirname(FUXIAN_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    const ids = getClaudeUserIds();
    if (ids) { try { fs.chownSync(dir, ids[0], ids[1]); } catch {} }
  }

  let existing = '';
  try { existing = await fs.promises.readFile(FUXIAN_PATH, 'utf8'); } catch {}

  const openIdx = existing.indexOf(FUXIAN_OPEN);
  const closeIdx = existing.indexOf(FUXIAN_CLOSE);
  let next;
  if (openIdx !== -1 && closeIdx !== -1 && closeIdx > openIdx) {
    next = existing.slice(0, openIdx) + blockText + existing.slice(closeIdx + FUXIAN_CLOSE.length);
  } else {
    const sep = existing && !existing.endsWith('\n') ? '\n\n' : (existing ? '\n' : '');
    next = existing + sep + blockText + '\n';
  }

  await fs.promises.writeFile(FUXIAN_PATH, next, 'utf8');
  const ids = getClaudeUserIds();
  if (ids) { try { fs.chownSync(FUXIAN_PATH, ids[0], ids[1]); } catch {} }
}

// ─────── 主入口 ───────
export async function runSurfacing(userText) {
  if (!userText || typeof userText !== 'string') return;

  turnsSinceLast += 1;
  if (turnsSinceLast < COOLDOWN) return;

  let items = [];

  const [boardItems, searchItems, rumination] = await Promise.all([
    getUnreadBoard(),
    searchMemory(userText),
    getRandomL2(),
  ]);

  // 优先级：board > search > rumination
  items = items.concat(boardItems);
  items = items.concat(searchItems);
  if (rumination) items.push(rumination);

  // 去重 + 截断
  const seen = new Set();
  items = items.filter(it => {
    const k = `${it.source}:${it.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, MAX_ITEMS);

  try {
    await writeBlock(renderBlock(items));
  } catch (e) {
    console.error('[surfacing] writeBlock failed:', e.message);
    return;
  }

  if (items.length > 0) {
    for (const it of items) {
      if (it.source !== 'board') pushRecent(it.id);
    }
    turnsSinceLast = 0;
    console.log(`[surfacing] surfaced ${items.length} item(s):`,
      items.map(it => `${it.source}:${String(it.id).slice(0, 8)}`).join(', '));
  } else {
    console.log('[surfacing] no items — cleared block');
  }
}
