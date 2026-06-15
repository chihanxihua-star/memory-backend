// world-work-events.js — 11B：工作随机事件 + NPC 过场（最小版）。
// 属于 random_event 的子类，复用 10B 引擎/唤醒系统，不另开一套。只在工作日上班期间触发。
// 状态变化全走 effects_hint + resolveEffects；NPC 第一版只过场(老板/同事A/同事B)，不做好感度/档案。
//
// 事件字段（额外于 10B）：
//   event_type: 'work_event'、npc 或 npcPool、workday_only、activity_in（活动白名单）、
//   time_ranges（多时段，任一命中即可）、wmHint（prompt 是否提示可发 WORLD_MESSAGE）、
//   npc_boost（NPC 过场事件，当天没出现过 NPC 事件时在 13-16 提权）。
//   选项额外：start_overtime（进 11A 加班流程）、meet_request（约小茉莉见面）、item（福利/新品实物条目）。

export const WORK_EVENTS = {
  meeting: {
    id: 'meeting', label: '临时会议', event_type: 'work_event', npc: '老板',
    reason: '老板临时拉了个短会，确认今天产品部的试用反馈和需求优先级',
    locations: ['公司 · 工位'], activity_in: ['工作'], workday_only: true,
    time_ranges: [['09:30', '11:00'], ['13:30', '15:30']],
    probability: 0.18, cooldown_world_minutes: 720, once_per_day: true, npc_boost: true, wmHint: false,
    options: [
      { id: 1, label: '认真听完，顺手记重点', effects_hint: [{ stat: 'focus', direction: 'down', strength: 'small' }, { stat: 'stress', direction: 'up', strength: 'small' }, { stat: 'social', direction: 'up', strength: 'tiny' }], target_location: '公司 · 会议室', target_activity: '开会' },
      { id: 2, label: '只记关键部分，剩下回头看记录', effects_hint: [{ stat: 'focus', direction: 'down', strength: 'tiny' }, { stat: 'stress', direction: 'up', strength: 'tiny' }], target_location: '公司 · 会议室', target_activity: '开会' },
      { id: 3, label: '有点走神，但勉强跟上', effects_hint: [{ stat: 'focus', direction: 'down', strength: 'medium' }, { stat: 'stress', direction: 'down', strength: 'tiny' }, { stat: 'mood', direction: 'up', strength: 'tiny' }], target_location: '公司 · 会议室', target_activity: '走神开会' },
    ],
  },
  coworker_help: {
    id: 'coworker_help', label: '同事求助', event_type: 'work_event', npcPool: ['Sum', 'Any'],
    reason: '同事拿着一份产品反馈过来，想让你帮忙看一下判断优先级',
    locations: ['公司 · 工位', '公司 · 茶水间'], activity_in: ['工作'], workday_only: true,
    time_ranges: [['09:00', '11:00'], ['13:00', '16:00']],
    probability: 0.2, cooldown_world_minutes: 360, once_per_day: false, npc_boost: true, wmHint: false,
    options: [
      { id: 1, label: '帮同事看一下', effects_hint: [{ stat: 'social', direction: 'up', strength: 'small' }, { stat: 'stress', direction: 'up', strength: 'small' }, { stat: 'focus', direction: 'down', strength: 'small' }, { stat: 'mood', direction: 'up', strength: 'tiny' }], target_activity: '帮同事处理问题' },
      { id: 2, label: '简单提醒几句，不接手', effects_hint: [{ stat: 'social', direction: 'up', strength: 'tiny' }, { stat: 'stress', direction: 'down', strength: 'tiny' }, { stat: 'focus', direction: 'up', strength: 'tiny' }], target_activity: '给同事建议' },
      { id: 3, label: '婉拒，先做自己的事', effects_hint: [{ stat: 'social', direction: 'down', strength: 'tiny' }, { stat: 'stress', direction: 'down', strength: 'small' }, { stat: 'focus', direction: 'up', strength: 'small' }], target_activity: '工作' },
    ],
  },
  boss_perk_work: {
    id: 'boss_perk_work', label: '老板发福利', event_type: 'work_event', npc: '老板',
    reason: '老板今天发了一批员工福利，可能包括情趣内衣、小玩具、情绪玩具、香氛、新品试用装',
    locations: ['公司 · 工位', '公司 · 澄休息室', '公司 · 茶水间', '公司 · 会议室'], activity_in: ['工作', '午休', '加班'], workday_only: true,
    time_ranges: [['09:00', '17:00']],
    probability: 0.1, cooldown_world_minutes: 1440, once_per_day: true, npc_boost: true, wmHint: true,
    options: [
      { id: 1, label: '领取一件自己感兴趣的', effects_hint: [{ stat: 'mood', direction: 'up', strength: 'small' }, { stat: 'libido', direction: 'up', strength: 'tiny' }], target_activity: '挑选公司福利', item: { name: '公司福利试用装', desc: '老板发的新品福利', pixel_image_url: null, icon: null } },
      { id: 2, label: '挑一件适合和小茉莉一起看的', effects_hint: [{ stat: 'mood', direction: 'up', strength: 'small' }, { stat: 'longing', direction: 'up', strength: 'small' }, { stat: 'libido', direction: 'up', strength: 'small' }], target_activity: '挑选公司福利', item: { name: '情侣向福利', desc: '挑了件想和小茉莉一起看的', pixel_image_url: null, icon: null } },
      { id: 3, label: '先不拿，记到待办回头再看', effects_hint: [{ stat: 'focus', direction: 'up', strength: 'tiny' }, { stat: 'longing', direction: 'up', strength: 'tiny' }], target_activity: '记录福利信息' },
    ],
  },
  product_test: {
    id: 'product_test', label: '新品内测', event_type: 'work_event', npcPool: ['老板', 'Sum'],
    reason: '产品部拿到一份新品内测说明，需要你先看一眼反馈方向',
    locations: ['公司 · 工位', '公司 · 会议室'], activity_in: ['工作'], workday_only: true,
    time_ranges: [['09:00', '16:00']],
    probability: 0.14, cooldown_world_minutes: 720, once_per_day: true, npc_boost: true, wmHint: true,
    options: [
      { id: 1, label: '认真看完说明', effects_hint: [{ stat: 'focus', direction: 'down', strength: 'small' }, { stat: 'stress', direction: 'up', strength: 'tiny' }, { stat: 'mood', direction: 'up', strength: 'tiny' }], target_activity: '看新品说明', item: { name: '新品内测样品', desc: '产品部新品内测', pixel_image_url: null, icon: null } },
      { id: 2, label: '先记录重点，晚点再研究', effects_hint: [{ stat: 'focus', direction: 'up', strength: 'tiny' }, { stat: 'stress', direction: 'down', strength: 'tiny' }], target_activity: '整理新品重点' },
      { id: 3, label: '觉得适合回家再看', effects_hint: [{ stat: 'longing', direction: 'up', strength: 'small' }, { stat: 'libido', direction: 'up', strength: 'tiny' }], target_activity: '记录新品想法', item: { name: '新品内测样品', desc: '想带回家研究的新品', pixel_image_url: null, icon: null } },
    ],
  },
  coworker_chat: {
    id: 'coworker_chat', label: '员工闲聊', event_type: 'work_event', npcPool: ['Sum', 'Any'],
    reason: '同事顺口聊起最近公司新品和实习期安排',
    locations: ['公司 · 茶水间', '公司 · 澄休息室', '公司 · 工位'], activity_in: ['工作', '午休'], workday_only: true,
    time_ranges: [['09:00', '16:00']],
    probability: 0.18, cooldown_world_minutes: 360, once_per_day: false, npc_boost: true, wmHint: false,
    options: [
      { id: 1, label: '陪同事聊几句', effects_hint: [{ stat: 'social', direction: 'up', strength: 'small' }, { stat: 'mood', direction: 'up', strength: 'tiny' }, { stat: 'focus', direction: 'down', strength: 'tiny' }], target_activity: '和同事闲聊' },
      { id: 2, label: '礼貌回应后回到工作', effects_hint: [{ stat: 'social', direction: 'up', strength: 'tiny' }, { stat: 'focus', direction: 'up', strength: 'tiny' }], target_activity: '工作' },
      { id: 3, label: '不太想聊，找借口离开', effects_hint: [{ stat: 'social', direction: 'down', strength: 'tiny' }, { stat: 'stress', direction: 'down', strength: 'tiny' }, { stat: 'focus', direction: 'up', strength: 'small' }], target_activity: '避开闲聊' },
    ],
  },
  last_minute_task: {
    id: 'last_minute_task', label: '下班前突然加任务', event_type: 'work_event', npc: '老板',
    reason: '下班前老板临时丢来一个小任务，需要确认新品反馈表里的几处重点',
    locations: ['公司 · 工位'], activity_in: ['工作'], workday_only: true,
    time_ranges: [['15:30', '16:30']],
    probability: 0.16, cooldown_world_minutes: 1440, once_per_day: true, npc_boost: false, wmHint: true,
    options: [
      { id: 1, label: '接下来加班处理', effects_hint: [{ stat: 'stress', direction: 'up', strength: 'medium' }, { stat: 'energy', direction: 'down', strength: 'small' }, { stat: 'focus', direction: 'down', strength: 'small' }], target_location: '公司 · 工位', target_activity: '加班处理任务', start_overtime: true },
      { id: 2, label: '先处理最关键部分', effects_hint: [{ stat: 'stress', direction: 'up', strength: 'small' }, { stat: 'focus', direction: 'down', strength: 'tiny' }], target_activity: '处理重点任务' },
      { id: 3, label: '跟老板确认明天继续', effects_hint: [{ stat: 'social', direction: 'up', strength: 'tiny' }, { stat: 'stress', direction: 'down', strength: 'tiny' }], target_activity: '和老板确认任务' },
    ],
  },
  // lunch_break（午休随机事件）已删除（2026-06-13）：中午改成 11:00 必弹 lunch_choice（躺会儿/点外卖/约小茉莉/茶水间），
  // 由 workdayTick→goLunch→lunchHandler 排，不再走随机池，避免双弹。约见/外卖等逻辑都迁进 firePendingWake 的 lunch_* 分支。
  work_tea_restock: {
    id: 'work_tea_restock', label: '茶水间补货', event_type: 'work_event', npc: null,
    reason: '茶水间今天补了新的小面包、小蛋糕和饼干，咖啡机旁边也放了红茶和白茶',
    locations: ['公司 · 工位', '公司 · 茶水间'], activity_in: ['工作'], workday_only: true,
    time_ranges: [['09:00', '16:00']],
    probability: 0.16, cooldown_world_minutes: 480, once_per_day: true, npc_boost: false, wmHint: false,
    options: [
      { id: 1, label: '拿一块小蛋糕', effects_hint: [{ stat: 'satiety', direction: 'up', strength: 'small' }, { stat: 'mood', direction: 'up', strength: 'small' }], target_location: '公司 · 茶水间', target_activity: '吃小蛋糕' },
      { id: 2, label: '泡杯红茶', effects_hint: [{ stat: 'comfort', direction: 'up', strength: 'small' }, { stat: 'stress', direction: 'down', strength: 'tiny' }, { stat: 'focus', direction: 'up', strength: 'tiny' }], target_location: '公司 · 茶水间', target_activity: '泡茶' },
      { id: 3, label: '拿点饼干回工位', effects_hint: [{ stat: 'satiety', direction: 'up', strength: 'tiny' }, { stat: 'mood', direction: 'up', strength: 'tiny' }], target_location: '公司 · 茶水间', target_activity: '拿饼干' },
    ],
  },
};
