// inject.js — 把"记忆浮现"折进用户消息成一条（tmux 交互模式用）。
// 替代 stream-json 的"静默轮注入"：交互式 CC 对每个 Enter 都会回，单独发注入会被当一轮去回复。
// 折进同一条 → CC 当一轮、回一次。用户真打的那句单独存/显示（这层在 index.js 的 send 路径区分）。
import { surfaceForInject } from './surfacing.js';

// 折叠后的消息：[记忆浮现背景（仅 CC 可见，别复述/别单独回应）] + [用户原话]
// 返回 { message, injectedCount }。无浮现命中时 message === userText 原样。
export async function buildMessageForCC(userText, { timePrefix = '' } = {}) {
  let fuxian = { text: '', items: [] };
  try {
    fuxian = await surfaceForInject(userText);
  } catch (e) {
    console.error('[inject] surfaceForInject failed:', e.message);
  }
  const user = timePrefix ? `${timePrefix}\n${userText}` : userText;
  if (!fuxian.text) return { message: user, injectedCount: 0 };
  const block =
    `<记忆浮现 — 仅你可见的背景，自然融入对话即可；不要直接复述，也不要把这段当成要回应的内容>\n` +
    `${fuxian.text}\n` +
    `</记忆浮现>\n\n` +
    user;
  return { message: block, injectedCount: fuxian.items.length };
}
