// 排课过程可变上下文：封装师资/班级日程映射，避免闭包捕获
import { timeToMinutes, minutesToTime } from '../utils/dateUtils.js';
import { CLASS_MIN_GAP } from './constants.js';

/**
 * 创建排课上下文
 * @param {Array} monthAvailability 当月空闲时间
 */
export function createScheduleContext(monthAvailability) {
  return {
    monthAvailability,
    teacherScheduleByDate: {}, // [teacher][date] = [{startTime, endTime}]
    classScheduleByDate: {},   // [classType][date] = [{startTime, endTime}]
    // 硬约束：每天只能排某个师资某个班级一节课
    // [teacher][classType][date] = count
    teacherClassScheduleByDate: {},
    scheduledCourses: [],      // 已排课程结果
    dayCourseCounts: {}        // [date] = count
  };
}

/** 将成功排课的时间槽注册到上下文 */
export function registerSlot(ctx, { teacher, classType, date, startTime, endTime }) {
  if (!ctx.teacherScheduleByDate[teacher]) ctx.teacherScheduleByDate[teacher] = {};
  if (!ctx.teacherScheduleByDate[teacher][date]) ctx.teacherScheduleByDate[teacher][date] = [];
  ctx.teacherScheduleByDate[teacher][date].push({ startTime, endTime });

  if (!ctx.classScheduleByDate[classType]) ctx.classScheduleByDate[classType] = {};
  if (!ctx.classScheduleByDate[classType][date]) ctx.classScheduleByDate[classType][date] = [];
  ctx.classScheduleByDate[classType][date].push({ startTime, endTime });

  // 注册"师资+班级+日期"硬约束（计数）
  if (!ctx.teacherClassScheduleByDate[teacher]) ctx.teacherClassScheduleByDate[teacher] = {};
  if (!ctx.teacherClassScheduleByDate[teacher][classType]) ctx.teacherClassScheduleByDate[teacher][classType] = {};
  ctx.teacherClassScheduleByDate[teacher][classType][date] =
    (ctx.teacherClassScheduleByDate[teacher][classType][date] || 0) + 1;

  ctx.dayCourseCounts[date] = (ctx.dayCourseCounts[date] || 0) + 1;
}

/**
 * 判断某天是否已排过"某师资+某班级"的课程（硬约束：每天只能排某个师资某个班级一节课）
 * @returns {boolean} true 表示该天已有该师资该班级的课程（冲突）
 */
export function hasTeacherClassOnDate(ctx, { teacher, classType, date }) {
  return (ctx.teacherClassScheduleByDate?.[teacher]?.[classType]?.[date] || 0) >= 1;
}

/** 校验某时间槽是否与已有课程冲突（师资间隔 minGap + 班级间隔 CLASS_MIN_GAP + 师资班级每天一节） */
export function hasConflict(ctx, { teacher, classType, date, slotStart, slotEnd, minGap }) {
  // 硬约束兜底：同一天同一师资同一班级只能排一节课
  if (hasTeacherClassOnDate(ctx, { teacher, classType, date })) {
    return true;
  }

  const existingTeacherCourses = ctx.teacherScheduleByDate[teacher]?.[date] || [];
  for (const e of existingTeacherCourses) {
    const eStart = timeToMinutes(e.startTime);
    const eEnd = timeToMinutes(e.endTime);
    if (!(slotEnd + minGap <= eStart || slotStart - minGap >= eEnd)) {
      return true;
    }
  }

  const existingClassCourses = ctx.classScheduleByDate[classType]?.[date] || [];
  for (const e of existingClassCourses) {
    const eStart = timeToMinutes(e.startTime);
    const eEnd = timeToMinutes(e.endTime);
    if (!(slotEnd + CLASS_MIN_GAP <= eStart || slotStart - CLASS_MIN_GAP >= eEnd)) {
      return true;
    }
  }

  return false;
}

