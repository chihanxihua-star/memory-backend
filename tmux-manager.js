// tmux-manager.js — 交互式 tmux 驱动层，对齐 cc-manager.js 的 CCProcessManager 接口。
// 与 stream-json 版的差异：
//   - CC 跑在 tmux 真终端里（交互模式），治 stream-json 的第2轮空回。
//   - 输入：load-buffer + paste-buffer + send-keys（CJK/多行安全）。
//   - 输出：不靠流式 delta，也不依赖 Stop hook（memory-home 与 CC 同机）——
//           检测 capture-pane 空闲后直接读 transcript 尾轮，emit turn_done。
//   - 治空回靠交互模式本身；轮完成判定靠 "esc to interrupt" 消失。
import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';

function sh(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => err ? reject(new Error((stderr || err.message || '').trim())) : resolve(stdout));
    if (input != null) { p.stdin.write(input); p.stdin.end(); }
  });
}
// 以 claude-user 跑 tmux
const tmux = (...args) => sh('sudo', ['-u', 'claude-user', '-H', 'tmux', ...args]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// cwd → claude 项目目录（/ 和 . 都换成 -）
function projectDirFor(cwd) {
  const slug = cwd.replace(/[/.]/g, '-');
  return `/home/claude-user/.claude/projects/${slug}`;
}

export class TmuxCCManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.cwd = options.cwd || '/home/claude-user/chat-sandbox';
    this.session = options.session || 'cheng';
    this.model = options.model || 'claude-opus-4-8';
    this.effort = options.effort || null;
    this.nativeThinking = options.nativeThinking || false;
    this.appendSystemPrompt = options.appendSystemPrompt || null;
    this.projectDir = projectDirFor(this.cwd);
    this.transcript = null;       // 当前 session 的 jsonl 路径
    this.busy = false;
    this.stopping = false;
    this.lastInputTokens = 0;
    this.firstContextTokens = 0;
    this._watching = false;
  }

  setAppendSystemPrompt(text) { this.appendSystemPrompt = text || null; }

  _launchCmd() {
    // append-system-prompt 走 CLAUDE.md（交互模式靠会话开场读），这里只拼基本 flag
    const parts = ['DISABLE_AUTOUPDATER=1', '/usr/bin/claude',
      '--model', this.model, '--dangerously-skip-permissions',
      "--allowedTools", "'mcp__supabase__*'"];
    if (this.effort && this.effort !== 'off') parts.push('--effort', this.effort);
    if (this.nativeThinking) parts.push('--thinking-display', 'summarized');
    return parts.join(' ');
  }

  async start() {
    this.stopping = false;
    await tmux('kill-session', '-t', this.session).catch(() => {});
    await sleep(800);
    await tmux('new-session', '-d', '-s', this.session, '-x', '220', '-y', '50', '-c', this.cwd);
    await sleep(800);
    await tmux('send-keys', '-t', this.session, this._launchCmd(), 'Enter');
    // 等就绪：界面出现 "for agents"，并处理首次"信任文件夹"确认 +
    // 自动更新器 churn 二进制导致的 "No such file/command not found" → 重发启动命令
    let launchRetries = 0;
    for (let i = 0; i < 150; i++) {
      await sleep(1000);
      const pane = await this._pane();
      // 1) 就绪优先：CC 的 footer 出现 = UI 起来了（比 "for agents" 可靠，后者会被截断）
      if (/bypass permissions on|for agents/.test(pane)) { this.emit('state', 'ready'); return; }
      // 2) 信任文件夹确认
      if (/Is this a project you created or one you trust/.test(pane)) {
        await tmux('send-keys', '-t', this.session, 'Enter'); continue;
      }
      // 3) 自动更新 churn 把二进制弄没 → 重发启动命令（仅在 CC 还没起来时）
      if (/(No such file or directory|command not found)/.test(pane) && launchRetries < 30) {
        launchRetries++;
        await sleep(3000);
        await tmux('send-keys', '-t', this.session, this._launchCmd(), 'Enter');
        continue;
      }
    }
    this.emit('state', 'down');
    throw new Error(`CC 交互界面未就绪（启动重试 ${launchRetries} 次）`);
  }

  async _pane() { return tmux('capture-pane', '-t', this.session, '-p').catch(() => ''); }
  async _isWorking() { return /esc to interrupt/.test(await this._pane()); }

  // content-block 数组里的图片 → 落临时文件，返回路径数组（交互 CC 读路径里的图）
  _materializeImages(blocks) {
    const exts = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
    const paths = [];
    blocks.forEach((b, i) => {
      if (b?.type !== 'image') return;
      let data = b.source?.data, media = b.source?.media_type;
      if (typeof data === 'string' && data.startsWith('data:')) { // 兼容直接传 dataURL
        const m = /^data:([^;]+);base64,(.+)$/.exec(data);
        if (m) { media = m[1]; data = m[2]; }
      }
      if (!data) return;
      const ext = exts[media] || 'png';
      const p = `/tmp/tmux-img-${this.session}-${Date.now()}-${i}.${ext}`;
      fs.writeFileSync(p, Buffer.from(data, 'base64')); fs.chmodSync(p, 0o644);
      paths.push(p);
    });
    return paths;
  }

  // 发消息：content 是字符串 或 Anthropic content-block 数组（带图片）
  async send(content) {
    if (Array.isArray(content)) {
      const text = content.filter(b => b?.type === 'text').map(b => b.text).join('\n');
      const imgPaths = this._materializeImages(content);
      // 把图片路径拼进消息（交互 CC 会去 Read 这些路径里的图）
      const imgLine = imgPaths.length
        ? `\n\n[用户发来图片，请查看：${imgPaths.join('  ')}]` : '';
      content = (text || (imgPaths.length ? '看看这个' : '')) + imgLine;
    }
    // 写到 /tmp（claude-user 的 tmux 要能读 load-buffer 的文件）；不用 os.tmpdir()（可能是私有目录）
    const tmp = `/tmp/tmux-msg-${this.session}.txt`;
    fs.writeFileSync(tmp, String(content)); fs.chmodSync(tmp, 0o644);
    const buf = `cheng-${this.session}`;
    await tmux('load-buffer', '-b', buf, tmp);
    await tmux('paste-buffer', '-b', buf, '-t', this.session);
    await sleep(600);
    await tmux('send-keys', '-t', this.session, 'Enter');
    this.busy = true;
    this.emit('turn_start');
    this._watchTurn();
  }

  // 轮观察：等开始工作→等空闲稳定→读 transcript 尾轮→emit turn_done
  async _watchTurn() {
    if (this._watching) return;
    this._watching = true;
    try {
      // 等开始（最多 ~12s 出现 working；没出现就当瞬时完成）
      for (let i = 0; i < 8; i++) { if (await this._isWorking()) break; await sleep(1500); }
      // 等连续空闲
      let idle = 0;
      for (let i = 0; i < 120; i++) {
        if (await this._isWorking()) idle = 0; else if (++idle >= 3) break;
        await sleep(1500);
      }
      await sleep(1200); // transcript flush
      const turn = await this._readLastTurn();
      this.busy = false;
      const u = turn.usage || {};
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (ctx > 0) { if (!this.firstContextTokens) this.firstContextTokens = ctx; this.lastInputTokens = ctx; }
      this.emit('turn_done', {
        text: turn.text,
        thinking: turn.thinking,
        usage: {
          input_tokens: u.input_tokens ?? null,
          output_tokens: u.output_tokens ?? null,
          cache_read_input_tokens: u.cache_read_input_tokens ?? null,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
        },
        contextTokens: ctx || null,
        systemTokens: this.firstContextTokens || null,
        is_error: false,
        empty: !turn.text.trim(),   // 交互模式理论上不空；真空了这里标出来
      });
    } catch (e) {
      this.busy = false;
      this.emit('turn_error', e);
    } finally {
      this._watching = false;
    }
  }

  // 找当前 session 最新 transcript，倒扫到上一条真实 user，收集 assistant text/thinking + 最近 usage
  async _readLastTurn() {
    if (!this.transcript || !fs.existsSync(this.transcript)) {
      const out = await sh('sudo', ['-u', 'claude-user', 'bash', '-c',
        `ls -t ${this.projectDir}/*.jsonl 2>/dev/null | head -1`]).catch(() => '');
      this.transcript = out.trim() || null;
    }
    if (!this.transcript) return { text: '', thinking: '', usage: {} };
    const raw = await sh('sudo', ['-u', 'claude-user', 'cat', this.transcript]).catch(() => '');
    const lines = raw.split('\n').filter(Boolean);
    const texts = [], thinks = []; let usage = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      const t = o.type, c = o.message?.content;
      if (t === 'user') {
        const isToolResult = Array.isArray(c) && c.some(b => b?.type === 'tool_result');
        if (typeof c === 'string' || (Array.isArray(c) && c.some(b => b?.type === 'text'))) break; // 真实 user 边界
        if (isToolResult) continue;
      }
      if (t === 'assistant') {
        if (!usage && o.message?.usage) usage = o.message.usage;
        for (const b of (c || [])) {
          if (b?.type === 'text' && b.text?.trim()) texts.push(b.text);
          else if (b?.type === 'thinking' && b.thinking) thinks.push(b.thinking);
        }
      }
    }
    texts.reverse(); thinks.reverse();
    return { text: texts.join('\n\n'), thinking: thinks.join('\n\n'), usage: usage || {} };
  }

  async clearScreen() { // 清屏 = 原生 /clear
    await tmux('send-keys', '-t', this.session, '/clear', 'Enter');
    this.transcript = null; this.firstContextTokens = 0; this.lastInputTokens = 0;
  }
  async interrupt() { await tmux('send-keys', '-t', this.session, 'C-c'); }

  async amnesia() { // 失忆 = 杀会话重起（交互新会话天然无上文，等价不带 --resume）
    this.transcript = null; this.firstContextTokens = 0; this.lastInputTokens = 0;
    await this.start();
  }

  async restart(options = {}) {
    if (options.model !== undefined) this.model = options.model || this.model;
    if (options.effort !== undefined) this.effort = options.effort || null;
    if (options.nativeThinking !== undefined) this.nativeThinking = !!options.nativeThinking;
    await this.start();
  }

  async stop() {
    this.stopping = true;
    await tmux('kill-session', '-t', this.session).catch(() => {});
  }

  async isRunning() { return tmux('has-session', '-t', this.session).then(() => true).catch(() => false); }
  isBusy() { return this.busy; }
}
