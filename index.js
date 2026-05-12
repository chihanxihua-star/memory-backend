import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { spawn as spawnProc } from 'child_process';
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

cc.on('turn_done', async ({ text, thinking, usage, is_error }) => {
  const turn = activeTurn;
  activeTurn = null;
  if (!turn) return;

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

  // barkFire 轮：把 clean 推到手机，不入库不发 ws
  if (turn.barkFire) {
    // CC 觉得这个时候不该打扰 → 输出含 [SKIP] → 跳过推送，但仍 markFired 防止下次轮询重复
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
      await supabase.from('messages').insert({
        conversation_id: turn.conversationId,
        role: 'assistant',
        content: clean,
        thinking: thinking || null,
        tool_calls: turn.tools && turn.tools.length ? turn.tools : null,
        token_input: usage.input_tokens,
        token_output: usage.output_tokens,
      });
      await checkContextThreshold(turn.conversationId, turn.settings);
    } catch (e) { console.error('存消息失败:', e); }
  }

  if (!turn.silent) {
    if (text !== clean) safeSend(turn.ws, { type: 'clean', text: clean });
    safeSend(turn.ws, { type: 'done', usage, is_error });
  }

  // sessions_cheng.turn_count +1 + 同步当前累计 input tokens（不阻塞主流程；单用户系统不担心并发竞争）
  bumpSessionTurnAndTokens(cc.sessionId, cc.lastInputTokens).catch(e =>
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
    if (activeTurn.barkFire) {
      console.warn(`[BARK] 触发失败 ${activeTurn.barkScheduleId}: ${err.message}`);
      // 标 fired 防止下次轮询重复尝试同一条
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
      // 1) CC 静默轮生成总结。失败/超时不致命 —— 没总结就继续走 forge，summary 留空
      try {
        const summaryLength = req.body?.summaryLength ?? req.body?.summary_length ?? null;
        forgeSummary = await generateForgeSummary({ summaryLength });
        console.log(`📝 forge 总结生成 (${forgeSummary.length} 字)`);
      } catch (e) {
        console.warn('forge 总结跳过:', e.message);
        forgeSummary = null;
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
    const forgeDoneDetail = {
      model: modelLabel,
      forge_truncated: forgeResult?.truncated ?? false,
      forge_total_tokens: forgeResult?.total_tokens ?? null,
      forge_retained_tokens: forgeResult?.retained_tokens ?? null,
      skipped: !forgeResult && req.body?.forge === true,
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
    // 2) 落库当前 session 的 tokens，再走 cc.restart（cc-manager 看不到 marker，会走 randomUUID 分支）
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
    res.json({ ok: true, session: cc.sessionId });
  } catch (err) {
    broadcast({
      type: 'system', kind: 'forge_done',
      id: progressId, content: '失忆失败', detail: { error: err.message },
    });
    res.status(500).json({ error: err.message });
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
    .select('id, role, content, thinking, tool_calls, images, token_input, token_output, created_at')
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
          const turn = activeTurn;
          activeTurn = null;
          await cc.restart();
          safeSend(turn.ws, { type: 'stopped' });
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
