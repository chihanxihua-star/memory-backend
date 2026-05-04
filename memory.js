import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export { supabase };

// 获取或创建单例"默认"项目（世界书锚点）
export async function getDefaultProject() {
  const { data: existing } = await supabase
    .from('projects')
    .select('id, name, system_prompt')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing) return existing;

  const { data, error } = await supabase
    .from('projects')
    .insert({ name: '默认', system_prompt: '' })
    .select('id, name, system_prompt')
    .single();
  if (error) throw error;
  return data;
}

// ==================== briefing ====================
export async function briefing() {
  // 不再区分project，所有记忆都直接读取

  // 锚点
  const { data: anchors } = await supabase
    .from('memories')
    .select('id, content, importance')
    .eq('layer', 'anchor')
    .gte('importance', 0.8)
    .order('importance', { ascending: false })
    .limit(5);

  // 最近3条小结
  const { data: summaries } = await supabase
    .from('memories')
    .select('content, summary, created_at')
    .eq('layer', 'diary')
    .contains('tags', ['小结'])
    .order('created_at', { ascending: false })
    .limit(3);

  // 最近碎片
  const { data: fragments } = await supabase
    .from('memories')
    .select('content, created_at')
    .eq('layer', 'daily')
    .order('created_at', { ascending: false })
    .limit(3);

  // 未完成待办
  const { data: todos } = await supabase
    .from('memories')
    .select('id, content, status, created_at')
    .eq('layer', 'diary')
    .contains('tags', ['待办'])
    .neq('status', '完成')
    .order('created_at', { ascending: false });

  // 呢喃待回复
  const { data: pendingMurmurs } = await supabase
    .from('memories')
    .select('id, content, context, created_at')
    .eq('layer', 'murmure')
    .eq('need_reply', true)
    .order('created_at', { ascending: false })
    .limit(5);

  // 如果有待回复呢喃，拉评论
  let pendingMessages = [];
  if (pendingMurmurs && pendingMurmurs.length > 0) {
    for (const m of pendingMurmurs) {
      const { data: comments } = await supabase
        .from('comments')
        .select('id, author, content, parent_id')
        .eq('memory_id', m.id)
        .order('created_at', { ascending: true });
      pendingMessages.push({
        memory_id: m.id,
        content: m.content,
        ref_memory_id: m.context?.ref_memory_id || null,
        comments: comments || [],
      });
    }
  }

  // 组装成自然语言简报
  let briefingText = '';

  if (anchors && anchors.length > 0) {
    briefingText += '【锚点/固定设定】\n';
    for (const a of anchors) {
      briefingText += `- ${a.content}\n`;
    }
    briefingText += '\n';
  }

  if (summaries && summaries.length > 0) {
    briefingText += '【最近小结】\n';
    for (const s of summaries) {
      const text = s.summary || s.content.slice(0, 200);
      const date = new Date(s.created_at).toLocaleDateString('zh-CN');
      briefingText += `- ${date}: ${text}\n`;
    }
    briefingText += '\n';
  }

  if (fragments && fragments.length > 0) {
    briefingText += '【最近碎片】\n';
    for (const f of fragments) {
      briefingText += `- ${f.content}\n`;
    }
    briefingText += '\n';
  }

  if (todos && todos.length > 0) {
    briefingText += '【未完成待办】\n';
    for (const t of todos) {
      briefingText += `- [${t.status || '进行中'}] ${t.content}\n`;
    }
    briefingText += '\n';
  }

  if (pendingMessages.length > 0) {
    briefingText += '【呢喃待回复】\n';
    for (const p of pendingMessages) {
      briefingText += `- 动态: ${p.content}\n`;
      if (p.comments.length > 0) {
        for (const c of p.comments) {
          briefingText += `  └ ${c.author}: ${c.content}\n`;
        }
      }
    }
    briefingText += '\n';
  }

  return briefingText || '（暂无记忆简报）';
}

// ==================== searchMemory ====================
export async function searchMemory({ query, layer, tags, importance_min, limit = 5, id }) {
  // 不再过滤project_id，读取所有记忆
  if (id) {
    const { data } = await supabase
      .from('memories')
      .select('id, layer, content, summary, tags, importance, author, source, created_at')
      .eq('id', id)
      .single();
    return data ? [data] : [];
  }

  let q = supabase
    .from('memories')
    .select('id, layer, content, summary, tags, importance, author, source, created_at');

  if (layer) q = q.eq('layer', layer);
  if (tags && tags.length > 0) q = q.contains('tags', tags);
  if (importance_min) q = q.gte('importance', importance_min);

  q = q.order('importance', { ascending: false })
       .order('created_at', { ascending: false })
       .limit(limit);

  const { data } = await q;

  return (data || []).map(m => ({
    id: m.id,
    layer: m.layer,
    text: m.summary || m.content.slice(0, 200),
    tags: m.tags,
    importance: m.importance,
    author: m.author,
    source: m.source,
    created_at: m.created_at,
  }));
}

// ==================== writeMemory ====================
export async function writeMemory({
  content,
  layer,
  importance = 0.5,
  tags = [],
  event_date = null,
  status = null,
  intensity = null,
  context = {},
  need_reply = false,
  author = '宝',
  project_id = null,
  source = 'web',
}) {
  const { data, error } = await supabase
    .from('memories')
    .insert({
      content,
      layer,
      importance,
      tags,
      event_date,
      status,
      intensity,
      context,
      need_reply,
      author,
      project_id,
      source,
    })
    .select('id')
    .single();

  if (error) {
    console.error('写入记忆失败:', error.message);
    return null;
  }
  return data.id;
}
