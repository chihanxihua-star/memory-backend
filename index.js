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
import { TmuxCCManager } from './tmux-manager.js';
import { runSurfacing } from './surfacing.js';
import { buildMessageForCC } from './inject.js';
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
import { DiceDaemon } from './dice.js';
import { WorldTickDaemon, advanceOneTick, readWorldConfig, writeWorldConfig, WORLD_EVENTS } from './world-tick.js';
import { PendingWakeDaemon } from './world-pending.js';
import { ACTIONS as WORLD_ACTIONS, getAvailableActions, executeWorldAction } from './world-actions.js';

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
    await restartCCAndRecordSession();
    res.json({ ok: true, session: cc.sessionId, resumed: !!cc.resumedFromForge });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CC 工具调用实时上报（hook → 这里 → 复用 tool_use/tool_result 事件 → 前端工具卡片）。
// loopback only + 立即响应；hook 脚本本就 fire-and-forget，这里也绝不让它等。
// phase: pre=PreToolUse(调用中) / post=PostToolUse(成功) / fail=PostToolUseFailure(失败带原因)。
function summarizeToolResp(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r.slice(0, 2000);
  if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
    const s = (r.stdout || '') + (r.stderr ? ('\n' + r.stderr) : '');
    return (s.trim() || '(无输出)').slice(0, 2000);
  }
  try { return JSON.stringify(r).slice(0, 2000); } catch { return String(r).slice(0, 2000); }
}
app.post('/api/internal/cc/tool-hook', (req, res) => {
  const ip = (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip !== '127.0.0.1' && ip !== '::1') return res.status(403).json({ error: 'forbidden (loopback only)' });
  res.json({ ok: true });   // 立刻回，hook 不等
  try {
    if (!USE_TMUX || !activeTurn) return;   // 只 tmux 模式需要(stream-json 自己 emit)；无活跃轮丢弃
    const phase = req.query.phase;
    const b = req.body || {};
    const id = b.tool_use_id;
    if (!id) return;
    if (phase === 'pre') {
      cc.emit('tool_use', { id, name: b.tool_name || 'tool', input: b.tool_input || {} });
    } else if (phase === 'post') {
      cc.emit('tool_result', { tool_use_id: id, content: summarizeToolResp(b.tool_response), is_error: false });
    } else if (phase === 'fail') {
      cc.emit('tool_result', { tool_use_id: id, content: b.error || '工具调用失败', is_error: true });
    }
  } catch (e) { console.error('[tool-hook]', e?.message || e); }
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

async function recordTmuxSessionStart(sessionId, { forgedFromSession = null } = {}) {
  if (!sessionId) return;
  const nowIso = new Date().toISOString();
  const { error: upErr } = await supabase
    .from('sessions_cheng')
    .update({ status: 'ended', ended_at: nowIso })
    .eq('status', 'active');
  if (upErr) console.warn('tmux mark active->ended:', upErr.message);

  const { error: insErr } = await supabase
    .from('sessions_cheng')
    .insert({
      session_id: sessionId,
      started_at: nowIso,
      status: 'active',
      turn_count: 0,
      forged_from_session: forgedFromSession || null,
      model: cc?.model || null,
    });
  if (insErr) console.warn('tmux insert session row:', insErr.message);
}

async function startCCAndRecordSession() {
  await cc.start();
  if (USE_TMUX) await recordTmuxSessionStart(cc.sessionId);
}

async function restartCCAndRecordSession(options = {}, meta = {}) {
  await cc.restart(options);
  if (USE_TMUX) await recordTmuxSessionStart(cc.sessionId, meta);
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

// <think指令> 区段：跟 use-style 同款的纯指令开关（写 chat-sandbox/CLAUDE.md）
const THINK_REGEX = /<think指令>[\s\S]*?<\/think指令>/;
// 包裹指令：开启「思考链」时追加这条，让 CC 把思考用 <think>…</think> 写进正文（再由 turn_done 抽出、折叠进思绪）
const THINK_WRAP = '在每次回复的最开头，用 <think>...</think> 标签包裹你的思考过程，然后再写正式回复。';

// <use-style> 区段：风格指令，跟 think指令 同机制
const STYLE_REGEX = /<use-style>[\s\S]*?<\/use-style>/;

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

// <output_style>：documents_cheng 里 doc_type='output_style' → 写成全局 output style 文件 + 翻 settings 开关。
//   - 与 system_prompt(append) 不同：output style 是「替换」出厂人格③那块，不是追加。
//   - 留空 / 不存在 = 删掉 outputStyle 设置 + 删 style 文件，退回出厂默认（不锁死）。
//   - settings.json 读-改-写，保留 theme 等其它键；文件名 / frontmatter name / 设置值三者必须一致（都用 slug）。
const CLAUDE_CFG_DIR = '/home/claude-user/.claude';
const OUTPUT_STYLES_DIR = path.join(CLAUDE_CFG_DIR, 'output-styles');
const OUTPUT_STYLE_SLUG = 'cheng';
const OUTPUT_STYLE_FILE = path.join(OUTPUT_STYLES_DIR, `${OUTPUT_STYLE_SLUG}.md`);
const CLAUDE_SETTINGS_FILE = path.join(CLAUDE_CFG_DIR, 'settings.json');
const APPEND_SYSPROMPT_FILE = path.join(CLAUDE_CFG_DIR, 'cheng-append-sysprompt.md');

function estimateTokensLoose(v) {
  const s = v == null ? '' : String(v);
  let cjk = 0, other = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x3040 && c <= 0x30ff) ||
        (c >= 0x3400 && c <= 0x9fff) ||
        (c >= 0xac00 && c <= 0xd7af) ||
        (c >= 0xf900 && c <= 0xfaff)) cjk++;
    else other++;
  }
  return Math.round(cjk + other / 4);
}

async function tokenInfoForFile(type, name, filePath) {
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return { type, name, chars: content.length, tokens: estimateTokensLoose(content), source: filePath };
  } catch {
    return null;
  }
}

