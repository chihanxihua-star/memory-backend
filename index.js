import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { supabase, writeMemory, searchMemory, getDefaultProject } from './memory.js';
import { CCProcessManager } from './cc-manager.js';

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
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// ==================== CC 常驻进程 ====================
const savedCfg = loadCCConfig();
const cc = new CCProcessManager({
  cwd: '/home/claude-user/chat-sandbox',
  effort: savedCfg.effort || 'high',
  model: savedCfg.model || null,
});
cc.start();

let activeTurn = null; // { ws, conversationId, settings, silent }
const summaryTriggers = new Map(); // conversation_id -> last k triggered
let pendingSummary = null; // { conversationId, summaryLength }

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
  activeTurn = { ws: null, conversationId: null, silent: true, settings: null };
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
  if (activeTurn) safeSend(activeTurn.ws, { type: 'tool_use', id, name, input });
});

cc.on('tool_result', ({ tool_use_id, content, is_error }) => {
  if (activeTurn) safeSend(activeTurn.ws, { type: 'tool_result', tool_use_id, content, is_error });
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
  }

  const clean = removeMemoryTags(text || '');

  if (turn.conversationId && clean && !turn.silent) {
    try {
      await supabase.from('messages').insert({
        conversation_id: turn.conversationId,
        role: 'assistant',
        content: clean,
        thinking: thinking || null,
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

  maybeFireSummary();
});

cc.on('turn_error', (err) => {
  if (activeTurn) {
    safeSend(activeTurn.ws, { type: 'error', message: err.message });
    activeTurn = null;
  }
});

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

app.post('/api/cc/restart', async (req, res) => {
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
    await cc.restart(opts);
    if (Object.keys(patch).length) saveCCConfig(patch);
    res.json({ ok: true, session: cc.sessionId, model: cc.model, effort: cc.effort });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    .select('id, role, content, thinking, token_input, token_output, created_at')
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

wss.on('connection', (ws) => {
  console.log('客户端已连接');
  safeSend(ws, { type: 'cc_status', status: cc.isRunning() ? 'ready' : 'down' });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'chat') {
        await handleChat(ws, msg);
      } else if (msg.type === 'stop') {
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

  ws.on('close', () => console.log('客户端断开'));
});

async function handleChat(ws, msg) {
  const { content, conversation_id, settings } = msg;

  if (!cc.isRunning()) {
    return safeSend(ws, { type: 'error', message: 'CC进程未运行，请点击重启' });
  }
  if (activeTurn) {
    return safeSend(ws, { type: 'error', message: 'CC正在回复上一条消息' });
  }

  if (conversation_id) {
    try {
      await supabase.from('messages').insert({
        conversation_id, role: 'user', content,
      });
      await supabase.from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversation_id);
      await checkContextThreshold(conversation_id, settings);
    } catch (e) { console.error('存用户消息失败:', e); }
  }

  activeTurn = { ws, conversationId: conversation_id, settings };

  try {
    cc.send(maybeTimePrefix(content, conversation_id));
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
