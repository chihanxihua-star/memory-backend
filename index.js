import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { spawn as spawnProc, spawnSync } from 'child_process';
import * as pty from 'node-pty';
import { supabase, writeMemory, searchMemory, getDefaultProject } from './memory.js';
import { CCProcessManager } from './cc-manager.js';
import { runSurfacing } from './surfacing.js';
import {
  parseBarkTags,
  removeBarkTags,
  saveBarkSchedules,
  findDuePending as findDueBarkPending,
  markFired as markBarkFired,
  pushBark,
  buildFirePrompt as buildBarkFirePrompt,
  fetchAppSummary,
} from './bark.js';

const CC_CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cc-runtime.json');

function loadCCConfig() {
  try {
    const raw = fs.readFileSync(CC_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}
function saveCCConfig(patch) {
  try {
    const cur = loadCCConfig();
    const next = { ...cur, ...patch };
    fs.writeFileSync(CC_CONFIG_PATH, JSON.stringify(next), 'utf-8');
  } catch (e) {
    console.error('保存 CC 运行配置失败:', e);
  }
}

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });          // 聊天 WS（默认路径）
const wssTerminal = new WebSocketServer({ noServer: true });  // 终端 WS（/terminal）

// 按路径分流 WS upgrade
server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch {}
  if (pathname === '/terminal') {
    wssTerminal.handleUpgrade(req, socket, head, (ws) => wssTerminal.emit('connection', ws, req));
  } else {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// ==================== 鉴权 ====================
let AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const JWT_TTL = process.env.JWT_TTL || '30d';
const ENV_PATH = path.join(__dirname, '.env');

if (!AUTH_PASSWORD) console.warn('⚠️  AUTH_PASSWORD 未配置，/api/auth 会一直返回 500');
if (!JWT_SECRET) console.warn('⚠️  JWT_SECRET 未配置，鉴权将拒绝所有请求');

function signAuthToken() {
  return jwt.sign({ scope: 'app' }, JWT_SECRET, { expiresIn: JWT_TTL });
}
function verifyAuthToken(token) {
  if (!token || !JWT_SECRET) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// 把 .env 里 AUTH_PASSWORD 那一行改写成新值；同时同步进程内变量
function persistAuthPassword(newPassword) {
  let raw = '';
  try { raw = fs.readFileSync(ENV_PATH, 'utf-8'); } catch { raw = ''; }
  const lines = raw.split(/\r?\n/);
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^AUTH_PASSWORD\s*=/.test(lines[i])) {
      lines[i] = `AUTH_PASSWORD=${newPassword}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) lines.push(`AUTH_PASSWORD=${newPassword}`);
  fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf-8');
  AUTH_PASSWORD = newPassword;
  process.env.AUTH_PASSWORD = newPassword;
}

// 公开（仅本机）：forge 触发的无缝 restart
app.post('/api/internal/cc/restart', async (req, res) => {
  const ip = (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip !== '127.0.0.1' && ip !== '::1') {
    return res.status(403).json({ error: 'forbidden (loopback only)' });
  }
  try {
    const sysPrompt = await syncCCDocs();
    cc.setAppendSystemPrompt(sysPrompt);
    await cc.restart();
    res.json({ ok: true, session: cc.sessionId, resumed: !!cc.resumedFromForge });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 公开：登录换 token
app.post('/api/auth', (req, res) => {
  const { password } = req.body || {};
  if (!AUTH_PASSWORD || !JWT_SECRET) {
    return res.status(500).json({ error: 'server auth not configured' });
  }
  if (typeof password !== 'string' || password !== AUTH_PASSWORD) {
    return res.status(401).json({ error: 'invalid password' });
  }
  res.json({ token: signAuthToken(), expires_in: JWT_TTL });
});

// 中间件：除了 /api/auth 和 /api/internal/* 之外的所有 /api/* 都要 Bearer
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/auth') return next();
  if (req.path.startsWith('/api/internal/')) return next();
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (!m || !verifyAuthToken(m[1])) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// 已登录：改密码（需 Bearer，由上面的中间件保护）
app.post('/api/auth/change-password', (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!AUTH_PASSWORD || !JWT_SECRET) {
    return res.status(500).json({ error: 'server auth not configured' });
  }
  if (typeof current_password !== 'string' || current_password !== AUTH_PASSWORD) {
    return res.status(401).json({ error: 'current password incorrect' });
  }
  if (typeof new_password !== 'string' || new_password.length < 4) {
    return res.status(400).json({ error: 'new password too short' });
  }
  if (new_password === current_password) {
    return res.status(400).json({ error: 'new password same as current' });
  }
  try {
    persistAuthPassword(new_password);
    console.log('🔑 AUTH_PASSWORD 已更新');
    res.json({ ok: true });
  } catch (e) {
    console.error('密码写入 .env 失败:', e);
    res.status(500).json({ error: 'failed to persist new password: ' + e.message });
  }
});

// ==================== CC 常驻进程 ====================
const SANDBOX_DIR = '/home/claude-user/chat-sandbox';
const CC_PROJECT_ID = 'b5e5d83a-0c17-4421-a0e2-217519ed62fb';

let _claudeUserIds = null;
function getClaudeUserIds() {
  if (_claudeUserIds) return _claudeUserIds;
  try {
    const st = fs.statSync(SANDBOX_DIR);
    _claudeUserIds = [st.uid, st.gid];
  } catch { _claudeUserIds = null; }
  return _claudeUserIds;
}

async function writeAsClaudeUser(filePath, content) {
  await fs.promises.writeFile(filePath, content ?? '', 'utf8');
  const ids = getClaudeUserIds();
  if (ids) { try { fs.chownSync(filePath, ids[0], ids[1]); } catch {} }
}

// <上次对话总结> 区段标记 —— 跟 <浮现> 同样的 marker 模式：
//   - syncCCDocs 写 CLAUDE.md 前抽这段保留，确保 supabase 文档覆盖不会冲掉
//   - forge 后由 writeForgeSummary 替换这段内容
const SUMMARY_OPEN = '<上次对话总结>';
const SUMMARY_CLOSE = '</上次对话总结>';
const SUMMARY_REGEX = /<上次对话总结>[\s\S]*?<\/上次对话总结>/;

function extractSummaryBlock(text) {
  if (!text) return null;
  const m = SUMMARY_REGEX.exec(text);
  return m ? m[0] : null;
}

// <浮现> 区段：surfacing.js 写入用的同一个文件，失忆时跟着清空
const FUXIAN_CLAUDE_MD = '/home/claude-user/.claude/CLAUDE.md';
const FUXIAN_REGEX = /<浮现>[\s\S]*?<\/浮现>/;

async function clearFuxianBlock() {
  let existing;
  try { existing = await fs.promises.readFile(FUXIAN_CLAUDE_MD, 'utf8'); }
  catch { return; } // 文件不存在就什么都不用做
  if (!FUXIAN_REGEX.test(existing)) return;
  const next = existing.replace(FUXIAN_REGEX, '<浮现>\n</浮现>');
  await writeAsClaudeUser(FUXIAN_CLAUDE_MD, next);
}

function estimateTokens(s) {
  let t = 0;
  for (let i = 0; i < s.length; i++) t += s.charCodeAt(i) > 0x7f ? 1.0 : 0.25;
  return Math.ceil(t);
}

// JSONL 是否会被 forge 截断 —— 跟 forge_reload.py 的 estimate_tokens 算法对齐
// （len(json.dumps(ev))//3，仅累计 user/assistant），返回累计 tokens
function estimateJsonlTokens(jsonlPath) {
  let total = 0;
  try {
    const raw = fs.readFileSync(jsonlPath, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'user' || ev.type === 'assistant') {
          total += Math.floor(JSON.stringify(ev).length / 3);
        }
      } catch {}
    }
  } catch {}
  return total;
}

function readRetainTokens() {
  try {
    const cfg = JSON.parse(fs.readFileSync(FORGE_CONFIG_PATH, 'utf-8'));
    return parseInt(cfg.retain_tokens) || 100000;
  } catch { return 100000; }
}

async function writeForgeSummary(summaryText) {
  const filePath = path.join(SANDBOX_DIR, 'CLAUDE.md');
  let existing = '';
  try { existing = await fs.promises.readFile(filePath, 'utf8'); } catch {}
  const clean = (summaryText || '').trim();
  const block = clean
    ? `${SUMMARY_OPEN}\n${clean}\n${SUMMARY_CLOSE}`
    : `${SUMMARY_OPEN}\n${SUMMARY_CLOSE}`;
  let next;
  const openIdx = existing.indexOf(SUMMARY_OPEN);
  const closeIdx = existing.indexOf(SUMMARY_CLOSE);
  if (openIdx !== -1 && closeIdx !== -1 && closeIdx > openIdx) {
    next = existing.slice(0, openIdx) + block + existing.slice(closeIdx + SUMMARY_CLOSE.length);
  } else {
    const sep = existing && !existing.endsWith('\n') ? '\n\n' : (existing ? '\n' : '');
    next = existing + sep + block + '\n';
  }
  await writeAsClaudeUser(filePath, next);
}

// syncCCDocs 写过的 file 名字 manifest —— 用来识别"上次写过、这次 db 里没了"的孤儿
// 只用本进程同目录下的 .synced-cc-files.json，不放 SANDBOX_DIR（避免 CC 看到这个内部状态）
const SYNCED_FILES_MANIFEST = path.join(__dirname, '.synced-cc-files.json');

function readSyncedFilesManifest() {
  try {
    const raw = fs.readFileSync(SYNCED_FILES_MANIFEST, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function writeSyncedFilesManifest(names) {
  try {
    const sorted = [...new Set(names)].sort();
    fs.writeFileSync(SYNCED_FILES_MANIFEST, JSON.stringify(sorted, null, 2), 'utf-8');
  } catch (e) {
    console.warn('synced-cc-files manifest 写入失败:', e.message);
  }
}

// 从 documents_cheng 拉所有 mode='cc' 的文档：
//  - claude_md  → 写入 CLAUDE.md（保留 <上次对话总结> 区段不覆盖）
//  - file       → 写入工作目录下同名文件
//  - system_prompt → 返回内容，由调用方传给 cc.setAppendSystemPrompt
// 同步结束后删除孤儿：上次写过、这次 db 里没了的 file 文件
// （只删 manifest 里登记过的名字，手动放进 SANDBOX_DIR 的 SKILL.pdf 等不会被误删）
async function syncCCDocs() {
  try {
    const { data, error } = await supabase
      .from('documents_cheng')
      .select('doc_type, name, content')
      .eq('mode', 'cc')
      .eq('project_id', CC_PROJECT_ID);
    if (error) throw error;

    let appendSystemPrompt = null;
    const currentFileNames = new Set();
    for (const d of data || []) {
      try {
        if (d.doc_type === 'claude_md') {
          // 跟 <浮现> 同款处理：覆盖前先抽 <上次对话总结> 区段保留，避免被 supabase 文档冲掉
          const claudeMdPath = path.join(SANDBOX_DIR, 'CLAUDE.md');
          let merged = d.content || '';
          try {
            const cur = await fs.promises.readFile(claudeMdPath, 'utf8');
            const block = extractSummaryBlock(cur);
            if (block) {
              const sep = merged && !merged.endsWith('\n') ? '\n\n' : (merged ? '\n' : '');
              merged = merged + sep + block + '\n';
            }
          } catch {}
          await writeAsClaudeUser(claudeMdPath, merged);
          console.log('📄 同步 CLAUDE.md');
        } else if (d.doc_type === 'system_prompt') {
          appendSystemPrompt = d.content || null;
          console.log(`📝 加载 system_prompt (${(d.content || '').length} 字)`);
        } else if (d.doc_type === 'file' && d.name) {
          const safeName = path.basename(d.name);
          currentFileNames.add(safeName);
          await writeAsClaudeUser(path.join(SANDBOX_DIR, safeName), d.content || '');
          console.log(`📁 同步文件 ${safeName}`);
        }
      } catch (e) {
        console.error(`同步 ${d.doc_type}/${d.name || ''} 失败:`, e.message);
      }
    }

    // 孤儿删除：上次同步写过、本次 db 里不再存在的 file 名字 → 从 SANDBOX_DIR 删掉
    // CLAUDE.md / 手动放置的文件 / .claude 系列因为不在 manifest，永远不会被碰
    const prevSynced = readSyncedFilesManifest();
    for (const oldName of prevSynced) {
      if (currentFileNames.has(oldName)) continue;
      const oldPath = path.join(SANDBOX_DIR, oldName);
      try {
        await fs.promises.unlink(oldPath);
        console.log(`🗑️  删除孤儿文件 ${oldName}`);
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`删除 ${oldName} 失败:`, e.message);
      }
    }
    writeSyncedFilesManifest(currentFileNames);

    return appendSystemPrompt;
  } catch (e) {
    console.error('文档同步失败:', e.message);
    return null;
  }
}

const savedCfg = loadCCConfig();
const cc = new CCProcessManager({
  cwd: SANDBOX_DIR,
  effort: savedCfg.effort || 'high',
  model: savedCfg.model || null,
});
// 启动前先把 documents_cheng 的内容拉下来落盘 + 注入 system_prompt
const _initSysPrompt = await syncCCDocs();
cc.setAppendSystemPrompt(_initSysPrompt);
cc.start();

let activeTurn = null; // { ws, conversationId, settings, silent }
const summaryTriggers = new Map(); // conversation_id -> last k triggered
let pendingSummary = null; // { conversationId, summaryLength }
let lastActiveConvId = null; // bark 主动消息存到最近活跃的对话

// 短消息模式：累积用户消息，bufferTime 内无新消息就合并发给 CC
// { ws, items: [{content, imgs, conversation_id, settings}], timer, readyToFlush }
let pendingBuffer = null;

// 给 CC 的时间戳注入：间隔超过 15 分钟才在消息前加一行（仅 CC 侧，DB 存原文）
const CC_TIME_GAP_MS = 15 * 60 * 1000;
const convLastMsgTime = new Map();
function maybeTimePrefix(content, conversationId) {
  if (!conversationId) return content;
  const now = Date.now();
  const last = convLastMsgTime.get(conversationId) || 0;
  convLastMsgTime.set(conversationId, now);
  if (!last || now - last < CC_TIME_GAP_MS) return content;
  const gap = Math.round((now - last) / 60000);
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const gapStr = gap >= 60
    ? `${Math.floor(gap / 60)} 小时${gap % 60 ? ' ' + (gap % 60) + ' 分钟' : ''}`
    : `${gap} 分钟`;
  return `[时间标记：现在 ${timeStr}，距上次消息 ${gapStr}]\n${content}`;
}

async function checkContextThreshold(conversationId, settings) {
  if (!conversationId) return;
  const threshold = Number(settings?.compressThreshold) || 50000;
  const summaryLength = Number(settings?.summaryLength) || 500;
  try {
    const { data } = await supabase
      .from('messages')
      .select('content')
      .eq('conversation_id', conversationId);
    const totalChars = (data || []).reduce((s, m) => s + (m.content?.length || 0), 0);
    for (const c of wss.clients) {
      safeSend(c, { type: 'char_count', conversation_id: conversationId, total: totalChars, threshold });
    }
    const k = Math.floor(totalChars / threshold);
    const prevK = summaryTriggers.get(conversationId) || 0;
    if (k > prevK && k >= 1) {
      summaryTriggers.set(conversationId, k);
      console.log(`⚠️  对话 ${conversationId} 字数 ${totalChars} 超过阈值 ${threshold}（k=${k}）`);
      for (const c of wss.clients) {
        safeSend(c, { type: 'toast', message: '上下文快满了，建议重启 CC', action: 'restart_cc' });
      }
      pendingSummary = { conversationId, summaryLength };
      maybeFireSummary();
    }
  } catch (e) {
    console.error('上下文阈值检查失败:', e);
  }
}

function maybeFireSummary() {
  if (!pendingSummary || activeTurn || !cc.isRunning()) return;
  const { conversationId, summaryLength } = pendingSummary;
  pendingSummary = null;
  const prompt = `【系统任务·自动小结】\n请根据我们当前对话已发生的上下文，写一段约 ${summaryLength} 字的中文摘要，概括关键内容、重要决定、情感状态与未完成事项。除记忆标记外不要输出其他任何内容。格式必须是：\n[MEMORY:diary]在此填写摘要正文|tags:小结|importance:0.7[/MEMORY]`;
  activeTurn = { ws: null, conversationId: null, silent: true, settings: null, tools: [] };
  try {
    cc.send(prompt);
    console.log('📝 已触发自动摘要');
  } catch (e) {
    console.error('自动摘要发送失败:', e);
    activeTurn = null;
  }
}

function safeSend(ws, obj) {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {}
}
function broadcast(obj) {
  for (const c of wss.clients) safeSend(c, obj);
}

cc.on('state', (state) => broadcast({ type: 'cc_status', status: state }));

cc.on('turn_start', () => {
  if (activeTurn) safeSend(activeTurn.ws, { type: 'start' });
});

cc.on('text_delta', (text) => {
  if (activeTurn) safeSend(activeTurn.ws, { type: 'delta', text });
});

cc.on('thinking_delta', (text) => {
  if (activeTurn) safeSend(activeTurn.ws, { type: 'thinking', text });
});

cc.on('tool_use', ({ id, name, input }) => {
  if (!activeTurn) return;
  activeTurn.tools.push({ id, name, input, result: undefined, isError: false });
  safeSend(activeTurn.ws, { type: 'tool_use', id, name, input });
});

cc.on('tool_result', ({ tool_use_id, content, is_error }) => {
  if (!activeTurn) return;
  const t = activeTurn.tools.find(t => t.id === tool_use_id);
  if (t) { t.result = content; t.isError = !!is_error; }
  safeSend(activeTurn.ws, { type: 'tool_result', tool_use_id, content, is_error });
});

cc.on('turn_done', async ({ text, thinking, usage, contextTokens, systemTokens, is_error }) => {
  const turn = activeTurn;
  activeTurn = null;
  if (!turn) return;

  if (turn.stopped) {
    maybeFireSummary();
    tryFlushBuffer();
    tryFireBark();
    return;
  }

  if (text) {
    const memories = parseMemoryTags(text);
    for (const m of memories) {
      try {
        await writeMemory(m);
        console.log(`💾 记忆: [${m.layer}] ${m.content.slice(0, 50)}`);
      } catch (e) { console.error('写记忆失败:', e); }
    }
    // [BARK:...] 入库；barkFire 轮内禁止再排程，避免循环
    if (!turn.barkFire) {
      const barkTags = parseBarkTags(text);
      if (barkTags.length) {
        try { await saveBarkSchedules(barkTags, cc.sessionId); }
        catch (e) { console.error('[BARK] 写库失败:', e); }
      }
    }
  }

  const clean = removeBarkTags(removeMemoryTags(text || ''));

  // barkFire 轮：推到手机 + 存 DB + 广播 ws
  if (turn.barkFire) {
    const skip = /\[SKIP\]/i.test(clean);
    if (skip) {
      console.log(`[BARK] CC 选择跳过 ${turn.barkScheduleId}`);
    } else {
      const body = clean
        .replace(/---bubble---/g, ' ')
        .replace(/\[SKIP\]/gi, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n+/g, ' ')
        .trim();
      if (body) {
        const ok = await pushBark({ title: '澄', body });
        console.log(`[BARK] 推送 ${turn.barkScheduleId}: ${ok ? 'ok' : 'failed'} (${body.slice(0, 40)})`);
        // 存到 messages 并广播到前端
        if (lastActiveConvId) {
          try {
            const { data: row } = await supabase.from('messages').insert({
              conversation_id: lastActiveConvId,
              role: 'assistant',
              content: clean,
              event: 'bark',
            }).select('id, created_at').single();
            broadcast({
              type: 'bark_msg',
              conversation_id: lastActiveConvId,
              message: {
                id: row?.id || 'bark-' + Date.now(),
                role: 'assistant',
                content: clean,
                event: 'bark',
                created_at: row?.created_at || new Date().toISOString(),
              },
            });
          } catch (e) { console.error('[BARK] 存消息/广播失败:', e); }
        }
      } else {
        console.warn(`[BARK] ${turn.barkScheduleId} 生成空消息，跳过推送`);
      }
    }
    try { await markBarkFired(turn.barkScheduleId); }
    catch (e) { console.warn('[BARK] markFired 异常:', e); }
    maybeFireSummary();
    tryFlushBuffer();
    tryFireBark();
    return;
  }

  if (turn.conversationId && clean && !turn.silent) {
    try {
      // token_input 存的是"等效 input"——按缓存类型加权后的费率等价 token 数：
      //   input_tokens         × 1.0   （未缓存，全价）
      //   cache_read_input     × 0.1   （命中，省 90%）
      //   cache_creation_input × 2.0   （写入 1h 缓存，押金 2 倍；若切回 5min 改成 1.25）
      // 前端 turnIncrement = token_input + token_output 直接反映这轮"等效成本"，
      // 命中缓存的轮次累计涨得慢，符合实际计费。
      const equivInput = Math.round(
        (usage.input_tokens || 0) * 1.0
        + (usage.cache_read_input_tokens || 0) * 0.1
        + (usage.cache_creation_input_tokens || 0) * 2.0
      );
      await supabase.from('messages').insert({
        conversation_id: turn.conversationId,
        role: 'assistant',
        content: clean,
        thinking: thinking || null,
        tool_calls: turn.tools && turn.tools.length ? turn.tools : null,
        token_input: equivInput,
        token_output: usage.output_tokens,
        cache_detail: {
          input: usage.input_tokens || 0,
          cache_read: usage.cache_read_input_tokens || 0,
          cache_creation: usage.cache_creation_input_tokens || 0,
        },
      });
      await checkContextThreshold(turn.conversationId, turn.settings);
    } catch (e) { console.error('存消息失败:', e); }
  }

  if (!turn.silent) {
    if (text !== clean) safeSend(turn.ws, { type: 'clean', text: clean });
    safeSend(turn.ws, { type: 'done', usage, contextTokens, systemTokens, is_error });
  }

  // sessions_cheng.turn_count +1 + 同步当前实际上下文 tokens（不阻塞主流程；单用户系统不担心并发竞争）
  bumpSessionTurnAndTokens(cc.sessionId, contextTokens || cc.lastInputTokens).catch(e =>
    console.warn('bump session row:', e?.message || e)
  );

  maybeFireSummary();
  tryFlushBuffer(); // 这轮完了，如果用户在生成期间排了队就发出去
  tryFireBark();
});

async function bumpSessionTurnAndTokens(sessionId, tokensTotal) {
  if (!sessionId) return;
  const { data: row, error: selErr } = await supabase
    .from('sessions_cheng')
    .select('turn_count')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (selErr || !row) return;
  const patch = { turn_count: (row.turn_count || 0) + 1 };
  if (typeof tokensTotal === 'number' && tokensTotal > 0) patch.tokens_total = tokensTotal;
  await supabase
    .from('sessions_cheng')
    .update(patch)
    .eq('session_id', sessionId);
}

cc.on('turn_error', (err) => {
  if (activeTurn) {
    if (activeTurn.stopped) {
      safeSend(activeTurn.ws, { type: 'stopped' });
    } else if (activeTurn.barkFire) {
      console.warn(`[BARK] 触发失败 ${activeTurn.barkScheduleId}: ${err.message}`);
      markBarkFired(activeTurn.barkScheduleId).catch(() => {});
    } else {
      safeSend(activeTurn.ws, { type: 'error', message: err.message });
    }
    activeTurn = null;
  }
  tryFlushBuffer();
  tryFireBark();
});

// 轮询 schedules_cheng，到期且 CC 空闲就触发一条
let _barkTickBusy = false;
async function tryFireBark() {
  if (_barkTickBusy) return;
  if (activeTurn || pendingBuffer) return;
  if (!cc.isRunning()) return;
  if (!process.env.BARK_DEVICE_KEY) return;
  _barkTickBusy = true;
  try {
    const sched = await findDueBarkPending();
    if (!sched) return;
    // 拉手机使用数据拼进 prompt；失败也继续，summary=null buildFirePrompt 会跳过那段
    const appSummary = await fetchAppSummary();
    activeTurn = {
      ws: null,
      conversationId: null,
      silent: true,
      settings: null,
      tools: [],
      barkFire: true,
      barkScheduleId: sched.id,
    };
    try {
      cc.send(buildBarkFirePrompt(sched.hint, appSummary));
      console.log(`[BARK] 触发 ${sched.id}: ${sched.hint.slice(0, 40)}${appSummary ? ' (含手机数据)' : ''}`);
    } catch (e) {
      console.error('[BARK] cc.send 失败:', e);
      activeTurn = null;
      await markBarkFired(sched.id).catch(() => {});
    }
  } catch (e) {
    console.error('[BARK] 轮询异常:', e);
  } finally {
    _barkTickBusy = false;
  }
}
const BARK_POLL_MS = 30 * 1000;
setInterval(() => { tryFireBark().catch(() => {}); }, BARK_POLL_MS);

cc.on('error', (err) => {
  console.error('CC error:', err.message);
});

// ==================== REST API ====================

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(__dirname + '/test-chat.html');
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', cc_running: cc.isRunning(), session: cc.sessionId, model: cc.model, effort: cc.effort });
});

app.get('/api/claude-md', (req, res) => {
  try {
    const content = fs.readFileSync('/home/claude-user/chat-sandbox/CLAUDE.md', 'utf-8');
    res.json({ content });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/claude-md', (req, res) => {
  try {
    fs.writeFileSync('/home/claude-user/chat-sandbox/CLAUDE.md', req.body.content, 'utf-8');
    res.json({ ok: true, message: '已保存，下次重启CC生效' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// forge 相关常量：和 forge-reload daemon 写在同一份 config.json，cc-manager 也在同一目录读 marker
const FORGE_RELOAD_DIR = '/root/forge-reload';
const FORGE_RELOAD_SCRIPT = path.join(FORGE_RELOAD_DIR, 'forge_reload.py');
const FORGE_CONFIG_PATH = path.join(FORGE_RELOAD_DIR, 'config.json');
const FORGE_MARKER_PATH = path.join(FORGE_RELOAD_DIR, 'last_forge.json');
// cc-manager.js EXPECTED_PROJECT_DIR 同步：CC 跑在 claude-user 下，session JSONL 在这里
const CC_JSONL_DIR = '/home/claude-user/.claude/projects/-home-claude-user-chat-sandbox';

// forge 之前用 CC 静默轮生成"被截掉部分"的总结。CC 自己看得到完整上下文，
// 让它自判要保留什么。silent:true 让 main turn_done 不持久化到 messages 表。
async function generateForgeSummary({ summaryLength }) {
  if (activeTurn) throw new Error('CC 正在回复，请等它说完再切换模型');
  if (!cc.isRunning()) throw new Error('CC 进程未运行');
  const target = Math.max(200, Math.min(2000, parseInt(summaryLength) || 500));
  const prompt = `【系统任务·forge 总结】\n` +
    `我即将对当前 session 做 forge：截掉最早的对话部分，只保留最近的 retain_tokens。\n` +
    `请用约 ${target} 字写一段中文总结，概括将被截掉的早期部分：\n` +
    `- 我们聊过的关键内容 / 话题脉络\n` +
    `- 重要决定、承诺、约定\n` +
    `- 情感状态变化的节点\n` +
    `- 未完成的事项 / 悬而未决的话\n\n` +
    `仅输出总结正文。不要前置说明，不要 markdown 标题，不要 [MEMORY:] 标签。`;
  activeTurn = { ws: null, conversationId: null, silent: true, settings: null, tools: [] };
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      cc.off('turn_done', onDone);
      cc.off('turn_error', onErr);
      clearTimeout(timer);
    };
    const onDone = ({ text, is_error }) => {
      if (settled) return; settled = true; cleanup();
      if (is_error) reject(new Error('CC 总结失败 (turn is_error)'));
      else resolve(removeMemoryTags((text || '').trim()));
    };
    const onErr = (err) => {
      if (settled) return; settled = true; cleanup();
      activeTurn = null;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const timer = setTimeout(() => {
      if (settled) return; settled = true; cleanup();
      activeTurn = null;
      reject(new Error('总结超时 (120s)'));
    }, 120000);
    cc.on('turn_done', onDone);
    cc.on('turn_error', onErr);
    try {
      cc.send(prompt);
    } catch (e) {
      settled = true; cleanup();
      activeTurn = null;
      reject(e);
    }
  });
}

// forge 后把对话原文喂给新 CC（silent turn），让新进程在 API 层面看到完整上下文。
// < 100k：全部原文；> 100k：最近 ~100k 的原文（被截掉的部分靠 CLAUDE.md 摘要补充）
async function injectConversationContext(conversationId, { withThinking = true } = {}) {
  if (!conversationId || !cc.isRunning()) return;
  if (activeTurn) { console.warn('CC 忙碌，跳过对话注入'); return; }

  const { data: msgs } = await supabase
    .from('messages')
    .select('role, content, thinking')
    .eq('conversation_id', conversationId)
    .neq('role', 'system')
    .order('created_at', { ascending: true });

  if (!msgs || msgs.length === 0) return;

  const filtered = msgs.filter(m => m.content);
  const lines = filtered.map(m => {
    const label = m.role === 'user' ? '小茉莉' : '澄';
    let line = `[${label}] ${m.content}`;
    if (withThinking && m.thinking) line = `[${label}·思考] ${m.thinking}\n[${label}] ${m.content}`;
    return line;
  });

  // 从尾部累加，保留 ~100k tokens 以内
  const TOKEN_CAP = 90000;
  let acc = 0;
  let startIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    acc += estimateTokens(lines[i]);
    if (acc > TOKEN_CAP) break;
    startIdx = i;
  }
  const transcript = lines.slice(startIdx).join('\n\n');
  if (!transcript.trim()) return null;

  const kept = filtered.slice(startIdx);
  const msgCount = kept.length;
  const thinkingCount = withThinking ? kept.filter(m => m.thinking).length : 0;
  const thinkingTokens = withThinking
    ? kept.reduce((s, m) => m.thinking ? s + estimateTokens(m.thinking) : s, 0)
    : 0;
  const estTokens = estimateTokens(transcript) - thinkingTokens;

  const prompt = `【系统任务·对话上下文注入】\n` +
    `以下是你和小茉莉之前的对话原文，请将这些视为你们之间已经发生的真实交流，延续这段关系继续聊天。\n` +
    `仅输出"OK"两个字，不要输出其他任何内容。\n\n` +
    transcript;

  activeTurn = { ws: null, conversationId: null, silent: true, settings: null, tools: [] };
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      cc.off('turn_done', onDone);
      cc.off('turn_error', onErr);
      clearTimeout(timer);
    };
    const onDone = () => {
      if (settled) return; settled = true; cleanup();
      activeTurn = null;
      resolve({ msgCount, estTokens, thinkingCount, thinkingTokens });
    };
    const onErr = (err) => {
      if (settled) return; settled = true; cleanup();
      activeTurn = null;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const timer = setTimeout(() => {
      if (settled) return; settled = true; cleanup();
      activeTurn = null;
      reject(new Error('对话注入超时 (120s)'));
    }, 120000);
    cc.on('turn_done', onDone);
    cc.on('turn_error', onErr);
    try {
      cc.send(prompt);
    } catch (e) {
      settled = true; cleanup();
      activeTurn = null;
      reject(e);
    }
  });
}

function runForgeReload(jsonlPath) {
  return new Promise((resolve, reject) => {
    const p = spawnProc('python3', [FORGE_RELOAD_SCRIPT, jsonlPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', reject);
    p.on('exit', code => {
      if (code === 0) {
        // stdout 只有 new_sid 一行；stderr 是 [forge] 日志
        const sid = (out.trim().split('\n').pop() || '').trim();
        // 抽 token / events 两个指标给前端
        const evMatch = /\((\d+)\s*->\s*(\d+)\s*events\)/.exec(err);
        const tkMatch = /tokens (\d+) -> (\d+)/.exec(err);
        const totalEvents = evMatch ? Number(evMatch[1]) : null;
        const retainedEvents = evMatch ? Number(evMatch[2]) : null;
        const totalTokens = tkMatch ? Number(tkMatch[1]) : null;
        const retainedTokens = tkMatch ? Number(tkMatch[2]) : null;
        const truncated =
          totalTokens != null && retainedTokens != null
            ? retainedTokens < totalTokens
            : (totalEvents != null && retainedEvents != null && retainedEvents < totalEvents);
        resolve({
          sid, stderr: err,
          total: totalEvents, retained: retainedEvents,
          total_tokens: totalTokens, retained_tokens: retainedTokens,
          truncated,
        });
      } else {
        // forge_reload 失败时 stderr 一般有 [forge] xxx — 抽最后一条让 toast 可读
        const lastLine = err.trim().split('\n').filter(Boolean).pop() || `exit ${code}`;
        const reason = lastLine.replace(/^\[forge\]\s*/, '');
        reject(new Error(reason));
      }
    });
  });
}

app.post('/api/cc/restart', async (req, res) => {
  // 提前声明，让外层 catch 也能用 progressId 关掉 forge_pending
  const progressId = 'forge-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  try {
    const opts = {};
    const patch = {};
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'model')) {
      opts.model = req.body.model;
      patch.model = req.body.model || null;
    }
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'effort')) {
      opts.effort = req.body.effort;
      patch.effort = req.body.effort || null;
    }
    // 模型切换进度通过 WebSocket "system" 消息广播。
    // 同一个 progressId：先发 forge_pending（前端渲染思绪样式动画），
    // 完成后再发 forge_done 把同一行替换成折叠的"小太阳醒啦"。中间不再切阶段文案。
    const progressBase = req.body?.conversation_id || null;
    const modelLabel = req.body?.model_label || opts.model || cc.model || null;
    broadcast({
      type: 'system', kind: 'forge_pending',
      id: progressId, content: '正在唤醒小太阳…',
    });
    // forge:true → 先让 CC 自己总结将被截掉的部分（CC 静默轮）→ 跑 forge → 写
    // <上次对话总结> 到 sandbox CLAUDE.md + PATCH sessions_cheng.summary → cc.restart()
    // 由 cc-manager.readForgeMarker 读 last_forge.json 用 --resume 接班
    let forgeResult = null;
    let forgeSummary = null;
    if (req.body?.forge === true) {
      const curSid = cc.sessionId;
      const jsonl = curSid ? path.join(CC_JSONL_DIR, `${curSid}.jsonl`) : null;
      let jsonlSize = 0;
      if (jsonl && fs.existsSync(jsonl)) {
        try { jsonlSize = fs.statSync(jsonl).size; } catch {}
      }
      const FORGE_MIN_BYTES = 10 * 1024;
      const skipReason = !curSid ? '无 session'
                       : !jsonl || jsonlSize === 0 ? 'JSONL 不存在'
                       : jsonlSize < FORGE_MIN_BYTES ? `JSONL ${jsonlSize}B < 10KB`
                       : null;
      if (skipReason) {
        // 把残留 marker 失效掉，否则 cc-manager 会 --resume 上一次 forged session
        try {
          if (fs.existsSync(FORGE_MARKER_PATH)) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.renameSync(FORGE_MARKER_PATH, `${FORGE_MARKER_PATH}.skipped.${stamp}`);
          }
        } catch (e) {
          console.warn('marker 重命名失败:', e.message);
        }
        console.log(`⏭️  跳过 forge（${skipReason}），直接重启`);
      } else {
      // 1) CC 静默轮生成总结。只在 *将要截断* 时才花这一轮 —— 整段保留的话总结也用不上
      //    （writeForgeSummary 也只在 truncated 时落地）。先估算 tokens 跟 retain 比。
      const retainTokens = readRetainTokens();
      const estTokens = estimateJsonlTokens(jsonl);
      const willTruncate = estTokens > retainTokens;
      console.log(`📏 forge 估算 ${estTokens} tokens vs retain ${retainTokens} → ${willTruncate ? '会截断' : '不截断'}`);
      if (willTruncate) {
        try {
          const summaryLength = req.body?.summaryLength ?? req.body?.summary_length ?? null;
          forgeSummary = await generateForgeSummary({ summaryLength });
          console.log(`📝 forge 总结生成 (${forgeSummary.length} 字)`);
        } catch (e) {
          console.warn('forge 总结跳过:', e.message);
          forgeSummary = null;
        }
      } else {
        console.log('⏭️  整段保留场景，跳过总结生成');
      }
      // 2) 跑 forge_reload.py
      try {
        forgeResult = await runForgeReload(jsonl);
        console.log(`🔨 forge ${curSid} → ${forgeResult.sid}`);
        if (forgeResult.stderr) console.log(`   forge stderr: ${forgeResult.stderr.trim()}`);
      } catch (e) {
        console.error('forge_reload 失败:', e.message);
        broadcast({
          type: 'system', kind: 'forge_done',
          id: progressId, content: '小太阳起床失败', detail: { error: e.message },
        });
        return res.status(500).json({ error: 'forge 失败: ' + e.message });
      }
      // 3) 只在真截断时把总结落地 —— 整段保留的场景不写，避免误导新 CC
      if (forgeSummary && forgeResult.truncated && forgeResult.sid) {
        try {
          await writeForgeSummary(forgeSummary);
          console.log(`✏️  <上次对话总结> 已写入 sandbox CLAUDE.md`);
        } catch (e) {
          console.error('writeForgeSummary 失败:', e.message);
        }
        // PATCH supabase sessions_cheng.summary（forge_reload.py 那条 insert 写的是 null）
        try {
          const { error } = await supabase
            .from('sessions_cheng')
            .update({ summary: forgeSummary })
            .eq('session_id', forgeResult.sid);
          if (error) console.warn('sessions_cheng.summary 更新失败:', error.message);
        } catch (e) {
          console.warn('sessions_cheng.summary 更新异常:', e.message);
        }
      } else if (forgeSummary && !forgeResult.truncated) {
        console.log('forge 未截断，丢弃总结');
      }
      } // end else (forge 实际执行块；JSONL 不存在或 < 10KB 时跳过整段)
    }
    // 重启前把 active session 的最终 tokens 落库（cc.lastInputTokens 是这一 session 最近一轮的累计）
    if (cc.sessionId && cc.lastInputTokens > 0) {
      try {
        await supabase.from('sessions_cheng')
          .update({ tokens_total: cc.lastInputTokens })
          .eq('session_id', cc.sessionId);
      } catch (e) { console.warn('finalize tokens_total:', e.message); }
    }
    // 重启前先把 documents_cheng 拉一遍：CLAUDE.md / 文件落盘（&lt;上次对话总结&gt; 已被 syncCCDocs 保留），
    // system_prompt 推到下次启动参数
    const sysPrompt = await syncCCDocs();
    cc.setAppendSystemPrompt(sysPrompt);
    await cc.restart(opts);
    if (Object.keys(patch).length) saveCCConfig(patch);

    // 最终态：广播 "小太阳醒啦" + detail，给前端做折叠展开；同时持久化到 messages 表
    const injectConvId = req.body?.conversation_id;
    const forgeDoneDetail = {
      model: modelLabel,
      forge_truncated: forgeResult?.truncated ?? false,
      forge_total_tokens: forgeResult?.total_tokens ?? null,
      forge_retained_tokens: forgeResult?.retained_tokens ?? null,
      skipped: !forgeResult && req.body?.forge === true,
      inject_ready: !!(injectConvId && req.body?.forge),
      inject_conversation_id: injectConvId || null,
    };
    broadcast({
      type: 'system', kind: 'forge_done',
      id: progressId, content: '小太阳醒啦', detail: forgeDoneDetail,
    });
    if (progressBase) {
      try {
        await supabase.from('messages').insert({
          conversation_id: progressBase,
          role: 'system',
          content: '小太阳醒啦',
          tool_calls: forgeDoneDetail,
        });
      } catch (e) { console.warn('小太阳醒啦 持久化失败:', e.message); }
    }
    res.json({
      ok: true,
      session: cc.sessionId,
      model: cc.model,
      effort: cc.effort,
      forged: forgeResult ? forgeResult.sid : null,
      forge_total: forgeResult?.total ?? null,
      forge_retained: forgeResult?.retained ?? null,
      forge_total_tokens: forgeResult?.total_tokens ?? null,
      forge_retained_tokens: forgeResult?.retained_tokens ?? null,
      forge_truncated: forgeResult?.truncated ?? null,
    });
  } catch (err) {
    // 兜底关掉 forge_pending —— 否则前端会一直转
    broadcast({
      type: 'system', kind: 'forge_done',
      id: progressId, content: '小太阳起床失败', detail: { error: err.message },
    });
    res.status(500).json({ error: err.message });
  }
});

// 失忆：清 forge marker → 用新 random UUID 启动 CC（无 --resume）。不走 forge / 不写总结。
app.post('/api/cc/amnesia', async (req, res) => {
  const amnesiaConvId = req.body?.conversation_id || lastActiveConvId;
  const progressId = 'amnesia-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  try {
    broadcast({
      type: 'system', kind: 'forge_pending',
      id: progressId, content: '正在失忆…',
    });
    // 1) 把 marker 改名失效，避免 cc-manager 接班
    try {
      if (fs.existsSync(FORGE_MARKER_PATH)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(FORGE_MARKER_PATH, `${FORGE_MARKER_PATH}.amnesia.${stamp}`);
      }
    } catch (e) { console.warn('amnesia marker rename:', e.message); }
    // 2) 清空两块注入区，否则新 session 启动后 CC 还是会读到旧上下文：
    //    - sandbox/CLAUDE.md 的 <上次对话总结>（forge 写进来的）
    //    - ~/.claude/CLAUDE.md 的 <浮现>（surfacing.js 写进来的）
    try { await writeForgeSummary(''); } catch (e) { console.warn('amnesia clear 上次对话总结:', e.message); }
    try { await clearFuxianBlock(); } catch (e) { console.warn('amnesia clear 浮现:', e.message); }
    // 3) 落库当前 session 的 tokens，再走 cc.restart（cc-manager 看不到 marker，会走 randomUUID 分支）
    if (cc.sessionId && cc.lastInputTokens > 0) {
      try {
        await supabase.from('sessions_cheng')
          .update({ tokens_total: cc.lastInputTokens })
          .eq('session_id', cc.sessionId);
      } catch (e) { console.warn('amnesia tokens_total:', e.message); }
    }
    const sysPrompt = await syncCCDocs();
    cc.setAppendSystemPrompt(sysPrompt);
    await cc.restart();
    broadcast({
      type: 'system', kind: 'forge_done',
      id: progressId, content: '失忆完成 · 干净新 session',
      detail: { skipped: true, model: cc.model || null },
    });
    if (amnesiaConvId) {
      try {
        await supabase.from('messages').insert({
          conversation_id: amnesiaConvId,
          role: 'system',
          content: '失忆完成 · 干净新 session',
        });
      } catch (e) { console.warn('amnesia save msg:', e.message); }
    }
    res.json({ ok: true, session: cc.sessionId });
  } catch (err) {
    broadcast({
      type: 'system', kind: 'forge_done',
      id: progressId, content: '失忆失败', detail: { error: err.message },
    });
    res.status(500).json({ error: err.message });
  }
});

// 对话注入：forge/模型切换后，用户选择是否带思考链注入旧对话
app.post('/api/cc/inject', async (req, res) => {
  try {
    const { conversation_id, withThinking } = req.body || {};
    if (!conversation_id) return res.status(400).json({ error: '缺少 conversation_id' });
    const info = await injectConversationContext(conversation_id, { withThinking: withThinking !== false });
    if (!info) return res.json({ ok: true, injected: false });
    console.log(`📋 对话原文已注入新 CC（${info.msgCount} 条, ~${info.estTokens} tokens, ${info.thinkingCount} 思绪, thinking=${withThinking !== false}）`);
    // 更新 DB 里最近一条"小太阳醒啦"消息的 tool_calls，把注入结果持久化
    if (conversation_id) {
      try {
        const { data: rows } = await supabase.from('messages')
          .select('id, tool_calls')
          .eq('conversation_id', conversation_id)
          .eq('role', 'system')
          .like('content', '%小太阳醒啦%')
          .order('created_at', { ascending: false })
          .limit(1);
        if (rows && rows[0]) {
          const merged = {
            ...(rows[0].tool_calls || {}),
            inject_msg_count: info.msgCount, inject_est_tokens: info.estTokens,
            inject_thinking_count: info.thinkingCount, inject_thinking_tokens: info.thinkingTokens,
          };
          await supabase.from('messages').update({ tool_calls: merged }).eq('id', rows[0].id);
        }
      } catch (e) { console.warn('inject detail 持久化失败:', e.message); }
    }
    const injectSummaryConv = `已浮想 ${info.msgCount} 个回忆` +
      (info.thinkingCount > 0 ? ` · ${info.thinkingCount} 个思绪` : '');
    broadcast({
      type: 'system', kind: 'inject_done',
      content: injectSummaryConv,
      detail: {
        inject_msg_count: info.msgCount, inject_est_tokens: info.estTokens,
        inject_thinking_count: info.thinkingCount, inject_thinking_tokens: info.thinkingTokens,
        withThinking: withThinking !== false,
      },
    });
    res.json({
      ok: true, injected: true,
      msgCount: info.msgCount, estTokens: info.estTokens,
      thinkingCount: info.thinkingCount, thinkingTokens: info.thinkingTokens,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 从 JSONL 读取某个 session 的 user/assistant 消息
// 一个 turn 可能有多条 assistant 事件（thinking / text / tool_use 分开），需要合并
function readSessionMessages(sessionId) {
  const jsonlPath = path.join(CC_JSONL_DIR, `${sessionId}.jsonl`);
  if (!fs.existsSync(jsonlPath)) return null;
  const raw = fs.readFileSync(jsonlPath, 'utf-8');
  const messages = [];
  let pendingAssistant = null;

  const flushAssistant = () => {
    if (!pendingAssistant) return;
    // 去掉 ---bubble--- 标记
    pendingAssistant.content = pendingAssistant.content.replace(/---bubble---/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (pendingAssistant.content) messages.push(pendingAssistant);
    pendingAssistant = null;
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'user') {
        const content = ev.message?.content;
        // tool_result 是 assistant tool_use 的回应，属于同一 turn，不 flush
        const isToolResult = Array.isArray(content) && content.some(b => b.type === 'tool_result');
        if (!isToolResult) {
          flushAssistant();
          const text = typeof content === 'string' ? content
            : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text || '').join('\n')
            : '';
          if (text.trim()) messages.push({ role: 'user', content: text.trim(), thinking: null });
        }
      } else if (ev.type === 'assistant') {
        if (!pendingAssistant) pendingAssistant = { role: 'assistant', content: '', thinking: null };
        const blocks = ev.message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b.type === 'text' && b.text) pendingAssistant.content += (pendingAssistant.content ? '\n' : '') + b.text;
            else if (b.type === 'thinking' && b.thinking) {
              pendingAssistant.thinking = (pendingAssistant.thinking || '') + b.thinking;
            }
          }
        }
      }
    } catch { /* skip */ }
  }
  flushAssistant();
  return messages;
}

// 读取旧 session 的聊天记录（给前端预览用）
app.get('/api/cc/session-messages/:sid', (req, res) => {
  try {
    const msgs = readSessionMessages(req.params.sid);
    if (!msgs) return res.status(404).json({ error: 'JSONL 不存在' });
    res.json({ messages: msgs, count: msgs.length, thinkingCount: msgs.filter(m => m.thinking).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 从旧 session 的 JSONL 注入对话到当前 CC
async function injectSessionContext(sessionId, { withThinking = true } = {}) {
  if (!cc.isRunning()) return null;
  if (activeTurn) { console.warn('CC 忙碌，跳过 session 注入'); return null; }
  const msgs = readSessionMessages(sessionId);
  if (!msgs || msgs.length === 0) return null;

  const lines = msgs.map(m => {
    const label = m.role === 'user' ? '小茉莉' : '澄';
    let line = `[${label}] ${m.content}`;
    if (withThinking && m.thinking) line = `[${label}·思考] ${m.thinking}\n[${label}] ${m.content}`;
    return line;
  });

  const TOKEN_CAP = 90000;
  let acc = 0, startIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    acc += estimateTokens(lines[i]);
    if (acc > TOKEN_CAP) break;
    startIdx = i;
  }
  const transcript = lines.slice(startIdx).join('\n\n');
  if (!transcript.trim()) return null;

  const kept = msgs.slice(startIdx);
  const msgCount = kept.length;
  const thinkingCount = withThinking ? kept.filter(m => m.thinking).length : 0;
  const thinkingTokens = withThinking
    ? kept.reduce((s, m) => m.thinking ? s + estimateTokens(m.thinking) : s, 0)
    : 0;
  const estTokens = estimateTokens(transcript) - thinkingTokens;

  const prompt = `【系统任务·对话上下文注入】\n` +
    `以下是你和小茉莉之前的对话原文，请将这些视为你们之间已经发生的真实交流，延续这段关系继续聊天。\n` +
    `仅输出"OK"两个字，不要输出其他任何内容。\n\n` +
    transcript;

  activeTurn = { ws: null, conversationId: null, silent: true, settings: null, tools: [] };
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { cc.off('turn_done', onDone); cc.off('turn_error', onErr); clearTimeout(timer); };
    const onDone = () => { if (settled) return; settled = true; cleanup(); activeTurn = null; resolve({ msgCount, estTokens, thinkingCount, thinkingTokens }); };
    const onErr = (err) => { if (settled) return; settled = true; cleanup(); activeTurn = null; reject(err); };
    const timer = setTimeout(() => { if (settled) return; settled = true; cleanup(); activeTurn = null; reject(new Error('session 注入超时')); }, 120000);
    cc.on('turn_done', onDone);
    cc.on('turn_error', onErr);
    try { cc.send(prompt); } catch (e) { if (!settled) { settled = true; cleanup(); activeTurn = null; reject(e); } }
  });
}

app.post('/api/cc/inject-session', async (req, res) => {
  try {
    const { session_id, withThinking, conversation_id } = req.body || {};
    if (!session_id && !conversation_id) return res.status(400).json({ error: '缺少 session_id 或 conversation_id' });
    // 优先 JSONL（session），没有才回退到 messages 表（conversation）
    let info = null;
    if (session_id) info = await injectSessionContext(session_id, { withThinking: withThinking !== false });
    if (!info && conversation_id) info = await injectConversationContext(conversation_id, { withThinking: withThinking !== false });
    if (!info) return res.json({ ok: true, injected: false });
    console.log(`📋 旧 session 已注入（${info.msgCount} 条, ~${info.estTokens} tokens, ${info.thinkingCount} 思绪）`);
    const injectSummary = `已浮想 ${info.msgCount} 个回忆` +
      (info.thinkingCount > 0 ? ` · ${info.thinkingCount} 个思绪` : '');
    const injectDetail = {
      inject_msg_count: info.msgCount, inject_est_tokens: info.estTokens,
      inject_thinking_count: info.thinkingCount, inject_thinking_tokens: info.thinkingTokens,
      withThinking: withThinking !== false, from_session: session_id,
    };
    broadcast({
      type: 'system', kind: 'inject_done',
      content: injectSummary,
      detail: injectDetail,
    });
    if (conversation_id) {
      try {
        await supabase.from('messages').insert({
          conversation_id,
          role: 'system',
          content: injectSummary,
          tool_calls: injectDetail,
        });
      } catch (e) { console.warn('inject_done 持久化失败:', e.message); }
    }
    res.json({
      ok: true, injected: true,
      msgCount: info.msgCount, estTokens: info.estTokens,
      thinkingCount: info.thinkingCount, thinkingTokens: info.thinkingTokens,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 解析 Claude.ai 导出 JSON（单条对话对象，含 chat_messages）
function parseClaudeAiExport(data) {
  const msgs = [];
  const chatMessages = data.chat_messages || data.messages || [];
  for (const m of chatMessages) {
    const role = (m.sender === 'human' || m.role === 'human' || m.role === 'user') ? 'user' : 'assistant';
    let text = '', thinking = null;
    const blocks = Array.isArray(m.content) ? m.content : Array.isArray(m.contentBlocks) ? m.contentBlocks : null;
    if (blocks) {
      text = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim();
      const thinkBlocks = blocks.filter(b => b.type === 'thinking').map(b => b.thinking || '').join('\n').trim();
      if (thinkBlocks) thinking = thinkBlocks;
    } else if (typeof m.text === 'string' && m.text.trim()) {
      text = m.text.trim();
    } else if (typeof m.content === 'string') {
      text = m.content.trim();
    }
    if (text) msgs.push({ role, content: text, thinking });
  }
  return msgs;
}

// 浮想外部对话（预解析的 messages 数组）到当前 CC
async function injectExternalContext(messages, { withThinking = true, thinkingPct = 100, tokenCap = 90000, summary = '' } = {}) {
  if (!cc.isRunning()) return null;
  if (activeTurn) { console.warn('CC 忙碌，跳过外部浮想'); return null; }
  if (!messages || messages.length === 0) return null;

  const pct = Math.max(0, Math.min(100, thinkingPct)) / 100;
  const cap = Math.max(1000, tokenCap || 90000);

  // Uniform sampling: at pct%, include ~pct fraction of thinking messages
  const thinkingSet = new Set();
  if (withThinking && pct > 0) {
    let thinkingSeen = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].thinking) {
        thinkingSeen++;
        if (Math.ceil(thinkingSeen * pct) > Math.ceil((thinkingSeen - 1) * pct)) {
          thinkingSet.add(i);
        }
      }
    }
  }

  const lines = messages.map((m, idx) => {
    const label = m.role === 'user' ? '小茉莉' : '澄';
    let line = `[${label}] ${m.content}`;
    if (thinkingSet.has(idx)) {
      line = `[${label}·思考] ${m.thinking}\n[${label}] ${m.content}`;
    }
    return line;
  });

  let acc = 0, startIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    acc += estimateTokens(lines[i]);
    if (acc > cap) break;
    startIdx = i;
  }
  const transcript = lines.slice(startIdx).join('\n\n');
  if (!transcript.trim()) return null;

  const kept = messages.slice(startIdx);
  const msgCount = kept.length;
  const thinkingCount = withThinking ? kept.filter(m => m.thinking).length : 0;
  const thinkingTokens = withThinking
    ? kept.reduce((s, m) => m.thinking ? s + Math.ceil(m.thinking.length / 3) : s, 0)
    : 0;
  const estTokens = estimateTokens(transcript) - thinkingTokens;

  const summaryBlock = summary ? `【前情摘要】\n${summary}\n\n【以下是最近的对话原文】\n\n` : '';
  const prompt = `【系统任务·对话上下文注入】\n` +
    `以下是你和小茉莉之前在别处的对话${summary ? '摘要与' : ''}原文，请将这些视为你们之间已经发生的真实交流，延续这段关系继续聊天。\n` +
    `仅输出"OK"两个字，不要输出其他任何内容。\n\n` +
    summaryBlock + transcript;

  activeTurn = { ws: null, conversationId: null, silent: true, settings: null, tools: [] };
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { cc.off('turn_done', onDone); cc.off('turn_error', onErr); clearTimeout(timer); };
    const onDone = () => { if (settled) return; settled = true; cleanup(); activeTurn = null; resolve({ msgCount, estTokens, thinkingCount, thinkingTokens }); };
    const onErr = (err) => { if (settled) return; settled = true; cleanup(); activeTurn = null; reject(err); };
    const timer = setTimeout(() => { if (settled) return; settled = true; cleanup(); activeTurn = null; reject(new Error('外部浮想超时')); }, 120000);
    cc.on('turn_done', onDone);
    cc.on('turn_error', onErr);
    try { cc.send(prompt); } catch (e) { if (!settled) { settled = true; cleanup(); activeTurn = null; reject(e); } }
  });
}

app.post('/api/cc/inject-external', async (req, res) => {
  try {
    const { data, withThinking, thinkingPct, tokenCap, summary, conversation_id } = req.body || {};
    if (!data) return res.status(400).json({ error: '缺少 data (Claude.ai JSON)' });
    const messages = parseClaudeAiExport(data);
    if (messages.length === 0) return res.status(400).json({ error: '未解析到有效消息' });

    const info = await injectExternalContext(messages, { withThinking: withThinking !== false, thinkingPct: thinkingPct ?? 100, tokenCap: tokenCap || 90000, summary: summary || '' });
    if (!info) return res.json({ ok: true, injected: false });
    console.log(`📋 外部对话已浮想（${info.msgCount} 条, ~${info.estTokens} tokens, ${info.thinkingCount} 思绪）`);
    const injectSummary = `已浮想外部对话 ${info.msgCount} 个回忆` +
      (info.thinkingCount > 0 ? ` · ${info.thinkingCount} 个思绪` : '');
    const injectDetail = {
      inject_msg_count: info.msgCount, inject_est_tokens: info.estTokens,
      inject_thinking_count: info.thinkingCount, inject_thinking_tokens: info.thinkingTokens,
      withThinking: withThinking !== false,
      source: 'claude.ai',
    };
    broadcast({
      type: 'system', kind: 'inject_done',
      content: injectSummary,
      detail: injectDetail,
    });
    if (conversation_id) {
      try {
        await supabase.from('messages').insert({
          conversation_id,
          role: 'system',
          content: injectSummary,
          tool_calls: injectDetail,
        });
      } catch (e) { console.warn('inject_done 持久化失败:', e.message); }
    }
    res.json({
      ok: true, injected: true,
      msgCount: info.msgCount, estTokens: info.estTokens,
      thinkingCount: info.thinkingCount, thinkingTokens: info.thinkingTokens,
      parsedTotal: messages.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// forge-reload 配置读写：daemon 每轮 rescan 会热加载 config.json，所以无需 systemctl 重启
app.get('/api/forge/config', (req, res) => {
  try {
    const raw = fs.readFileSync(FORGE_CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw);
    res.json({
      retain_tokens: cfg.retain_tokens,
      trigger_threshold: cfg.trigger_threshold,
    });
  } catch (e) {
    res.status(500).json({ error: 'read forge config: ' + e.message });
  }
});

app.put('/api/forge/config', (req, res) => {
  try {
    const raw = fs.readFileSync(FORGE_CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw);
    const patch = {};
    for (const k of ['retain_tokens', 'trigger_threshold']) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) {
        const v = Number(req.body[k]);
        if (!Number.isFinite(v) || v <= 0) {
          return res.status(400).json({ error: `${k} 必须是正数` });
        }
        patch[k] = Math.round(v);
      }
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: '没有可更新字段' });
    }
    const next = { ...cfg, ...patch };
    fs.writeFileSync(FORGE_CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf-8');
    res.json({
      ok: true,
      retain_tokens: next.retain_tokens,
      trigger_threshold: next.trigger_threshold,
    });
  } catch (e) {
    res.status(500).json({ error: 'write forge config: ' + e.message });
  }
});

// 自动 forge daemon 开关：调 systemctl 启/停 forge-monitor.service
const FORGE_SERVICE_FILE = path.join(FORGE_RELOAD_DIR, 'forge-monitor.service');
const FORGE_SERVICE_NAME = 'forge-monitor';

function readForgeDaemonEnabled() {
  const r = spawnSync('systemctl', ['is-active', FORGE_SERVICE_NAME], { encoding: 'utf-8' });
  return (r.stdout || '').trim() === 'active';
}

app.get('/api/forge/daemon', (req, res) => {
  res.json({ enabled: readForgeDaemonEnabled() });
});

app.post('/api/forge/daemon', (req, res) => {
  const enabled = !!req.body?.enabled;
  if (enabled) {
    const r = spawnSync('systemctl', ['enable', '--now', FORGE_SERVICE_FILE], { encoding: 'utf-8' });
    if (r.status !== 0) {
      const msg = (r.stderr || r.stdout || '').trim() || `exit ${r.status}`;
      return res.status(500).json({ error: 'systemctl enable failed: ' + msg });
    }
  } else {
    // 已经停了就跳过 disable（unit 不存在时 disable 会报错）
    if (readForgeDaemonEnabled()) {
      const r = spawnSync('systemctl', ['disable', '--now', FORGE_SERVICE_NAME], { encoding: 'utf-8' });
      if (r.status !== 0) {
        const msg = (r.stderr || r.stdout || '').trim() || `exit ${r.status}`;
        return res.status(500).json({ error: 'systemctl disable failed: ' + msg });
      }
    } else {
      // 不在运行但 unit 还 linked 着：把 wants 符号链接也清掉，确保下次开机不自启
      spawnSync('systemctl', ['disable', FORGE_SERVICE_NAME], { encoding: 'utf-8' });
    }
  }
  res.json({ ok: true, enabled: readForgeDaemonEnabled() });
});

app.post('/api/conversations', async (req, res) => {
  const { title } = req.body;
  const { data, error } = await supabase
    .from('conversations')
    .insert({ title: title || '新对话' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/conversations/:id/messages', async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('id, role, content, thinking, tool_calls, images, token_input, token_output, cache_detail, event, created_at')
    .eq('conversation_id', req.params.id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 消息编辑 / 删除（给前端的编辑和重新生成用）
app.put('/api/messages/:id', async (req, res) => {
  const { content } = req.body;
  const { data, error } = await supabase
    .from('messages')
    .update({ content })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/messages/:id', async (req, res) => {
  const { error } = await supabase
    .from('messages')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// JSONL 全 session 搜索：遍历所有 session 文件，在 user/assistant 文本里找关键词
function extractSearchableText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'thinking' && typeof c.thinking === 'string') parts.push(c.thinking);
  }
  return parts.join('\n');
}

// sessions_cheng 里 forged_from_session 不为 null 的行，反过来建 parent_sid → forged_start_uuid 映射
// 用途：搜索/列消息时，旧 session JSONL 里从这个 uuid 开始的尾巴已经被复制到新 session（uuid 已重写），跳过避免重复
let _forgeMapCache = { ts: 0, map: null };
async function getForgeChildMap() {
  const now = Date.now();
  if (_forgeMapCache.map && now - _forgeMapCache.ts < 30_000) return _forgeMapCache.map;
  const map = new Map();
  try {
    const { data, error } = await supabase
      .from('sessions_cheng')
      .select('forged_from_session, forged_start_uuid')
      .not('forged_from_session', 'is', null);
    if (!error && Array.isArray(data)) {
      for (const row of data) {
        if (row.forged_from_session && row.forged_start_uuid) {
          map.set(row.forged_from_session, row.forged_start_uuid);
        }
      }
    }
  } catch { /* 静默：拉不到就退化到无去重 */ }
  _forgeMapCache = { ts: now, map };
  return map;
}

// 读一个 session 的 JSONL，过滤出 user/assistant 事件（去掉 sidechain），并应用 forge 去重：
// 如果这个 session 有子 session，从 forged_start_uuid 那行起整段 break（这些行已经在子 session 里）
async function readSessionEvents(sessionId, forgeMap) {
  let raw;
  try { raw = await fs.promises.readFile(path.join(CC_JSONL_DIR, `${sessionId}.jsonl`), 'utf-8'); }
  catch { return []; }
  const stopUuid = forgeMap.get(sessionId) || null;
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (stopUuid && ev.uuid === stopUuid) break;
    if (ev.type !== 'user' && ev.type !== 'assistant') continue;
    if (ev.isSidechain) continue;
    out.push(ev);
  }
  return out;
}

app.get('/api/search/messages', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    return res.json({ current_session_id: cc.sessionId || null, total: 0, truncated: false, results: [] });
  }
  const qLower = q.toLowerCase();
  const PREVIEW_PAD = 50;
  const MAX_RESULTS = 200;

  let files;
  try {
    files = (await fs.promises.readdir(CC_JSONL_DIR)).filter(f => f.endsWith('.jsonl'));
  } catch (e) {
    return res.status(500).json({ error: 'failed to read jsonl dir: ' + e.message });
  }

  const forgeMap = await getForgeChildMap();
  const results = [];
  for (const file of files) {
    const sessionId = file.replace(/\.jsonl$/, '');
    const events = await readSessionEvents(sessionId, forgeMap);
    for (const ev of events) {
      const text = extractSearchableText(ev.message?.content);
      if (!text) continue;
      const idx = text.toLowerCase().indexOf(qLower);
      if (idx === -1) continue;
      const start = Math.max(0, idx - PREVIEW_PAD);
      const end = Math.min(text.length, idx + q.length + PREVIEW_PAD);
      const preview = (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
      results.push({
        session_id: sessionId,
        uuid: ev.uuid || null,
        type: ev.type,
        timestamp: ev.timestamp || null,
        preview,
      });
    }
  }

  results.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  const total = results.length;
  res.json({
    current_session_id: cc.sessionId || null,
    total,
    truncated: total > MAX_RESULTS,
    results: results.slice(0, MAX_RESULTS),
  });
});

// 取某段时间内所有 session 的全部消息（应用 forge 去重，时间正序）
// 用于搜索结果展开"匹配消息所在那一天"的全部消息
app.get('/api/search/day-messages', async (req, res) => {
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();
  const startTs = Date.parse(start);
  const endTs = Date.parse(end);
  if (!isFinite(startTs) || !isFinite(endTs) || endTs < startTs) {
    return res.status(400).json({ error: 'start and end (ISO) required, end >= start' });
  }

  let files;
  try {
    files = (await fs.promises.readdir(CC_JSONL_DIR)).filter(f => f.endsWith('.jsonl'));
  } catch (e) {
    return res.status(500).json({ error: 'failed to read jsonl dir: ' + e.message });
  }

  const forgeMap = await getForgeChildMap();
  const MAX = 2000;
  const items = [];
  for (const file of files) {
    const sessionId = file.replace(/\.jsonl$/, '');
    const events = await readSessionEvents(sessionId, forgeMap);
    for (const ev of events) {
      if (!ev.timestamp) continue;
      const t = Date.parse(ev.timestamp);
      if (!isFinite(t) || t < startTs || t > endTs) continue;
      const text = extractSearchableText(ev.message?.content);
      if (!text) continue;
      items.push({
        session_id: sessionId,
        uuid: ev.uuid || null,
        type: ev.type,
        timestamp: ev.timestamp,
        text,
      });
    }
  }
  items.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  res.json({
    total: items.length,
    truncated: items.length > MAX,
    messages: items.slice(0, MAX),
  });
});

// Token 统计
app.get('/api/stats/tokens', async (req, res) => {
  try {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1));
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(today.getDate() - 6);

    const [todayData, weekData, monthData, dailyData] = await Promise.all([
      supabase.from('messages').select('token_output').gte('created_at', today.toISOString()),
      supabase.from('messages').select('token_output').gte('created_at', weekStart.toISOString()),
      supabase.from('messages').select('token_output').gte('created_at', monthStart.toISOString()),
      supabase.from('messages').select('created_at, token_output').gte('created_at', sevenDaysAgo.toISOString()),
    ]);

    const sum = (arr) => (arr || []).reduce((s, m) => s + (m.token_output || 0), 0);

    const dailyMap = {};
    (dailyData.data || []).forEach(m => {
      const d = new Date(m.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      dailyMap[key] = (dailyMap[key] || 0) + (m.token_output || 0);
    });

    const daily = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      daily.push({ date: key, output: dailyMap[key] || 0 });
    }

    res.json({
      today: sum(todayData.data),
      week: sum(weekData.data),
      month: sum(monthData.data),
      daily,
    });
  } catch (err) {
    console.error('统计失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 世界书（单例：第一个 project 的 system_prompt）
app.get('/api/worldbook', async (req, res) => {
  try {
    const p = await getDefaultProject();
    res.json({ id: p.id, name: p.name, system_prompt: p.system_prompt || '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/worldbook', async (req, res) => {
  try {
    const p = await getDefaultProject();
    const { system_prompt, name } = req.body;
    const updates = {};
    if (system_prompt !== undefined) updates.system_prompt = system_prompt;
    if (name !== undefined) updates.name = name;
    const { data, error } = await supabase
      .from('projects')
      .update(updates)
      .eq('id', p.id)
      .select('id, name, system_prompt')
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 记忆 CRUD
app.post('/api/memory/search', async (req, res) => {
  try {
    const results = await searchMemory(req.body || {});
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/memory/write', async (req, res) => {
  try {
    const id = await writeMemory({ ...(req.body || {}), source: 'web' });
    if (!id) return res.status(500).json({ error: '写入失败' });
    res.json({ id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/memory/:id', async (req, res) => {
  const { content, importance, tags, status, layer } = req.body || {};
  const updates = {};
  if (content !== undefined) updates.content = content;
  if (importance !== undefined) updates.importance = importance;
  if (tags !== undefined) updates.tags = tags;
  if (status !== undefined) updates.status = status;
  if (layer !== undefined) updates.layer = layer;
  const { data, error } = await supabase
    .from('memories')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/memory/:id', async (req, res) => {
  const { error } = await supabase
    .from('memories')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ==================== Memory tag helpers ====================

function parseMemoryTags(text) {
  const re = /\[MEMORY:(\w+)\](.*?)\[\/MEMORY\]/gs;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const layer = m[1];
    const parts = m[2].trim().split('|').map(p => p.trim());
    const memory = { content: parts[0], layer, source: 'chat', author: 'CC' };
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      if (p.startsWith('tags:')) memory.tags = p.slice(5).split(',').map(t => t.trim());
      else if (p.startsWith('importance:')) memory.importance = parseFloat(p.slice(11));
      else if (p.startsWith('author:')) memory.author = p.slice(7);
    }
    out.push(memory);
  }
  return out;
}

function removeMemoryTags(text) {
  return text.replace(/\[MEMORY:\w+\].*?\[\/MEMORY\]/gs, '').trim();
}

// ==================== WebSocket ====================

wss.on('connection', (ws, req) => {
  // 鉴权：?token=xxx，无效就立刻断
  let token = null;
  try {
    const url = new URL(req.url, 'http://localhost');
    token = url.searchParams.get('token');
  } catch {}
  if (!verifyAuthToken(token)) {
    try { ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' })); } catch {}
    ws.close(4001, 'unauthorized');
    console.log('WS 鉴权失败，已断开');
    return;
  }

  console.log('客户端已连接');
  safeSend(ws, { type: 'cc_status', status: cc.isRunning() ? 'ready' : 'down' });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'chat') {
        await handleChat(ws, msg);
      } else if (msg.type === 'stop') {
        // 同时清掉缓冲队列
        if (pendingBuffer) {
          if (pendingBuffer.timer) clearTimeout(pendingBuffer.timer);
          pendingBuffer = null;
        }
        if (activeTurn) {
          activeTurn.stopped = true;
          safeSend(activeTurn.ws, { type: 'stopped' });
        }
      } else if (msg.type === 'flush') {
        if (pendingBuffer) {
          if (pendingBuffer.timer) { clearTimeout(pendingBuffer.timer); pendingBuffer.timer = null; }
          pendingBuffer.readyToFlush = true;
          tryFlushBuffer();
        }
      }
    } catch (err) {
      console.error('消息处理失败:', err);
      safeSend(ws, { type: 'error', message: err.message });
    }
  });

  ws.on('close', () => {
    if (pendingBuffer && pendingBuffer.ws === ws) {
      if (pendingBuffer.timer) clearTimeout(pendingBuffer.timer);
      pendingBuffer = null;
    }
    console.log('客户端断开');
  });
});

// ==================== 终端 WS (/terminal) ====================
wssTerminal.on('connection', (ws, req) => {
  // 鉴权：?token=xxx，跟聊天 WS 一致
  let token = null;
  try {
    const url = new URL(req.url, 'http://localhost');
    token = url.searchParams.get('token');
  } catch {}
  if (!verifyAuthToken(token)) {
    try { ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' })); } catch {}
    ws.close(4001, 'unauthorized');
    console.log('终端 WS 鉴权失败，已断开');
    return;
  }

  let term;
  try {
    term = pty.spawn('bash', [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: '/root',
      env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG || 'en_US.UTF-8' },
    });
  } catch (e) {
    console.error('pty.spawn 失败:', e);
    try { ws.send('\r\n\x1b[31mfailed to spawn pty: ' + (e?.message || e) + '\x1b[0m\r\n'); } catch {}
    ws.close(1011, 'pty spawn failed');
    return;
  }

  console.log('终端 WS 客户端已连接, pty pid =', term.pid);

  term.onData((data) => {
    try { if (ws.readyState === 1) ws.send(data); } catch {}
  });
  term.onExit(({ exitCode, signal }) => {
    try { ws.send(`\r\n\x1b[33m[pty exited code=${exitCode} signal=${signal}]\x1b[0m\r\n`); } catch {}
    try { ws.close(); } catch {}
  });

  ws.on('message', (raw) => {
    try {
      const s = raw.toString();
      // 前端可发 {type:'resize', cols, rows} 控制 pty 尺寸；{type:'ping'} 当心跳
      if (s.length < 200 && s.startsWith('{') && s.includes('"type"')) {
        try {
          const o = JSON.parse(s);
          if (o.type === 'resize' && Number(o.cols) > 0 && Number(o.rows) > 0) {
            term.resize(Number(o.cols), Number(o.rows));
            return;
          }
          if (o.type === 'ping') return; // 心跳，吞掉别落到 pty
        } catch { /* 不是 JSON 控制消息，按普通输入处理 */ }
      }
      term.write(s);
    } catch (e) {
      console.error('终端 WS 写入失败:', e);
    }
  });

  ws.on('close', () => {
    try { term.kill(); } catch {}
    console.log('终端 WS 客户端断开');
  });
});

// 把前端传来的 dataURL 转成 Anthropic content-block 数组里的 image block
function dataUrlToImageBlock(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}

async function handleChat(ws, msg) {
  const { content, images, conversation_id, settings } = msg;
  const imgs = Array.isArray(images) ? images.filter(Boolean) : [];

  if (!cc.isRunning()) {
    return safeSend(ws, { type: 'error', message: 'CC进程未运行，请点击重启' });
  }

  if (conversation_id) lastActiveConvId = conversation_id;

  // 用户消息照常落库（每条独立一行，保留时间线）
  if (conversation_id) {
    try {
      await supabase.from('messages').insert({
        conversation_id, role: 'user', content,
        images: imgs.length ? imgs : null,
      });
      await supabase.from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversation_id);
      await checkContextThreshold(conversation_id, settings);
    } catch (e) { console.error('存用户消息失败:', e); }
  }

  const bufferTime = Math.max(0, parseInt(settings?.bufferTime) || 0);
  const shortMsgCount = Math.max(1, parseInt(settings?.shortMsgCount) || 1);

  // bufferTime=0 且 CC 空闲：保留原直发路径
  if (bufferTime <= 0 && !activeTurn && !pendingBuffer) {
    return flushPendingToCC(ws, [{ content, imgs, conversation_id, settings }]);
  }

  // 否则进入缓冲
  if (!pendingBuffer) {
    pendingBuffer = { ws, items: [], timer: null, readyToFlush: false };
  } else {
    // 多窗口情况：以最新 ws 为准
    pendingBuffer.ws = ws;
  }
  pendingBuffer.items.push({ content, imgs, conversation_id, settings });
  safeSend(ws, { type: 'buffering', count: pendingBuffer.items.length, waitMs: bufferTime * 1000 });

  // 达到条数上限：立刻标记 ready
  if (pendingBuffer.items.length >= shortMsgCount) {
    if (pendingBuffer.timer) { clearTimeout(pendingBuffer.timer); pendingBuffer.timer = null; }
    pendingBuffer.readyToFlush = true;
    return tryFlushBuffer();
  }

  // 重置计时
  if (pendingBuffer.timer) clearTimeout(pendingBuffer.timer);
  if (bufferTime > 0) {
    pendingBuffer.timer = setTimeout(() => {
      if (!pendingBuffer) return;
      pendingBuffer.timer = null;
      pendingBuffer.readyToFlush = true;
      tryFlushBuffer();
    }, bufferTime * 1000);
  } else {
    // bufferTime=0 但 CC 忙：直接 ready，等 turn_done 触发
    pendingBuffer.readyToFlush = true;
    tryFlushBuffer();
  }
}

function tryFlushBuffer() {
  if (!pendingBuffer || !pendingBuffer.readyToFlush) return;
  if (activeTurn) return; // CC 忙，等 turn_done
  const items = pendingBuffer.items;
  const ws = pendingBuffer.ws;
  pendingBuffer = null;
  flushPendingToCC(ws, items).catch(e => console.error('flush failed:', e));
}

async function flushPendingToCC(ws, items) {
  if (!items?.length) return;
  if (activeTurn) {
    // 不应该发生，但兜底
    if (!pendingBuffer) pendingBuffer = { ws, items: [], timer: null, readyToFlush: true };
    pendingBuffer.items.unshift(...items);
    return;
  }

  const combinedText = items.map(i => i.content).filter(s => s && s.length).join('\n\n');
  const combinedImgs = items.flatMap(i => i.imgs || []);
  const last = items[items.length - 1];
  const conversation_id = last.conversation_id;
  const settings = last.settings;

  activeTurn = { ws, conversationId: conversation_id, settings, tools: [] };

  try {
    try { await runSurfacing(combinedText); } catch (e) { console.error('[surfacing] uncaught:', e); }

    const prefixed = maybeTimePrefix(combinedText, conversation_id);
    let payload = prefixed;
    if (combinedImgs.length > 0) {
      const blocks = [];
      if (prefixed && prefixed.length) blocks.push({ type: 'text', text: prefixed });
      for (const dataUrl of combinedImgs) {
        const b = dataUrlToImageBlock(dataUrl);
        if (b) blocks.push(b);
      }
      payload = blocks;
    }
    cc.send(payload);
  } catch (err) {
    activeTurn = null;
    safeSend(ws, { type: 'error', message: err.message });
  }
}

// ==================== 启动 ====================

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`服务器已启动: http://0.0.0.0:${PORT}`);
  console.log(`WebSocket: ws://0.0.0.0:${PORT}`);
  console.log(`Supabase: ${process.env.SUPABASE_URL ? '已连接' : '未配置'}`);
  console.log(`CC 工作目录: /home/claude-user/chat-sandbox (CLAUDE.md 由 CC 自己加载)`);
});

process.on('SIGTERM', () => { cc.stop(); process.exit(0); });
process.on('SIGINT', () => { cc.stop(); process.exit(0); });