async function applyOutputStyle(content) {
  const body = (content || '').trim();
  let settings = {};
  try { settings = JSON.parse(await fs.promises.readFile(CLAUDE_SETTINGS_FILE, 'utf8')) || {}; } catch {}
  if (body) {
    try { await fs.promises.mkdir(OUTPUT_STYLES_DIR, { recursive: true }); } catch {}
    const ids = getClaudeUserIds();
    if (ids) { try { fs.chownSync(OUTPUT_STYLES_DIR, ids[0], ids[1]); } catch {} }
    // textarea 内容当作 style 正文，统一套上规范 frontmatter（name 必须 == slug == 设置值）
    const file = `---\nname: ${OUTPUT_STYLE_SLUG}\ndescription: 澄\n---\n${body}\n`;
    await writeAsClaudeUser(OUTPUT_STYLE_FILE, file);
    settings.outputStyle = OUTPUT_STYLE_SLUG;
    console.log(`🎭 应用 output style (${body.length} 字)`);
  } else {
    delete settings.outputStyle;
    try { await fs.promises.unlink(OUTPUT_STYLE_FILE); } catch {}
    console.log('🎭 output style 留空 → 退回出厂默认');
  }
  await writeAsClaudeUser(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// 从 documents_cheng 拉所有 mode='cc' 的文档：
//  - claude_md  → 写入 CLAUDE.md（保留 <上次对话总结> 区段不覆盖）
//  - file       → 写入工作目录下同名文件
//  - system_prompt → 返回内容，由调用方传给 cc.setAppendSystemPrompt
//  - output_style → 写成全局 output style 文件 + 翻 settings（替换出厂人格③）
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
    let outputStyle = null;
    const currentFileNames = new Set();
    for (const d of data || []) {
      try {
        if (d.doc_type === 'claude_md') {
          // 覆盖前先抽 <上次对话总结> 和 <think指令> 区段保留，避免被 supabase 文档冲掉
          const claudeMdPath = path.join(SANDBOX_DIR, 'CLAUDE.md');
          let merged = d.content || '';
          try {
            const cur = await fs.promises.readFile(claudeMdPath, 'utf8');
            const block = extractSummaryBlock(cur);
            if (block) {
              const sep = merged && !merged.endsWith('\n') ? '\n\n' : (merged ? '\n' : '');
              merged = merged + sep + block + '\n';
            }
            const thinkBlock = THINK_REGEX.exec(cur);
            if (thinkBlock && thinkBlock[0].replace(/<\/?think指令>/g, '').trim()) {
              const sep2 = merged && !merged.endsWith('\n') ? '\n' : '';
              merged = merged + sep2 + thinkBlock[0] + '\n';
            }
            const styleBlock = STYLE_REGEX.exec(cur);
            if (styleBlock && styleBlock[0].replace(/<\/?use-style>/g, '').trim()) {
              const sep3 = merged && !merged.endsWith('\n') ? '\n' : '';
              merged = merged + sep3 + styleBlock[0] + '\n';
            }
          } catch {}
          await writeAsClaudeUser(claudeMdPath, merged);
          console.log('📄 同步 CLAUDE.md');
        } else if (d.doc_type === 'system_prompt') {
          appendSystemPrompt = d.content || null;
          console.log(`📝 加载 system_prompt (${(d.content || '').length} 字)`);
        } else if (d.doc_type === 'output_style') {
          outputStyle = d.content || null;
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

    // output style：始终调用 —— 有内容则写文件+开开关，没有则清掉退回默认（覆盖「删除」场景）
    await applyOutputStyle(outputStyle);

    return appendSystemPrompt;
  } catch (e) {
    console.error('文档同步失败:', e.message);
    return null;
  }
}

const savedCfg = loadCCConfig();
// 驱动选择：CC_DRIVER=tmux → 交互模式（治空回）；否则保持 stream-json（生产默认）。
// 切流=设环境变量+重启；回滚=去掉变量+重启。
const USE_TMUX = process.env.CC_DRIVER === 'tmux';
const ccOpts = {
  cwd: SANDBOX_DIR,
  effort: savedCfg.effort || 'high',
  model: savedCfg.model || (USE_TMUX ? 'claude-opus-4-8' : null),
  nativeThinking: savedCfg.nativeThinking || false,
};
const cc = USE_TMUX ? new TmuxCCManager({ ...ccOpts, session: 'cheng' }) : new CCProcessManager(ccOpts);
console.log(`🧩 CC 驱动：${USE_TMUX ? 'tmux 交互' : 'stream-json'}`);
// 启动前先把 documents_cheng 的内容拉下来落盘 + 注入 system_prompt
const _initSysPrompt = await syncCCDocs();
cc.setAppendSystemPrompt(_initSysPrompt);
await startCCAndRecordSession();

const diceDaemon = new DiceDaemon({
  getActiveTurn: () => activeTurn,
  getPendingBuffer: () => pendingBuffer,
  isRunning: () => cc.isRunning(),
  sendToCC: (prompt) => {
    activeTurn = {
      ws: null, conversationId: null, silent: true,
      settings: null, tools: [], diceFire: true,
    };
    cc.send(prompt);
  },
  broadcast,
  getLastActiveConvId: () => lastActiveConvId,
});

// world-home 世界时钟 daemon（默认关，要手动开）。tick 命中事件 → triggerWorldWake（冷却+空闲在那判）。
const worldTickDaemon = new WorldTickDaemon({
  onEvent: (event, status) => triggerWorldWake(event, status, { force: false }),
});

// world-home pending_wake daemon（第 5 步，常驻）：到点把澄"先忍 10 分钟"的续集重新唤醒。
const pendingWakeDaemon = new PendingWakeDaemon({
  onDue: (row) => firePendingWake(row),
  intervalMs: 7000,
});

let activeTurn = null; // { ws, conversationId, settings, silent }
const summaryTriggers = new Map(); // conversation_id -> last k triggered
let pendingSummary = null; // { conversationId, summaryLength }
let lastActiveConvId = null; // bark 主动消息存到最近活跃的对话
(async () => {
  try {
    const { data } = await supabase.from('messages').select('conversation_id')
      .order('created_at', { ascending: false }).limit(1);
    if (data?.[0]?.conversation_id) {
      lastActiveConvId = data[0].conversation_id;
      console.log('[INIT] lastActiveConvId =', lastActiveConvId);
    }
  } catch (e) { console.warn('[INIT] 获取 lastActiveConvId 失败:', e.message); }
})();

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
  const d = new Date(now + 8 * 3600000);
  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
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

// ==================== world-home 世界唤醒（第 4 步）====================
// 状态打包成唤醒包发给澄（CC 进程）→ 澄选一个选项+说理由 → turn_done 里结算 effects + 写行程。
const WORLD_WAKE_COOLDOWN_MS = 30 * 60 * 1000; // 补充5：同一事件 30 分钟内不自动重复触发
const lastWorldWakeAt = new Map();             // eventKey -> 上次触发时间戳(ms)
const WORLD_PHONE_RATE_MS = 10 * 60 * 1000;    // WORLD_MESSAGE phone：自动唤醒 10 分钟最多 1 条
let lastWorldPhoneAt = 0;                       // 上次 world phone 消息时间戳(ms)

function buildWorldWakePrompt(event, s, pendingContext = null, user = {}) {
  const opts = event.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
  // pending_wake 续集：在完整模板的原因后加一段上下文，其余（时间/位置/天气/完整状态/选项）照常，
  // 让澄看到此刻的完整状态重新判断，而不是只收一句补充说明（补充2）。
  const pendingLine = pendingContext ? `\n补充：${pendingContext}` : '';
  // 第 6/7 步：带上澄自己的位置+正在做什么，以及小茉莉的在家/位置/正在/备注（只传信息，不做行为限制）。
  // 措辞用澄的口吻（"她在/她正在/她说"），不用生硬的 user/presence 标签。
  const u = user || {};
  const noteLine = u.custom_note ? `\n她说：${u.custom_note}` : '';
  return `【世界唤醒】
原因：${event.reason}${pendingLine}
时间：${s.world_time}
位置：${s.location}
你正在：${s.activity || '工作'}
天气：${s.weather}

小茉莉此刻：${u.presence || '在家'}
她在：${u.location || '家 · 客厅'}
她正在：${u.activity || '休息'}${noteLine}

你的状态：
体力 ${s.energy}，饱腹 ${s.satiety}，清洁 ${s.cleanliness}，健康 ${s.health}，
压力 ${s.stress}，注意力 ${s.focus}，心情 ${s.mood}，想念 ${s.longing}

你可以选择：
${opts}

根据当前状态和你的偏好自己决定。
用这个格式回复：[WORLD_CHOICE:选项编号]你的理由[/WORLD_CHOICE]

如果你想对小茉莉说一句话，可以额外输出：
[WORLD_MESSAGE:phone]消息内容[/WORLD_MESSAGE]
如果你和小茉莉处于同一地点、可以面对面说话，也可以输出：
[WORLD_MESSAGE:face]消息内容[/WORLD_MESSAGE]
不想说就不写，不要强行凑。
（不用自己写「［手机消息］」之类的前缀，只写这一句话本身，后端会自动标记。）

如果这个瞬间值得记住，可以额外写一条 [MEMORY:diary]...[/MEMORY]。
除了 [WORLD_CHOICE]、可选的 [WORLD_MESSAGE]、可选的 [MEMORY] 标签外，不要输出其他内容。`;
}

// 触发一次世界唤醒。
//   force         = 手动测试按钮：绕过冷却。
//   pendingContext= pending_wake 续集：绕过冷却（是上次"先忍着"的延续，不是新自动检测，补充1）+ 在原因后加上下文。
// 两者都仍受 CC 空闲约束（CC 忙时不发、不抢占在途轮）。普通 tick 自动检测（都不传）才受 30min 冷却。
// 返回 { fired:boolean, reason?:string }。check-and-set activeTurn 之间无 await，原子。
async function triggerWorldWake(event, status, { force = false, pendingContext = null } = {}) {
  // 第 6/7 步：读 user 的在家/位置/正在/备注。放在 check-and-set activeTurn 之前（这个 await 不夹在
  // 空闲检查与 activeTurn 赋值之间，原子性不破）。读失败给默认值。
  let userStatus = { presence: '在家', location: '家 · 客厅', activity: '休息', custom_note: null };
  try {
    const { data } = await supabase
      .from('user_status_cheng')
      .select('presence, location, activity, custom_note')
      .eq('name', 'user').limit(1);
    if (data && data[0]) userStatus = { ...userStatus, ...data[0] };
  } catch (e) { console.warn('[WORLD] 读 user_status 失败，用默认:', e.message); }

  if (!cc.isRunning() || activeTurn || pendingBuffer) {
    console.log('[WORLD] CC 忙或未运行，唤醒跳过');
    return { fired: false, reason: 'cc_busy' };
  }
  const bypassCooldown = force || !!pendingContext;
  if (!bypassCooldown) {
    const last = lastWorldWakeAt.get(event.key) || 0;
    if (Date.now() - last < WORLD_WAKE_COOLDOWN_MS) {
      console.log(`[WORLD] 事件 ${event.key} 冷却中（30min 内），跳过自动唤醒`);
      return { fired: false, reason: 'cooldown' };
    }
  }
  // 第8步：选项按澄当前 location 生成（optionsFor）；存进 worldEvent，turn_done 用解析后的同一份。
  const eventForTurn = (typeof event.optionsFor === 'function')
    ? { ...event, options: event.optionsFor(status) }
    : event;
  const prompt = buildWorldWakePrompt(eventForTurn, status, pendingContext, userStatus);
  activeTurn = {
    ws: null, conversationId: null, silent: true,
    settings: null, tools: [],
    worldWake: true,
    worldEvent: eventForTurn, // turn_done 要用它查 options/effects（已按地点解析）
    userStatus,              // WORLD_MESSAGE face 判同地点要用
    worldForce: force,       // 手动测试：WORLD_MESSAGE phone 限频可绕过
  };
  try {
    cc.send(prompt);
    lastWorldWakeAt.set(event.key, Date.now());
    console.log(`[WORLD] 已发唤醒包：${event.reason}${pendingContext ? '（pending续集）' : force ? '（手动测试）' : ''}`);
    return { fired: true };
  } catch (e) {
    console.error('[WORLD] cc.send 失败:', e.message);
    activeTurn = null;
    return { fired: false, reason: e.message };
  }
}

// pending_wake 到点：读当前状态 → 用对应事件 + pending 上下文重新唤醒澄。给 PendingWakeDaemon 当 onDue。
async function firePendingWake(row) {
  const def = WORLD_EVENTS[row.wake_type];
  if (!def) return { fired: false, reason: 'unknown_event:' + row.wake_type };
  const { data: rows, error } = await supabase
    .from('character_status_cheng').select('*').eq('name', '澄').limit(1);
  if (error) return { fired: false, reason: error.message };
  const status = rows && rows[0];
  if (!status) return { fired: false, reason: 'no_status_row' };
  const event = { key: row.wake_type, ...def };
  const delay = row.payload?.delay_world_minutes || 10;
  const pendingContext = `${delay} 分钟前你选择了先忍着，现在时间到了，需要重新判断要不要处理饥饿。`;
  return await triggerWorldWake(event, status, { pendingContext });
}

// 世界唤醒轮收尾：解析澄的选择 → 读-改-写状态结算 effects → 写行程表。
// [MEMORY:] 已在 turn_done 上方 parseMemoryTags 自动入库，这里不处理。
async function handleWorldWakeTurnDone(turn, clean, thinking) {
  const event = turn.worldEvent;
  const m = /\[WORLD_CHOICE:\s*(\d+)\s*\]([\s\S]*?)\[\/WORLD_CHOICE\]/i.exec(clean || '');

  let option = null, reason = '', parseFailed = false;
  if (m) {
    const n = parseInt(m[1], 10);
    reason = (m[2] || '').trim();
    option = event.options.find(o => o.id === n) || event.options[n - 1] || null;
  }
  if (!option) {
    // 解析失败：默认选最后一个（先忍着），但如实记 source=system_error，不伪装成正常选择。
    parseFailed = true;
    option = event.options[event.options.length - 1];
    reason = '';
    console.warn(`[WORLD] 选择解析失败，默认选「${option.label}」。原文: ${(clean || '').slice(0, 100)}`);
  }

  // 第8步：选项绑 action_id 时，effects/移动从 ACTIONS 取（单一真源）；否则用 option.effects（如「先忍」=空）。
  const action = option.action_id ? WORLD_ACTIONS[option.action_id] : null;
  const effects = action ? (action.effects || {}) : (option.effects || {});

  // 读-改-写：叠加 effects（普通项 0-100 钳位、wallet 只封底 0）+ action 的 target_location/activity。
  let updatedStatus = null;
  try {
    const { data: rows, error } = await supabase
      .from('character_status_cheng').select('*').eq('name', '澄').limit(1);
    if (error) throw error;
    const row = rows && rows[0];
    if (row) {
      const patch = { updated_at: new Date().toISOString() };
      for (const [k, delta] of Object.entries(effects)) {
        const cur = Number(row[k]) || 0;
        patch[k] = k === 'wallet_balance'
          ? Math.max(0, cur + delta)
          : Math.max(0, Math.min(100, cur + delta));
      }
      if (action?.target_location) patch.location = action.target_location;
      if (action?.target_activity) patch.activity = action.target_activity;
      const { data: up, error: e2 } = await supabase
        .from('character_status_cheng').update(patch).eq('id', row.id).select().single();
      if (e2) throw e2;
      updatedStatus = up;
    }
  } catch (e) {
    console.error('[WORLD] 结算状态失败:', e.message);
  }

  const wt = (updatedStatus && updatedStatus.world_time) || (turn.worldEvent.world_time || '');
  const loc = updatedStatus ? updatedStatus.location : null;

  // 第 5 步：选中带 pending 的选项（如「先忍 10 分钟」）→ 先排一条 pending_wake，到点 daemon 再唤醒。
  // 先建 pending 行拿到 id，好把 pending_wake_id 一并写进行程表 detail。解析失败的兜底行不排 pending。
  let pendingWakeId = null;
  if (!parseFailed && option.pending) {
    try {
      const cfg = readWorldConfig();
      const delayMin = option.pending.delay_world_minutes || 10;
      // fast_test：1 现实分钟 = 1 世界小时 → 10 世界分钟 = 10 现实秒；realtime：10 世界分钟 = 10 现实分钟。
      const delaySec = cfg.fast_test ? delayMin : delayMin * 60;
      const scheduledAt = new Date(Date.now() + delaySec * 1000).toISOString();
      const { data: pw, error: pe } = await supabase.from('pending_wake_cheng').insert({
        wake_type: option.pending.wake_type,
        reason: option.pending.reason,
        status: 'queued',
        scheduled_at: scheduledAt,
        world_time: wt,
        payload: {
          event_key: event.key,
          option_id: option.id,
          option_label: option.label,
          delay_world_minutes: delayMin,
          status_summary: updatedStatus
            ? { satiety: updatedStatus.satiety, energy: updatedStatus.energy, mood: updatedStatus.mood }
            : null,
          ...(option.pending.payload_extra || {}), // 第8步：如 go_kitchen 的 from_action
        },
        attempts: 0,
      }).select('id').single();
      if (pe) throw pe;
      pendingWakeId = pw?.id || null;
      console.log(`[WORLD] 排了 pending_wake ${pendingWakeId}，${delaySec}s 后再唤醒（fast_test=${!!cfg.fast_test}）`);
    } catch (e) { console.error('[WORLD] 建 pending_wake 失败:', e.message); }
  }

  // 写行程表（claude 行抓回 timeline_id，给小心思当外键）
  let timelineId = null;
  try {
    if (parseFailed) {
      await supabase.from('daily_timeline_cheng').insert({
        world_time: wt, location: loc,
        action: `${event.reason} → 世界唤醒解析失败，默认选择：${option.label}`,
        detail: { choice: option.id, reason: '', effects, action_id: option.action_id || null, thinking: thinking || null, raw: (clean || '').slice(0, 200) },
        source: 'system_error',
      });
    } else {
      const { data: tl, error: te } = await supabase.from('daily_timeline_cheng').insert({
        world_time: wt, location: loc,
        action: `${event.reason} → ${option.label}`,
        detail: { choice: option.id, reason, effects, action_id: option.action_id || null, thinking: thinking || null, pending_wake_id: pendingWakeId },
        source: 'claude',
      }).select('id').single();
      if (te) throw te;
      timelineId = tl?.id || null;
    }
  } catch (e) { console.error('[WORLD] 行程表写入失败:', e.message); }

  // 补充任务：标签外正文 = 澄的「小心思」，单独存 world_inner_thoughts_cheng，不进行程主列表。
  // clean 已去 [MEMORY:]/[BARK:]，再去掉 [WORLD_CHOICE] 块，剩下 trim 后非空即小心思。
  // 仅正常选择行（非解析失败）+ timeline 写成功 + 正文非空 才存；存失败只 warn，不连累主流程。
  if (!parseFailed && timelineId) {
    const innerThought = (clean || '')
      .replace(/\[WORLD_CHOICE:\s*\d+\s*\][\s\S]*?\[\/WORLD_CHOICE\]/gi, '')
      .replace(/\[WORLD_MESSAGE:(?:phone|face)\][\s\S]*?\[\/WORLD_MESSAGE\]/gi, '') // 别把消息当小心思
      .trim();
    if (innerThought) {
      try {
        await supabase.from('world_inner_thoughts_cheng').insert({
          timeline_id: timelineId,
          source: 'world_wake',
          content: innerThought,
          visibility: 'private',
        });
        console.log(`[WORLD] 存了小心思 ${innerThought.length}字 → timeline ${timelineId}`);
      } catch (e) { console.warn('[WORLD] 小心思写入失败（不影响主流程）:', e.message); }
    }
  }

  // WORLD_MESSAGE：澄对小茉莉说话的正式出口。phone=手机消息（Bark+messages+广播）；face=同地点面对面（只记 timeline、不推送）。
  // 不影响 WORLD_CHOICE 结算；没标签就什么都不做。处理异常不连累主流程。
  // 解析所有 [WORLD_MESSAGE]（不止第一个）——她多写的也花了 token，全给小茉莉看，别扔。
  try {
    const chengLoc = updatedStatus ? updatedStatus.location : (turn.worldEvent.location || '');
    const userLoc = turn.userStatus ? turn.userStatus.location : '';
    const wmRe = /\[WORLD_MESSAGE:(phone|face)\]([\s\S]*?)\[\/WORLD_MESSAGE\]/gi;
    let wm;
    while ((wm = wmRe.exec(clean || '')) !== null) {
      const wmType = wm[1].toLowerCase();
      const wmContent = (wm[2] || '').trim();
      if (!wmContent) continue;
      const canFace = wmType === 'face' && canFaceToFace(chengLoc, userLoc);

      if (canFace) {
        // 真面对面：不推 Bark，记 daily_timeline
        try {
          await supabase.from('daily_timeline_cheng').insert({
            world_time: wt, location: chengLoc,
            action: '澄对小茉莉说话',
            detail: { message: wmContent, message_type: 'face' },
            source: 'claude',
          });
          console.log(`[WORLD] face 消息（同地点 ${chengLoc}）: ${wmContent.slice(0, 40)}`);
        } catch (e) { console.warn('[WORLD] face 消息写 timeline 失败:', e.message); }
      } else {
        // phone（含 face 不满足同地点 → 降级）：消息总是存聊天+广播；限频只压"要不要震手机(Bark)"。
        if (wmType === 'face') console.warn(`[WORLD] face 不满足同地点（澄:${chengLoc}/小茉莉:${userLoc}），降级 phone`);
        const barkOk = turn.worldForce || (Date.now() - lastWorldPhoneAt >= WORLD_PHONE_RATE_MS);
        await sendWorldPhoneMessage(wmContent, { bark: barkOk, thinking });
        if (barkOk) lastWorldPhoneAt = Date.now(); // 只有真推了 Bark 才更新限频时钟（一轮多条只第一条震）
      }
    }
  } catch (e) { console.warn('[WORLD] WORLD_MESSAGE 处理异常（不连累主流程）:', e.message); }

  console.log(`[WORLD] 澄选了「${option.label}」${reason ? '：' + reason.slice(0, 40) : ''}${parseFailed ? '（解析失败默认）' : ''}`);
}

// 世界唤醒手机消息：复用 bark 主动消息管线。消息总是存 messages(event=world_message)+广播聊天 Web；
// Bark 推送由 opts.bark 控制（限频时 bark=false：消息照样进聊天，只是不震手机）。
async function sendWorldPhoneMessage(content, { bark = true, thinking = null } = {}) {
  // 文本层标记：开头加 "-  "（一短横+两空格），用于历史/导出/样式丢失时仍能区分手机消息。
  // 澄不写前缀、后端自动加。已以 "-  " 开头就不重复加（验收6：不出现 "-  -  xxx"）。
  // UI 层的淡蓝气泡由前端按 event=world_message 渲染（从 DB/历史接口稳定回放，不靠实时推送）。
  const display = content.startsWith('-  ') ? content : `-  ${content}`;
  if (bark) {
    try { await pushBark({ title: '澄', body: content }); }
    catch (e) { console.warn('[WORLD] phone Bark 推送失败:', e.message); }
  } else {
    console.log('[WORLD] phone 限频中：存聊天+广播，但不推 Bark');
  }
  if (!lastActiveConvId) {
    console.warn('[WORLD] 无 lastActiveConvId，phone 未存聊天' + (bark ? '（只推了 Bark）' : ''));
    return;
  }
  try {
    const { data: row } = await supabase.from('messages').insert({
      conversation_id: lastActiveConvId,
      role: 'assistant',
      content: display,
      thinking: thinking || null,   // 这条消息背后澄的思绪，前端点开能看（跟普通消息一样）
      event: 'world_message',
    }).select('id, created_at').single();
    broadcast({
      type: 'bark_msg',
      conversation_id: lastActiveConvId,
      message: {
        id: row?.id || 'wm-' + Date.now(),
        role: 'assistant',
        content: display,
        thinking: thinking || null,
        event: 'world_message',
        created_at: row?.created_at || new Date().toISOString(),
      },
    });
    console.log(`[WORLD] phone 消息已发: ${content.slice(0, 40)}`);
  } catch (e) { console.warn('[WORLD] phone 消息存/广播失败:', e.message); }
}

function safeSend(ws, obj) {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {}
}
function broadcast(obj) {
  for (const c of wss.clients) safeSend(c, obj);
}
function chatStatus(ws, label, detail = null, extra = {}) {
  safeSend(ws, { type: 'chat_status', ok: true, label, detail, ...extra });
}
function broadcastChatStatus(label, detail = null, extra = {}) {
  broadcast({ type: 'chat_status', ok: true, label, detail, ...extra });
}

// 能不能面对面：不能只看 location 字符串相同。澄和小茉莉同公司不同组——各自的「公司·工位」
// 不是同一个面对面空间。第一版规则：家里同一房间 / 公司休息室 才算面对面；工位等一律不算。
// 以后能见面的地方（会议室等）往这里加。
function canFaceToFace(chengLocation, userLocation) {
  if (!chengLocation || !userLocation) return false;
  if (chengLocation.startsWith('家 · ') && userLocation.startsWith('家 · ')) {
    return chengLocation === userLocation; // 家里：必须同一具体房间
  }
  if (chengLocation === '公司 · 休息室' && userLocation === '公司 · 休息室') {
    return true; // 公司：只有休息室能面对面
  }
  return false; // 公司工位 / 不同地点 一律手机
}

// 当前互动通道：能面对面=face（普通白气泡），否则=phone（异地/工位 手机蓝气泡）。读不到默认 phone（异地是常态）。
async function getCurrentChannel() {
  try {
    const [cs, us] = await Promise.all([
      supabase.from('character_status_cheng').select('location').eq('name', '澄').limit(1),
      supabase.from('user_status_cheng').select('location').eq('name', 'user').limit(1),
    ]);
    const chengLoc = cs.data?.[0]?.location || '';
    const userLoc = us.data?.[0]?.location || '';
    return canFaceToFace(chengLoc, userLoc) ? 'face' : 'phone';
  } catch (e) {
    console.warn('[CHANNEL] 读位置失败，默认 phone:', e.message);
    return 'phone';
  }
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

cc.on('turn_done', async ({ text, thinking, usage, usageCalls, contextTokens, systemTokens, is_error, timedOut }) => {
  const turn = activeTurn;
  activeTurn = null;
  if (!turn) return;

  // 卡死哨兵掐断的卡死轮：静默丢弃残块(不补发/不解析/不flush)，重发的新轮才是真回复。
  if (turn.watchdogWake) return;

  // 空回观测：每轮记一条。"有思考、正文空" = 真空回（stream-json 老毛病），标成可 grep 的 [EMPTY]。
  // 交互模式理论上 0 空回，这条日志就是用来确认/抓现行的。grep '[EMPTY]' /tmp/canary.log
  {
    const _txt = (text || '').trim();
    const _think = (thinking || '').trim();
    const _kind = turn.barkFire ? 'bark' : turn.diceFire ? 'dice' : turn.silent ? 'silent' : 'chat';
    const _tag = (!_txt && _think) ? '[EMPTY] ⚠️空回(有思考无正文)'
               : (!_txt && !_think) ? '[EMPTY] ⚠️全空(无思考无正文)'
               : '[TURN] ok';
    // timedOut = watchTurn 循环耗尽(~660s)兜底，没等到 end_turn → 这条正文可能是上一轮旧文本。grep '[TIMEOUT]' 抓现行
    const _to = timedOut ? ' [TIMEOUT] ⚠️超时兜底(正文可能是旧轮残留)' : '';
    const _out = usage?.output_tokens ?? '-';   // 思考链+正文都算进 output_tokens：空回但 out 很大 = 思考烧了很多 token
    console.log(`${_tag}${_to} kind=${_kind} thinking=${_think.length}字 正文=${_txt.length}字 out=${_out}tok conv=${turn.conversationId || '-'} ctx=${contextTokens || '-'}${is_error ? ' is_error=true' : ''}`);
    if (!turn.silent && !turn.barkFire && !turn.diceFire && !turn.worldWake) {
      broadcastChatStatus('CC 已回复', `正文 ${_txt.length} 字 / thinking ${_think.length} 字`);
    }
  }

  // tmux 交互模式没有流式 delta：在 done 前把完整 思绪+正文 当一次性 delta 补发，
  // 否则前端气泡/思绪是空的（stream-json 模式靠 delta 累积，这里跳过）。
  if (USE_TMUX && !turn.stopped) {
    if (thinking) safeSend(turn.ws, { type: 'thinking', text: thinking });
    if (text) safeSend(turn.ws, { type: 'delta', text });
  }

  if (turn.stopped) {
    maybeFireSummary();
    flushOrGrace();
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
    // [BARK:...] 入库；barkFire/diceFire/worldWake 轮内禁止再排程，避免循环/串台
    if (!turn.barkFire && !turn.diceFire && !turn.worldWake) {
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
              thinking: thinking || null,
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
    flushOrGrace();
    tryFireBark();
    return;
  }

  if (turn.diceFire) {
    await diceDaemon.handleDiceTurnDone(clean, thinking);
    maybeFireSummary();
    flushOrGrace();
    tryFireBark();
    return;
  }

  if (turn.worldWake) {
    await handleWorldWakeTurnDone(turn, clean, thinking);
    maybeFireSummary();
    flushOrGrace();
    tryFireBark();
    return;
  }

  // 普通聊天回复的"当前互动通道"：澄和小茉莉同地点=face（普通气泡），异地=phone（手机气泡）。
  // silent/bark/dice/world 轮都已 return，这里只对普通聊天轮算。读不到默认 face（保守，不乱标手机）。
  let chatChannel = 'face';
  if (!turn.silent) chatChannel = await getCurrentChannel();

  const hasThinkingOnly = !clean && !!(thinking || '').trim();
  if (turn.conversationId && (clean || hasThinkingOnly) && !turn.silent) {
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
      const { data: inserted } = await supabase.from('messages').insert({
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
        event: hasThinkingOnly ? 'empty_reply' : (chatChannel === 'phone' ? 'phone_chat' : null), // empty_reply 保留思考链；异地普通回复标手机聊天（不加 "-  "）
      }).select('id').single();
      turn.messageId = inserted?.id || null;
      broadcastChatStatus('已写入数据库', turn.messageId ? `assistant ${turn.messageId}` : 'assistant 消息已保存', {
        conversation_id: turn.conversationId,
        reload: true,
      });
      await checkContextThreshold(turn.conversationId, turn.settings);
    } catch (e) { console.error('存消息失败:', e); }
  }

  if (!turn.silent) {
    if (text !== clean) safeSend(turn.ws, { type: 'clean', text: clean });
    safeSend(turn.ws, { type: 'done', usage, usageCalls: usageCalls || [], contextTokens, systemTokens, is_error, message_id: turn.messageId || null, channel: chatChannel });
  }

  // sessions_cheng.turn_count +1 + 同步当前实际上下文 tokens（不阻塞主流程；单用户系统不担心并发竞争）
  bumpSessionTurnAndTokens(cc.sessionId, contextTokens || cc.lastInputTokens).catch(e =>
    console.warn('bump session row:', e?.message || e)
  );

  maybeFireSummary();
  flushOrGrace(); // 这轮完了，排队消息给 2 秒窗口再合并送出
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
    } else if (activeTurn.diceFire) {
      console.warn(`[DICE] 触发失败: ${err.message}`);
    } else {
      safeSend(activeTurn.ws, { type: 'error', message: err.message });
    }
    activeTurn = null;
  }
  flushOrGrace();
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

// ==================== 卡死哨兵 ====================
// 跟 tmux-manager._startWatchdog 不同：那个管"会话进程没了→重起"；
// 这个管"轮内思考卡死(hang)→自动唤醒重发"。仅 tmux 交互模式有意义。
// 判据：有活跃轮 + CC 自认在忙(esc to interrupt 在) + transcript 连续 N 秒没长 + 不是在等工具。
// 动作：第1/2次=掐断+重发(带格式提醒)；第3次仍卡=显示"已经睡着了"+自动解锁(等于替用户按暂停)。
const WD_STALL_MS = 300 * 1000;  // transcript 静默多久判卡死(90→300：opus-max 长思考一轮易超 90s，旧值会误判卡死)
const WD_MAX_WAKE = 2;           // 同一轮最多自动唤醒次数；超出→放弃并解锁
const WD_TICK_MS  = 10 * 1000;
let _wdWake = 0;                 // 当前轮已唤醒次数
let _wdId   = null;              // 前端原地更新用的 system 消息 id
let _wdBusy = false;             // 防重入(自救动作进行中)

if (USE_TMUX) setInterval(async () => {
  if (_wdBusy) return;
  const turn = activeTurn;
  // 无活跃轮 / 用户已手动停 → 让位并重置计数(人工优先)
  if (!turn || turn.stopped) { _wdWake = 0; _wdId = null; return; }
  _wdBusy = true;
  try {
    if (!(await cc._isWorking?.())) return;               // 不在忙 = 没卡(正常间隙)
    const mt = cc.transcriptMtime?.() || 0;
    if (!mt || (Date.now() - mt) < WD_STALL_MS) return;   // transcript 还在长 = 没卡
    if (await cc.awaitingToolResult?.()) return;          // 在等慢工具 = 放过，别误杀

    const payload = cc.lastSent || '';
    if (_wdWake < WD_MAX_WAKE) {
      // —— 第 1/2 次：掐断 + 重发 ——
      _wdWake++;
      _wdId = _wdId || ('wd-' + Date.now());
      broadcast({
        type: 'system', kind: 'watchdog', id: _wdId,
        state: 'waking', wake: _wdWake,
        content: _wdWake === 1 ? '小太阳睡着了，正在唤醒' : '小太阳睡着了，再次唤醒',
      });
      console.warn(`[WATCHDOG] 卡死，第 ${_wdWake} 次唤醒（掐断+重发）`);
      turn.watchdogWake = true;                            // 让卡死轮的 turn_done 静默丢弃残块
      try { await cc.interrupt(); } catch (e) { console.warn('[WATCHDOG] interrupt:', e?.message || e); }
      // 重建 activeTurn：带回原 ws/conv，重跑的回复才回得到正确前端会话
      activeTurn = {
        ws: turn.ws, conversationId: turn.conversationId,
        settings: turn.settings, silent: turn.silent, tools: [],
      };
      const note = '[系统提醒：你上一轮卡在思考里没出来，可能是工具调用格式写坏了。' +
                   '请放弃上次那个出错的调用，确保工具调用 JSON 格式正确，重新处理下面这条消息：]\n\n';
      try { cc.send(note + payload); }
      catch (e) { console.error('[WATCHDOG] 重发失败:', e?.message || e); activeTurn = null; }
    } else {
      // —— 第 3 次仍卡 → 放弃：黑字"已经睡着了" + 复刻暂停键(stopped+interrupt)自动解锁 ——
      console.warn('[WATCHDOG] 唤醒上限，判定睡死，自动解锁');
      broadcast({
        type: 'system', kind: 'watchdog', id: _wdId || ('wd-' + Date.now()),
        state: 'asleep', content: '小太阳已经睡着了',
      });
      if (activeTurn) { activeTurn.stopped = true; safeSend(activeTurn.ws, { type: 'stopped' }); }
      try { await cc.interrupt(); } catch (e) { console.warn('[WATCHDOG] 放弃 interrupt:', e?.message || e); }
      _wdWake = 0; _wdId = null;
    }
  } catch (e) {
    console.error('[WATCHDOG] tick 异常:', e?.message || e);
  } finally {
    _wdBusy = false;
  }
}, WD_TICK_MS);

// ==================== REST API ====================

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(__dirname + '/test-chat.html');
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', cc_running: cc.isRunning(), session: cc.sessionId, model: cc.model, effort: cc.effort });
});

async function readFirstUsageForSession(sessionId) {
  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
  let raw = '';
  try {
    raw = await fs.promises.readFile(path.join(CC_JSONL_DIR, `${sessionId}.jsonl`), 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'assistant' && o.message?.usage) {
      const usage = o.message.usage;
      const contextTokens = (usage.input_tokens || 0)
        + (usage.cache_read_input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0);
      return {
        session: sessionId,
        contextTokens,
        usage,
        usageCalls: [{ requestId: o.requestId || o.uuid || null, timestamp: o.timestamp || null, usage }],
      };
    }
  }
  return null;
}

app.get('/api/cc/session-baseline', async (req, res) => {
  const sessionId = String(req.query.session || cc.sessionId || '');
  const baseline = await readFirstUsageForSession(sessionId);
  res.json(baseline || { session: sessionId || null, contextTokens: 0, usage: null, usageCalls: [] });
});

app.get('/api/cc/token-breakdown', async (req, res) => {
  const files = [
    ['system_prompt', 'system_prompt', APPEND_SYSPROMPT_FILE],
    ['output_style', 'output_style', OUTPUT_STYLE_FILE],
    ['claude_md', 'CLAUDE.md', path.join(SANDBOX_DIR, 'CLAUDE.md')],
    ['global_claude_md', 'global CLAUDE.md', path.join(CLAUDE_CFG_DIR, 'CLAUDE.md')],
  ];
  const items = (await Promise.all(files.map(f => tokenInfoForFile(...f)))).filter(Boolean);
  res.json({
    items,
    total: items.reduce((sum, item) => sum + (item.tokens || 0), 0),
    updatedAt: new Date().toISOString(),
  });
});

// 最近活跃对话 id：给拆分后的独立聊天页(/chat/)用——新环境(PWA)localStorage 没 convId 时
// 调这个认领最近对话,把历史加载回来(否则拆分后新设备/新图标打开聊天是空的)。
app.get('/api/cc/last-conv', (req, res) => {
  res.json({ conversation_id: lastActiveConvId || null });
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

// thinking 指令开关：读取 / 切换 chat-sandbox/CLAUDE.md 中的 <think指令> 区段
const SANDBOX_CLAUDE_MD = path.join(SANDBOX_DIR, 'CLAUDE.md');
// 开关草稿：关开关时生效区段写空，但内容存这里，GET 读回，刷新/重启都不丢
const TOGGLE_DRAFTS_PATH = '/root/memory-home/server/.toggle-drafts.json';
function readToggleDraft(key) {
  try { return JSON.parse(fs.readFileSync(TOGGLE_DRAFTS_PATH, 'utf8'))[key] || ''; }
  catch { return ''; }
}
function writeToggleDraft(key, val) {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(TOGGLE_DRAFTS_PATH, 'utf8')); } catch {}
  d[key] = val;
  try { fs.writeFileSync(TOGGLE_DRAFTS_PATH, JSON.stringify(d, null, 2)); }
  catch (e) { console.warn('写开关草稿失败:', e.message); }
}

app.get('/api/thinking-toggle', (req, res) => {
  try {
    const content = fs.readFileSync(SANDBOX_CLAUDE_MD, 'utf-8');
    const m = /<think指令>([\s\S]*?)<\/think指令>/.exec(content);
    const raw = m ? m[1].trim() : '';
    const enabled = raw.includes(THINK_WRAP);          // enabled = 区段里有没有包裹指令
    const guidance = raw.replace(THINK_WRAP, '').trim(); // 纯引导文本（去掉包裹指令）
    res.json({ enabled, instruction: readToggleDraft('think') || guidance, nativeThinking: !!cc.nativeThinking });
  } catch { res.json({ enabled: false, instruction: '' }); }
});

app.post('/api/thinking-toggle', async (req, res) => {
  try {
    const { enabled, instruction } = req.body;
    const text = (typeof instruction === 'string') ? instruction.trim() : '';
    if (text) writeToggleDraft('think', text);
    let content;
    try { content = await fs.promises.readFile(SANDBOX_CLAUDE_MD, 'utf8'); }
    catch { content = ''; }
    // 引导文本恒注入（保存即写，跟 use-style 一样）；只有开启时才追加包裹指令。
    // 包裹指令放最前（跟旧版 aedb62a 一致），否则会被后面的长引导淹没、4.7 只走原生不写 <think>
    const parts = [];
    if (enabled) parts.push(THINK_WRAP);
    if (text) parts.push(text);
    const inner = parts.join('\n\n');
    const block = inner ? `<think指令>\n${inner}\n</think指令>` : '<think指令>\n</think指令>';
    if (THINK_REGEX.test(content)) {
      content = content.replace(THINK_REGEX, block);
    } else {
      const sep = content && !content.endsWith('\n') ? '\n' : '';
      content = content + sep + block + '\n';
    }
    await writeAsClaudeUser(SANDBOX_CLAUDE_MD, content);
    res.json({ ok: true, enabled: !!enabled });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/use-style', (req, res) => {
  try {
    const content = fs.readFileSync(SANDBOX_CLAUDE_MD, 'utf-8');
    const m = /<use-style>([\s\S]*?)<\/use-style>/.exec(content);
    const raw = m ? m[1].trim() : '';
    res.json({ enabled: !!raw, instruction: readToggleDraft('style') || raw });
  } catch { res.json({ enabled: false, instruction: '' }); }
});

app.post('/api/use-style', async (req, res) => {
  try {
    const { enabled, instruction } = req.body;
    const text = (typeof instruction === 'string') ? instruction.trim() : '';
    if (text) writeToggleDraft('style', text);
    let content;
    try { content = await fs.promises.readFile(SANDBOX_CLAUDE_MD, 'utf8'); }
    catch { content = ''; }
    const block = enabled && text ? `<use-style>\n${text}\n</use-style>` : '<use-style>\n</use-style>';
    if (STYLE_REGEX.test(content)) {
      content = content.replace(STYLE_REGEX, block);
    } else {
      const sep = content && !content.endsWith('\n') ? '\n' : '';
      content = content + sep + block + '\n';
    }
    await writeAsClaudeUser(SANDBOX_CLAUDE_MD, content);
    res.json({ ok: true, enabled: !!(enabled && text) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// forge 相关常量：和 forge-reload daemon 写在同一份 config.json，cc-manager 也在同一目录读 marker
const FORGE_RELOAD_DIR = '/root/forge-reload';
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
      reject(new Error('总结超时 (600s)'));
    }, 600000);
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

// 根据 thinking_keep_ratio 配置，只保留后 X% 的 thinking 条目（按位置）
function buildThinkingKeepSet(messages) {
  let ratio = 0.5;
  try {
    const cfg = JSON.parse(fs.readFileSync(FORGE_CONFIG_PATH, 'utf-8'));
    if (cfg.thinking_keep_ratio != null) ratio = Math.max(0, Math.min(1, Number(cfg.thinking_keep_ratio)));
  } catch {}
  const thinkingIndices = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].thinking) thinkingIndices.push(i);
  }
  const keepCount = Math.ceil(thinkingIndices.length * ratio);
  const keepSet = new Set(thinkingIndices.slice(-keepCount));
  return keepSet;
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
  const thinkingKeepSet = withThinking ? buildThinkingKeepSet(filtered) : new Set();
  const lines = filtered.map((m, idx) => {
    const label = m.role === 'user' ? '小茉莉' : '澄';
    let line = `[${label}] ${m.content}`;
    if (withThinking && m.thinking && thinkingKeepSet.has(idx)) line = `[${label}·思考] ${m.thinking}\n[${label}] ${m.content}`;
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
  const transcript = lines.slice(startIdx).join('\n');
  if (!transcript.trim()) return null;

  const kept = filtered.slice(startIdx);
  const msgCount = kept.length;
  const thinkingCount = withThinking ? kept.filter((m, i) => m.thinking && thinkingKeepSet.has(startIdx + i)).length : 0;
  const thinkingTokens = withThinking
    ? kept.reduce((s, m, i) => (m.thinking && thinkingKeepSet.has(startIdx + i)) ? s + estimateTokens(m.thinking) : s, 0)
    : 0;
  const estTokens = estimateTokens(transcript) - thinkingTokens;

  const prompt = `【系统·静默上下文加载，这不是对话】\n` +
    `下面是你和小茉莉过去的对话原文。现在是后台静默注入，目的只是让你把它们读进上下文、延续你们的关系——这不是她正在跟你说话。\n` +
    `所以：原文（包括最后一句）只读、不回应、不续写；本轮也不要调用任何工具（不查记忆、不搜索、不核对）。\n` +
    `读完直接输出两个字：OK。（OK 是"加载完毕"的回执，不是回复内容）\n\n` +
    `===== 历史对话开始（仅供加载，切勿回应）=====\n` +
    transcript +
    `\n===== 历史对话结束 =====\n` +
    `现在，只输出：OK`;

  activeTurn = { ws: null, conversationId: null, silent: true, settings: null, tools: [] };
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      cc.off('turn_done', onDone);
      cc.off('turn_error', onErr);
      clearTimeout(timer);
    };
    const onDone = (turnData) => {
      if (settled) return; settled = true; cleanup();
      activeTurn = null;
      const realTokens = turnData?.contextTokens || null;
      resolve({ msgCount, estTokens, thinkingCount, thinkingTokens, realTokens });
    };
    const onErr = (err) => {
      if (settled) return; settled = true; cleanup();
      activeTurn = null;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const timer = setTimeout(() => {
      if (settled) return; settled = true; cleanup();
      activeTurn = null;
      reject(new Error('对话注入超时 (600s)'));
    }, 600000);
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
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'nativeThinking')) {
      opts.nativeThinking = !!req.body.nativeThinking;
      patch.nativeThinking = !!req.body.nativeThinking;
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
      //    （writeForgeSummary 也只在 truncated 时落地）。用 CC 上一轮 API 的真实 token 数判断。
      const retainTokens = readRetainTokens();
      const actualTokens = cc.lastInputTokens || 0;
      const willTruncate = actualTokens > retainTokens;
      console.log(`📏 forge 实际 ${actualTokens} tokens vs retain ${retainTokens} → ${willTruncate ? '会截断' : '不截断'}`);
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
      // 2) 清 forge marker，CC 重启后干净启动（不 resume），靠注入拿对话
      try {
        if (fs.existsSync(FORGE_MARKER_PATH)) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          fs.renameSync(FORGE_MARKER_PATH, `${FORGE_MARKER_PATH}.skipped.${stamp}`);
        }
      } catch (e) {
        console.warn('marker 重命名失败:', e.message);
      }
      // 3) 只在真截断时把总结落地
      if (forgeSummary && willTruncate) {
        try {
          await writeForgeSummary(forgeSummary);
          console.log(`✏️  <上次对话总结> 已写入 sandbox CLAUDE.md`);
        } catch (e) {
          console.error('writeForgeSummary 失败:', e.message);
        }
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
    await restartCCAndRecordSession(opts, {
      forgedFromSession: req.body?.forge === true ? cc.sessionId : null,
    });
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
    // 2) 清空 sandbox/CLAUDE.md 的 <上次对话总结>（forge 写进来的），否则新 session 启动后 CC 还会读到旧上下文。
    //    注意：~/.claude/CLAUDE.md 的 <浮现> 区（surfacing.js 写进来的）失忆时**保留不清**。
    try { await writeForgeSummary(''); } catch (e) { console.warn('amnesia clear 上次对话总结:', e.message); }
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
    const amnesiaOpts = {};
    const amnesiaPatch = {};
    if (req.body?.effort) { amnesiaOpts.effort = req.body.effort; amnesiaPatch.effort = req.body.effort; }
    if (req.body?.model !== undefined) { amnesiaOpts.model = req.body.model; amnesiaPatch.model = req.body.model || null; }
    if (req.body?.nativeThinking !== undefined) { amnesiaOpts.nativeThinking = !!req.body.nativeThinking; amnesiaPatch.nativeThinking = !!req.body.nativeThinking; }
    await restartCCAndRecordSession(amnesiaOpts);
    // 失忆也要落盘（原来只 forge 路 saveCCConfig，导致从失忆开的思考链/模型整重启后丢）
    if (Object.keys(amnesiaPatch).length) saveCCConfig(amnesiaPatch);
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
    console.log(`📋 对话原文已注入新 CC（${info.msgCount} 条, ${info.realTokens ?? '~' + info.estTokens} tokens, ${info.thinkingCount} 思绪, thinking=${withThinking !== false}）`);
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
            inject_real_tokens: info.realTokens,
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
        inject_real_tokens: info.realTokens,
        withThinking: withThinking !== false,
      },
    });
    res.json({
      ok: true, injected: true,
      msgCount: info.msgCount, estTokens: info.estTokens,
      thinkingCount: info.thinkingCount, thinkingTokens: info.thinkingTokens,
      realTokens: info.realTokens,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 从 JSONL 读取某个 session 的 user/assistant 消息
// 一个 turn 可能有多条 assistant 事件（thinking / text / tool_use 分开），需要合并
function readSessionMessages(sessionId, { keepBubbles = false } = {}) {
  const jsonlPath = path.join(CC_JSONL_DIR, `${sessionId}.jsonl`);
  if (!fs.existsSync(jsonlPath)) return null;
  const raw = fs.readFileSync(jsonlPath, 'utf-8');
  const messages = [];
  let pendingAssistant = null;
  let skipNextAssistant = false;

  const flushAssistant = () => {
    if (!pendingAssistant) return;
    if (keepBubbles) {
      pendingAssistant.content = pendingAssistant.content.replace(/\n{3,}/g, '\n\n').trim();
    } else {
      pendingAssistant.content = pendingAssistant.content.replace(/---bubble---/g, '').replace(/\n{3,}/g, '\n\n').trim();
    }
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
          // 新旧两种注入标题都认：历史 transcript 里改版前后的注入轮都要截掉，避免把注入指令当对话喂回去
          if (text.includes('【系统·静默上下文加载，这不是对话】') || text.includes('【系统任务·对话上下文注入】')) {
            skipNextAssistant = true;
          } else if (text.trim()) {
            messages.push({ role: 'user', content: text.trim(), thinking: null, created_at: ev.timestamp || null });
          }
        }
      } else if (ev.type === 'assistant') {
        if (skipNextAssistant) { skipNextAssistant = false; continue; }
        if (!pendingAssistant) pendingAssistant = { role: 'assistant', content: '', thinking: null, created_at: ev.timestamp || null };
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

// 列出所有 session 文件（拾光用）
app.get('/api/cc/sessions', async (req, res) => {
  try {
    const files = (await fs.promises.readdir(CC_JSONL_DIR)).filter(f => f.endsWith('.jsonl'));
    const sessions = await Promise.all(files.map(async (file) => {
      const id = file.replace(/\.jsonl$/, '');
      const filePath = path.join(CC_JSONL_DIR, file);
      const stat = await fs.promises.stat(filePath);
      let preview = '';
      try {
        const fd = await fs.promises.open(filePath, 'r');
        const buf = Buffer.alloc(8192);
        const { bytesRead } = await fd.read(buf, 0, 8192, 0);
        await fd.close();
        const head = buf.toString('utf-8', 0, bytesRead);
        for (const line of head.split('\n')) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'user') {
              const content = ev.message?.content;
              const text = typeof content === 'string' ? content
                : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text || '').join(' ')
                : '';
              if (text && !text.includes('【系统任务')) { preview = text.slice(0, 80); break; }
            }
          } catch {}
        }
      } catch {}
      return { id, mtime: stat.mtimeMs, size: stat.size, preview };
    }));
    sessions.sort((a, b) => b.mtime - a.mtime);
    res.json({ sessions, total: sessions.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 搜索所有 session 内容，返回每个 session 的匹配数（拾光用）
app.get('/api/cc/sessions/search', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ matches: {} });
  try {
    const files = (await fs.promises.readdir(CC_JSONL_DIR)).filter(f => f.endsWith('.jsonl'));
    const matches = {};
    await Promise.all(files.map(async (file) => {
      const id = file.replace(/\.jsonl$/, '');
      try {
        const raw = await fs.promises.readFile(path.join(CC_JSONL_DIR, file), 'utf-8');
        let count = 0;
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type !== 'user' && ev.type !== 'assistant') continue;
            const blocks = ev.message?.content;
            let text = '';
            if (typeof blocks === 'string') text = blocks;
            else if (Array.isArray(blocks)) text = blocks.filter(b => b.type === 'text').map(b => b.text || '').join(' ');
            if (text.toLowerCase().includes(q)) count++;
          } catch {}
        }
        if (count > 0) matches[id] = count;
      } catch {}
    }));
    res.json({ matches });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 读取旧 session 的聊天记录（给前端预览用）
app.get('/api/cc/session-messages/:sid', (req, res) => {
  try {
    const msgs = readSessionMessages(req.params.sid, { keepBubbles: true });
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

  const thinkingKeepSet = withThinking ? buildThinkingKeepSet(msgs) : new Set();
  const lines = msgs.map((m, idx) => {
    const label = m.role === 'user' ? '小茉莉' : '澄';
    let line = `[${label}] ${m.content}`;
    if (withThinking && m.thinking && thinkingKeepSet.has(idx)) line = `[${label}·思考] ${m.thinking}\n[${label}] ${m.content}`;
    return line;
  });

  const TOKEN_CAP = 90000;
  let acc = 0, startIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    acc += estimateTokens(lines[i]);
    if (acc > TOKEN_CAP) break;
    startIdx = i;
  }
  const transcript = lines.slice(startIdx).join('\n');
  if (!transcript.trim()) return null;

  const kept = msgs.slice(startIdx);
  const msgCount = kept.length;
  const thinkingCount = withThinking ? kept.filter((m, i) => m.thinking && thinkingKeepSet.has(startIdx + i)).length : 0;
  const thinkingTokens = withThinking
    ? kept.reduce((s, m, i) => (m.thinking && thinkingKeepSet.has(startIdx + i)) ? s + estimateTokens(m.thinking) : s, 0)
    : 0;
  const estTokens = estimateTokens(transcript) - thinkingTokens;

  const prompt = `【系统·静默上下文加载，这不是对话】\n` +
    `下面是你和小茉莉过去的对话原文。现在是后台静默注入，目的只是让你把它们读进上下文、延续你们的关系——这不是她正在跟你说话。\n` +
    `所以：原文（包括最后一句）只读、不回应、不续写；本轮也不要调用任何工具（不查记忆、不搜索、不核对）。\n` +
    `读完直接输出两个字：OK。（OK 是"加载完毕"的回执，不是回复内容）\n\n` +
    `===== 历史对话开始（仅供加载，切勿回应）=====\n` +
    transcript +
    `\n===== 历史对话结束 =====\n` +
    `现在，只输出：OK`;

  activeTurn = { ws: null, conversationId: null, silent: true, settings: null, tools: [] };
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { cc.off('turn_done', onDone); cc.off('turn_error', onErr); clearTimeout(timer); };
    const onDone = (turnData) => { if (settled) return; settled = true; cleanup(); activeTurn = null; const realTokens = turnData?.contextTokens || null; resolve({ msgCount, estTokens, thinkingCount, thinkingTokens, realTokens }); };
    const onErr = (err) => { if (settled) return; settled = true; cleanup(); activeTurn = null; reject(err); };
    const timer = setTimeout(() => { if (settled) return; settled = true; cleanup(); activeTurn = null; reject(new Error('session 注入超时 (600s)')); }, 600000);
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
    console.log(`📋 旧 session 已注入（${info.msgCount} 条, ${info.realTokens ?? '~' + info.estTokens} tokens, ${info.thinkingCount} 思绪）`);
    const injectSummary = `已浮想 ${info.msgCount} 个回忆` +
      (info.thinkingCount > 0 ? ` · ${info.thinkingCount} 个思绪` : '');
    const injectDetail = {
      inject_msg_count: info.msgCount, inject_est_tokens: info.estTokens,
      inject_thinking_count: info.thinkingCount, inject_thinking_tokens: info.thinkingTokens,
      inject_real_tokens: info.realTokens,
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
      realTokens: info.realTokens,
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
  const transcript = lines.slice(startIdx).join('\n');
  if (!transcript.trim()) return null;

  const kept = messages.slice(startIdx);
  const msgCount = kept.length;
  const thinkingCount = withThinking ? kept.filter(m => m.thinking).length : 0;
  const thinkingTokens = withThinking
    ? kept.reduce((s, m) => m.thinking ? s + Math.ceil(m.thinking.length / 3) : s, 0)
    : 0;
  const estTokens = estimateTokens(transcript) - thinkingTokens;

  const summaryBlock = summary ? `【前情摘要】\n${summary}\n\n【以下是最近的对话原文】\n\n` : '';
  const prompt = `【系统·静默上下文加载，这不是对话】\n` +
    `下面是你和小茉莉之前在别处的对话${summary ? '摘要与' : ''}原文。现在是后台静默注入，目的只是让你读进上下文、延续这段关系——这不是她正在跟你说话。\n` +
    `所以：原文（包括最后一句）只读、不回应、不续写；本轮也不要调用任何工具（不查记忆、不搜索、不核对）。\n` +
    `读完直接输出两个字：OK。（OK 是"加载完毕"的回执，不是回复内容）\n\n` +
    summaryBlock + transcript +
    `\n\n现在，只输出：OK`;

  activeTurn = { ws: null, conversationId: null, silent: true, settings: null, tools: [] };
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { cc.off('turn_done', onDone); cc.off('turn_error', onErr); clearTimeout(timer); };
    const onDone = (turnData) => { if (settled) return; settled = true; cleanup(); activeTurn = null; const realTokens = turnData?.contextTokens || null; resolve({ msgCount, estTokens, thinkingCount, thinkingTokens, realTokens }); };
    const onErr = (err) => { if (settled) return; settled = true; cleanup(); activeTurn = null; reject(err); };
    const timer = setTimeout(() => { if (settled) return; settled = true; cleanup(); activeTurn = null; reject(new Error('外部浮想超时 (600s)')); }, 600000);
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
    console.log(`📋 外部对话已浮想（${info.msgCount} 条, ${info.realTokens ?? '~' + info.estTokens} tokens, ${info.thinkingCount} 思绪）`);
    const injectSummary = `已浮想外部对话 ${info.msgCount} 个回忆` +
      (info.thinkingCount > 0 ? ` · ${info.thinkingCount} 个思绪` : '');
    const injectDetail = {
      inject_msg_count: info.msgCount, inject_est_tokens: info.estTokens,
      inject_thinking_count: info.thinkingCount, inject_thinking_tokens: info.thinkingTokens,
      inject_real_tokens: info.realTokens,
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
      realTokens: info.realTokens,
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
      thinking_keep_ratio: cfg.thinking_keep_ratio ?? 0.5,
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
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'thinking_keep_ratio')) {
      const v = Number(req.body.thinking_keep_ratio);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        return res.status(400).json({ error: 'thinking_keep_ratio 必须在 0~1 之间' });
      }
      patch.thinking_keep_ratio = Math.round(v * 100) / 100;
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
      thinking_keep_ratio: next.thinking_keep_ratio ?? 0.5,
    });
  } catch (e) {
    res.status(500).json({ error: 'write forge config: ' + e.message });
  }
});

