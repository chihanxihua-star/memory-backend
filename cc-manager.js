import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

export class CCProcessManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.cwd = options.cwd || '/home/claude-user/chat-sandbox';
    this.proc = null;
    this.stdoutBuf = '';
    this.autoRestart = options.autoRestart !== false;
    this.stopping = false;
    this.sessionId = null;
    this.currentTurn = null;
    this.restartTimer = null;
    this.model = options.model || null; // 默认跟随 CC 用户配置
    this.effort = options.effort || null; // low / medium / high / xhigh / max
  }

  start() {
    if (this.proc) return;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }

    this.stopping = false;
    this.sessionId = randomUUID();
    this.stdoutBuf = '';
    this.currentTurn = null;

    const claudeArgs = [
      '--print',
      '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      '--allowedTools', 'mcp__supabase__*',
      '--session-id', this.sessionId,
    ];
    if (this.model) claudeArgs.push('--model', this.model);
    if (this.effort) claudeArgs.push('--effort', this.effort);

    console.log(`🚀 启动CC (session=${this.sessionId}${this.model ? ', model=' + this.model : ''}${this.effort ? ', effort=' + this.effort : ''})`);
    const proc = spawn('sudo', ['-u', 'claude-user', '-H', '--preserve-env=PATH', 'claude', ...claudeArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    this.proc = proc;

    proc.stdout.on('data', chunk => this.handleStdout(chunk));
    proc.stderr.on('data', chunk => {
      console.error('CC stderr:', chunk.toString().trim());
    });
    proc.on('exit', (code, signal) => this.handleExit(code, signal));
    proc.on('error', err => {
      console.error('CC spawn error:', err);
      this.emit('error', err);
    });

    this.emit('state', 'ready');
  }

  handleStdout(chunk) {
    this.stdoutBuf += chunk.toString();
    const lines = this.stdoutBuf.split('\n');
    this.stdoutBuf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.handleEvent(JSON.parse(trimmed));
      } catch {
        console.warn('CC 非JSON行:', trimmed.slice(0, 200));
      }
    }
  }

  handleExit(code, signal) {
    console.log(`CC 退出 code=${code} signal=${signal}`);
    this.proc = null;
    if (this.currentTurn) {
      this.emit('turn_error', new Error(`CC 进程中途退出 (code=${code})`));
      this.currentTurn = null;
    }
    this.emit('state', 'down');

    if (!this.stopping && this.autoRestart) {
      console.log('⚠️  3s 后自动重启...');
      this.restartTimer = setTimeout(() => this.start(), 3000);
    }
  }

  handleEvent(ev) {
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          this.currentTurn = { text: '', thinking: '', toolIds: new Set() };
          this.emit('turn_start');
        }
        break;

      case 'stream_event': {
        const s = ev.event;
        if (!s) break;
        if (s.type === 'content_block_delta' && s.delta) {
          if (s.delta.type === 'text_delta' && s.delta.text) {
            if (this.currentTurn) this.currentTurn.text += s.delta.text;
            this.emit('text_delta', s.delta.text);
          } else if (s.delta.type === 'thinking_delta' && s.delta.thinking) {
            if (this.currentTurn) this.currentTurn.thinking += s.delta.thinking;
            this.emit('thinking_delta', s.delta.thinking);
          }
        }
        break;
      }

      case 'assistant': {
        if (!this.currentTurn) this.currentTurn = { text: '', thinking: '', toolIds: new Set() };
        if (!this.currentTurn.toolIds) this.currentTurn.toolIds = new Set();
        const blocks = ev.message?.content || [];

        // tool_use blocks aren't streamed as deltas — always emit (deduped by id)
        for (const b of blocks) {
          if (b.type === 'tool_use' && b.id && !this.currentTurn.toolIds.has(b.id)) {
            this.currentTurn.toolIds.add(b.id);
            this.emit('tool_use', { id: b.id, name: b.name, input: b.input || {} });
          }
        }

        // Fallback: if no stream_event deltas arrived, emit text/thinking from full message
        if (this.currentTurn.text === '' && this.currentTurn.thinking === '') {
          for (const b of blocks) {
            if (b.type === 'text' && b.text) {
              this.currentTurn.text += b.text;
              this.emit('text_delta', b.text);
            } else if (b.type === 'thinking' && b.thinking) {
              this.currentTurn.thinking += b.thinking;
              this.emit('thinking_delta', b.thinking);
            }
          }
        }
        break;
      }

      case 'user': {
        const blocks = ev.message?.content || [];
        for (const b of blocks) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            let content = '';
            if (typeof b.content === 'string') {
              content = b.content;
            } else if (Array.isArray(b.content)) {
              content = b.content.map(c => c?.type === 'text' ? c.text : JSON.stringify(c)).join('\n');
            }
            this.emit('tool_result', { tool_use_id: b.tool_use_id, content, is_error: b.is_error === true });
          }
        }
        break;
      }

      case 'result': {
        const usage = {
          input_tokens: ev.usage?.input_tokens ?? null,
          output_tokens: ev.usage?.output_tokens ?? null,
          cache_read_input_tokens: ev.usage?.cache_read_input_tokens ?? null,
          cache_creation_input_tokens: ev.usage?.cache_creation_input_tokens ?? null,
          total_cost_usd: ev.total_cost_usd ?? null,
        };
        const turn = this.currentTurn || { text: ev.result || '', thinking: '' };
        this.currentTurn = null;
        this.emit('turn_done', {
          text: turn.text,
          thinking: turn.thinking,
          usage,
          is_error: ev.is_error === true,
          subtype: ev.subtype,
        });
        break;
      }

      default:
        break;
    }
  }

  send(content) {
    if (!this.proc) throw new Error('CC进程未运行');
    if (this.currentTurn) throw new Error('CC 正在处理上一轮请求');
    const msg = {
      type: 'user',
      message: { role: 'user', content: String(content) },
    };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  async restart(options = {}) {
    if (options.model !== undefined) this.model = options.model || null;
    if (options.effort !== undefined) this.effort = options.effort || null;
    console.log(`🔄 重启CC${this.model ? ' (model=' + this.model + ')' : ''}${this.effort ? ' (effort=' + this.effort + ')' : ''}...`);
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }

    if (this.proc) {
      const p = this.proc;
      await new Promise(res => {
        let done = false;
        const finish = () => { if (!done) { done = true; res(); } };
        p.once('exit', finish);
        try { p.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { p.kill('SIGKILL'); } catch {} finish(); }, 3000);
      });
    }

    this.stopping = false;
    this.autoRestart = true;
    this.start();
  }

  stop() {
    this.stopping = true;
    this.autoRestart = false;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch {}
      this.proc = null;
    }
  }

  isRunning() { return this.proc !== null; }
  isBusy() { return this.currentTurn !== null; }
}
