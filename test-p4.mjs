// P4 测试：图片 content-block → 临时文件 → 路径进消息 → CC 读图描述颜色。
import fs from 'fs';
import { TmuxCCManager } from './tmux-manager.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const b64 = fs.readFileSync('/tmp/p4-test.png').toString('base64');
const blocks = [
  { type: 'text', text: '这张图主要是什么颜色？只说颜色。' },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
];

const mgr = new TmuxCCManager({ cwd: '/tmp/ccp1', session: 'ccp4', model: 'claude-opus-4-8', effort: 'low', nativeThinking: false });

await mgr.start();
let reply = '';
mgr.once('turn_done', d => { reply = d.text; });
console.log('发送带图片的 content-block 数组…');
await mgr.send(blocks);
await new Promise(res => mgr.once('turn_done', res));
await sleep(1500);

console.log('\n[CC 回复]\n' + reply);
const hit = /品红|洋红|玫红|紫|粉|magenta|pink|purple/i.test(reply);
console.log(`\n=== P4 ${hit ? '✅ 通过：CC 读到了图、说对了颜色（品红系）' : '❌ 没说中颜色，CC 可能没读到图'} ===`);
// 顺带确认临时图文件生成了
const imgs = fs.readdirSync('/tmp').filter(f => f.startsWith('tmux-img-ccp4-'));
console.log('生成的临时图文件:', imgs.join(', ') || '(无)');
await mgr.stop();
process.exit(0);
