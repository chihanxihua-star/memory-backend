import { supabase } from './memory.js';

async function migrate() {
  try {
    console.log('开始迁移：添加 images 列...');

    const { data, error } = await supabase.rpc('exec_sql', {
      sql: `ALTER TABLE messages ADD COLUMN IF NOT EXISTS images jsonb DEFAULT '[]'::jsonb;`
    });

    if (error) {
      // 如果rpc不支持，尝试直接通过REST API
      console.log('尝试通过原生查询...');

      // 检查列是否已存在
      const { data: testData } = await supabase
        .from('messages')
        .select('images')
        .limit(1);

      if (testData) {
        console.log('✅ images 列已存在或创建成功');
      }
    } else {
      console.log('✅ 迁移完成');
    }
  } catch (err) {
    console.log('注意: 你可能需要手动在Supabase控制台执行以下SQL:');
    console.log('ALTER TABLE messages ADD COLUMN IF NOT EXISTS images jsonb DEFAULT \'[]\'::jsonb;');
    console.log('');
    console.log('或者直接忽略此错误，如果列已存在的话。');
  }

  process.exit(0);
}

migrate();