/**
 * 判断某师资在某日是否还存在「任意」可放下指定时长课程的时间槽
 * 用于分散方案规划阶段剔除已被其他师资/班级占满的日期（跨师资班级冲突感知）
 * 采用最宽松判定（minGap=0，仅要求时间不重叠），保守地只剔除完全不可行的日期
 * @param {Object} ctx 排课上下文
 * @param {Object} p { teacher, classType, date, durationMinutes }
 * @returns {boolean} true 表示该日至少还有一个可用时间槽
 */
export function hasAnyFeasibleSlot(ctx, { teacher, classType, date, durationMinutes }) {
  // 硬约束：该师资该班级当天已排过课 → 不可再排
  if (hasTeacherClassOnDate(ctx, { teacher, classType, date })) {
    return false;
  }
  const dateAvailabilities = ctx.monthAvailability.filter(
    a => a.date === date && a.teacher === teacher
  );
  for (const avail of dateAvailabilities) {
    const availStart = timeToMinutes(avail.startTime);
    const availEnd = timeToMinutes(avail.endTime);
    for (let offset = 0; offset <= availEnd - availStart - durationMinutes; offset += 5) {
      const slotStart = availStart + offset;
      const slotEnd = slotStart + durationMinutes;
      if (slotEnd > availEnd) break;
      if (!hasConflict(ctx, { teacher, classType, date, slotStart, slotEnd, minGap: 0 })) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 构建师资-班级空闲时间表：从师资空闲时间中减去班级课程时间表中已占用的时段
 * 班级课程时间表包含该班级所有已排课程（含其他师资），确保新排课程不与班级已有课程冲突
 *
 * 算法：对每个空闲时间段，用班级已占时段（含 CLASS_MIN_GAP 缓冲）做差集，返回剩余碎片
 *
 * @param {Array} monthAvailability 所有师资空闲时间
 * @param {string} teacher 师资名
 * @param {string} classType 班级
 * @param {Object} ctx 排课上下文（含 classScheduleByDate）
 * @returns {Array} 过滤后的空闲时间列表（仅包含未被班级占用的时段）
 */
export function buildTeacherClassAvailability(monthAvailability, teacher, classType, ctx) {
  const teacherAvail = monthAvailability.filter(a => a.teacher === teacher);
  const classSchedule = ctx.classScheduleByDate[classType] || {};

  const result = [];
  for (const avail of teacherAvail) {
    const availStart = timeToMinutes(avail.startTime);
    const availEnd = timeToMinutes(avail.endTime);

    const classCourses = classSchedule[avail.date] || [];

    // 无班级课程 → 保留原始空闲时间
    if (classCourses.length === 0) {
      result.push(avail);
      continue;
    }

    // 构建已占用区间（左右各加 CLASS_MIN_GAP 缓冲）
    const occupied = classCourses
      .map(c => ({
        start: Math.max(0, timeToMinutes(c.startTime) - CLASS_MIN_GAP),
        end: timeToMinutes(c.endTime) + CLASS_MIN_GAP
      }))
      .sort((a, b) => a.start - b.start);

    // 合并重叠的已占用区间
    const merged = [];
    for (const occ of occupied) {
      if (merged.length > 0 && merged[merged.length - 1].end >= occ.start) {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, occ.end);
      } else {
        merged.push({ ...occ });
      }
    }

    // 从空闲时间段中减去已占用区间，得到剩余碎片
    let current = availStart;
    for (const occ of merged) {
      if (occ.start > current) {
        const fragEnd = Math.min(occ.start, availEnd);
        if (fragEnd > current) {
          result.push({
            teacher,
            date: avail.date,
            startTime: minutesToTime(current),
            endTime: minutesToTime(fragEnd)
          });
        }
      }
      current = Math.max(current, occ.end);
    }
    if (current < availEnd) {
      result.push({
        teacher,
        date: avail.date,
        startTime: minutesToTime(current),
        endTime: minutesToTime(availEnd)
      });
    }
  }

  return result;
}
