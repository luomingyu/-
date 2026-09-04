// 排课过程可变上下文：封装师资/班级日程映射，避免闭包捕获
import { timeToMinutes, minutesToTime } from '../utils/dateUtils.js';
import { splitClassTypes } from '../utils/classType.js';
import { CLASS_MIN_GAP, AVAIL_REMOVE_PAD } from './constants.js';

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

  // 合班课（v5.27）：对每个班级分别注册班级日程与"师资+班级+日期"硬约束计数
  for (const eachClass of splitClassTypes(classType)) {
    if (!ctx.classScheduleByDate[eachClass]) ctx.classScheduleByDate[eachClass] = {};
    if (!ctx.classScheduleByDate[eachClass][date]) ctx.classScheduleByDate[eachClass][date] = [];
    ctx.classScheduleByDate[eachClass][date].push({ startTime, endTime });

    if (!ctx.teacherClassScheduleByDate[teacher]) ctx.teacherClassScheduleByDate[teacher] = {};
    if (!ctx.teacherClassScheduleByDate[teacher][eachClass]) ctx.teacherClassScheduleByDate[teacher][eachClass] = {};
    ctx.teacherClassScheduleByDate[teacher][eachClass][date] =
      (ctx.teacherClassScheduleByDate[teacher][eachClass][date] || 0) + 1;
  }

  ctx.dayCourseCounts[date] = (ctx.dayCourseCounts[date] || 0) + 1;
}

/**
 * 判断某天是否已排过"某师资+某班级"的课程（硬约束：每天只能排某个师资某个班级一节课）
 * 合班课（v5.27）：任一班级当天已有该师资课程即视为已排
 * @returns {boolean} true 表示该天已有该师资该班级的课程（冲突）
 */
export function hasTeacherClassOnDate(ctx, { teacher, classType, date }) {
  return splitClassTypes(classType).some(
    eachClass => (ctx.teacherClassScheduleByDate?.[teacher]?.[eachClass]?.[date] || 0) >= 1
  );
}

