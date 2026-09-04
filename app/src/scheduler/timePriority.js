// 时间优先级评分（奖惩函数 v5.8）：晚上 > 下午 > 上午，分层不重叠
// 19:00 → 300 分（最优，v5.71 满分 200→300 同比例放大 ×1.5）
// 16:00-23:00 → 240-300 分（越接近 19:00 越高；16:00=255 / 16:30=262.5 / 17:00=270 / 19:00=300）
// 14:00-17:00 → 165-225 分（越接近 14:00 越高）
// 09:00-12:00 →  90-150 分（越接近 9:00 越高）
// 其他时段   → 15-45 分
// 整点 > 半点 > 整10分 > 整5分
import {
  EVENING_START, EVENING_END, OPTIMAL_EVENING,
  AFTERNOON_START, AFTERNOON_END,
  MORNING_START, MORNING_END
} from '../config/constants.js';
/**
 * 计算粒度奖励：整点 > 半点 > 整10分 > 整5分
 * 分钟为0 → +15（整点）
 * 分钟为30 → +10.5（半点）
 * 分钟为10/20/40/50 → +6（整10分）
 * 其他5分倍数 → +0
 */
function calculateGranularityBonus(minutesOfHour) {
  if (minutesOfHour === 0) return 15;
  if (minutesOfHour === 30) return 10.5;
  if (minutesOfHour % 10 === 0) return 6;
  return 0;
}

/**
 * 计算单个时间槽的优先级分数（惩罚/奖励合并函数）
 * 基础分 + 粒度奖励（整点+15/半点+10.5/整10分+6/整5分+0）
 * 晚上(16:00-23:00): 基础 240~300 + 奖励 0~15 = 240~315（越接近 19:00 越高）
 * 下午(14:00-17:00): 基础 165~225 + 奖励 0~15 = 165~240（越接近 14:00 越高）
 * 上午(09:00-12:00): 基础  90~150 + 奖励 0~15 =  90~165（越接近 09:00 越高）
 * 其它: 15~45 + 奖励 0~15 = 15~60
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

  // 晚上 16:00 ~ 23:00（v5.8）：越接近 19:00 越高（19:00=300，两端最低 240）
  if (slotStartMinutes >= EVENING_START && slotStartMinutes <= EVENING_END) {
    const distanceFromOptimal = Math.abs(slotStartMinutes - OPTIMAL_EVENING);
    const maxDistance = Math.max(OPTIMAL_EVENING - EVENING_START, EVENING_END - OPTIMAL_EVENING);
    const baseScore = 300 - (distanceFromOptimal / maxDistance) * 60;
    return baseScore + granularityBonus;
  }

  // 下午 14:00 ~ 17:00（不包含 17:00，17:00 起归晚间区间）：越接近 14:00 越高
  if (slotStartMinutes >= AFTERNOON_START && slotStartMinutes < AFTERNOON_END) {
    const progress = (slotStartMinutes - AFTERNOON_START) / (AFTERNOON_END - AFTERNOON_START);
    const baseScore = 225 - progress * 60;
    return baseScore + granularityBonus;
  }

  // 上午 09:00 ~ 12:00：越接近 09:00 越高
  if (slotStartMinutes >= MORNING_START && slotStartMinutes < MORNING_END) {
    const progress = (slotStartMinutes - MORNING_START) / (MORNING_END - MORNING_START);
    const baseScore = 150 - progress * 60;
    return baseScore + granularityBonus;
  }

  // 12:00-14:00 午间过渡
  if (slotStartMinutes >= MORNING_END && slotStartMinutes < AFTERNOON_START) {
    return 45 + granularityBonus;
  }

  // 其他时段
  if (slotStartMinutes < MORNING_START) {
    return 15 + granularityBonus;
  }

  return 30 + granularityBonus; // 23:00 之后
}