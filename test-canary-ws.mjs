// 全栈 canary：自签 JWT → 连 ws://localhost:3002 → 发一条 chat（不带 conversation_id 免污染）
// → 收集 start/delta/thinking/done 事件 → 打印。验证 WS→后端→tmux CC→turn_done→推回 整条链。
import dotenv from 'dotenv';
dotenv.config();
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';

const token = jwt.sign({ scope: 'app' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const ws = new WebSocket(`ws://localhost:3002/?token=${token}`);
const got = [];
let doneText = '';
let acc = '';        // 累积 delta（像前端那样）
let accThink = '';

const timeout = setTimeout(() => { console.log('⏱️ 超时退出'); finish(); }, 120000);
function finish() {
  clearTimeout(timeout);
  console.log('\n=== 收到的事件类型序列 ===');
  console.log(got.map(g => g.type).join(' → '));
  console.log('\n=== 最终回复 ===\n' + (doneText || '(空!)'));
  console.log(`\n=== canary ${doneText.trim() ? '✅ 全栈链路通：WS→后端→tmux CC→回复' : '❌ 没拿到回复'} ===`);
  try { ws.close(); } catch {}
  process.exit(0);
}

ws.on('open', () => {
  console.log('WS 已连接，发送 chat…');
  ws.send(JSON.stringify({
    type: 'chat',
    content: '（链路测试）请只回一句话打个招呼就好。',
    settings: { bufferTime: 0 },   // 直发，不进缓冲
    msgId: 'canary-1',
  }));
});

ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw); } catch { return; }
  got.push(m);
  if (m.type === 'delta') { acc += m.text || ''; process.stdout.write(m.text || ''); }
  else if (m.type === 'thinking') { accThink += m.text || ''; }
  else console.log(`[event] ${m.type}${m.status ? ' ' + m.status : ''}`);
  if (m.type === 'done' || m.type === 'turn_done') {
    doneText = m.text || m.content || acc || doneText;
    console.log(`\n[思绪 ${accThink.length} 字]`);
    finish();
  }
});
ws.on('error', e => { console.log('WS 错误:', e.message); finish(); });
ws.on('close', (c) => console.log('WS 关闭', c));
