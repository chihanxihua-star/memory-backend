// P2 测试：① buildMessageForCC 对真 supabase 折叠浮现；② 折进一条 → CC 当一轮回一次、自然用背景不复述。
import dotenv from 'dotenv';
dotenv.config();
import { buildMessageForCC } from './inject.js';
import { TmuxCCManager } from './tmux-manager.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ───── Part B：真 supabase 折叠（不启动 CC）─────
console.log('===== Part B：buildMessageForCC（真 surfacing）=====');
for (const q of ['我回来啦', '我们之前聊过什么', '今天好累']) {
  const { message, injectedCount } = await buildMessageForCC(q);
  console.log(`\n[用户] ${q}  → 注入 ${injectedCount} 条`);
  console.log('[喂给CC]\n' + (message === q ? '(无浮现，原样)' : message));
}

// ───── Part A：折叠消息 → CC 回一次 ─────
console.log('\n\n===== Part A：折进一条消息，CC 当一轮回一次 =====');
const mgr = new TmuxCCManager({ cwd: '/tmp/ccp1', session: 'ccp2', model: 'claude-opus-4-8', effort: 'high', nativeThinking: true });
let doneCount = 0;
mgr.on('turn_done', d => {
  doneCount++;
  console.log(`\n[turn_done #${doneCount}] empty=${d.empty} text(${d.text.length}):\n${d.text}`);
});

await mgr.start();
// 手工折一条：背景(假记忆) + 用户原话。验 CC 是否自然用"豆豆/橘猫"而不复述标签、且只回一次。
const folded =
  `<记忆浮现 — 仅你可见的背景，自然融入即可；不要直接复述，也不要把这段当成要回应的内容>\n` +
  `前几天……用户提过他养了一只叫"豆豆"的橘猫\n` +
  `</记忆浮现>\n\n我回来啦`;
console.log('[发送折叠消息]\n' + folded);
await mgr.send(folded);
// 等这一轮完成
await new Promise(res => { mgr.once('turn_done', res); });
await sleep(2000);

console.log(`\n=== Part A 结果：共 ${doneCount} 个 turn_done（应=1，证明没被拆成多轮）===`);
console.log('（人工看上面回复：是否自然提到豆豆/猫、没复述<记忆浮现>标签、只回了"我回来啦"这一句）');
await mgr.stop();
process.exit(0);
