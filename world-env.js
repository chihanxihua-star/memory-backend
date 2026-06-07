// world-env.js — 10A 步：小世界天气「读取 + 粗描述」。
// memory-backend 不持有高德 key、不请求天气 API。天气由独立组件 weather-fetcher 拉取、清洗、写入
// world_environment_cheng（已丢弃 city/province/adcode）。这里只把表里字段格式化成给澄的粗描述。
// 唤醒包只给粗描述（阴天，温度偏低，微风），不给精确温度/湿度，更难反推现实位置；UI 可显示精确字段。

function describeTemp(t) {
  if (t == null || Number.isNaN(Number(t))) return '';
  const n = Number(t);
  if (n < 5) return '气温很低';
  if (n < 12) return '温度偏低';
  if (n < 22) return '温度舒适';
  if (n < 30) return '温度偏高';
  return '天气炎热';
}
function describeWind(wind) {
  if (!wind) return '';
  const m = /(\d+)/.exec(wind);
  const p = m ? parseInt(m[1], 10) : (/≤\s*3/.test(wind) ? 3 : 0);
  if (p <= 3) return '微风';
  if (p <= 5) return '有点风';
  return '风大';
}

// world_environment_cheng 行 → 给澄的粗描述，如「阴，温度偏低，微风」。无数据返回空串。
// 注意：故意不含精确温度/湿度/城市，只给生活化天气感受。
export function formatWeather(env) {
  if (!env || !env.weather_text) return '';
  const parts = [env.weather_text, describeTemp(env.temperature), describeWind(env.wind)].filter(Boolean);
  return parts.join('，');
}
