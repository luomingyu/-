// 单门课程排课：在目标日期内寻找最佳时间槽
// 综合考虑时间优先级和计划日期锚定，确保课程遵循 Z 规则分散方案
import { timeToMinutes, minutesToTime, durationToMinutes } from '../utils/dateUtils.js';
import { calculateTimePriorityScore } from './timePriority.js';
import { hasConflict, hasTeacherClassOnDate } from './scheduleContext.js';
import { EVENING_START, EVENING_END } from '../config/constants.js';

// 综合评分权重（v5.19：提升晚上排课优先级、降低分散度优先级）
// timeScore 权重 ×1→×3：同日期内晚上时段相对下午/上午的优势放大，晚上优先更稳固。
// planAnchorBonus 保持 ×10 主导日期选择（保住全局分散骨架），但当锚点日晚上放不下
// 课程时长时锚定奖励降级（见 tryScheduleCourse 评分阶段），课程转向邻日晚上 → 分散度让位。
// v5.65：移除 v5.10 槽位级间隔天数分散度奖励（calculateDispersionBonus）——后台真实数据
// 验证 100% 选中槽位为锚点全等锁定（slotMatchBonus+10000），该奖励从未改变任何选中结果，
// 分散语义由 v5.64 Z 规则方案评分唯一承载。
export const W_TIME = 3;        // 时间优先级（晚上 > 下午 > 上午）
export const W_ANCHOR = 10;     // 计划日期锚定（分散度规划日期）
export const W_PROGRESSION = 5; // 日期递增（课程体系顺序）

/**
 * 尝试为一门课程在目标日期列表中寻找最佳时间槽
 * 策略：先满足课程体系顺序 → 再按日期递增
 * 评分 = 计划日期锚定奖励 + 日期递增奖励 + 时间优先级
 * @param {Object} ctx 排课上下文
 * @param {Object} courseItem { classType, courseName, duration, originalIndex }
 * @param {string} teacher 师资
 * @param {string[]} targetDates 目标日期
 * @param {number} minGap 最小间隔（分钟）
 * @param {string|null} previousDate 前一门课程的日期（用于日期递增约束）
 * @param {string[]} allAvailableDates 所有可用日期（用于日期递增回退策略）
 * @param {Object|string|null} preferredSlot 分散方案锚点（v5.51：{date, startTime, endTime} 槽位，
 *                                            槽位完整可用时最高优先级锁定；startTime 为 null 或纯日期
 *                                            字符串时退化为按锚点日期评分）
 * @param {string|null} latestDate 日期上界（v5.34：后子表中位于合班课之前的普通课，须限定在合班课日期之前）
 * @param {boolean} earliestFirst 尽早优先（v5.34.1：合班课优先排早，避免被晚间时段偏好拖到月末，
 *                                 导致后续合班课/其他师资无日期可排）
 * @param {number} reserveAfter 本课后还需要排的同师资课程数（v5.34.2：含本课在内共需日期数，
 *                               排课时须保证本课之后仍有足够可用日期，否则后续课程将无日期可排）
 * @param {string|null} earliestDate 日期下界（v5.83，先合后分侧：位于已定日期合班课之后的普通课，
 *                                   限定在该合班课日期后一天之后排课）
 * @param {boolean} allowSameDay 兜底放宽（仅第三轮调用时为 true）：忽略「同一师资+同一班级每天
 *                               只能排一节课」整日封锁，允许同天不同时段再排一节；此时仍按
 *                               minGap（师资间隔，放宽轮取 AVAIL_REMOVE_PAD_TEACHER）与
 *                               CLASS_MIN_GAP（班级间隔）判定时间窗冲突。
 * @returns {{date, startTime, endTime} | null}
 */
