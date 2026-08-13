// 排课编排器：纯函数，输入 state 输出排课结果
// v5.14: 班级→师资→课程 循环结构，每步构建师资-班级空闲时间表
import { formatDate, timeToMinutes, durationToMinutes } from '../utils/dateUtils.js';
import { SCHEDULE_LEVELS } from './constants.js';
import { createScheduleContext, registerSlot, hasAnyFeasibleSlot, buildTeacherClassAvailability } from './scheduleContext.js';
import { findBestDispersionPlan } from './dispersion.js';
import { tryScheduleCourse } from './trySchedule.js';

/**
 * 执行排课
 * @param {Object} state { currentDate, availabilityData, courseSystemData }
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   courses?: Array,
 *   courseSystemData?: Array,
 *   successCount?: number,
 *   failedCount?: number,
 *   diagnostics?: Object
 * }}
 */
export function generateSchedule(state) {
  const { currentDate, availabilityData, courseSystemData } = state;

  if (!availabilityData || availabilityData.length === 0) {
    return { ok: false, error: '请先上传师资空闲时间表' };
  }
  if (!courseSystemData || courseSystemData.length === 0) {
    return { ok: false, error: '请先上传课程体系表' };
  }

  // 计算当前月份的所有日期（用于分散度评分）
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const totalDays = new Date(year, month + 1, 0).getDate();
  const currentMonthDates = [];
  for (let i = 1; i <= totalDays; i++) {
    currentMonthDates.push(formatDate(new Date(year, month, i)));
  }

  const monthAvailability = availabilityData;
  if (monthAvailability.length === 0) {
    return { ok: false, error: '没有可用的师资空闲时间' };
  }

  // 深拷贝课程体系表并重置排课状态
  const newCourseSystemData = courseSystemData.map(item => ({ ...item, scheduled: false }));

  // 创建全局排课上下文（所有班级共享，跟踪师资跨班级日程）
  const ctx = createScheduleContext(monthAvailability);

  // ================================================================
  // 1. 为课程体系表中所有班级建立班级课程时间表
  //    ctx.classScheduleByDate[classType][date] = [{startTime, endTime}, ...]
  //    初始为空，随排课进度逐步更新
  // ================================================================

  // 按班级分组课程
  const classGroups = {};
  newCourseSystemData.forEach((item, index) => {
    if (!classGroups[item.classType]) classGroups[item.classType] = [];
    classGroups[item.classType].push({ ...item, originalIndex: index });
  });

  // 班级内按 orderInSheet 排序（保持课程体系表的原始顺序）
  Object.values(classGroups).forEach(courses => {
    courses.sort((a, b) => (a.orderInSheet ?? 0) - (b.orderInSheet ?? 0));
  });

  // ================================================================
  // 2. 班级排序：按"最难师资"难易程度降序（难排的班级优先）
  // ================================================================
  const classDifficulty = {};
  for (const classType of Object.keys(classGroups)) {
    const courses = classGroups[classType];
    const teachersInClass = [...new Set(courses.map(c => c.teacher))];
    let maxDifficulty = -Infinity;
    for (const teacher of teachersInClass) {
      const teacherCourses = courses.filter(c => c.teacher === teacher);
      const demand = teacherCourses.reduce((s, c) => s + durationToMinutes(c.duration), 0);
      const supply = monthAvailability
        .filter(a => a.teacher === teacher)
        .reduce((s, a) => s + (timeToMinutes(a.endTime) - timeToMinutes(a.startTime)), 0);
      const diff = supply > 0 ? demand / supply : Infinity;
      if (diff > maxDifficulty) maxDifficulty = diff;
    }
    classDifficulty[classType] = maxDifficulty;
  }

  const sortedClasses = Object.keys(classGroups).sort((a, b) => {
    const diffA = classDifficulty[a];
    const diffB = classDifficulty[b];
    const normA = diffA === Infinity ? Number.MAX_VALUE : diffA;
    const normB = diffB === Infinity ? Number.MAX_VALUE : diffB;
    if (normB !== normA) return normB - normA;
    return a.localeCompare(b);
  });

  console.log('--- 班级排课优先级（按最难师资难易程度降序）---');
  sortedClasses.forEach((cls, i) => {
    const diff = classDifficulty[cls];
    const diffStr = diff === Infinity ? '∞' : (diff * 100).toFixed(1) + '%';
    const teacherCount = [...new Set(classGroups[cls].map(c => c.teacher))].length;
    console.log(`  ${i + 1}. 班级 ${cls} (${classGroups[cls].length}课, ${teacherCount}师资, 最难师资难易程度: ${diffStr})`);
  });
  console.log('');

  const diagnostics = { teacherStats: [], classStats: [], schedulingOrder: [] };

  // ================================================================
  // 3. 逐班级排课
  // ================================================================
  for (const classType of sortedClasses) {
    const courses = classGroups[classType];

    // 按师资分组（班级内）
    const teacherGroups = {};
    courses.forEach(c => {
      if (!teacherGroups[c.teacher]) teacherGroups[c.teacher] = [];
      teacherGroups[c.teacher].push(c);
    });

    // 师资排序：按难易程度降序（难排的师资优先）
    const teacherDifficultyList = Object.keys(teacherGroups).map(teacher => {
      const teacherCourses = teacherGroups[teacher];
      const courseDemandMinutes = teacherCourses.reduce(
        (sum, c) => sum + durationToMinutes(c.duration), 0
      );
      const teacherAvailabilities = monthAvailability.filter(a => a.teacher === teacher);
      const availabilityMinutes = teacherAvailabilities.reduce(
        (sum, a) => sum + (timeToMinutes(a.endTime) - timeToMinutes(a.startTime)), 0
      );
      const difficulty = availabilityMinutes > 0
        ? courseDemandMinutes / availabilityMinutes
        : Infinity;
      return { teacher, difficulty, courseDemandMinutes, availabilityMinutes, totalCourses: teacherCourses.length };
    }).sort((a, b) => {
      const normA = a.difficulty === Infinity ? Number.MAX_VALUE : a.difficulty;
      const normB = b.difficulty === Infinity ? Number.MAX_VALUE : b.difficulty;
      return normB - normA;
    });

    console.log(`[班级 ${classType}] 师资排课顺序:`);
    teacherDifficultyList.forEach(d => {
      const diffStr = d.difficulty === Infinity
        ? '∞ (无空闲时间)'
        : (d.difficulty * 100).toFixed(1) + '%';
      console.log(`  ${d.teacher}: 课程需求 ${d.courseDemandMinutes}分钟 / 空闲 ${d.availabilityMinutes}分钟 = ${diffStr} (${d.totalCourses}课)`);
    });

    // ================================================================
    // 4. 逐师资排课（班级内）
    // ================================================================
    for (const { teacher, difficulty, courseDemandMinutes, availabilityMinutes, totalCourses: teacherTotalCourses } of teacherDifficultyList) {
      const teacherCourses = teacherGroups[teacher];

      // ================================================================
      // 4-1. 构建师资-班级空闲时间表
      //     = 师资空闲时间 - 班级课程时间表（含 CLASS_MIN_GAP 缓冲）
      // ================================================================
      const teacherClassAvailability = buildTeacherClassAvailability(
        monthAvailability, teacher, classType, ctx
      );

      const originalSlots = monthAvailability.filter(a => a.teacher === teacher).length;
      const filteredSlots = teacherClassAvailability.length;
      const removedSlots = originalSlots - filteredSlots;
      if (removedSlots > 0) {
        console.log(`  [${teacher}|${classType}] 构建师资-班级空闲时间表: 原始 ${originalSlots} 段 → 班级课程占用 ${removedSlots} 段 → 剩余 ${filteredSlots} 段可用`);
      }

      if (filteredSlots === 0) {
        console.log(`  [${teacher}|${classType}] 无可用空闲时间，跳过`);
        for (const courseItem of teacherCourses) {
          newCourseSystemData[courseItem.originalIndex].scheduled = false;
        }
        diagnostics.teacherStats.push({
          teacher, classType,
          totalCourses: teacherTotalCourses,
          scheduled: 0,
          failed: teacherTotalCourses,
          difficulty: difficulty === Infinity ? null : difficulty,
          difficultyPercent: difficulty === Infinity ? null : Math.round(difficulty * 100),
          courseDemandMinutes, availabilityMinutes
        });
        continue;
      }

      // 创建临时上下文：用师资-班级空闲时间表替换 monthAvailability
      // teacherCtx 与 ctx 共享 teacherScheduleByDate/classScheduleByDate（浅拷贝）
      // 排课结果自动回写到全局 ctx，班级课程时间表自动更新
      const teacherCtx = { ...ctx, monthAvailability: teacherClassAvailability };

      // ================================================================
      // 4-2. 预计算分散度方案
      // ================================================================
      const repDuration = teacherCourses.length > 0
        ? durationToMinutes(teacherCourses[0].duration)
        : 60;

      const allTeacherDates = [...new Set(
        teacherClassAvailability.map(a => a.date)
      )].sort();

      // 冲突感知过滤：剔除已被占满的日期
      const feasibleDates = allTeacherDates.filter(d =>
        hasAnyFeasibleSlot(teacherCtx, { teacher, classType, date: d, durationMinutes: repDuration })
      );
      const feasibleExcluded = allTeacherDates.length - feasibleDates.length;
      if (feasibleExcluded > 0) {
        console.log(`  [${teacher}|${classType}] 冲突感知: 可用 ${allTeacherDates.length} 天，剔除已被占满 ${feasibleExcluded} 天，剩 ${feasibleDates.length} 天用于分散规划`);
      }

      const bestPlan = findBestDispersionPlan(
        feasibleDates, teacherTotalCourses, teacher, teacherClassAvailability, currentMonthDates
      );
      const planDates = (bestPlan.primary || bestPlan.secondary)?.dates || [];

      // ================================================================
      // 4-3. 第一阶段：正常排课（按课程体系顺序，考虑分散度）
      // ================================================================
      let scheduledCount = 0;
      const teacherLastDate = {};
      const teacherCourseIndex = {};

      for (const courseItem of teacherCourses) {
        const allDates = feasibleDates;
        if (!allDates || allDates.length === 0) continue;

        const previousDate = teacherLastDate[teacher] || null;
        const courseIdx = teacherCourseIndex[teacher] || 0;
        const preferredDate = planDates[courseIdx] || null;

        let slot = null;
        for (const level of SCHEDULE_LEVELS) {
          slot = tryScheduleCourse(teacherCtx, courseItem, teacher, allDates, level.gap, false, previousDate, allDates, preferredDate);
          if (slot) break;
        }

        if (slot) {
          commitSlot(ctx, newCourseSystemData, courseItem, teacher, slot);
          teacherLastDate[teacher] = slot.date;
          teacherCourseIndex[teacher] = courseIdx + 1;
          scheduledCount++;
        }
      }

      // ================================================================
      // 4-4. 第二阶段：补排（跳过分散度，使用原始空闲时间确保所有课程排入）
      //     注意：补排使用原始 ctx（含全部空闲时间），让 hasConflict 兜底检测冲突
      // ================================================================
      const failedCourses = teacherCourses.filter(c => !newCourseSystemData[c.originalIndex].scheduled);
      if (failedCourses.length > 0) {
        console.log(`  [${teacher}|${classType}] 有 ${failedCourses.length} 节课需要补排（跳过分散度，使用原始空闲时间）`);

        for (const courseItem of failedCourses) {
          const allDates = [...new Set(
            monthAvailability.filter(a => a.teacher === teacher).map(a => a.date)
          )].sort();

          let slot = null;
          for (const level of SCHEDULE_LEVELS) {
            if (!allDates || allDates.length === 0) continue;
            slot = tryScheduleCourse(ctx, courseItem, teacher, allDates, level.gap, true, null, []);
            if (slot) break;
          }

          if (slot) {
            commitSlot(ctx, newCourseSystemData, courseItem, teacher, slot);
            scheduledCount++;
            console.log(`    补排成功: ${courseItem.courseName} → ${slot.date} ${slot.startTime}-${slot.endTime}`);
          }
        }
      }

      // ================================================================
      // 4-5. 师资-班级空闲时间表自动销毁（临时变量，离开作用域即 GC）
      //     班级课程时间表已通过 registerSlot 自动更新到 ctx.classScheduleByDate
      // ================================================================

      // 统计师资排课结果
      const teacherStat = {
        teacher, classType,
        totalCourses: teacherTotalCourses,
        scheduled: scheduledCount,
        failed: teacherTotalCourses - scheduledCount,
        difficulty: difficulty === Infinity ? null : difficulty,
        difficultyPercent: difficulty === Infinity ? null : Math.round(difficulty * 100),
        courseDemandMinutes, availabilityMinutes
      };
      diagnostics.teacherStats.push(teacherStat);

      const diffStr = difficulty === Infinity
        ? '∞ (无空闲时间)'
        : (difficulty * 100).toFixed(1) + '%';
      console.log(`  [${teacher}|${classType}] 完成: ${scheduledCount}/${teacherTotalCourses} (难易程度: ${diffStr})`);
    }

    console.log(`[班级 ${classType}] 排课完成\n`);
  }

  // ================================================================
  // 5. 诊断信息：统计班级分布
  // ================================================================
  const classMap = {};
  for (const c of ctx.scheduledCourses) {
    if (!classMap[c.classType]) classMap[c.classType] = { classType: c.classType, courses: [], teachers: new Set() };
    classMap[c.classType].courses.push(c);
    classMap[c.classType].teachers.add(c.teacher);
  }
  diagnostics.classStats = Object.values(classMap).map(s => ({
    classType: s.classType,
    count: s.courses.length,
    teachers: [...s.teachers],
    dates: [...new Set(s.courses.map(c => c.date))].sort()
  }));

  const successCount = ctx.scheduledCourses.length;
  const failedCount = newCourseSystemData.length - successCount;

  return {
    ok: true,
    courses: ctx.scheduledCourses,
    courseSystemData: newCourseSystemData,
    successCount,
    failedCount,
    diagnostics
  };
}

/** 落账：注册时间槽 + 写入课程结果 + 标记课程体系表状态 */
function commitSlot(ctx, newCourseSystemData, courseItem, teacher, slot) {
  const { classType, courseName, originalIndex, itemId } = courseItem;

  registerSlot(ctx, {
    teacher,
    classType,
    date: slot.date,
    startTime: slot.startTime,
    endTime: slot.endTime
  });

  newCourseSystemData[originalIndex].scheduled = true;

  ctx.scheduledCourses.push({
    id: originalIndex + 100,
    name: courseName,
    classType,
    date: slot.date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    teacher: `${teacher}老师`,
    type: 'scheduled',
    sourceItemId: itemId
  });
}
