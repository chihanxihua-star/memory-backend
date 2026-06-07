// world-home 第 5 步：pending_wake 短期连续状态。
// 澄选「先忍 10 分钟」时后端排一条 pending_wake_cheng；到点这个 daemon 把它捞出来、
// 调回 index.js 的 onDue（=重新世界唤醒澄）。轮询 + fired/failed 账务都在这；CC 会话逻辑在 index.js。
import { supabase } from './memory.js';

export class PendingWakeDaemon {
  // onDue(row): async → { fired:boolean, reason?:string }
  //   fired=true            → 标 status='fired'、fired_at=now、attempts+1
  //   fired=false reason=cc_busy → 保持 queued，不计 attempts，下次再试
  //   fired=false 其它       → attempts+1；>=3 标 failed + 写 daily_timeline(system_error)
  constructor({ onDue, intervalMs = 7000 }) {
    this._onDue = onDue;
    this._intervalMs = intervalMs;
    this._timer = null;
    this._busy = false;
  }

  start() {
    this.stop();
    this._timer = setInterval(() => this._tick(), this._intervalMs);
    console.log(`[PENDING] daemon 启动，每 ${this._intervalMs / 1000}s 检查一次到期的 pending_wake`);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  async _tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      const { data, error } = await supabase
        .from('pending_wake_cheng')
        .select('*')
        .eq('status', 'queued')
        .lte('scheduled_at', new Date().toISOString())
        .order('scheduled_at', { ascending: true })
        .limit(1);
      if (error) { console.error('[PENDING] 查询失败:', error.message); return; }
      const row = data && data[0];
      if (!row) return;

      let res;
      try { res = await this._onDue(row); }
      catch (e) { res = { fired: false, reason: e?.message || 'onDue 异常' }; }

      if (res && res.fired) {
        await supabase.from('pending_wake_cheng').update({
          status: 'fired',
          fired_at: new Date().toISOString(),
          attempts: (row.attempts || 0) + 1,
        }).eq('id', row.id);
        console.log(`[PENDING] 已触发 ${row.id} (${row.wake_type})`);
        return;
      }

      // CC 忙：保持 queued，下次再试，不计 attempts
      if (res && res.reason === 'cc_busy') {
        console.log(`[PENDING] CC 忙，${row.id} 留 queued 等下次`);
        return;
      }

      // 真发送失败：attempts+1，到 3 次标 failed
      const attempts = (row.attempts || 0) + 1;
      const patch = { attempts };
      if (attempts >= 3) patch.status = 'failed';
      await supabase.from('pending_wake_cheng').update(patch).eq('id', row.id);
      console.warn(`[PENDING] ${row.id} 触发失败(attempts=${attempts}${attempts >= 3 ? '，标 failed' : ''}): ${res?.reason || 'unknown'}`);
      if (attempts >= 3) {
        try {
          await supabase.from('daily_timeline_cheng').insert({
            world_time: row.world_time || '',
            location: null,
            action: `pending_wake 触发失败（${row.wake_type}），已放弃`,
            detail: { pending_wake_id: row.id, reason: row.reason, attempts },
            source: 'system_error',
          });
        } catch (e) { console.error('[PENDING] 写 system_error 行程失败:', e.message); }
      }
    } finally {
      this._busy = false;
    }
  }
}
