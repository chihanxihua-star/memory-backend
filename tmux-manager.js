// tmux-manager.js — 交互式 tmux 驱动层，对齐 cc-manager.js 的 CCProcessManager 接口。
// 与 stream-json 版的差异：
//   - CC 跑在 tmux 真终端里（交互模式），治 stream-json 的第2轮空回。
//   - 输入：load-buffer + paste-buffer + send-keys（CJK/多行安全）。
//   - 输出：不靠流式 delta，也不依赖 Stop hook（memory-home 与 CC 同机）——
//           检测 capture-pane 空闲后直接读 transcript 尾轮，emit turn_done。
//   - 治空回靠交互模式本身；轮完成判定靠 "esc to interrupt" 消失。
import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import { randomUUID, createHash } from 'crypto';
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

// 系统提示「文件路线」落点：正文写进这个文件，启动命令只传路径（--append-system-prompt-file），
// 避免把长文本+符号塞进 tmux 的 shell 命令字符串导致解析崩溃。路径本身无特殊字符，shell 安全。
const APPEND_SYSPROMPT_FILE = '/home/claude-user/.claude/cheng-append-sysprompt.md';

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
    this.lastSent = null;        // 上一轮发给 CC 的文本（卡死哨兵重发用，比读 /tmp 文件稳）
    this.reused = false;         // 本次 start() 是否「接管了已存在的会话」（后端重启没杀 CC）→ index.js 据此不重复记 session
    this._generation = 0;        // 生命周期代次：每次 start 自增；旧的看门狗/观察器/延迟重起据此自我作废，防串台
    this._restartTimer = null;   // 看门狗延迟重起的句柄（统一可清，避免 force 重起后旧 timer 又拉一个）
    this._starting = false;      // start 串行锁：防 boot/看门狗/换模型多处并发 start 互相 kill
  }

  setAppendSystemPrompt(text) { this.appendSystemPrompt = text || null; }

  _launchCmd() {
    const parts = ['DISABLE_AUTOUPDATER=1', '/usr/bin/claude',
      '--model', this.model, '--dangerously-skip-permissions',
      "--allowedTools", "'mcp__supabase__*'",
      '--session-id', this.sessionId];   // 确定 sessionId + transcript 路径
    if (this.effort && this.effort !== 'off') parts.push('--effort', this.effort);
    if (this.nativeThinking) parts.push('--thinking-display', 'summarized');
    // 系统提示走「文件路线」：正文写进文件、命令行只传路径（避免长文本+符号塞进 shell 命令崩掉）。
    // 留空则删文件 + 不加 flag（退回无 append）。stream-json 驱动那边走数组 args 无 shell 问题，不受影响。
    const sp = (this.appendSystemPrompt || '').trim();
    if (sp) {
      try {
        fs.writeFileSync(APPEND_SYSPROMPT_FILE, sp, 'utf8');
        try { const st = fs.statSync(this.cwd); fs.chownSync(APPEND_SYSPROMPT_FILE, st.uid, st.gid); } catch {}
        parts.push('--append-system-prompt-file', APPEND_SYSPROMPT_FILE);
      } catch (e) { console.error('写 append-system-prompt 文件失败:', e.message); }
    } else {
      try { fs.unlinkSync(APPEND_SYSPROMPT_FILE); } catch {}
    }
    return parts.join(' ');
  }

  // 影响 Claude 进程身份的配置指纹（模型/effort/思考/cwd/系统提示）。
  // 起会话时写进 tmux @cheng_config_hash；后端重启复用前比对，不一致=配置变了=必须真重起才能生效。
  _configHash() {
    const sp = (this.appendSystemPrompt || '').trim();
    const sig = [this.model, this.effort || '', this.nativeThinking ? '1' : '0', this.cwd,
      createHash('sha1').update(sp).digest('hex')].join('|');
    return createHash('sha1').update(sig).digest('hex').slice(0, 16);
  }

  async _sessionAlive() { return tmux('has-session', '-t', this.session).then(() => true).catch(() => false); }

  // 探测现有会话能否「安全接管」（后端重启没杀 CC 时复用，澄不失忆）。
  // 任何一项不满足都返回 ok:false → 上层落回强制重起，宁可失忆一次也不接管一个坏/不一致的会话。
  async _probeReusable() {
    // 1) pane 没死、且跑的确实是 claude（没崩成 shell / 没被别的命令占用）
    const info = await tmux('list-panes', '-t', this.session,
      '-F', '#{pane_dead}|#{pane_current_command}|#{pane_start_command}').catch(() => '');
    const line = (info || '').split('\n').filter(Boolean)[0] || '';
    if (!line) return { ok: false, reason: 'no-pane' };
    const parts = line.split('|');
    const dead = parts[0], cmd = (parts[1] || '').trim(), startCmd = parts.slice(2).join('|');
    if (dead === '1') return { ok: false, reason: 'pane-dead' };
    if (!/^(claude|node)$/.test(cmd)) return { ok: false, reason: `pane-cmd=${cmd || 'empty'}` };
    // 2) 配置指纹一致（模型/effort/思考/系统提示都没变）。缺指纹（旧代码起的会话）也视为不一致 → 重起一次升级。
    const wantHash = this._configHash();
    const gotHash = (await tmux('show-options', '-qv', '-t', this.session, '@cheng_config_hash').catch(() => '')).trim();
    if (gotHash !== wantHash) return { ok: false, reason: `config-changed(${gotHash || 'none'}≠${wantHash})` };
    // 3) 还原运行中 claude 的 session-id：先读 metadata，兜底从启动命令解析 --session-id（不靠 ls-t 猜）
    let sid = (await tmux('show-options', '-qv', '-t', this.session, '@cheng_session_id').catch(() => '')).trim();
    if (!sid) {
      // pane_start_command 整条被 tmux 引号包裹；--session-id 若是末尾 token，\S+ 会带上收尾引号，去掉。
      const m = /--session-id\s+(\S+)/.exec(startCmd || '');
      sid = m ? m[1].replace(/["']+$/, '') : '';
    }
    return { ok: true, sessionId: sid || null };
  }

  // 串行锁外壳：防 boot/看门狗/换模型 多处并发进 _start 互相 kill。
  async start(opts = {}) {
    while (this._starting) await sleep(200);
    this._starting = true;
    try { return await this._start(opts); }
    finally { this._starting = false; }
  }

  async _start(opts = {}) {
    this.stopping = false;
    this.running = false;
    this.resumedFromForge = false;
    const generation = ++this._generation;   // 本代标识：期间被新一代 start 取代就主动放手，旧 watcher 也据此作废
    this._clearRestartTimer();
    // 探活复用：会话还活着、且能「安全接管」（pane 活+配置没变）→ 不杀不换 session-id，澄不失忆。
    // 配合 detach()（退出不杀会话）+ systemd KillMode=process（不收割子进程）才完整生效。
    // force=true（amnesia/restart/换模型）跳过复用，强制杀旧起新——失忆/换模型语义不变。
    if (!opts.force) {
      const alive = await this._sessionAlive();
      if (alive) {
        const probe = await this._probeReusable();
        if (probe.ok) {
          this.reused = true;
          this.sessionId = probe.sessionId;
          this.transcript = probe.sessionId ? path.join(this.projectDir, probe.sessionId + '.jsonl') : null;
          this.firstContextTokens = 0; this.lastInputTokens = 0;
          this.running = true;
          this._startWatchdog(generation);
          this.emit('state', 'ready');
          // 接管时 Claude 正好还在生成（后端在它回话途中被重启）：标 busy + 排空那一轮，
          // 期间各发送 gate 看 isBusy() 不会把新消息粘进还在工作的 Claude。那一轮的回复随重启已无投递目标，不补发。
          if (await this._isWorking()) {
            this.busy = true;
            console.log(`[tmux] 接管会话但 Claude 仍在生成，排空中… session=${this.sessionId || '?'}`);
            this._drainOrphanTurn(generation);
          } else {
            this.busy = false;
            console.log(`[tmux] 复用已存在 cheng 会话（空闲），session=${this.sessionId || '?'}`);
          }
          return;
        }
        console.warn(`[tmux] 现有会话不可安全接管（${probe.reason}）→ 强制重起`);
      }
    }
    this.reused = false;
    this.sessionId = randomUUID();
    this.transcript = path.join(this.projectDir, this.sessionId + '.jsonl');
    this.firstContextTokens = 0; this.lastInputTokens = 0;
    // 让 tmux 会话「直接把 claude 当命令跑」(不经交互 shell)：
    // 这样 churn 把二进制弄没只会让会话退出，不会留下"命令落进输入框"的垃圾。
    // churn 杀了会话 → 外层重建；最多重建 30 次（覆盖一整个二进制稳定窗口）。
    const cmd = this._launchCmd();
    const wantHash = this._configHash();
    for (let attempt = 0; attempt < 30; attempt++) {
      if (generation !== this._generation) return;   // 被新一代 start 接管 → 放手，别再 kill/建
      await tmux('kill-session', '-t', this.session).catch(() => {});
      await sleep(500);
      await tmux('new-session', '-d', '-s', this.session, '-x', '220', '-y', '50', '-c', this.cwd, cmd).catch(() => {});
      // 等就绪 或 会话因 churn 死亡（最多 ~25s）
      for (let i = 0; i < 25; i++) {
        if (generation !== this._generation) return;
        await sleep(1000);
        const alive = await this._sessionAlive();
        if (!alive) break;                          // churn 杀了它 → 外层重建
        const pane = await this._pane();
        if (/Is this a project you created or one you trust/.test(pane)) {
          await tmux('send-keys', '-t', this.session, 'Enter'); continue;   // 信任确认
        }
        if (/bypass permissions on|for agents/.test(pane)) {
          // 写 metadata：session-id + 配置指纹，供下次后端重启探活复用
          await tmux('set-option', '-t', this.session, '@cheng_session_id', this.sessionId).catch(() => {});
          await tmux('set-option', '-t', this.session, '@cheng_config_hash', wantHash).catch(() => {});
          this.running = true; this._startWatchdog(generation); this.emit('state', 'ready'); return;
        }
      }
      if (attempt < 29) await sleep(2000);          // churn 窗口，喘口气再重建
    }
    this.running = false;
    this.emit('state', 'down');
    // 不 throw：index.js 在 375 行非 await 调用 start()，throw 会成未捕获 rejection。看门狗会再拉。
    console.error('[tmux] CC 交互界面 30 次重建仍未就绪');
  }

  // 排空「接管时还在生成的那一轮」：只等它自己结束、把 busy 放掉，不读不投递（activeTurn 已随后端重启丢失）。
  // 结束后 emit 'drained'，index.js 据此把这期间攒下的消息 flush 出去。
  async _drainOrphanTurn(generation) {
    try {
      for (let i = 0; i < 440; i++) {                 // 上限 ~660s，与 _watchTurn 同量级
        if (this.stopping || generation !== this._generation) return;
        if (!(await this._isWorking())) {
          if (!(await this._sessionAlive())) break;    // 会话没了 → 看门狗会处理
          await sleep(1500);
          if (!(await this._isWorking())) break;       // 二次确认确实空闲
        }
        await sleep(1500);
      }
    } finally {
      if (generation === this._generation) { this.busy = false; this.emit('drained'); }
    }
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
    this.lastSent = String(content);   // 记下本轮文本，供卡死哨兵重发
    // 写到 /tmp（claude-user 的 tmux 要能读 load-buffer 的文件）；不用 os.tmpdir()（可能是私有目录）
    const tmp = `/tmp/tmux-msg-${this.session}.txt`;
    fs.writeFileSync(tmp, String(content)); fs.chmodSync(tmp, 0o644);
    const buf = `cheng-${this.session}`;
    await tmux('load-buffer', '-b', buf, tmp);
    // -p = 括号粘贴(bracketed paste)：让多条消息拼接里的换行只当文字、不被终端误当回车提交。
    // 缺它时(旧版)：缓冲多条用 \n\n 拼成一坨粘进来 → 换行被当回车 → 一次发送被拆成多轮 → 双回复+第二轮卡死。
    // 注意：这是 tmux paste-buffer 的 -p，跟 `claude -p`(headless/API)毫无关系，不碰 Max 额度。
    await tmux('paste-buffer', '-p', '-b', buf, '-t', this.session);
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
    this._interrupted = false;
    const generation = this._generation;   // 本轮所属代次：被 force 重起换代后，旧观察器不再 emit（防把旧轮结果当新会话）
    try {
      // 等开始（最多 ~12s 出现 working；没出现就当瞬时完成）
      for (let i = 0; i < 8; i++) { if (await this._isWorking()) break; await sleep(1500); }
      // 等真完成：空闲 + transcript 最后一条 assistant 的 stop_reason=end_turn。
      // 只看"空闲"会被工具执行时 esc-to-interrupt 短暂消失骗到 → 提前读取 → 吞掉工具后的回复。
      let idle = 0, ended = false;
      // 200→440：单轮上限 ~300s→~660s，扛住分钟级上游 stall（≥ inject 的 600s，
      // 否则 stall 时这里的"耗尽兜底"会抢先 emit 旧文本，注入/对话都拿到半截）。
      for (let i = 0; i < 440; i++) {
        // 被 interrupt()(用户按停止→Ctrl+C)打断：立刻收尾，别再等屏幕判定/660s 超时。
        // ended=true → timedOut=false（这是主动结束、不是耗尽兜底）；下游 turn_done 走 stopped 分支清锁+flush。
        if (this._interrupted) { ended = true; break; }
        if (await this._isWorking()) { idle = 0; }
        else {
          // 空闲也可能是「Claude 轮中崩溃/会话退出」：二次确认会话还在，不在就快速失败（别傻等 660s）。
          if (!(await this._sessionAlive())) throw new Error('tmux 会话轮中退出');
          idle++;
          // 空闲且 transcript 显示这轮真结束(非 tool_use 中途)才完成
          if (idle >= 2 && await this._turnEnded()) { ended = true; break; }
        }
        await sleep(1500);
      }
      await sleep(1200); // transcript flush
      const turn = await this._readLastTurn();
      this.busy = false;
      if (generation !== this._generation) { return; }   // 期间发生过 force 重起：这是上一代的轮，丢弃不 emit
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
        usageCalls: turn.usageCalls || [],
        contextTokens: ctx || null,
        systemTokens: this.firstContextTokens || null,
        is_error: false,
        empty: !turn.text.trim(),   // 交互模式理论上不空；真空了这里标出来
        timedOut: !ended,           // true = 循环耗尽兜底(没等到 end_turn)，读到的可能是上一轮旧文本，下游别当真回复
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
    const texts = [], thinks = [];
    let usage = null;
    const usageCallsRev = [];
    const seenReq = new Set();
    for (let i = lines.length - 1; i >= 0; i--) {
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      const t = o.type, c = o.message?.content;
      if (t === 'user') {
        const isToolResult = Array.isArray(c) && c.some(b => b?.type === 'tool_result');
        if (typeof c === 'string' || (Array.isArray(c) && c.some(b => b?.type === 'text'))) break; // 真实 user 边界
        if (isToolResult) continue;
      }
      if (t === 'assistant') {
        if (o.message?.usage) {
          const req = o.requestId || o.uuid || `idx-${i}`;
          if (!seenReq.has(req)) {
            seenReq.add(req);
            usageCallsRev.push({ requestId: req, timestamp: o.timestamp || null, usage: o.message.usage });
          }
          if (!usage) usage = o.message.usage;
        }
        for (const b of (c || [])) {
          if (b?.type === 'text' && b.text?.trim()) texts.push(b.text);
          else if (b?.type === 'thinking' && b.thinking) thinks.push(b.thinking);
        }
      }
    }
    texts.reverse(); thinks.reverse();
    return { text: texts.join('\n\n'), thinking: thinks.join('\n\n'), usage: usage || {}, usageCalls: usageCallsRev.reverse() };
  }

  // 卡死哨兵用：当前 transcript 文件最后修改时间(ms)。0 = 还没 transcript。
  transcriptMtime() {
    if (!this.transcript) return 0;
    try { return fs.statSync(this.transcript).mtimeMs; } catch { return 0; }
  }

  // 卡死哨兵用：transcript 末尾是否停在"已发起工具调用、还没拿到结果"
  //（在等慢工具，不是思考卡死，哨兵应放过别误杀）。
  async awaitingToolResult() {
    const tf = this.transcript;
    if (!tf) return false;
    const raw = await sh('sudo', ['-u', 'claude-user', 'cat', tf]).catch(() => '');
    const lines = raw.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let o; try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o.type === 'user') return false;        // 最后是 tool_result → 工具已回，不在等
      if (o.type === 'assistant') {
        const c = o.message?.content;
        return Array.isArray(c) && c.some(b => b?.type === 'tool_use');
      }
    }
    return false;
  }

  async clearScreen() { // 清屏 = 原生 /clear（注意：/clear 后 claude 会换新 session 文件）
    await tmux('send-keys', '-t', this.session, '/clear', 'Enter');
    await sleep(1500);
    this.transcript = null; this.firstContextTokens = 0; this.lastInputTokens = 0;
  }
  async interrupt() {
    this._interrupted = true;                                   // 让正在跑的 _watchTurn 立刻收尾
    await tmux('send-keys', '-t', this.session, 'C-c');
    // 等观察器释放 _watching（它每 ~1.5s 检查一次 _interrupted）：否则紧接着的新一轮 send()
    // 会因 _watching=true 拿不到观察器 → 新轮永不 emit turn_done。最多等 ~4.5s 兜底。
    for (let i = 0; i < 30 && this._watching; i++) await sleep(150);
    this.busy = false;
    this._interrupted = false;
  }

  async amnesia() { // 失忆 = 杀会话重起（交互新会话天然无上文，等价不带 --resume）
    this.transcript = null; this.firstContextTokens = 0; this.lastInputTokens = 0;
    await this.start({ force: true });   // force：跳过探活复用，强制杀旧起新（否则会接管旧会话=没失忆）
  }

  async restart(options = {}) {
    if (options.model !== undefined) this.model = options.model || this.model;
    if (options.effort !== undefined) this.effort = options.effort || null;
    if (options.nativeThinking !== undefined) this.nativeThinking = !!options.nativeThinking;
    await this.start({ force: true });   // force：换模型/换 effort 必须真的重起，不能复用旧会话
  }

  async stop() {
    this.stopping = true;
    this.running = false;
    this._clearWatchdog();
    this._clearRestartTimer();
    await tmux('kill-session', '-t', this.session).catch(() => {});
  }

  // 后端退出但「不杀 CC」：只清掉本进程的看门狗+延迟重起 timer，留 tmux 会话活着。
  // 用于 SIGTERM/SIGINT——配合 systemd KillMode=process（systemd 不收割 cgroup 子进程）
  // + start() 探活复用，实现「重启后端不重启 CC」（澄不失忆）。
  // 想真正杀掉 CC 用 stop()/amnesia()/restart()，或手动 `tmux kill-session -t cheng`。
  detach() {
    this.stopping = true;        // 防 _watchTurn / 看门狗在进程退出途中再动作
    this.running = false;
    this._clearWatchdog();
    this._clearRestartTimer();   // 关键：别让延迟重起 timer 在 node 退出前又把 Claude 拉起/杀掉
    // 故意不 kill-session
  }

  isRunning() { return this.running; }  // 同步：index.js 里 if(!cc.isRunning()) 要这个

  _clearWatchdog() { if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; } }
  _clearRestartTimer() { if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; } }

  // 看门狗：每 10s 查会话还在不在；没了且非主动停 → 标 down + 延迟自动重起。
  // 递归 setTimeout（不是 setInterval）：每次检查「结束后」才排下一次，避免某次 tmux 命令卡住导致探活重叠。
  // generation：本代标识，被 force/新一代 start 换代后旧 tick 自动停。
  _startWatchdog(generation) {
    this._clearWatchdog();
    const tick = async () => {
      if (generation !== this._generation || this.stopping) return;   // 旧代/已停 → 不再排
      // 忙/观察中不触发重起（轮中崩溃由 _watchTurn 内部二次探活快速失败处理，避免双发）
      if (!this._watching && !this.busy) {
        const alive = await this._sessionAlive();
        if (!alive && this.running) {
          this.running = false;
          this.emit('state', 'down');
          console.warn('[tmux] 会话不在了，3s 后自动重起…');
          this._restartTimer = setTimeout(() => {
            this._restartTimer = null;
            if (!this.stopping && generation === this._generation) this.start();
          }, 3000);
          return;   // 交给 start 接管，本代看门狗不再排 tick
        }
      }
      if (generation === this._generation && !this.stopping) this._watchdog = setTimeout(tick, 10000);
    };
    this._watchdog = setTimeout(tick, 10000);
  }
  isBusy() { return this.busy; }
}