export function tryScheduleCourse(ctx, courseItem, teacher, targetDates, minGap, previousDate = null, allAvailableDates = [], preferredSlot = null, latestDate = null, earliestFirst = false, reserveAfter = 1, earliestDate = null, allowSameDay = false) {
  const { classType, duration, startDate, endDate } = courseItem;
  const durationMinutes = durationToMinutes(duration);
  // v5.51：解析锚点——对象槽位提取日期（时段可能为空），兼容旧的纯日期字符串
  const preferredDate = preferredSlot
    ? (typeof preferredSlot === 'string' ? preferredSlot : (preferredSlot.date || null))
    : null;
  const preferredSlotTime = preferredSlot && typeof preferredSlot === 'object' && preferredSlot.startTime ? preferredSlot : null;

  if (!ctx.teacherScheduleByDate[teacher]) ctx.teacherScheduleByDate[teacher] = {};
  if (!ctx.classScheduleByDate[classType]) ctx.classScheduleByDate[classType] = {};

  // 课程排课区间约束：仅允许在 [起始日期, 终止日期] 之间排课（未填写则不限）
  const inCourseRange = (date) => {
    if (startDate && date < startDate) return false;
    if (endDate && date > endDate) return false;
    return true;
  };
  const rangeTargetDates = targetDates.filter(inCourseRange);
  if (rangeTargetDates.length === 0) return null;
  // 日期窗口硬约束（v5.31 下界 / v5.34 上界 / v5.83 合班课日期下界）：
  //   下界：存在前一门课程日期时，只允许排 >= prevDate 的日期（课程体系顺序）
  //   上界：后子表中位于合班课之前的普通课，须限定在合班课日期之前
  //   合班课日期下界：先合后分侧中位于已定日期合班课之后的普通课，只允许排 >= earliestDate 的日期
  const effectiveTargetDates = rangeTargetDates.filter(d => {
    if (previousDate && d < previousDate) return false;
    if (latestDate && d > latestDate) return false;
    if (earliestDate && d < earliestDate) return false;
    return true;
  });
  if (effectiveTargetDates.length === 0) return null;

  // 详细日志（SCHEDULE_DEBUG=1 时输出）：定位算法在哪个决策点出错/次优
  if (!!process.env.SCHEDULE_DEBUG) {
    console.log(`[trySchedule] ${courseItem.courseName} [${classType}] 师资=${teacher} duration=${duration}`);
    const preferredLabel = preferredSlot ? (preferredSlot.date + (preferredSlot.startTime ? ` ${preferredSlot.startTime}-${preferredSlot.endTime}` : '')) : 'null';
    console.log(`  preferred=${preferredLabel} previousDate=${previousDate} latestDate=${latestDate} earliestFirst=${earliestFirst} reserveAfter=${reserveAfter}`);
    console.log(`  课程区间: ${startDate || '不限'} ~ ${endDate || '不限'}`);
    console.log(`  区间内目标日期(${rangeTargetDates.length}): ${rangeTargetDates.join(', ')}`);
    console.log(`  有效目标日期(${effectiveTargetDates.length}): ${effectiveTargetDates.join(', ')}`);
  }

  // 计算已占用的日期（排除"师资+班级"当天已有课程的日期，硬约束）
  // allowSameDay=true（兜底放宽）：不把整日封锁计入占用，保留同天候选交由后续评分
  const occupiedDates = new Set();
  if (!allowSameDay) {
    for (const date of effectiveTargetDates) {
      if (hasTeacherClassOnDate(ctx, { teacher, classType, date })) {
        occupiedDates.add(date);
      }
    }
  }

  // 真正可选的日期（排除已占用日期）
  const availableTargetDates = effectiveTargetDates.filter(d => !occupiedDates.has(d));

  // v5.34.2 日期预算硬约束：本课后还有 reserveAfter-1 门同师资课程需要新日期。
  // 若候选日期之后可用日期数不足（< reserveAfter-1），禁选该日期——否则本课会占掉
  // 后续课程唯一可用的日期，导致后续课程排不上。仅对 reserveAfter > 1 生效。
  // v5.50：reserveAfter 由调用方向下传前已按「排课区间有交集」过滤（区间完全错开的
  // 后续课程不计入），因此这里的统计基准（本课的区间内可用日期）与预算口径一致。
  const sortedAvailDates = [...availableTargetDates].sort((a, b) => a.slice(5).localeCompare(b.slice(5)));
  const canReserveAfter = (date) => {
    if (reserveAfter <= 1) return true;
    let laterCount = 0;
    for (const d of sortedAvailDates) {
      if (d.slice(5) > date.slice(5)) laterCount++;
    }
    return laterCount >= reserveAfter - 1;
  };

  // 计算第一个可选日期（用于第一门课的起始点）
  const sortedAvailableDates = [...availableTargetDates].sort((a, b) => {
    return a.slice(5).localeCompare(b.slice(5));
  });
  const firstAvailableDate = sortedAvailableDates.length > 0 ? sortedAvailableDates[0] : null;

  // 收集所有可用时间槽
  const allCandidates = [];

  for (const targetDate of effectiveTargetDates) {
    // 硬约束上提：同一天同一师资同一班级只能排一节课，直接跳过整个日期
    // 避免对该日期的所有时间槽重复调用 hasConflict
    // allowSameDay=true（兜底放宽）：不跳过，交给下方 hasConflict 按时间窗（含 minGap）判定
    if (!allowSameDay && hasTeacherClassOnDate(ctx, { teacher, classType, date: targetDate })) {
      if (!!process.env.SCHEDULE_DEBUG) console.log(`    跳过日期 ${targetDate}（当天师资+班级已有课程，硬约束）`);
      continue;
    }

    // v5.34.2 硬约束：日期预算不足（本课排此日后，后续同师资课程无足够日期）则禁选该日期
    if (!canReserveAfter(targetDate)) {
      if (!!process.env.SCHEDULE_DEBUG) console.log(`    跳过日期 ${targetDate}（日期预算不足：其后可用日期 < ${reserveAfter - 1}）`);
      continue;
    }

    const dateAvailabilities = ctx.monthAvailability.filter(
      a => a.date === targetDate && a.teacher === teacher
    );
    if (dateAvailabilities.length === 0) continue;

    const dateDay = parseInt(targetDate.slice(-2), 10);

    for (const avail of dateAvailabilities) {
      const availStart = timeToMinutes(avail.startTime);
      const availEnd = timeToMinutes(avail.endTime);

      for (let offset = 0; offset <= availEnd - availStart - durationMinutes; offset += 5) {
        const slotStart = availStart + offset;
        const slotEnd = slotStart + durationMinutes;
        if (slotEnd > availEnd) break;

        if (hasConflict(ctx, { teacher, classType, date: targetDate, slotStart, slotEnd, minGap, allowSameDay })) {
          continue;
        }

        const timeScore = calculateTimePriorityScore(slotStart);
        if (timeScore < 0) continue; // 过滤非5分钟时间

        // 0. 计划日期锚定奖励（分散度，权重×10）
        // 预计算分散方案的日期已升序排列且分散度最优，优先使用可避免回绕
        // v5.19：锚定权重保持 ×10 保住全局分散骨架，
        //         但锚点日晚上放不下课程时长时降级（见下方评分阶段）
        let planAnchorBonus = 0;
        if (preferredDate) {
          if (targetDate === preferredDate) {
            planAnchorBonus = 100;
          } else {
            // 距离计划日期越近奖励越高（用于计划日期冲突时的近邻回退）
            const gap = Math.abs(calculateDateGap(targetDate, preferredDate));
            if (gap === 0) planAnchorBonus = 100;
            else if (gap <= 1) planAnchorBonus = 70;
            else if (gap <= 3) planAnchorBonus = 50;
            else if (gap <= 7) planAnchorBonus = 30;
            else planAnchorBonus = 10;
          }
        }

        // 1. 日期递增奖励（次高优先级，权重×5）
        // 如果有前一门课的日期，鼓励当前日期 >= 前一门课的日期
        // 如果是第一门课（无previousDate），鼓励选择最早的可选日期
        let progressionBonus = 0;
        if (previousDate) {
          progressionBonus = calculateProgressionBonus(targetDate, previousDate, allAvailableDates, availableTargetDates, earliestFirst);
        } else if (firstAvailableDate) {
          // 第一门课：鼓励选择最早的可选日期
          if (targetDate === firstAvailableDate) {
            progressionBonus = 100;
          } else {
            const gap = calculateDateGap(targetDate, firstAvailableDate);
            if (gap > 0 && gap <= 3) progressionBonus = 80;
            else if (gap <= 7) progressionBonus = 60;
            else progressionBonus = 40;
          }
        }

        // 记录组件分数，综合评分在收集完成后统一计算（需先判定锚定降级）
        allCandidates.push({
          date: targetDate,
          startTime: minutesToTime(slotStart),
          endTime: minutesToTime(slotEnd),
          timeScore,
          planAnchorBonus,
          progressionBonus,
          isEvening: slotStart >= EVENING_START,
          dateDay
        });
      }
    }
  }

  // 收集完成后统一评分
  // v5.19：锚定降级——若锚点日已无晚上时间槽能放得下该课程时长（如晚间被其他班占用、
  // 只剩下午可选），则锚定奖励降为最低档（10 分），让课程优先转向相邻日期（如次日晚间）
  // 的晚上时段，而非被迫排在锚点日当天的下午。实现"晚上排课优先级提升、分散度让位"。
  const datesWithEveningCandidate = new Set(
    allCandidates.filter(c => c.isEvening).map(c => c.date)
  );
  const hasAnyEveningCandidate = datesWithEveningCandidate.size > 0;

  for (const c of allCandidates) {
    let anchor = c.planAnchorBonus;
    if (preferredDate && c.date === preferredDate && !datesWithEveningCandidate.has(c.date)) {
      anchor = 10; // 锚点日晚上放不下课程时长 → 锚定奖励降级
    }
    // v5.43 晚间守护：课程有整体分散锚点且系统中存在晚间候选时，
    // 候选日当天只能排白天（无晚间时段，如 09:00-18:00 空闲）的时段施加强惩罚，
    // 引导课程落到邻近有晚间时段的日期（如 23 日 19:00），
    // 避免锚点日被班级/师资占用后近邻回退到「无晚间时段日期的白天」
    // （如 21 日 14:00-16:30）形成不合常理的白天排课。
    // 强度须压过「尽早优先」递增奖励（300 分）与晚间时间分差（100 分）。
    let eveningGuardPenalty = 0;
    if (preferredDate && hasAnyEveningCandidate && !c.isEvening && !datesWithEveningCandidate.has(c.date)) {
      eveningGuardPenalty = 500;
    }
    // v5.51：锚点槽位精确匹配（日期+起止时段全等）→ 最高优先级锁定。
    // 模拟排课已验证该槽位遵循师资-班级空闲表且与同表其他课互斥；主排课时该槽
    // 仍可行（未被更早排入的其他课占用）则直接采纳，被占用/被硬约束过滤则自然
    // 滑落到下方评分逻辑（不会硬锁导致失败）。
    const slotMatchBonus = (preferredSlotTime && c.date === preferredSlotTime.date && c.startTime === preferredSlotTime.startTime && c.endTime === preferredSlotTime.endTime) ? 10000 : 0;
    // 综合评分：时间优先级（权重×3，晚上优先增强） + 计划日期锚定（权重×10） + 日期递增（权重×5） + 锚点槽位锁定
    c.score = c.timeScore * W_TIME + anchor * W_ANCHOR + c.progressionBonus * W_PROGRESSION - eveningGuardPenalty + slotMatchBonus;
    // 记录实际使用的锚定分与晚间守护惩罚（供详细日志展示）
    c.anchorUsed = anchor;
    c.guardPenalty = eveningGuardPenalty;
    c.slotMatchUsed = slotMatchBonus;
  }

  // 如果有候选时间槽，选择评分最高的
  if (allCandidates.length > 0) {
    allCandidates.sort((a, b) => b.score - a.score);
    const best = allCandidates[0];
    // 详细日志：按日期聚合取最高分候选，打印 Top5 得分明细，定位选中槽为何胜出/次优
    if (!!process.env.SCHEDULE_DEBUG) {
      const byDate = new Map();
      for (const c of allCandidates) {
        if (!byDate.has(c.date) || c.score > byDate.get(c.date).score) byDate.set(c.date, c);
      }
      const top = [...byDate.values()].sort((a, b) => b.score - a.score).slice(0, 5);
      console.log(`  候选得分明细（每日期取最高分候选，Top${top.length}）:`);
      for (const c of top) {
        console.log(`    ${c.date} ${c.startTime}-${c.endTime} score=${c.score.toFixed(1)} | time=${c.timeScore}×${W_TIME}=${(c.timeScore * W_TIME).toFixed(1)} anchor=${c.anchorUsed}×${W_ANCHOR}=${(c.anchorUsed * W_ANCHOR).toFixed(1)} prog=${c.progressionBonus}×${W_PROGRESSION}=${(c.progressionBonus * W_PROGRESSION).toFixed(1)} guard=-${c.guardPenalty}${c.slotMatchUsed ? ' slotL=⚓' : ''}${c.isEvening ? '' : '(非晚间)'}`);
      }
      console.log(`  → 选中: ${best.date} ${best.startTime}-${best.endTime}`);
    }
    return {
      date: best.date,
      startTime: best.startTime,
      endTime: best.endTime
    };
  }

  return null;
}

