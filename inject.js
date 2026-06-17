// inject.js — 把"记忆浮现"折进用户消息成一条（tmux 交互模式用）。
// 替代 stream-json 的"静默轮注入"：交互式 CC 对每个 Enter 都会回，单独发注入会被当一轮去回复。
// 折进同一条 → CC 当一轮、回一次。用户真打的那句单独存/显示（这层在 index.js 的 send 路径区分）。
import { surfaceForInject } from './surfacing.js';
import { consumeDreamResidue } from './world-dream.js';

// 折叠后的消息：[记忆浮现背景（仅 CC 可见，别复述/别单独回应）] + [用户那条（可含时间前缀）]
// - searchText: 搜浮现用的干净用户文本（不含时间标记，免污染检索）
// - userPortion: 折叠块下方实际放的用户内容（默认=searchText；通常传 maybeTimePrefix 后的版本）
// 返回 { message, injectedCount }。无浮现命中时 message === userPortion 原样。
export async function buildMessageForCC(searchText, userPortion = searchText) {
  let fx = { statusLine: '', text: '', items: [], worldThought: '' };
  try {
    fx = await surfaceForInject(searchText);
  } catch (e) {
    console.error('[inject] surfaceForInject failed:', e.message);
  }
  // 三个独立块：<此刻>=现实情境（每条都带）、<小世界浮现>=念头池(12B-2,最多1条)、<记忆浮现>=长期记忆库（冷却+命中才有）。
  // 14B-1：梦境残留——澄醒来后记得的那点梦，只注入一次（consumeDreamResidue 取完即标 surfaced）。
  // 聊天和世界唤醒哪条先用就由哪条消费；放 <此刻> 后（刚醒的情境）。完整梦永不在这里。
  let dreamResidue = '';
  try { dreamResidue = (await consumeDreamResidue()) || ''; } catch (e) { console.warn('[inject] 梦境残留消费失败:', e.message); }

  const blocks = [];
  if (fx.statusLine) {
    blocks.push(`<此刻>\n${fx.statusLine}\n</此刻>`);
  }
  if (dreamResidue) {
    blocks.push(`<梦境残留>\n${dreamResidue}\n</梦境残留>`);
  }
  // 标签精简（2026-06-12）：「仅你可见的背景，别复述别当成要回应」的叮嘱挪进了 sysprompt
  // （documents_cheng system_prompt 的 <世界唤醒区>③），这里不再每条重复，省 token。
  if (fx.worldThought) {
    blocks.push(`<小世界浮现>\n${fx.worldThought}\n</小世界浮现>`);
  }
  if (fx.text) {
    blocks.push(`<记忆浮现>\n${fx.text}\n</记忆浮现>`);
  }
  if (!blocks.length) return { message: userPortion, injectedCount: 0 };
  const message = blocks.join('\n') + '\n\n' + userPortion;
  return { message, injectedCount: fx.items.length };
}
