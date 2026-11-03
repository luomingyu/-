// 调课：绿色可调课时间段计算（纯函数，无副作用）
//
// 约束（与业务确认口径）：
//   ① 在课程体系表中按课程属性（课程名称 + 师资 + 班级）定位「包含该课程的子表」，
//      取各子表内「当前课程」前一个已落位课程授课结束之后、后一个已落位课程授课开始之前
//      （按课程体系表行序 orderInSheet 取前后）；命中多个子表时取交集（最严格）。
//      「已落位课程」= 排课结果课程 或「已排课表」条目 —— 后者 itemId 不属于课程体系表，
//      故统一按属性匹配把「课程体系表行」映射到实际落位的那门课。
//   ② 排除同师资、同班级课程占用；同班级课程前后各留 5 分钟，同师资课程前后各留 30 分钟
//   ③ 剩余空闲段长度必须 ≥ 该课程时长
import { splitClassTypes } from './classType.js';
import { durationToMinutes, minutesToTime, timeToMinutes } from './dateUtils.js';
import { sheetKeyOf } from './sheetForm.js';

const CLASS_GAP_MINUTES = 5;    // 同班级课程最小间隔
const TEACHER_GAP_MINUTES = 30; // 同师资课程最小间隔

/**
 * 日期 + 时间 → 绝对分钟数（用于跨日期比较）。
 * 口径：逻辑日序号 × 1440 + 当日分钟，保证 abs % 1440 恒等于当日分钟（不受本地时区偏移影响）。
 */
function absMinutes(dateStr, timeStr = '00:00') {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(timeStr).split(':').map(Number);
  const dayIndex = Math.round((Date.UTC(y || 1970, (m || 1) - 1, d || 1) - Date.UTC(1970, 0, 1)) / 86400000);
  return dayIndex * 1440 + (hh || 0) * 60 + (mm || 0);
}

/** 从空闲区间集合中扣除占用区间，返回剩余区间 */
function subtractIntervals(base, blocks) {
  let result = [base];
  for (const [bs, be] of blocks) {
    if (be <= bs) continue;
    const next = [];
    for (const [s, e] of result) {
      if (be <= s || bs >= e) { next.push([s, e]); continue; }
      if (bs > s) next.push([s, bs]);
      if (be < e) next.push([be, e]);
    }
    result = next;
  }
  return result;
}

/** 规范化比较字段（去首尾空白） */
function normField(value) {
  return String(value ?? '').trim();
}

/**
 * 课程体系表某行是否「包含该课程」：课程名称（非空）+ 师资 + 班级三者全部命中。
 * 班级按合班展开后取交集（如课程「班A,班B」与行「班A」视为命中）。
 * 同一门课可能同时出现在多个子表（同名课 / 合班课），因此命中结果可能多行、跨子表。
 */
function itemContainsCourse(item, course) {
  const name = normField(item.courseName);
  // 排课结果课程的课名字段是 name；「已排课表」条目是 courseName —— 两者都接受
  if (!name || name !== (normField(course?.name) || normField(course?.courseName))) return false;
  if (normField(item.teacher) !== normField(course?.teacher)) return false;
  const itemClasses = splitClassTypes(item.classType);
  const courseClasses = splitClassTypes(course?.classType);
  return itemClasses.some(cls => courseClasses.includes(cls));
}

/**
 * 课程（排课结果 or「已排课表」条目）→ 其在课程体系表中对应子表的 key 集合。
 * 排课结果课程带 sourceItemId，可精确命中其课程体系行；「已排课表」条目的 itemId
 * 不属于课程体系表，退化为属性匹配（课名 + 师资 + 班级有交集），可能命中多个子表。
 */
export function resolveCourseSheetKeys(course, courseSystemData) {
  const data = courseSystemData || [];
  if (!course) return new Set();
  const exact = data.find(it => it.itemId === course.sourceItemId);
  if (exact) return new Set([sheetKeyOf(exact)]);
  const keys = new Set();
  for (const it of data) {
    if (itemContainsCourse(it, course)) keys.add(sheetKeyOf(it));
  }
  return keys;
}

/**
 * 取某调课对象的课时长（分钟）。
 * 优先按 sourceItemId 查课程体系表；查不到（「已排课表」preset 条目无课程体系行）时，
 * 用条目自身的 startTime/endTime 推算。
 */
