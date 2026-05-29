import dotenv from 'dotenv'; dotenv.config();
import jwt from 'jsonwebtoken'; import WebSocket from 'ws';
const token = jwt.sign({ scope:'app' }, process.env.JWT_SECRET, { expiresIn:'1h' });
const ws = new WebSocket(`ws://localhost:3002/?token=${token}`);
let acc=''; const evts=[];
const to=setTimeout(()=>fin(),150000);
function fin(){clearTimeout(to);console.log('\n事件:',evts.join(' '));console.log('\n最终回复:\n'+(acc||'(空!被吞了)'));console.log('\n'+(acc.trim()?'✅ 工具后回复没被吞':'❌ 还是被吞'));try{ws.close()}catch{};process.exit(0)}
ws.on('open',()=>{console.log('连上,发触发工具的消息…');ws.send(JSON.stringify({type:'chat',content:'用工具查一下记忆库里有没有关于"猫"的记忆,有就简短说一句,没有也说一句。',settings:{bufferTime:0},msgId:'t'}))});
ws.on('message',d=>{let m;try{m=JSON.parse(d)}catch{return}evts.push(m.type);if(m.type==='delta')acc+=m.text||'';if(m.type==='tool_use')console.log('[工具调用]',m.name);if(m.type==='done')fin()});
ws.on('error',e=>{console.log('err',e.message);fin()});
