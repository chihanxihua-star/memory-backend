-- 为messages表添加images列
ALTER TABLE messages ADD COLUMN IF NOT EXISTS images jsonb DEFAULT '[]'::jsonb;

-- 添加索引以提高查询性能
CREATE INDEX IF NOT EXISTS idx_messages_images ON messages USING GIN (images);