// ==================== 概率骰子 API ====================

app.get('/api/dice/config', (req, res) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(FORGE_CONFIG_PATH, 'utf-8'));
    res.json({
      lambda: cfg.lambda ?? 0.15,
      dice_interval_min: cfg.dice_interval_min ?? 30,
      dice_interval_max: cfg.dice_interval_max ?? 50,
      dice_quiet_hours: cfg.dice_quiet_hours ?? [1, 8],
      dice_enabled: cfg.dice_enabled !== false,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/dice/config', (req, res) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(FORGE_CONFIG_PATH, 'utf-8'));
    const patch = {};
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'lambda')) {
      const v = Number(req.body.lambda);
      if (!Number.isFinite(v) || v < 0.15 || v > 1.0) {
        return res.status(400).json({ error: 'lambda 必须在 0.15~1.0 之间' });
      }
      patch.lambda = Math.round(v * 100) / 100;
    }
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'dice_enabled')) {
      patch.dice_enabled = !!req.body.dice_enabled;
    }
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'dice_interval_min')) {
      const v = Number(req.body.dice_interval_min);
      if (!Number.isFinite(v) || v < 5 || v > 120) {
        return res.status(400).json({ error: 'dice_interval_min 必须在 5~120 之间' });
      }
      patch.dice_interval_min = Math.round(v);
    }
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'dice_interval_max')) {
      const v = Number(req.body.dice_interval_max);
      if (!Number.isFinite(v) || v < 5 || v > 120) {
        return res.status(400).json({ error: 'dice_interval_max 必须在 5~120 之间' });
      }
      patch.dice_interval_max = Math.round(v);
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: '没有可更新字段' });
    }
    const next = { ...cfg, ...patch };
    fs.writeFileSync(FORGE_CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf-8');
    if (patch.dice_enabled === false) diceDaemon.stop();
    else if (next.dice_enabled !== false) { diceDaemon.stop(); diceDaemon.start(); }
    res.json({ ok: true, lambda: next.lambda, dice_enabled: next.dice_enabled !== false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== world-home 世界时钟 ====================
// 手动推进 1 小时（前端「推进 1 小时」按钮 / 测试用）
app.post('/api/world/tick', async (req, res) => {
  try {
    const row = await advanceOneTick();
    res.json({ ok: true, status: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 读当前世界配置
app.get('/api/world/config', (req, res) => {
  res.json(readWorldConfig());
});

// 改世界配置（world_tick_enabled / fast_test），写完 daemon 立即 reload
app.post('/api/world/config', async (req, res) => {
  try {
    const patch = {};
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'world_tick_enabled')) {
      patch.world_tick_enabled = !!req.body.world_tick_enabled;
    }
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'fast_test')) {
      patch.fast_test = !!req.body.fast_test;
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: '没有可更新字段（world_tick_enabled / fast_test）' });
    }
    const next = await writeWorldConfig(patch); // 串行写锁
    worldTickDaemon.reload();                    // 即时生效：清旧 interval + 按新配置重启
    res.json({ ok: true, config: next });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 测试用：强制发一次「饿了」唤醒，无视触发条件和冷却。但 CC 忙/未运行时仍不发（不抢占在途轮）。
app.post('/api/world/wake', async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('character_status_cheng').select('*').eq('name', '澄').limit(1);
    if (error) throw error;
    const status = rows && rows[0];
    if (!status) return res.status(404).json({ error: 'character_status_cheng 没有澄那一行' });
    const event = { key: 'hungry', ...WORLD_EVENTS.hungry };
    const r = await triggerWorldWake(event, status, { force: true });
    if (r.fired) return res.json({ ok: true, event: event.reason });
    return res.status(409).json({ ok: false, reason: r.reason || 'not_fired' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 仅开发用：直接插一条 scheduled_at=now() 的 hungry pending_wake，省去手写 SQL。
// 插完由 PendingWakeDaemon（每 7s）捞起、绕过冷却重新唤醒澄。不直接触发，走正常 daemon 路径才测得真。
app.post('/api/world/pending/test-hungry', async (req, res) => {
  try {
    const { data: rows } = await supabase
      .from('character_status_cheng').select('world_time, satiety, energy, mood').eq('name', '澄').limit(1);
    const status = rows && rows[0];
    const { data: pw, error } = await supabase.from('pending_wake_cheng').insert({
      wake_type: 'hungry',
      reason: '【测试】手动插入的饥饿续唤醒',
      status: 'queued',
      scheduled_at: new Date().toISOString(),
      world_time: status?.world_time || null,
      payload: {
        event_key: 'hungry',
        delay_world_minutes: 10,
        test: true,
        status_summary: status ? { satiety: status.satiety, energy: status.energy, mood: status.mood } : null,
      },
      attempts: 0,
    }).select('id, scheduled_at').single();
    if (error) throw error;
    res.json({ ok: true, id: pw.id, scheduled_at: pw.scheduled_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 第8步：当前澄 location 下可执行的行为列表
app.get('/api/world/actions', async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('character_status_cheng').select('location').eq('name', '澄').limit(1);
    if (error) throw error;
    const location = rows?.[0]?.location || '';
    res.json({ location, actions: getAvailableActions(location) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 第8步：执行一个行为（澄），返回更新后的状态。位置不允许 → 400，不更新。
app.post('/api/world/action', async (req, res) => {
  const actionId = req.body?.action_id;
  if (!actionId) return res.status(400).json({ error: '缺少 action_id' });
  try {
    const status = await executeWorldAction(actionId, { actor: 'cheng', source: 'manual' });
    res.json({ ok: true, status });
  } catch (e) {
    if (e.code === 'not_allowed' || e.code === 'unknown_action') {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/dice/log', async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const before = req.query.before || null;
    let q = supabase
      .from('sigh_log_cheng')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (before) q = q.lt('created_at', before);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/dice/status', async (req, res) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(FORGE_CONFIG_PATH, 'utf-8'));
    const { data } = await supabase
      .from('messages')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1);
    const lastMsg = data?.[0]?.created_at || null;
    const tHours = lastMsg ? (Date.now() - new Date(lastMsg).getTime()) / 3600000 : null;
    const lambda = cfg.lambda || 0.15;
    const probability = tHours !== null ? 1 - Math.exp(-lambda * tHours) : null;
    res.json({ lambda, t_hours: tHours, probability, dice_enabled: cfg.dice_enabled !== false });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
  const pageSize = 1000;
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('messages')
      .select('id, role, content, thinking, tool_calls, images, token_input, token_output, cache_detail, event, created_at')
      .eq('conversation_id', req.params.id)
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return res.status(500).json({ error: error.message });
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  res.json(all);
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
  if (activeTurn) {
    activeTurn.ws = ws;
    chatStatus(ws, '已接管进行中的回复', 'websocket 重连后继续接收当前 turn');
  }

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
        // 真打断：tmux 发 Ctrl+C 让 CC 真停下（治"软停只标记、CC 卡死时还占着 activeTurn 发不出消息"）。
        // C-c 后 `esc to interrupt` 消失 → _watchTurn 数秒内判完成 → emit turn_done(走 stopped 分支)
        // → 清 activeTurn + flush 排队消息 → 用户立刻能重发。正常叫停/卡死自救两场景都覆盖。
        if (USE_TMUX) {
          try { await cc.interrupt(); console.log('[STOP] 已发 Ctrl+C 打断 CC'); }
          catch (e) { console.warn('[STOP] interrupt 失败:', e?.message || e); }
        }
      } else if (msg.type === 'flush') {
        console.log(`[CHAT] 收到 flush 指令 (pendingBuffer=${!!pendingBuffer}, activeTurn=${!!activeTurn})`);
        if (pendingBuffer) {
          if (!activeTurn) {
            if (pendingBuffer.timer) { clearTimeout(pendingBuffer.timer); pendingBuffer.timer = null; }
            console.log('[CHAT] flush 延迟 200ms 等消息到齐');
            pendingBuffer.timer = setTimeout(() => {
              if (!pendingBuffer) return;
              pendingBuffer.timer = null;
              pendingBuffer.readyToFlush = true;
              console.log('[CHAT] flush 200ms 到期，执行');
              tryFlushBuffer();
            }, 200);
          } else {
            console.log('[CHAT] flush 忽略（CC 忙）');
          }
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
    if (activeTurn && activeTurn.ws === ws) activeTurn.ws = null;
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
  const { content, images, conversation_id, settings, msgId } = msg;
  const imgs = Array.isArray(images) ? images.filter(Boolean) : [];

  if (!cc.isRunning()) {
    return safeSend(ws, { type: 'error', message: 'CC进程未运行，请点击重启' });
  }

  if (conversation_id) lastActiveConvId = conversation_id;

  diceDaemon.resetOnMessage();

  // 用户消息照常落库（每条独立一行，保留时间线）
  if (conversation_id) {
    try {
      const { data: savedUserMsg } = await supabase.from('messages').insert({
        conversation_id, role: 'user', content,
        images: imgs.length ? imgs : null,
      }).select('id, created_at').single();
      if (msgId && savedUserMsg?.id) {
        safeSend(ws, {
          type: 'user_saved',
          local_id: msgId,
          message: {
            id: savedUserMsg.id,
            created_at: savedUserMsg.created_at || null,
          },
        });
      }
      chatStatus(ws, '已发送到后端', savedUserMsg?.id ? `user ${savedUserMsg.id}` : '用户消息已入库');
      await supabase.from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversation_id);
      await checkContextThreshold(conversation_id, settings);
    } catch (e) { console.error('存用户消息失败:', e); }
  }

  const bufferTime = Math.max(0, parseInt(settings?.bufferTime) || 0);
  const shortMsgCount = Math.max(1, parseInt(settings?.shortMsgCount) || 1);
  console.log(`[CHAT] 收到消息 (bufferTime=${bufferTime}s, shortMsgCount=${shortMsgCount}, activeTurn=${!!activeTurn}, pendingBuffer=${!!pendingBuffer}, content="${content.slice(0, 30)}")`);

  // bufferTime=0 且 CC 空闲：保留原直发路径
  if (bufferTime <= 0 && !activeTurn && !pendingBuffer) {
    console.log('[CHAT] 直发 CC（bufferTime=0 且空闲）');
    if (msgId) safeSend(ws, { type: 'flushed', ids: [msgId] });
    chatStatus(ws, '已 flush 给 CC', '1 条消息（直发）');
    return flushPendingToCC(ws, [{ content, imgs, conversation_id, settings, msgId }]);
  }

  // 否则进入缓冲
  if (!pendingBuffer) {
    pendingBuffer = { ws, items: [], timer: null, readyToFlush: false, bufferTime };
  } else {
    pendingBuffer.ws = ws;
  }
  pendingBuffer.items.push({ content, imgs, conversation_id, settings, msgId });
  console.log(`[CHAT] 入 buffer (count=${pendingBuffer.items.length}, readyToFlush=${pendingBuffer.readyToFlush})`);
  safeSend(ws, { type: 'buffering', count: pendingBuffer.items.length, waitMs: bufferTime * 1000 });
  chatStatus(ws, '已进入缓冲', `第 ${pendingBuffer.items.length} 条 / 满 ${shortMsgCount} 条发送给 CC`);

  // 达到条数上限：立刻标记 ready
  if (pendingBuffer.items.length >= shortMsgCount) {
    if (pendingBuffer.timer) { clearTimeout(pendingBuffer.timer); pendingBuffer.timer = null; }
    pendingBuffer.readyToFlush = true;
    console.log(`[CHAT] 条数满 (${pendingBuffer.items.length}>=${shortMsgCount})，flush`);
    return tryFlushBuffer();
  }

  // 重置计时
  if (pendingBuffer.timer) clearTimeout(pendingBuffer.timer);
  if (bufferTime > 0) {
    pendingBuffer.timer = setTimeout(() => {
      if (!pendingBuffer) return;
      pendingBuffer.timer = null;
      pendingBuffer.readyToFlush = true;
      console.log(`[CHAT] bufferTime 到期 (${bufferTime}s)，flush`);
      tryFlushBuffer();
    }, bufferTime * 1000);
  } else {
    // bufferTime=0 但 CC 忙：直接 ready，等 turn_done 触发
    pendingBuffer.readyToFlush = true;
    console.log('[CHAT] bufferTime=0 + CC忙，标记 ready 等 turn_done');
    tryFlushBuffer();
  }
}

function tryFlushBuffer() {
  if (!pendingBuffer || !pendingBuffer.readyToFlush) {
    if (pendingBuffer) console.log(`[CHAT] tryFlush 跳过 (readyToFlush=${pendingBuffer.readyToFlush})`);
    return;
  }
  if (activeTurn) {
    console.log('[CHAT] tryFlush 跳过 (CC 忙)');
    return;
  }
  const items = pendingBuffer.items;
  const ws = pendingBuffer.ws;
  pendingBuffer = null;
  const flushedIds = items.map(i => i.msgId).filter(Boolean);
  console.log(`[CHAT] flush ${items.length} 条消息给 CC`);
  if (flushedIds.length) safeSend(ws, { type: 'flushed', ids: flushedIds });
  chatStatus(ws, '已 flush 给 CC', `${items.length} 条消息`);
  flushPendingToCC(ws, items).catch(e => console.error('flush failed:', e));
}

// CC 刚空闲后调用：先 tryFlush，如果缓冲区还没 ready 就给 2 秒窗口再送出
function flushOrGrace() {
  console.log(`[CHAT] flushOrGrace (pendingBuffer=${!!pendingBuffer}, readyToFlush=${pendingBuffer?.readyToFlush}, bufferTime=${pendingBuffer?.bufferTime})`);
  tryFlushBuffer();
  if (pendingBuffer && !pendingBuffer.readyToFlush) {
    if (pendingBuffer.bufferTime > 0) {
      console.log('[CHAT] 短消息模式，不自动 grace，等用户手动发送');
      return;
    }
    if (pendingBuffer.timer) clearTimeout(pendingBuffer.timer);
    console.log('[CHAT] grace 2s 窗口启动');
    pendingBuffer.timer = setTimeout(() => {
      if (!pendingBuffer) return;
      pendingBuffer.timer = null;
      pendingBuffer.readyToFlush = true;
      console.log('[CHAT] grace 2s 到期，flush');
      tryFlushBuffer();
    }, 2000);
  }
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
    const prefixed = maybeTimePrefix(combinedText, conversation_id);
    // 浮现：tmux 交互模式折进消息（长驻会话不重读 CLAUDE.md）；stream-json 仍写 CLAUDE.md。
    let textForCC = prefixed;
    if (USE_TMUX) {
      const { message } = await buildMessageForCC(combinedText, prefixed);
      textForCC = message;
    } else {
      try { await runSurfacing(combinedText); } catch (e) { console.error('[surfacing] uncaught:', e); }
    }

    let payload = textForCC;
    if (combinedImgs.length > 0) {
      const blocks = [];
      if (textForCC && textForCC.length) blocks.push({ type: 'text', text: textForCC });
      for (const dataUrl of combinedImgs) {
        const b = dataUrlToImageBlock(dataUrl);
        if (b) blocks.push(b);
      }
      payload = blocks;
    }
    await cc.send(payload);
    const seenIds = items.map(i => i.msgId).filter(Boolean);
    if (seenIds.length) safeSend(ws, { type: 'seen', ids: seenIds });
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
  diceDaemon.start();
  worldTickDaemon.start();
  pendingWakeDaemon.start();
});

process.on('SIGTERM', () => { cc.stop(); process.exit(0); });
process.on('SIGINT', () => { cc.stop(); process.exit(0); });
