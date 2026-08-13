// 全局常量与魔数集中管理

export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
export const MONTHS = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月'
];

// 时间优先级相关魔数（单位：分钟）
export const EVENING_START = 18 * 60;       // 18:00 = 1080
export const EVENING_END = 22.5 * 60;       // 22:30 = 1350
export const OPTIMAL_EVENING = 19 * 60;     // 19:00 = 1140（最优时间点）
export const AFTERNOON_START = 14 * 60;     // 14:00 = 840
export const AFTERNOON_END = 17 * 60;       // 17:00 = 1020
export const MORNING_START = 9 * 60;        // 09:00 = 540
export const MORNING_END = 12 * 60;         // 12:00 = 720
