// 时间优先级评分：晚上 > 下午 > 上午
// 19:00 → 200 分（最优）
// 18:00-22:30 → 150-200 分（越接近 19:00 越高）
// 14:00-17:00 → 100-150 分（越接近 14:00 越高）
// 09:00-12:00 → 50-90 分（越接近 9:00 越高）
// 其他时段   → 20-30 分
// 整点 > 半点 > 整10分 > 整5分
import {
  EVENING_START, EVENING_END, OPTIMAL_EVENING,
  AFTERNOON_START, AFTERNOON_END,
  MORNING_START, MORNING_END
} from '../config/constants.js';
import { timeToMinutes } from '../utils/dateUtils.js';

/**
 * 计算粒度奖励：整点 > 半点 > 整10分 > 整5分
 * 分钟为0 → +10（整点）
 * 分钟为30 → +7（半点）
 * 分钟为10/20/40/50 → +4（整10分）
 * 其他5分倍数 → +0
 */
function calculateGranularityBonus(minutesOfHour) {
  if (minutesOfHour === 0) return 10;
  if (minutesOfHour === 30) return 7;
  if (minutesOfHour % 10 === 0) return 4;
  return 0;
}

/**
 * 计算单个时间槽的优先级分数
 * 基础分 + 粒度奖励（整点+10/半点+7/整10分+4/整5分+0）
 * 晚上(18:00-22:30): 基础 140~190 + 奖励 0~10 = 140~200
 * 下午(14:00-17:00): 基础 90~140 + 奖励 0~10 = 90~150
 * 上午(09:00-12:00): 基础 40~80 + 奖励 0~10 = 40~90
 * 其它: 10~30 + 奖励 0~10 = 10~40
 * @param {number} slotStartMinutes - 必须是5分钟的整数倍
 * @returns {number} 分数，非5分钟时间返回 -1
 */
export function calculateTimePriorityScore(slotStartMinutes) {
  // 不可用非整5分时间
  if (slotStartMinutes % 5 !== 0) {
    return -1;
  }

  const minutesOfHour = slotStartMinutes % 60;
  const granularityBonus = calculateGranularityBonus(minutesOfHour);

  // 晚上 18:00 ~ 22:30：越接近 19:00 越高
  if (slotStartMinutes >= EVENING_START && slotStartMinutes <= EVENING_END) {
    const distanceFromOptimal = Math.abs(slotStartMinutes - OPTIMAL_EVENING);
    const maxDistance = Math.max(OPTIMAL_EVENING - EVENING_START, EVENING_END - OPTIMAL_EVENING);
    const baseScore = 190 - (distanceFromOptimal / maxDistance) * 50;
    return baseScore + granularityBonus;
  }

  // 下午 14:00 ~ 17:00：越接近 14:00 越高
  if (slotStartMinutes >= AFTERNOON_START && slotStartMinutes <= AFTERNOON_END) {
    const progress = (slotStartMinutes - AFTERNOON_START) / (AFTERNOON_END - AFTERNOON_START);
    const baseScore = 140 - progress * 50;
    return baseScore + granularityBonus;
  }

  // 上午 09:00 ~ 12:00：越接近 09:00 越高
  if (slotStartMinutes >= MORNING_START && slotStartMinutes < MORNING_END) {
    const progress = (slotStartMinutes - MORNING_START) / (MORNING_END - MORNING_START);
    const baseScore = 80 - progress * 40;
    return baseScore + granularityBonus;
  }

  // 12:00-14:00 午间过渡
  if (slotStartMinutes >= MORNING_END && slotStartMinutes < AFTERNOON_START) {
    return 30 + granularityBonus;
  }

  // 17:00-18:00 傍晚过渡
  if (slotStartMinutes >= AFTERNOON_END && slotStartMinutes < EVENING_START) {
    return 30 + granularityBonus;
  }

  // 其他时段
  if (slotStartMinutes < MORNING_START) {
    return 10 + granularityBonus;
  }

  return 20 + granularityBonus; // 22:30 之后
}

/** 该日期的空闲时间是否覆盖晚上（18:00 之后） */
export function hasEveningTime(dateAvailabilities) {
  for (const avail of dateAvailabilities) {
    const start = timeToMinutes(avail.startTime);
    const end = timeToMinutes(avail.endTime);
    if (start < EVENING_START && end > EVENING_START) {
      return true;
    }
  }
  return false;
}

/** 计算某日期可放下课程时的最高时间优先级分数 */
export function calculateDatePriorityScore(dateAvailabilities, durationMinutes) {
  let maxScore = 0;
  for (const avail of dateAvailabilities) {
    const availStart = timeToMinutes(avail.startTime);
    const availEnd = timeToMinutes(avail.endTime);
    for (let offset = 0; offset <= availEnd - availStart - durationMinutes; offset += 5) {
      const slotStart = availStart + offset;
      const score = calculateTimePriorityScore(slotStart);
      if (score > maxScore) {
        maxScore = score;
      }
    }
  }
  return maxScore;
}