/**
 * 计算日期递增奖励
 * 确保课程按日期递增排列
 * 当没有递增日期可选时，回退到最早的未占用日期（从头开始新的递增序列）
 * 日期格式：MM-DD（如 09-30, 10-01）
 * @param {string} currentDate 当前候选日期
 * @param {string} previousDate 前一门课程的日期
 * @param {string[]} availableDates 所有可用日期（用于判断是否有递增日期）
 * @param {string[]} targetDates 实际可选日期（用于回退策略计算最近日期）
 * @param {boolean} earliestFirst 尽早优先（v5.34.1：合班课优先排早）
 * @returns {number} 日期递增奖励分
 */
function calculateProgressionBonus(currentDate, previousDate, availableDates = [], targetDates = [], earliestFirst = false) {
  // 使用完整日期字符串（MM-DD）进行比较
  const currentKey = currentDate.slice(5);
  const previousKey = previousDate.slice(5);

  // 使用实际可选日期来判断是否有递增日期
  const effectiveDates = targetDates.length > 0 ? targetDates : availableDates;

  // 对实际可选日期排序
  const sortedDates = [...effectiveDates].sort((a, b) => {
    return a.slice(5).localeCompare(b.slice(5));
  });

  // 检查是否有日期在 previousDate 之后可选
  const laterDates = sortedDates.filter(d => {
    return d.slice(5) > previousKey;
  });

  if (laterDates.length > 0) {
    // 有递增日期可选
    const gap = calculateDateGap(currentDate, previousDate);
    if (gap > 0) {
      if (earliestFirst) {
        // v5.34.1：合班课尽早优先——gap 越小得分越高，
        // 且级差（每后移 1 天扣 30 分 × 权重 5 = 150 分）须压过晚间时段偏好
        // （晚间 vs 下午 timeScore 差 90 分 × 权重 3 = 270 分，v5.71 满分 200→300 后同比例放大），
        // 否则合班课仍会被拖到月末，导致后续合班课或同师资其他课程无日期可排。
        // gap=2 满分（既尽早又与上一门间隔两天，分散度更好），gap=1 次之（紧贴前课）。
        if (gap <= 1) return 95;
        if (gap <= 2) return 100;
        if (gap <= 3) return 60;
        if (gap <= 4) return 30;
        return 0; // 尽早优先下宁可不奖励
      }
      // 适中间隔(gap=3)奖励最高，兼顾日期递增和分散度
      // gap=1-2 太近（分散度差），给较低奖励
      // gap=3-7 适中（递增且分散），给高奖励
      // gap>7 太远，给较低奖励
      if (gap <= 1) return 70;   // 太近，分散度差
      if (gap <= 2) return 85;   // 较近
      if (gap <= 3) return 100;  // 最佳间隔
      if (gap <= 4) return 95;
      if (gap <= 5) return 90;
      if (gap <= 6) return 85;
      if (gap <= 7) return 80;
      return 60; // gap > 7，太远
    } else {
      return 0;
    }
  } else {
    // 没有递增日期可选，回退策略
    // 选择最早的未占用日期（从头开始新的递增序列）
    // 而不是选择距离 previousDate 最近的日期，避免插入到中间课程之间造成逆序
    
    // 找到所有可选日期中最早的
    const earliestDate = sortedDates.length > 0 ? sortedDates[0] : null;
    
    if (!earliestDate) return 0;
    
    // 如果当前日期是最早的日期，给最高分
    if (currentDate === earliestDate) {
      return 100;
    }
    
    // 如果当前日期在最早日期之后，按距离递减
    const gapFromEarliest = calculateDateGap(currentDate, earliestDate);
    if (gapFromEarliest > 0 && gapFromEarliest <= 3) return 80;
    if (gapFromEarliest <= 7) return 60;
    return 40;
  }
}

/**
 * 计算两个日期之间的间隔（天）
 * 日期格式：YYYY-MM-DD
 */
function calculateDateGap(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.round((d1 - d2) / (1000 * 60 * 60 * 24));
}
