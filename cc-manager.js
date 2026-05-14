import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { supabase } from './memory.js';

const FORGE_MARKER = '/root/forge-reload/last_forge.json';
// CC 跑在 claude-user 下、cwd=/home/claude-user/chat-sandbox，
// 所以 session JSONL 必须落在这里 claude-user 才认。
const EXPECTED_PROJECT_DIR = '/home/claude-user/.claude/projects/-home-claude-user-chat-sandbox';

// 检查 forge 是否给我们准备好接班的 session；返回 {sid, jsonl} 或 null
// 严格校验 JSONL 在 claude-user 的项目目录下 —— 否则 --resume 注定失败
function readForgeMarker() {
  try {
    const m = JSON.parse(fs.readFileSync(FORGE_MARKER, 'utf8'));
    if (!m?.new_session) return null;
    const expected = path.join(EXPECTED_PROJECT_DIR, m.new_session + '.jsonl');
    if (!fs.existsSync(expected)) return null;
    return { sid: m.new_session, jsonl: expected };
  } catch { return null; }
}

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
    this.appendSystemPrompt = options.appendSystemPrompt || null;
    this.failedResumeSids = new Set(); // 试过 --resume 但 CC 启不来的 sid，避免死循环
    this.lastResumeAttemptSid = null;  // 本轮 start() 用的 resume sid（成功后清零）
    // 这一 session 最近一轮的累计 input tokens（input + cache_read + cache_creation）。
    // 给 sessions_cheng.tokens_total 做实时同步用，restart 时也作为 session 结束前的最终值落地。
    this.lastInputTokens = 0;
  }

  setAppendSystemPrompt(text) {
    this.appendSystemPrompt = text || null;
  }

  start() {
    if (this.proc) return;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }

    this.stopping = false;
    this.stdoutBuf = '';
    this.currentTurn = null;
    this.lastInputTokens = 0;

    // 优先接 forge 给的新 session（marker 存在、JSONL 在 claude-user 的项目目录、且未被黑名单）
    const forge = readForgeMarker();
    const resuming = forge !== null && !this.failedResumeSids.has(forge.sid);
    if (resuming) {
      this.sessionId = forge.sid;
      this.lastResumeAttemptSid = forge.sid;
      this.resumedFromForge = true;
    } else {
      this.sessionId = randomUUID();
      this.lastResumeAttemptSid = null;
      this.resumedFromForge = false;
    }

    const claudeArgs = [
      '--print',
      '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      '--allowedTools', 'mcp__supabase__*',
    ];
    if (resuming) {
      claudeArgs.push('--resume', this.sessionId);
    } else {
      claudeArgs.push('--session-id', this.sessionId);
    }
    if (this.model) claudeArgs.push('--model', this.model);
    if (this.effort) claudeArgs.push('--effort', this.effort);
    if (this.appendSystemPrompt) claudeArgs.push('--append-system-prompt', this.appendSystemPrompt);

    console.log(`${resuming ? '🔁 接 forge session' : '🚀 启动CC'} (session=${this.sessionId}${this.model ? ', model=' + this.model : ''}${this.effort ? ', effort=' + this.effort : ''}${this.appendSystemPrompt ? ', sys-prompt=' + this.appendSystemPrompt.length + 'ch' : ''})`);

    // 普通重启：把任何遗留的 active 改成 ended，再插一行新的 active（forged_from_session=null）
    // forge 接班：forge_reload.py 已经写过表，跳过。
    if (!resuming) {
      this.recordSessionStart(this.sessionId).catch(e =>
        console.error('recordSessionStart failed:', e?.message || e)
      );
    }
    const proc = spawn('sudo', ['-u', 'claude-user', '-H', '--preserve-env=PATH,ENABLE_PROMPT_CACHING_1H', 'claude', ...claudeArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.cwd,
      env: { ...process.env, FORCE_COLOR: '0', ENABLE_PROMPT_CACHING_1H: '1' },
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
      // CC 吐出第一行 JSON = 进程起来了，--resume 没出问题；清空 attempt 避免后续崩溃误拉黑
      if (this.lastResumeAttemptSid) this.lastResumeAttemptSid = null;
      try {
        this.handleEvent(JSON.parse(trimmed));
      } catch {
        console.warn('CC 非JSON行:', trimmed.slice(0, 200));
      }
    }
  }

  handleExit(code, signal) {
    console.log(`CC 退出 code=${code} signal=${signal}`);
    // 如果这次启动用了 --resume 又异常退出，把该 sid 拉黑，下次 start() 不再试
    if (code !== 0 && this.lastResumeAttemptSid) {
      console.warn(`⚠️  --resume ${this.lastResumeAttemptSid} 启动失败，加入黑名单`);
      this.failedResumeSids.add(this.lastResumeAttemptSid);
    }
    this.lastResumeAttemptSid = null;
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
        // 追踪每次 API 调用的 usage（最后一次 = 实际上下文大小，不是 result 里的累加值）
        const msgUsage = ev.message?.usage;
        if (msgUsage) {
          const ctx = (msgUsage.input_tokens || 0)
                    + (msgUsage.cache_read_input_tokens || 0)
                    + (msgUsage.cache_creation_input_tokens || 0);
          if (ctx > 0) {
            if (!this.firstContextTokens) this.firstContextTokens = ctx;
            this.lastContextTokens = ctx;
          }
        }
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
        // 跟前端右上角同一个算法（input + cache_read + cache_creation）
        const inFull = (usage.input_tokens || 0)
                     + (usage.cache_read_input_tokens || 0)
                     + (usage.cache_creation_input_tokens || 0);
        if (inFull > 0) this.lastInputTokens = inFull;
        const turn = this.currentTurn || { text: ev.result || '', thinking: '' };
        this.currentTurn = null;
        const contextTokens = this.lastContextTokens || null;
        const systemTokens = this.firstContextTokens || null;
        this.lastContextTokens = null;
        this.firstContextTokens = null;
        this.emit('turn_done', {
          text: turn.text,
          thinking: turn.thinking,
          usage,
          contextTokens,
          systemTokens,
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
    // content 可以是字符串，或 Anthropic content-block 数组（用于带图片的消息）
    const payload = typeof content === 'string' || Array.isArray(content) ? content : String(content);
    const msg = {
      type: 'user',
      message: { role: 'user', content: payload },
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

  // 把所有 active session 改 ended（兜底），再插入一行新 active
  async recordSessionStart(sessionId) {
    const nowIso = new Date().toISOString();
    const { error: upErr } = await supabase
      .from('sessions_cheng')
      .update({ status: 'ended', ended_at: nowIso })
      .eq('status', 'active');
    if (upErr) console.warn('mark active->ended:', upErr.message);

    const { error: insErr } = await supabase
      .from('sessions_cheng')
      .insert({
        session_id: sessionId,
        started_at: nowIso,
        status: 'active',
        turn_count: 0,
        forged_from_session: null,
        model: this.model || null,
      });
    if (insErr) console.warn('insert session row:', insErr.message);
  }
}