/** 校验某时间槽是否与已有课程冲突（师资间隔 minGap + 班级间隔 CLASS_MIN_GAP + 师资班级每天一节） */
export function hasConflict(ctx, { teacher, classType, date, slotStart, slotEnd, minGap }) {
  // 硬约束兜底：同一天同一师资（合班课的任一班级）只能排一节课
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

  // 合班课（v5.27）：任一班级当天该时段已被课程占用即冲突
  for (const eachClass of splitClassTypes(classType)) {
    const existingClassCourses = ctx.classScheduleByDate[eachClass]?.[date] || [];
    for (const e of existingClassCourses) {
      const eStart = timeToMinutes(e.startTime);
      const eEnd = timeToMinutes(e.endTime);
      if (!(slotEnd + CLASS_MIN_GAP <= eStart || slotStart - CLASS_MIN_GAP >= eEnd)) {
        return true;
      }
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
 * 合班课之后截断（v5.59）：删除「第一个已排日期合班课」时间段之后的所有空闲时间。
 * 切割时刻 = 合班课开始时间 − AVAIL_REMOVE_PAD 分钟（如 17:00-19:00 → 16:55）。
 * 保留时间域：
 *   · date < cutAfter.date 的碎片全部保留；
 *   · date === cutAfter.date 且碎片开始时间早于切割时刻（不含）的保留，
 *     跨越切割点的碎片截断到切割时刻（结束时刻恰为切割点的保留）；
 *   · date > cutAfter.date（或开始时间不早于切割时刻）的碎片丢弃。
 * 应用此函数后，该子表普通课的候选时间域不再包含合班课日期（含）之后的部分。
 * @param {Array} availability 空闲时间碎片列表（含 date/startTime/endTime）
 * @param {Object|null} [cutAfter] { date: 'YYYY-MM-DD', startTime: 'HH:MM'（已减缓冲后的切割时刻）}
 * @returns {Array} 截断后的空闲时间列表
 */
export function applyCutAfter(availability, cutAfter) {
  if (!Array.isArray(availability) || !cutAfter || !cutAfter.date || availability.length === 0) {
    return availability;
  }
  const cutMinute = cutAfter.startTime ? timeToMinutes(cutAfter.startTime) : 0;
  const result = [];
  for (const frag of availability) {
    if (!frag) continue;
    if (frag.date > cutAfter.date) continue; // 切割日期之后 → 整段丢弃
    if (frag.date === cutAfter.date) {
      const s = timeToMinutes(frag.startTime);
      const e = timeToMinutes(frag.endTime);
      if (s >= cutMinute) continue;          // 起点不早于切割时刻 → 丢弃
      if (e > cutMinute) {                   // 跨越切割点 → 截断到切割时刻
        result.push({ ...frag, endTime: minutesToTime(cutMinute) });
        continue;
      }
    }
    result.push(frag);                       // 早于切割日期（或未跨越切割点）→ 保留
  }
  return result;
}

/**
 * 构建师资-班级空闲时间表：从师资空闲时间中减去已排课占用的时段（v5.39）
 *
 * 扣除维度：
 *   1. 班级已占用时段：班级课程时间表包含该班级所有已排课程（含其他师资），
 *      确保新排课程不与班级已有课程冲突，扣减时开头结尾各多减 AVAIL_REMOVE_PAD 分钟；
 *   2. 师资已占用时段：该师资自身已排课程（同一时刻师资只能上一门课，
 *      即使那门课是别的班级的也要扣除），扣减时同样开头结尾各多减 AVAIL_REMOVE_PAD 分钟，
 *      确保新排课程与师资既有档期保持间隔（如已排 17:00-19:00，实际扣除 16:55-19:05）。
 *   3. 尾段预留（v5.49，可选）：首次排含合班课子表时，将该月后 N% 日期中
 *      「合班课其他班级」已排课程时间一并扣除——为合班课预留尾段位置，
 *      避免子表内普通课占用尾段日期，导致合班课（需多个班级同时空闲）无处可排。
 *      N = 合班课数量 ÷ 子表总课数量 × 130%，尾段天数 = 当月天数 × N，取整。
 *   4. 合班课之后截断（v5.59，可选）：若本子表含有已排日期的合班课，删除该子表
 *      第一个合班课时间段（开始时间 − AVAIL_REMOVE_PAD 分钟）之后的所有空闲时间——
 *      该子表普通课的候选时间域收缩到第一个合班课之前（如合班课 8/22 17:00-19:00，
 *      则 8/22 16:55 及之后所有空闲时间全部删除）。
 *
 * 算法：对每个空闲时间段，用「班级已占时段（含缓冲）+ 师资已占时段」做差集，返回剩余碎片
 *
 * @param {Array} monthAvailability 所有师资空闲时间
 * @param {string} teacher 师资名
 * @param {string} classType 班级
 * @param {Object} ctx 排课上下文（含 classScheduleByDate / teacherScheduleByDate）
 * @param {Object} [options] 可选参数
 * @param {Object} [options.tailReserve] 尾段预留配置 { dates: string[], otherClasses: string[] }
 *        dates = 该月后 N% 的日期列表；otherClasses = 合班课组成班级（本课班级之外的自动跳过）
 * @param {Object} [options.cutAfter] 合班课之后截断配置 { date: 'YYYY-MM-DD', startTime: 'HH:MM' }
 *        date = 子表内第一个已排日期合班课的日期；startTime = 切割时刻
 *        （合班课开始时间 − AVAIL_REMOVE_PAD 分钟，如 17:00 → 16:55）
 * @returns {Array} 过滤后的空闲时间列表（仅包含未被班级与师资占用的时段）
 */
export function buildTeacherClassAvailability(monthAvailability, teacher, classType, ctx, options = {}) {
  // v5.59：合班课之后截断 —— 先对师资原始空闲时间剔除「第一个合班课之后」的时间域，
  // 再执行班级/师资占用扣除（截断点由调用方计算并透传，见 index.js 子表循环）
  let teacherAvail = applyCutAfter(
    monthAvailability.filter(a => a.teacher === teacher),
    options.cutAfter
  );
  if (teacherAvail.length === 0) return [];

  // 合班课（v5.27）：合并所有班级的已占用课程（任一班级冲突即不可排）
  // 将各班级的 classScheduleByDate 并集到同一张 [date] -> courses 映射
  const classSchedule = {};
  for (const eachClass of splitClassTypes(classType)) {
    const schedule = ctx.classScheduleByDate[eachClass] || {};
    for (const date of Object.keys(schedule)) {
      if (!classSchedule[date]) classSchedule[date] = [];
      classSchedule[date].push(...schedule[date]);
    }
  }

  // 尾段预留（v5.49）：将该月后 N% 日期中「合班课其他班级」已排课程时间并入占用。
  // N = 合班课数量 ÷ 子表总课数量 × 130%，尾段天数 = 当月天数 × N，取整（见 index.js 子表循环）。
  // 当前课程班级自身（splitClassTypes(classType) 已覆盖）不在其中，避免重复扣除。
  const tail = options.tailReserve;
  if (tail && Array.isArray(tail.dates) && tail.dates.length > 0) {
    const dateSet = new Set(tail.dates);
    const thisClasses = new Set(splitClassTypes(classType));
    for (const otherClass of tail.otherClasses || []) {
      if (thisClasses.has(otherClass)) continue;
      const schedule = ctx.classScheduleByDate[otherClass] || {};
      for (const date of Object.keys(schedule)) {
        if (!dateSet.has(date)) continue;
        if (!classSchedule[date]) classSchedule[date] = [];
        classSchedule[date].push(...schedule[date]);
      }
    }
  }

  const result = [];
  for (const avail of teacherAvail) {
    const availStart = timeToMinutes(avail.startTime);
    const availEnd = timeToMinutes(avail.endTime);

    const classCourses = classSchedule[avail.date] || [];
    // 该师资当天自身已排课程（v5.39：排除已排课的师资时间）
    const teacherCourses = ctx.teacherScheduleByDate?.[teacher]?.[avail.date] || [];

    // 无任何占用 → 保留原始空闲时间
    if (classCourses.length === 0 && teacherCourses.length === 0) {
      result.push(avail);
      continue;
    }

    // 构建已占用区间：
    //   班级课程占用：开头结尾各多减 AVAIL_REMOVE_PAD 分钟（如已排 17:00-19:00，按 16:55-19:05 扣除）
    //   师资自身课程占用：同样开头结尾各多减 AVAIL_REMOVE_PAD 分钟，与师资既有档期保持间隔
    const occupied = [];
    for (const c of classCourses) {
      occupied.push({
        start: Math.max(0, timeToMinutes(c.startTime) - AVAIL_REMOVE_PAD),
        end: timeToMinutes(c.endTime) + AVAIL_REMOVE_PAD
      });
    }
    for (const c of teacherCourses) {
      occupied.push({
        start: Math.max(0, timeToMinutes(c.startTime) - AVAIL_REMOVE_PAD),
        end: timeToMinutes(c.endTime) + AVAIL_REMOVE_PAD
      });
    }
    occupied.sort((a, b) => a.start - b.start);

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