export function resolveCourseDuration(courseSystemData, course) {
  const item = (courseSystemData || []).find(it => it.itemId === course?.sourceItemId);
  if (item) return durationToMinutes(item.duration);
  const start = timeToMinutes(course?.startTime);
  const end = timeToMinutes(course?.endTime);
  return end > start ? end - start : 0;
}

/**
 * 计算一门课程在所有候选日期上的绿色可调课时间段。
 * @param {Object}   params
 * @param {Object}   params.course           当前被调课程（含 sourceItemId / teacher / classType / date / startTime / endTime）
 * @param {Array}    params.courses          全部已排课程
 * @param {Array}    params.presets          「已排课表」条目（含 itemId / classType / teacher / date / startTime / endTime）
 * @param {Array}    params.courseSystemData 课程体系表扁平数据（含 itemId / courseName / teacher / classType /
 *                                            sheetName / sheetIndex / orderInSheet / duration）
 * @param {string[]} params.dates            候选日期（'YYYY-MM-DD'）
 * @returns {Object} { [dateStr]: [{ startTime, endTime }] }
 */
export function computeAdjustSegments({ course, courses, courseSystemData, presets, dates }) {
  const result = {};
  if (!course) return result;

  const data = courseSystemData || [];
  const all = courses || [];
  // 「已排课表」条目归一化为与排课结果课程同口径（含 name），
  // 既参与同师资/同班级冲突判定，也参与「前后课程」的属性匹配
  const presetItems = (presets || []).map(p => ({
    sourceItemId: p.itemId,
    name: p.name || p.courseName || '',
    classType: p.classType,
    teacher: p.teacher,
    date: p.date,
    startTime: p.startTime,
    endTime: p.endTime
  }));
  const occupiers = [...all, ...presetItems];

  const duration = resolveCourseDuration(data, course);
  if (!(duration > 0)) return result;

  // 定位「课程体系表中包含该课程的子表」：
  // 排课结果课程按 sourceItemId 精确命中其课程体系行；「已排课表」条目退化为属性匹配
  // （课名 + 师资 + 班级有交集）——与 resolveCourseSheetKeys 口径一致。
  const exactRows = data.filter(it => it.itemId === course.sourceItemId);
  const matchedItems = exactRows.length > 0
    ? exactRows
    : data.filter(it => itemContainsCourse(it, course));

  // 课程体系表行 → 实际已落位课程（排课结果 or「已排课表」条目）：
  // ① 排课结果课程带 sourceItemId，可精确命中对应行；
  // ② 其余（「已排课表」条目 itemId 不属于课程体系表）按属性匹配（课名 + 师资 + 班级有交集）。
  const placedCache = new Map();
  const resolvePlaced = (courseItem) => {
    if (placedCache.has(courseItem.itemId)) return placedCache.get(courseItem.itemId);
    const hit = all.find(o => o.sourceItemId === courseItem.itemId)
      || occupiers.find(o => o.sourceItemId !== course.sourceItemId && itemContainsCourse(courseItem, o))
      || null;
    placedCache.set(courseItem.itemId, hit);
    return hit;
  };

  // 每个命中子表内，按行序排序找当前课程前后最近「已落位」的课程作为时间上下界；
  // 命中多个子表（同名课 / 合班课）时取交集（最严格口径）：
  //   下界 = 各子表「前一门已落位课结束时间」的最大值，上界 = 各子表「后一门已落位课开始时间」的最小值。
  // 无命中 → 上下界保持 -∞/+∞，时间窗退化为全天 00:00–23:59。
  const sheetItemsCache = new Map();
  let prevBound = -Infinity;
  let nextBound = Infinity;
  for (const item of matchedItems) {
    const sheetKey = sheetKeyOf(item);
    if (!sheetItemsCache.has(sheetKey)) {
      sheetItemsCache.set(
        sheetKey,
        data
          .filter(it => sheetKeyOf(it) === sheetKey)
          .sort((a, b) => (a.orderInSheet ?? 0) - (b.orderInSheet ?? 0))
      );
    }
    const sheetItems = sheetItemsCache.get(sheetKey);
    const curIdx = sheetItems.findIndex(it => it.itemId === item.itemId);
    const prevCourse = findNearestPlaced(sheetItems, curIdx, -1, resolvePlaced);
    const nextCourse = findNearestPlaced(sheetItems, curIdx, +1, resolvePlaced);
    if (prevCourse) prevBound = Math.max(prevBound, absMinutes(prevCourse.date, prevCourse.endTime));
    if (nextCourse) nextBound = Math.min(nextBound, absMinutes(nextCourse.date, nextCourse.startTime));
  }

  // 被调课程自身的时间段必须始终保留（不得因上下界收窄而被「删除」）：
  // 正常情况下其自身时间本就落在前后两门已排课之间，min/max 属于无操作；
  // 当出现前后上下界倒挂（如日期回绕导致的脏数据）时，仍保证原时间点在绿色段内。
  const ownStartAbs = absMinutes(course.date, course.startTime);
  const ownEndAbs = absMinutes(course.date, course.endTime);
  const lowerBound = Math.min(prevBound, ownStartAbs);
  const upperBound = Math.max(nextBound, ownEndAbs);

  const currentClasses = new Set(splitClassTypes(course.classType));

  for (const date of dates || []) {
    // 每天可调课时间范围固定为 00:00 ~ 23:59
    const dayStart = absMinutes(date, '00:00');
    const dayEnd = absMinutes(date, '23:59');
    const windowStart = Math.max(dayStart, lowerBound);
    const windowEnd = Math.min(dayEnd, upperBound);
    if (windowEnd - windowStart < duration) continue;

    // 收集同日同师资 / 同班级课程的占用区间（含间隔）
    // 占用来源：排课结果课程 + 「已排课表」条目（统一口径）
    // 注意：被调课程自身不计入占用 —— 其原时间段必须保留为可落点，不得删除。
    const blocks = [];
    for (const c of occupiers) {
      if (c.date !== date) continue;
      if (c.sourceItemId === course.sourceItemId) continue;
      const sameTeacher = !!c.teacher && c.teacher === course.teacher;
      const sameClass = splitClassTypes(c.classType).some(cls => currentClasses.has(cls));
      if (!sameTeacher && !sameClass) continue;
      const gap = sameTeacher ? TEACHER_GAP_MINUTES : CLASS_GAP_MINUTES;
      blocks.push([
        absMinutes(date, c.startTime) - gap,
        absMinutes(date, c.endTime) + gap
      ]);
    }

    const frees = subtractIntervals([windowStart, windowEnd], blocks)
      .filter(([s, e]) => e - s >= duration);
    if (frees.length === 0) continue;

    // 按从早到晚排序，逐段展示
    result[date] = frees
      .slice()
      .sort((a, b) => a[0] - b[0])
      .map(([s, e]) => ({
        startTime: minutesToTime(((s % 1440) + 1440) % 1440),
        endTime: minutesToTime(((e % 1440) + 1440) % 1440)
      }));
  }

  return result;
}

/** 沿行序方向找最近一门已落位课程（跳过尚未落位的课程体系表行） */
function findNearestPlaced(sheetItems, fromIdx, step, resolvePlaced) {
  if (fromIdx < 0) return null;
  for (let i = fromIdx + step; i >= 0 && i < sheetItems.length; i += step) {
    const c = resolvePlaced(sheetItems[i]);
    if (c) return c;
  }
  return null;
}

/**
 * 计算某绿色时间段内所有合法的「授课开始时间」（5 分钟刻度）。
 * 满足：开始时间 + 课程时长 ≤ 段末；且落在段内。
 * @returns {string[]} 'HH:MM' 数组
 */
export function computeStartTimes(segment, duration) {
  if (!segment || !(duration > 0)) return [];
  // 段起止本身就在同一天内，直接按「当日分钟」计算，避免绝对分钟数的时区偏移
  const startMin = timeToMinutes(segment.startTime);
  const endMin = timeToMinutes(segment.endTime);
  const times = [];
  // 从整 5 分钟刻度开始（向上取整到 5 的倍数）
  let t = Math.ceil(startMin / 5) * 5;
  for (; t + duration <= endMin; t += 5) {
    times.push(minutesToTime(t));
  }
  return times;
}
