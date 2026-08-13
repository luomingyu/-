// 排课算法相关常量

/** 建议的课程间隔（分钟） */
export const MIN_GAP = 10;
/** 回退课程间隔（分钟，无法满足 MIN_GAP 时使用） */
export const FALLBACK_GAP = 5;
/** 无间隔（最后回退） */
export const NO_GAP = 0;
/** 同班级课程最小间隔（分钟） */
export const CLASS_MIN_GAP = 5;

/**
 * 六级排课策略（v5.10 恢复，保留分散度优化）
 * 结合 useEveningOnly 筛选时间范围，保留 trySchedule.js 中的分散度奖励机制
 *
 * Level 1: 仅晚上 + 10 分钟间隔
 * Level 2: 仅晚上 + 5 分钟间隔
 * Level 3: 仅晚上 + 无间隔
 * Level 4: 所有空闲时间 + 10 分钟间隔
 * Level 5: 所有空闲时间 + 5 分钟间隔
 * Level 6: 所有空闲时间 + 无间隔
 *
 * 注：trySchedule.js 中的 calculateDispersionBonus 分散度奖励机制在所有 Level 中均生效
 */
export const SCHEDULE_LEVELS = [
  { name: '仅晚上+10分钟间隔', gap: MIN_GAP, useEveningOnly: true },
  { name: '仅晚上+5分钟间隔', gap: FALLBACK_GAP, useEveningOnly: true },
  { name: '仅晚上+无间隔', gap: NO_GAP, useEveningOnly: true },
  { name: '所有空闲+10分钟间隔', gap: MIN_GAP, useEveningOnly: false },
  { name: '所有空闲+5分钟间隔', gap: FALLBACK_GAP, useEveningOnly: false },
  { name: '所有空闲+无间隔', gap: NO_GAP, useEveningOnly: false }
];
