// P1 独立测试：驱动 TmuxCCManager 跑多轮，验证 turn_done 带 text+usage、无空回。不碰生产。
import { TmuxCCManager } from './tmux-manager.js';

const mgr = new TmuxCCManager({
  cwd: '/tmp/ccp1',           // 独立 cwd，跟生产 chat-sandbox 隔离
  session: 'ccp1',
  model: 'claude-opus-4-8',
  effort: 'high',
  nativeThinking: true,        // 故意开原生思考——这正是 stream-json 下会空回的条件
});

const msgs = ['嘿嘿', '晚上好呀~', '想你啦', '鸡兔同笼35头94脚各几只', '在干嘛呢'];
const results = [];

mgr.on('state', s => console.log(`[state] ${s}`));
mgr.on('turn_error', e => console.log(`[turn_error] ${e.message}`));

function nextTurn(i) {
  return new Promise(async (resolve) => {
    mgr.once('turn_done', d => {
      const flag = d.empty ? ' ❌空回!' : '';
      console.log(`轮${i + 1} "${msgs[i]}" → text(${d.text.length}) thinking(${d.thinking.length}) ` +
        `usage[in=${d.usage.input_tokens} cr=${d.usage.cache_read_input_tokens} cc=${d.usage.cache_creation_input_tokens} out=${d.usage.output_tokens}]${flag}`);
      results.push({ turn: i + 1, msg: msgs[i], empty: d.empty, textLen: d.text.length, hasUsage: d.usage.cache_read_input_tokens != null });
      resolve();
    });
    await mgr.send(msgs[i]);
  });
}

(async () => {
  console.log('启动 CC 交互会话…');
  await mgr.start();
  for (let i = 0; i < msgs.length; i++) await nextTurn(i);
  const empties = results.filter(r => r.empty).length;
  const noUsage = results.filter(r => !r.hasUsage).length;
  console.log(`\n=== 结果：${results.length} 轮 · 空回 ${empties} · 缺 usage ${noUsage} ===`);
  console.log(empties === 0 && noUsage === 0 ? '✅ P1 通过：闭环工作、带 usage、零空回' : '⚠️ 有问题，看上面');
  await mgr.stop();
  process.exit(0);
})();
