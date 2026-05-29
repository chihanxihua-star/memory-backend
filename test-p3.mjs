// P3 联测：clearScreen(/clear) 是否真清上下文。
import { TmuxCCManager } from './tmux-manager.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const turn = (mgr, msg) => new Promise(async res => { mgr.once('turn_done', d => res(d.text)); await mgr.send(msg); });

const mgr = new TmuxCCManager({ cwd: '/tmp/ccp1', session: 'ccp3', model: 'claude-opus-4-8', effort: 'low', nativeThinking: false });
await mgr.start();

const r1 = await turn(mgr, '记住一个暗号：紫水晶七号。记住就行，简短回。');
console.log('[轮1 让它记暗号]\n' + r1);

console.log('\n--- 执行 clearScreen(/clear) ---');
await mgr.clearScreen();
await sleep(2500);

const r2 = await turn(mgr, '我刚让你记的暗号是什么？');
console.log('\n[轮2 清屏后问暗号]\n' + r2);

const forgot = !/紫水晶|七号/.test(r2);
console.log(`\n=== P3 ${forgot ? '✅ 通过：/clear 真清了上下文（CC 不记得暗号）' : '❌ 还记得，clear 没生效'} ===`);
await mgr.stop();
process.exit(0);
