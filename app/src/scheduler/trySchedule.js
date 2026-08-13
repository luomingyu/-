// 单门课程排课：在目标日期内寻找最佳时间槽
// 综合考虑时间优先级和分散度，确保课程分散到整个月
import { timeToMinutes, minutesToTime, durationToMinutes } from '../utils/dateUtils.js';
import { calculateTimePriorityScore } from './timePriority.js';
import { hasConflict, hasTeacherClassOnDate } from './scheduleContext.js';

/**
 * 尝试为一门课程在目标日期列表中寻找最佳时间槽
 * 策略：先满足课程体系顺序 → 再按日期递增 → 最后优化分散度
 * 评分 = 计划日期锚定奖励 + 日期递增奖励 + 时间优先级 + 分散度奖励
 * @param {Object} ctx 排课上下文
 * @param {Object} courseItem { classType, courseName, duration, originalIndex }
 * @param {string} teacher 师资
 * @param {string[]} targetDates 目标日期
 * @param {number} minGap 最小间隔（分钟）
 * @param {boolean} skipDispersion 是否跳过分散度计算（用于补排）
 * @param {string|null} previousDate 前一门课程的日期（用于日期递增约束）
 * @param {string[]} allAvailableDates 所有可用日期（用于日期递增回退策略）
 * @param {string|null} preferredDate 预计算分散方案中该课程的锚定日期（升序，避免回绕）
 * @returns {{date, startTime, endTime} | null}
 */
export function tryScheduleCourse(ctx, courseItem, teacher, targetDates, minGap, skipDispersion = false, previousDate = null, allAvailableDates = [], preferredDate = null) {
  const { classType, duration } = courseItem;
  const durationMinutes = durationToMinutes(duration);

  if (!ctx.teacherScheduleByDate[teacher]) ctx.teacherScheduleByDate[teacher] = {};
  if (!ctx.classScheduleByDate[classType]) ctx.classScheduleByDate[classType] = {};

  // 计算已占用的日期（排除"师资+班级"当天已有课程的日期，硬约束）
  const occupiedDates = new Set();
  for (const date of targetDates) {
    if (hasTeacherClassOnDate(ctx, { teacher, classType, date })) {
      occupiedDates.add(date);
    }
  }

  // 真正可选的日期（排除已占用日期）
  const availableTargetDates = targetDates.filter(d => !occupiedDates.has(d));

  // 计算第一个可选日期（用于第一门课的起始点）
  const sortedAvailableDates = [...availableTargetDates].sort((a, b) => {
    return a.slice(5).localeCompare(b.slice(5));
  });
  const firstAvailableDate = sortedAvailableDates.length > 0 ? sortedAvailableDates[0] : null;

  // 收集所有可用时间槽
  const allCandidates = [];

  for (const targetDate of targetDates) {
    // 硬约束上提：同一天同一师资同一班级只能排一节课，直接跳过整个日期
    // 避免对该日期的所有时间槽重复调用 hasConflict
    if (hasTeacherClassOnDate(ctx, { teacher, classType, date: targetDate })) {
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

        if (hasConflict(ctx, { teacher, classType, date: targetDate, slotStart, slotEnd, minGap })) {
          continue;
        }

        const timeScore = calculateTimePriorityScore(slotStart);
        if (timeScore < 0) continue; // 过滤非5分钟时间

        // 0. 计划日期锚定奖励（最高优先级，权重×10）
        // 预计算分散方案的日期已升序排列且分散度最优，优先使用可避免回绕
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
          progressionBonus = calculateProgressionBonus(targetDate, previousDate, allAvailableDates, availableTargetDates);
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

        // 2. 日期分散度奖励
        const dispersionBonus = skipDispersion
          ? 0
          : calculateDispersionBonus(ctx, targetDate, teacher, classType);

        // 综合评分：计划日期锚定（权重×10） + 日期递增（权重×5） + 时间优先级 + 分散度
        // 优先级：计划日期锚定 > 日期递增 > 时间优先级 ≈ 分散度
        const totalScore = planAnchorBonus * 10 + progressionBonus * 5 + timeScore + dispersionBonus;

        allCandidates.push({
          date: targetDate,
          startTime: minutesToTime(slotStart),
          endTime: minutesToTime(slotEnd),
          score: totalScore,
          timeScore,
          progressionBonus,
          dispersionBonus,
          dateDay
        });
      }
    }
  }

  // 如果有候选时间槽，选择评分最高的
  if (allCandidates.length > 0) {
    allCandidates.sort((a, b) => b.score - a.score);
    const best = allCandidates[0];
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
 * @returns {number} 日期递增奖励分
 */
function calculateProgressionBonus(currentDate, previousDate, availableDates = [], targetDates = []) {
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

/**
 * 计算日期分散度奖励（仅针对同一师资+同一班级的已排课程）
 * 分散度只在"师资+班级"维度内生效，不同师资或不同班级之间不需要分散
 * @param {Object} ctx 排课上下文
 * @param {string} date 目标日期
 * @param {string} teacher 师资
 * @param {string} classType 班级
 * @returns {number} 分散度奖励分
 */
function calculateDispersionBonus(ctx, date, teacher, classType) {
  const dateDay = parseInt(date.slice(-2), 10);
  const existingDates = [];

  // 从已排课程中筛选同一师资+同一班级的课程日期
  // 这样可以确保分散度只针对"师资+班级"维度
  for (const course of ctx.scheduledCourses) {
    if (course.teacher === `${teacher}老师` && course.classType === classType) {
      const courseDateDay = parseInt(course.date.slice(-2), 10);
      existingDates.push(courseDateDay);
    }
  }

  // 也检查 classScheduleByDate 中的记录
  const classSchedule = ctx.classScheduleByDate[classType];
  if (classSchedule) {
    for (const d of Object.keys(classSchedule)) {
      const slots = classSchedule[d];
      // 检查该班级在该日期是否有该师资的课
      const hasTeacherCourse = ctx.teacherScheduleByDate[teacher]?.[d]?.length > 0;
      if (hasTeacherCourse) {
        existingDates.push(parseInt(d.slice(-2), 10));
      }
    }
  }

  if (existingDates.length === 0) {
    // 第一节课，给中间日期一些奖励
    // 中间日期（10-20号）奖励更高，鼓励覆盖整个月
    if (dateDay >= 10 && dateDay <= 20) return 30;
    if (dateDay >= 5 && dateDay <= 25) return 15;
    return 0;
  }

  // 计算与已有日期的最小间隔
  let minGap = Infinity;
  for (const existingDay of existingDates) {
    const gap = Math.abs(dateDay - existingDay);
    if (gap < minGap) minGap = gap;
  }

  // 间隔越大，奖励越高
  // 间隔 >= 10天：+100分（强奖励，鼓励跨周分散）
  // 间隔 >= 7天：+80分
  // 间隔 >= 5天：+60分
  // 间隔 >= 3天：+40分
  // 间隔 >= 1天：+20分
  if (minGap >= 10) return 100;
  if (minGap >= 7) return 80;
  if (minGap >= 5) return 60;
  if (minGap >= 3) return 40;
  if (minGap >= 1) return 20;
  return 0;
}
