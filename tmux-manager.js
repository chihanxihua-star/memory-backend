// tmux-manager.js — 交互式 tmux 驱动层，对齐 cc-manager.js 的 CCProcessManager 接口。
// 与 stream-json 版的差异：
//   - CC 跑在 tmux 真终端里（交互模式），治 stream-json 的第2轮空回。
//   - 输入：load-buffer + paste-buffer + send-keys（CJK/多行安全）。
//   - 输出：不靠流式 delta，也不依赖 Stop hook（memory-home 与 CC 同机）——
//           检测 capture-pane 空闲后直接读 transcript 尾轮，emit turn_done。
//   - 治空回靠交互模式本身；轮完成判定靠 "esc to interrupt" 消失。
import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

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
    this.transcript = null;       // 当前 session 的 jsonl 路径（start 时按 sessionId 定）
    this.sessionId = null;        // 启动时生成、用 --session-id 传给 claude
    this.running = false;         // isRunning() 同步返回这个
    this.resumedFromForge = false;// 交互模式不走 forge，恒 false（对齐 cc-manager 字段）
    this.busy = false;
    this.stopping = false;
    this.lastInputTokens = 0;
    this.firstContextTokens = 0;
    this._watching = false;
    this._watchdog = null;
  }

  setAppendSystemPrompt(text) { this.appendSystemPrompt = text || null; }

  _launchCmd() {
    // append-system-prompt 走 CLAUDE.md（交互模式靠会话开场读），这里只拼基本 flag
    const parts = ['DISABLE_AUTOUPDATER=1', '/usr/bin/claude',
      '--model', this.model, '--dangerously-skip-permissions',
      "--allowedTools", "'mcp__supabase__*'",
      '--session-id', this.sessionId];   // 确定 sessionId + transcript 路径
    if (this.effort && this.effort !== 'off') parts.push('--effort', this.effort);
    if (this.nativeThinking) parts.push('--thinking-display', 'summarized');
    return parts.join(' ');
  }

  async start() {
    this.stopping = false;
    this.running = false;
    this.resumedFromForge = false;
    this.sessionId = randomUUID();
    this.transcript = path.join(this.projectDir, this.sessionId + '.jsonl');
    this.firstContextTokens = 0; this.lastInputTokens = 0;
    // 让 tmux 会话「直接把 claude 当命令跑」(不经交互 shell)：
    // 这样 churn 把二进制弄没只会让会话退出，不会留下"命令落进输入框"的垃圾。
    // churn 杀了会话 → 外层重建；最多重建 30 次（覆盖一整个二进制稳定窗口）。
    const cmd = this._launchCmd();
    for (let attempt = 0; attempt < 30; attempt++) {
      await tmux('kill-session', '-t', this.session).catch(() => {});
      await sleep(500);
      await tmux('new-session', '-d', '-s', this.session, '-x', '220', '-y', '50', '-c', this.cwd, cmd).catch(() => {});
      // 等就绪 或 会话因 churn 死亡（最多 ~25s）
      for (let i = 0; i < 25; i++) {
        await sleep(1000);
        const alive = await tmux('has-session', '-t', this.session).then(() => true).catch(() => false);
        if (!alive) break;                          // churn 杀了它 → 外层重建
        const pane = await this._pane();
        if (/Is this a project you created or one you trust/.test(pane)) {
          await tmux('send-keys', '-t', this.session, 'Enter'); continue;   // 信任确认
        }
        if (/bypass permissions on|for agents/.test(pane)) {
          this.running = true; this._startWatchdog(); this.emit('state', 'ready'); return;
        }
      }
      if (attempt < 29) await sleep(2000);          // churn 窗口，喘口气再重建
    }
    this.running = false;
    this.emit('state', 'down');
    // 不 throw：index.js 在 375 行非 await 调用 start()，throw 会成未捕获 rejection。看门狗会再拉。
    console.error('[tmux] CC 交互界面 30 次重建仍未就绪');
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
      // 等真完成：空闲 + transcript 最后一条 assistant 的 stop_reason=end_turn。
      // 只看"空闲"会被工具执行时 esc-to-interrupt 短暂消失骗到 → 提前读取 → 吞掉工具后的回复。
      let idle = 0;
      for (let i = 0; i < 200; i++) {
        if (await this._isWorking()) { idle = 0; }
        else {
          idle++;
          // 空闲且 transcript 显示这轮真结束(非 tool_use 中途)才完成
          if (idle >= 2 && await this._turnEnded()) break;
        }
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

  // 这轮是否真结束：transcript 最后一条 assistant 的 stop_reason 是终止态(非 tool_use 中途)
  async _turnEnded() {
    const tf = this.transcript;
    if (!tf) return true;
    const raw = await sh('sudo', ['-u', 'claude-user', 'cat', tf]).catch(() => '');
    const lines = raw.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o.type === 'assistant') {
        const sr = o.message?.stop_reason;
        return sr === 'end_turn' || sr === 'stop_sequence' || sr === 'max_tokens';
      }
      // 最后是 user(tool_result) 在 assistant 之前 → 工具刚回、CC 还要接着说 → 没结束
      if (o.type === 'user') return false;
    }
    return false;
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

  async clearScreen() { // 清屏 = 原生 /clear（注意：/clear 后 claude 会换新 session 文件）
    await tmux('send-keys', '-t', this.session, '/clear', 'Enter');
    await sleep(1500);
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
    this.running = false;
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
    await tmux('kill-session', '-t', this.session).catch(() => {});
  }

  isRunning() { return this.running; }  // 同步：index.js 里 if(!cc.isRunning()) 要这个

  // 看门狗：每 10s 查会话还在不在；没了且非主动停 → 标 down + 自动重起（对齐 cc-manager autoRestart）
  _startWatchdog() {
    if (this._watchdog) clearInterval(this._watchdog);
    this._watchdog = setInterval(async () => {
      if (this.stopping || this._watching || this.busy) return; // 忙/重启中不查
      const alive = await tmux('has-session', '-t', this.session).then(() => true).catch(() => false);
      if (!alive && this.running) {
        this.running = false;
        this.emit('state', 'down');
        console.warn('[tmux] 会话不在了，3s 后自动重起…');
        setTimeout(() => { if (!this.stopping) this.start(); }, 3000);
      }
    }, 10000);
  }
  isBusy() { return this.busy; }
}
