// 排课编排器：纯函数，输入 state 输出排课结果
// v5.30: 子表维度排课
//  ① 子表间：含合班课的子表优先，其内按课程数量降序排课（数量多的子表优先）
//  ② 子表内：严格按行顺序（orderInSheet）排课，日期递增；合班课与所在子表课程体系顺序
//     一起排课（v5.34），不再独立于子表穿插
//  ③ 合班课：按「课程名称+师资」识别，先排的子表确定日期，
//     后处理的子表自动对齐该日期（不重复排）；后子表中位于合班课之前的普通课，
//     限定在该合班课日期之前排课（从本月初到第一个合班课日期前一天），
//     其余课程通过班级冲突检测避开合班课日期
import { durationToMinutes, timeToMinutes, minutesToTime } from '../utils/dateUtils.js';
import { hasMultipleClasses, splitClassTypes } from '../utils/classType.js';
import { MIN_GAP, AVAIL_REMOVE_PAD } from './constants.js';
import { createScheduleContext, registerSlot, hasAnyFeasibleSlot, buildTeacherClassAvailability } from './scheduleContext.js';
import { tryScheduleCourse } from './trySchedule.js';
import { findBestDispersionPlan } from './dispersion.js';
import { getSubjectOfTeacher, getSubjectPriority } from '../config/constants.js';

/**
 * 计算师资难易程度与师资理论排课次序（v5.11 难易程度评估 + v5.25 科目师资表，v5.36 重新接入排课）
 *
 * 难易程度 = 该师资课程时间总需求 ÷ 空闲时间总量（单位分钟）
 *   - 比值越大 → 排课越困难 → 越优先排课
 *   - 无空闲时间的师资 → Infinity（∞）→ 该科目内最优先排课
 *
 * 师资排课顺序（先科目确立大体顺序，科目内按难易程度定最终顺序）：
 *   ① 先科目：英语 > 政治 > 数学 > 未收录科目（SUBJECT_PRIORITY，config/constants.js）
 *   ② 科目内：难易程度降序（难排的师资先排）
 *
 * @param {Array} availabilityData 师资空闲时间表 [{teacher, date, startTime, endTime}]
 * @param {Array} courseSystemData 课程体系表 [{teacher, duration, ...}]
 * @returns {Array<{teacher, subject, subjectPriority, courseMinutes, availMinutes, difficulty}>}
 *          按理论排课次序排序（数组下标即次序，越小越优先）
 */
function buildTeacherRanking(availabilityData, courseSystemData) {
  const courseMinutes = {};
  const availMinutes = {};
  for (const c of courseSystemData) {
    const t = c.teacher;
    if (!t) continue;
    courseMinutes[t] = (courseMinutes[t] || 0) + durationToMinutes(c.duration);
  }
  for (const a of availabilityData) {
    const t = a.teacher;
    const [h1, m1] = String(a.startTime).split(':').map(Number);
    const [h2, m2] = String(a.endTime).split(':').map(Number);
    availMinutes[t] = (availMinutes[t] || 0) + (h2 * 60 + m2 - (h1 * 60 + m1));
  }

  const teachers = new Set([...Object.keys(courseMinutes), ...Object.keys(availMinutes)]);
  const list = [...teachers].map(t => {
    const avail = availMinutes[t] || 0;
    const difficulty = avail > 0 ? (courseMinutes[t] || 0) / avail : Infinity;
    return {
      teacher: t,
      subject: getSubjectOfTeacher(t),       // null = 未收录科目
      subjectPriority: getSubjectPriority(t), // 英语0 < 政治1 < 数学2 < 未收录3
      courseMinutes: courseMinutes[t] || 0,
      availMinutes: avail,
      difficulty                             // Infinity = 无空闲时间（最优先）
    };
  });

  // ① 科目优先级升序（先科目） ② 科目内难易程度降序 ③ 同序时按姓名稳定排序
  list.sort((a, b) => {
    if (a.subjectPriority !== b.subjectPriority) return a.subjectPriority - b.subjectPriority;
    if (a.difficulty !== b.difficulty) return b.difficulty - a.difficulty;
    return String(a.teacher).localeCompare(String(b.teacher), 'zh');
  });
  return list;
}

/** 难易程度展示文本：Infinity → ∞，否则百分比（保留 1 位小数）；无空闲且无课程时为 0% */
export function formatDifficulty(d) {
  if (d === Infinity) return '∞';
  if (typeof d !== 'number') return '—';
  return `${Math.round(d * 1000) / 10}%`;
}

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
  const { availabilityData, courseSystemData } = state;

  if (!availabilityData || availabilityData.length === 0) {
    return { ok: false, error: '请先上传师资空闲时间表' };
  }
  if (!courseSystemData || courseSystemData.length === 0) {
    return { ok: false, error: '请先上传课程体系表' };
  }

  const monthAvailability = availabilityData;

  // 深拷贝课程体系表并重置排课状态
  const newCourseSystemData = courseSystemData.map(item => ({ ...item, scheduled: false }));

  // 创建全局排课上下文（所有班级共享，跟踪师资跨班级日程）
  const ctx = createScheduleContext(monthAvailability);

  // v5.41：以子表为单位的整体分散方案（锚点日期）
  // 合班课与所在子表前面的普通课程共享同一套分散锚点序列，保证子表全部课程
  // （普通课 + 合班课）整体均匀分散；排课时把每门课吸引到预计算的最优分散日期，
  // 锚点仅作评分加成，锚点日被占用/不可行时由 tryScheduleCourse 的近邻回退与硬约束平滑接管。
  const allMonthDates = getMonthDates(state.currentDate, monthAvailability);
  // v5.58：分散锚点方案改为「每张子表排课前即时构建」（基于排到该子表时的全局 ctx，
  // 见子表循环），此处仅声明容器，供子表循环填充与排课报告展示。
  const dispersionPlans = new Map();

  // ================================================================
  // 2. 师资难易程度评估 + 师资理论排课次序（v5.36 接入排课）：
  //    先按科目确立大体师资顺序（英语>政治>数学>未收录科目），
  //    科目内再按难易程度降序确定最终师资排课顺序（难排的师资优先排课）
  // ================================================================
  const teacherRanking = buildTeacherRanking(monthAvailability, newCourseSystemData);
  const teacherRankIndex = new Map(teacherRanking.map((r, i) => [r.teacher, { ...r, order: i + 1 }]));

  // ================================================================
  // 3. 合班课识别（v5.27/v5.30）：
  const isMergeCourse = (item) =>
    (item.mergeNote && String(item.mergeNote).includes('合班')) ||
    hasMultipleClasses(item.classType);

  // ================================================================
  // 4. 子表分组 + 排序（v5.30 / v5.34 / v5.37）：
  //    按 sheetName 分组，组内按 orderInSheet 严格排序；
  //    子表间顺序（v5.37，按师资排课顺序）：
  //      ① 先按师资排课顺序遍历师资（先科目：英语>政治>数学>未收录科目；
  //         科目内难易程度降序，难排的师资优先，见 2. 师资难易程度评估）
  //      ② 每位师资的所有子表按课程数量降序（数量多的子表优先排课）
  //      ③ 数量相同时按子表出现顺序
  //      ④ 无归属师资的子表（课程无师资字段）按出现顺序兜底排最后
  //    子表归属师资 = 子表内课时数最多的师资；课时数相同取师资理论排课次序更靠前者。
  //    例：师资 A 的课程在子表 1/2/3/4，按课程数量降序 → 子表 2,4,1,3；
  //        师资 B 的课程在子表 5/7 → 子表 5,7；整体排课次序 = 子表 2,4,1,3,5,7,…
  // ================================================================
  const sheetMap = new Map();
  newCourseSystemData.forEach((item, index) => {
    const key = item.sheetName || `sheet-${item.sheetIndex ?? 0}`;
    if (!sheetMap.has(key)) sheetMap.set(key, []);
    sheetMap.get(key).push({ ...item, originalIndex: index });
  });

  // 子表主师资 = 子表内课时数最多的师资；课时数相同取师资理论排课次序（teacherRanking.order）更靠前者
  const sheetOwnerOf = (courses) => {
    const count = {};
    for (const c of courses) {
      if (!c.teacher) continue;
      count[c.teacher] = (count[c.teacher] || 0) + 1;
    }
    let best = null;
    let bestCount = 0;
    let bestOrder = Infinity;
    for (const [t, n] of Object.entries(count)) {
      const r = teacherRankIndex.get(t);
      const order = r ? r.order : Infinity;
      if (n > bestCount || (n === bestCount && order < bestOrder)) {
        best = t;
        bestCount = n;
        bestOrder = order;
      }
    }
    return best;
  };

  const sheetGroups = [...sheetMap.entries()].map(([sheetName, courses]) => ({
    sheetName,
    sheetIndex: courses[0].sheetIndex ?? 0,
    owner: sheetOwnerOf(courses),
    courses: courses.sort((a, b) => (a.orderInSheet ?? 0) - (b.orderInSheet ?? 0))
  }));

  // 按师资排课顺序排子表（v5.37）：师资A 的子表（课程数量降序）→ 师资B 的子表（课程数量降序）→ …
  const sheetsByOwner = new Map(); // teacher -> [{sheetName, sheetIndex, courses}]
  const leftoverSheets = [];
  for (const s of sheetGroups) {
    if (s.owner && teacherRankIndex.has(s.owner)) {
      if (!sheetsByOwner.has(s.owner)) sheetsByOwner.set(s.owner, []);
      sheetsByOwner.get(s.owner).push(s);
    } else {
      leftoverSheets.push(s);
    }
  }
  const sortedSheets = [];
  for (const r of teacherRanking) {
    const sheets = sheetsByOwner.get(r.teacher);
    if (!sheets || sheets.length === 0) continue;
    sheets.sort((a, b) => {
      // 课程数量降序（数量多的子表优先排课）；数量相同按子表出现顺序
      if (b.courses.length !== a.courses.length) return b.courses.length - a.courses.length;
      return (a.sheetIndex ?? 0) - (b.sheetIndex ?? 0);
    });
    sortedSheets.push(...sheets);
  }
  // 无归属师资的子表按出现顺序兜底
  sortedSheets.push(...leftoverSheets.sort((a, b) => (a.sheetIndex ?? 0) - (b.sheetIndex ?? 0)));

  const diagnostics = {
    teacherStats: [],
    classStats: [],
    sheetStats: [],
    schedulingOrder: sortedSheets.map(s => `${s.sheetName}(${s.courses.length}门)`),
    // v5.36：师资难易程度评估 + 师资理论排课次序（先科目，科目内难易程度降序）
    teacherOrder: teacherRanking.map((r, i) => ({
      order: i + 1,
      teacher: r.teacher,
      subject: r.subject,
      subjectPriority: r.subjectPriority,
      courseMinutes: r.courseMinutes,
      availMinutes: r.availMinutes,
      difficulty: r.difficulty,
      difficultyPercent: r.difficulty === Infinity ? null : Math.round(r.difficulty * 1000) / 10
    }))
  };
  // 排课轨迹：逐个课程记录排课决策（含排课时刻的师资-班级空闲时间表快照），供生成排课报告
  const reportSteps = [];

  // 已确定日期的合班课：key = 课程名称|师资 → { date, startTime, endTime, fromSheet }
  const mergedScheduleMap = new Map();

  // v5.33 / v5.34：合班课跨子表递增补充约束
  // v5.33 曾让合班课脱离所在子表课程顺序，独立于同班普通课日期递增（导致合班课如
  // Sheet5 中「证明题（一）」早于其行序之前的 8 门高数课）。v5.34 起合班课回归
  // 「与所在子表课程体系顺序一起排课」：递增约束取「子表内同班的上一门课程日期」
  // 与「该师资最近一门合班课日期」的较大值——先排的含合班课子表（课程最多者）整体
  // 排课确定日期，后表合班课对齐该日期，跨子表合班课顺序不会回退。
  const lastMergeDateByTeacher = {};

  // v5.57：排课轨迹记录 —— 已成功排课课程按来源子表分组（供报告展示「各子表排第一节课时，
  // 师资-班级空闲时间表已减去的来源子表课程」）；sheetFirstLessons 逐子表记录第一门实际排课
  // （非对齐）课程排课瞬间的师资-班级空闲时间表快照及其排除来源。
  const scheduledBySheet = new Map(); // sheetName -> [{orderInSheet, courseName, classType, teacher, date, startTime, endTime}]
  const sheetFirstLessons = [];       // {sheetName, 课程信息, availability 快照, tailReserve, excluded}

  // ================================================================
  // 4. 逐子表排课（子表内严格按行顺序）
  // ================================================================
  for (const sheet of sortedSheets) {
    console.log(`\n=== 子表: ${sheet.sheetName}（${sheet.courses.length} 门课程，严格按行顺序排课）===`);

    // v5.49：首次排含合班课子表 —— 计算合班课占比并预留该月尾段日期给合班课
    // 用户规则：首次排含合班课的子表时，按「合班课节数 ÷ 子表总课数量」计算占比，
    // 乘以 130% 得到尾段比例（N = 合班课数量 ÷ 总课数量 × 130%，如 3/8 → 48.75%）；
    // 尾段天数 = 当月天数 × N，取整（如 30 × 48.75% = 14.625 → 15 天，即 9 月 16-30 日）。
    // 生成师资-班级空闲时间表时，将该月后该比例日期中「合班课其他班级」已排课程时间
    // 一并扣除，使子表内普通课避开尾段，为合班课（需多个班级同时空闲）腾出位置。
    // 仅首次排课的子表生效：本子表合班课日期一旦确定（mergedScheduleMap），
    // 后续子表同名合班课直接对齐，不再重复预留。
    let tailReserve = null;
    {
      const mergeCoursesInSheet = sheet.courses.filter(c => isMergeCourse(c));
      const firstTimeMerge = mergeCoursesInSheet.find(c => !mergedScheduleMap.has(`${c.courseName}|${c.teacher}`));
      if (firstTimeMerge && sheet.courses.length > 1) {
        const mergeCount = mergeCoursesInSheet.length;
        // 尾段比例 N = 合班课数量 ÷ 子表总课数量 × 130%；尾段天数 = 当月天数 × N，取整
        // （不设 50% 上限；仅保留结构兜底：至少留 1 天给普通课、至多整月减 1 天）
        const ratio = (mergeCount / sheet.courses.length) * 1.3;
        const tailCount = Math.min(allMonthDates.length - 1, Math.max(1, Math.round(allMonthDates.length * ratio)));
        const tailDates = allMonthDates.slice(-tailCount);
        const mergeClasses = new Set();
        for (const c of mergeCoursesInSheet) {
          for (const cls of splitClassTypes(c.classType)) mergeClasses.add(cls);
        }
        tailReserve = { dates: tailDates, otherClasses: [...mergeClasses] };
        console.log(`  [尾段预留 v5.49] ${sheet.sheetName}：合班课 ${mergeCount}/${sheet.courses.length} 门（占比 ${Math.round((mergeCount / sheet.courses.length) * 100)}% × 130% = ${(ratio * 100).toFixed(2)}% → 该月后 ${tailCount} 天：${tailDates[0]} ~ ${tailDates[tailDates.length - 1]} 中合班课其他班级已排时间）`);
      }
    }

    // v5.59：已排日期合班课之后截断（cutAfter）——
    // 若本子表含有「已排日期」的合班课（mergedScheduleMap 命中，日期由先前排课的子表确定，
    // 或本子表内先排的合班课已定日期），则在生成本子表师资-班级空闲时间表时，
    // 删除该子表第一个合班课时间段之后的所有空闲时间（用户规则：如合班课 8/22 17:00-19:00
    // 与 8/25 07:00-09:00，则删除所有 8/22 16:55——开始时间−AVAIL_REMOVE_PAD 分钟——之后
    // 的空闲时间），使本子表普通课的候选时间域收缩到第一个合班课之前。
    // 注意：仅在「排课开始前已确定」的第一个合班课生效（合班课行本身不受此约束——
    // 后表合班课走对齐排课、不消耗此空闲表；本子表首次定日期的合班课排课时其日期尚未
    // 确定，cutAfter 为 null，不会把后续合班课排死）。
    let sheetCutAfter = null;
    {
      const firstFixedMerge = sheet.courses.find(c => isMergeCourse(c) && mergedScheduleMap.has(`${c.courseName}|${c.teacher}`));
      if (firstFixedMerge) {
        const fixed = mergedScheduleMap.get(`${firstFixedMerge.courseName}|${firstFixedMerge.teacher}`);
        sheetCutAfter = {
          date: fixed.date,
          startTime: minutesToTime(Math.max(0, timeToMinutes(fixed.startTime) - AVAIL_REMOVE_PAD)),
          courseName: firstFixedMerge.courseName,
          classType: firstFixedMerge.classType,
          mergeDate: fixed.date,
          mergeStart: fixed.startTime,
          fromSheet: fixed.fromSheet
        };
        console.log(`  [合班课截断 v5.59] ${sheet.sheetName}：已排日期合班课「${firstFixedMerge.courseName}」（${fixed.date} ${fixed.startTime}，日期由「${fixed.fromSheet}」确定）之后的空闲时间全部删除（切割时刻 ${sheetCutAfter.date} ${sheetCutAfter.startTime}，即开始时间−${AVAIL_REMOVE_PAD} 分钟缓冲）`);
      }
    }

    // v5.58：每张子表排课前，基于「当前全局 ctx（已含先前子表排课的师资/班级时段占用 +
    // 本子表尾段预留）」重新生成该子表的整体分散锚点方案 —— 所有模拟排课策略均在
    // 「该子表排课瞬间的师资-班级空闲时间表」基础上模拟，模拟槽位不会落在真实空闲表之外。
    {
      const builtPlans = buildDispersionPlans(newCourseSystemData, monthAvailability, allMonthDates, ctx, tailReserve, sheet.sheetName, sheetCutAfter, mergedScheduleMap);
      const sheetPlan = builtPlans.get(sheet.sheetName);
      if (sheetPlan) dispersionPlans.set(sheet.sheetName, sheetPlan);
      if (!!process.env.SCHEDULE_DEBUG) {
        console.log(`  [分散方案 v5.58] ${sheet.sheetName} 基于当前 ctx 即时构建（先前子表已排 ${ctx.scheduledCourses.length} 门）锚点: ${(sheetPlan ? sheetPlan.slots.map(s => (s ? s.date.slice(5) : '—')) : []).join(', ')}`);
      }
    }

    let sheetScheduled = 0;
    let sheetAligned = 0;
    let sheetFailed = 0;
    let firstLessonDone = false; // v5.57：本子表第一门实际排课（非对齐）课程的快照是否已记录

    // 子表内按班级维度维护"上一门课程日期"（v5.32）：
    // 同一班级的课程严格按行顺序日期递增；不同班级互不阻塞；
    // 合班课取各组成班级的最晚日期作为递增约束，排课后推进所有相关班级。
    const prevDateByClass = {};
    const getCoursePrevDate = (classes) => {
      let maxDate = null;
      for (const cls of classes) {
        const d = prevDateByClass[cls];
        if (d && (!maxDate || d > maxDate)) maxDate = d;
      }
      return maxDate;
    };
    const advancePrevDates = (classes, date) => {
      for (const cls of classes) {
        const cur = prevDateByClass[cls];
        // 取最大日期，防止合班课等排到更早日期时把班级递增链回退
        prevDateByClass[cls] = cur && cur > date ? cur : date;
      }
    };
    const advanceMergeDate = (teacher, date) => {
      // 实验开关：NO_MERGE_ADVANCE=1 时禁用跨子表合班课日期推进（诊断用）
      if (process.env.NO_MERGE_ADVANCE === '1') return;
      const cur = lastMergeDateByTeacher[teacher];
      lastMergeDateByTeacher[teacher] = cur && cur > date ? cur : date;
    };

    // v5.34：后处理子表中，位于「已确定日期合班课」之前的普通课，
    // 须限定在该合班课日期之前排课（用户规则：从本月初到第一个合班课日期前一天）。
    // 逐行（行序）扫描：普通课取「其后最近一个已确定日期合班课」的日期前一天作为上界；
    // 合班课行自身不受此上界约束（主子表内合班课按子表行序自然递增，后表合班课直接对齐）。
    // v5.61：锚点分散性不再依赖独立 before-merge 锚点（v5.46 双轨已删除）—— 模拟排课已把
    // 已定日期合班课固定槽纳入整体锚点（硬约束），且普通课受 cutAfter 截断（第一个已定
    // 合班课开始时间 −5 分钟后空闲全删），整体锚点天然承载「普通课不晚于第一个合班课」语义；
    // 此处 latestDate 上界继续作为排课硬约束兜底。
    const mergeUpperBefore = new Map(); // courseItem -> latestDate（合班课日期前一天）
    let nextMergeDate = null;
    for (let i = sheet.courses.length - 1; i >= 0; i--) {
      const c = sheet.courses[i];
      if (isMergeCourse(c)) {
        const fixed = mergedScheduleMap.get(`${c.courseName}|${c.teacher}`);
        if (fixed) nextMergeDate = fixed.date;
        mergeUpperBefore.set(c, null);
      } else {
        mergeUpperBefore.set(c, nextMergeDate ? dayBefore(nextMergeDate) : null);
      }
    }

    for (let idx = 0; idx < sheet.courses.length; idx++) {
      const courseItem = sheet.courses[idx];
      const classes = splitClassTypes(courseItem.classType);

      // ---- 排课轨迹：本步记录（状态/时间槽/递增约束/空闲表快照在排课过程中填充） ----
      const tRank = teacherRankIndex.get(courseItem.teacher);
      const step = {
        sheetName: sheet.sheetName,
        orderInSheet: courseItem.orderInSheet,
        courseName: courseItem.courseName,
        classType: courseItem.classType,
        teacher: courseItem.teacher,
        // v5.36：该师资的科目（先科目后难易程度，见师资难易程度评估）
        subject: tRank ? (tRank.subject || '未收录科目') : '—',
        teacherOrder: tRank ? tRank.order : null,
        difficultyPercent: tRank ? formatDifficulty(tRank.difficulty) : '—',
        isMerge: isMergeCourse(courseItem),
        status: '',
        slot: null,
        phase: '',
        prevDate: null,
        latestDate: null,
        note: '',
        availability: [] // 排课时刻的师资-班级空闲时间表快照
      };

      // ---- 合班课去重对齐：同一门合班课已在先前子表确定日期 → 不重复排，对齐该日期 ----
      const mergeKey = `${courseItem.courseName}|${courseItem.teacher}`;
      // v5.61：子表整体分散方案锚点（槽位与课程一一对应，含已定合班课固定槽），
      // 在对齐分支与正常排课分支共用（对齐课同样消耗其对应槽位序号）
      const planEntry = dispersionPlans.get(sheet.sheetName);
      if (isMergeCourse(courseItem) && mergedScheduleMap.has(mergeKey)) {
        const fixed = mergedScheduleMap.get(mergeKey);
        newCourseSystemData[courseItem.originalIndex].scheduled = true;
        sheetScheduled++;
        sheetAligned++;
        // 合班课日期参与相关班级的递增链（同班后续课程日期不得早于它）
        advancePrevDates(classes, fixed.date);
        advanceMergeDate(courseItem.teacher, fixed.date);
        // v5.42：对齐课不再写入课程结果 —— 界面中同一门合班课只显示一次
        //（由先排子表那次排课展示）；时间槽已在先排子表注册，不重复注册；
        // 课程体系表中该行仍标记为已排课（scheduled=true），日期与先排子表一致。
        step.status = 'aligned';
        step.slot = { date: fixed.date, startTime: fixed.startTime, endTime: fixed.endTime };
        step.note = `日期已在子表「${fixed.fromSheet}」确定，对齐排课（界面合班课只显示一次）`;
        reportSteps.push(step);
        // v5.61：锚点槽位序列与课程一一对应（含已定合班课固定槽），对齐课同样消耗其
        // 对应槽位序号，避免后续普通课取错槽（v5.41「对齐课不消耗锚点」仅为旧双轨遗留）
        if (planEntry) planEntry.index++;
        console.log(`  [合班对齐] ${courseItem.courseName} [${courseItem.classType}] → ${fixed.date} ${fixed.startTime}-${fixed.endTime}（日期已在子表「${fixed.fromSheet}」确定）`);
        continue;
      }

      // ---- 正常排课（v5.34：合班课与所在子表课程体系顺序一起排课） ----
      // 递增约束取「子表内同班的上一门课程日期」与「该师资最近一门合班课日期」的较大值；
      // 普通课取涉及班级中最晚的上一门日期。
      const sheetPrevDate = getCoursePrevDate(classes);
      const globalMergePrev = lastMergeDateByTeacher[courseItem.teacher] || null;
      const prevDate = isMergeCourse(courseItem)
        ? (sheetPrevDate && globalMergePrev) ? (sheetPrevDate > globalMergePrev ? sheetPrevDate : globalMergePrev)
          : (sheetPrevDate || globalMergePrev)
        : sheetPrevDate;
      // 上界：仅后处理子表中位于已定日期合班课之前的普通课生效（其余为 null）
      const latestDate = isMergeCourse(courseItem) ? null : (mergeUpperBefore.get(courseItem) || null);
      // v5.34.2：候选日期紧张（只够排完本课及后续同师资课程）时强制尽早排，
      // 避免分散度偏好把本课拖到偏后日期，占掉后续同师资课程的可用日期
      // v5.50：只统计「排课区间与本课有交集」的后续同师资课程 —— 区间完全错开的
      // 课程（如本课 10-08~10-15、后续 10-20~10-31）不可能占用本课区间内的日期，
      // 计入会使紧区间课程因「其后可用日期不足」被全部禁选（区间不一致子表前排失败）。
      // 未填写区间（不限）的课程保守视为与任何区间相交。
      let reserveAfter = 1; // 至少本课程自身需要 1 个日期
      for (let j = idx + 1; j < sheet.courses.length; j++) {
        const later = sheet.courses[j];
        if (later.teacher !== courseItem.teacher) continue;
        // 已在先前子表确定日期的合班课仅对齐、不占用新日期，不计入
        const laterMergeKey = `${later.courseName}|${later.teacher}`;
        if (isMergeCourse(later) && mergedScheduleMap.has(laterMergeKey)) continue;
        if (!rangesOverlap(courseItem, later)) continue; // v5.50：区间不重叠的课程不占用本课日期预算
        reserveAfter++;
      }
      // v5.41/v5.51：分散方案锚点槽位——以子表为单位整体分散（合班课与子表前面全部课程
      // 共享同一套锚点序列），模拟排课产出「日期+时段」槽位，第 idx 门课取方案中第 idx 个
      // 槽位，作为 preferredSlot 传递（槽位完整可用时直接命中；该槽被占用/不可行时
      // tryScheduleCourse 按日期近邻回退与评分逻辑平滑接管，不会造成硬失败）。
      // v5.61：模拟阶段已将已定日期合班课固定槽纳入（与实际对齐、不再自由模拟），普通课
      // 受 cutAfter 截断（第一个已定合班课开始时间 −5 分钟后空闲全删）—— 子表整体锚点已
      // 天然承载 v5.46「before-merge 段」语义，故删除 beforeMergePlan 双轨，统一取整体锚点，
      // 「选中策略（模拟）/最终排课（主排）」同源一致。
      const preferredSlot = planEntry ? (planEntry.slots[planEntry.index] || null) : null;
      // v5.59：合班课行本身不受"第一个合班课之后截断"约束（后表合班课走对齐、本子表首次
      // 定日期时其日期尚未确定），仅普通课的候选时间域收缩到第一个已排日期合班课之前
      const courseCutAfter = isMergeCourse(courseItem) ? null : sheetCutAfter;
      // v5.72：合班课传入跨子表推进日期（globalMergePrev）与子表内链下界（sheetPrevDate），
      // 第一阶段失败时可将推进分量逐天前移重试（不越过子表内链下界）；非合班课不启用。
      const slot = scheduleCourse(ctx, courseItem, monthAvailability, prevDate, latestDate, isMergeCourse(courseItem), reserveAfter, step, preferredSlot, tailReserve, courseCutAfter, isMergeCourse(courseItem) ? globalMergePrev : null, isMergeCourse(courseItem) ? sheetPrevDate : null);
      // v5.57：记录本子表第一门实际排课（非对齐）课程排课瞬间的师资-班级空闲时间表快照，
      // 以及该时刻已从空闲表中扣除的来源（此前各子表已成功排课并注册的课程时段，子表整块
      // 顺序排课时第一课尚无本子表课程占用，故来源均为先前子表）。
      // v5.59：同时记录本子表的"合班课之后截断"信息（若本子表含有已排日期合班课）。
      if (!firstLessonDone) {
        firstLessonDone = true;
        sheetFirstLessons.push({
          sheetName: sheet.sheetName,
          orderInSheet: courseItem.orderInSheet,
          courseName: courseItem.courseName,
          classType: courseItem.classType,
          teacher: courseItem.teacher,
          status: slot ? 'scheduled' : (step.phase === 'makeup' ? 'makeup-failed' : 'failed'),
          slot: slot ? { date: slot.date, startTime: slot.startTime, endTime: slot.endTime } : null,
          availability: (step.availability || []).map(a => ({ ...a })),
          cutAfter: courseCutAfter ? { ...courseCutAfter } : null,
          tailReserve: tailReserve ? {
            tailCount: tailReserve.dates.length,
            tailFrom: tailReserve.dates[0],
            tailTo: tailReserve.dates[tailReserve.dates.length - 1],
            otherClasses: [...tailReserve.otherClasses]
          } : null,
          // v5.60：只记录「确实参与本子表第一课空闲表占用扣除」的来源课程
          //（同师资 / 同班级 / 尾段预留其他班级在尾段日期内），此前版本把当时所有
          // 已排子表的全部课程都记为扣除来源，导致报告中出现与本子表师资/班级无关的课程
          excluded: [...scheduledBySheet.entries()]
            .map(([sn, arr]) => {
              const relevant = arr.filter(a => isRelevantExcludedCourse(a, courseItem, tailReserve));
              return relevant.length > 0
                ? { sheetName: sn, courses: relevant.map(a => ({ ...a })) }
                : null;
            })
            .filter(Boolean)
        });
      }
      // 记录本步的递增约束取值（供排课报告说明排课逻辑）
      step.prevDate = prevDate;
      step.latestDate = latestDate;
      if (slot) {
        commitSlot(ctx, newCourseSystemData, courseItem, courseItem.teacher, slot);
        sheetScheduled++;
        // v5.57：登记该课为其来源子表的已排课程（供后续子表「第一课时空闲表已扣除来源」展示）
        if (!scheduledBySheet.has(sheet.sheetName)) scheduledBySheet.set(sheet.sheetName, []);
        scheduledBySheet.get(sheet.sheetName).push({
          orderInSheet: courseItem.orderInSheet,
          courseName: courseItem.courseName,
          classType: courseItem.classType,
          teacher: courseItem.teacher,
          date: slot.date,
          startTime: slot.startTime,
          endTime: slot.endTime
        });
        advancePrevDates(classes, slot.date);
        // v5.41：锚点序号仅在新排（非对齐）成功后推进（对齐课不消耗锚点）
        // v5.61：已删除 beforeMergePlan 双轨，普通课与合班课统一推进子表整体锚点序号
        if (planEntry) planEntry.index++;
        step.status = 'scheduled';
        step.slot = { date: slot.date, startTime: slot.startTime, endTime: slot.endTime };
        if (isMergeCourse(courseItem)) {
          advanceMergeDate(courseItem.teacher, slot.date);
          mergedScheduleMap.set(mergeKey, {
            date: slot.date,
            startTime: slot.startTime,
            endTime: slot.endTime,
            fromSheet: sheet.sheetName
          });
          // v5.68：本子表首次确定合班课日期时**不再**回填截断信息 —— 第一门课快照必须如实
          // 反映排课瞬间的空闲表：此刻合班课日期尚未确定，快照不含「合班课之后截断」。
          // 仅排课前已确定的合班课（sheetCutAfter 命中，日期由先前子表确定）才在快照上截断
          // （见 L475 记录的 courseCutAfter）。即：合班课真正确定后再排的第二个子表
          // （如 Sheet1 (2)）才需减去该合班课之后的所有空闲时间。
          step.note = '合班日期由此子表确定，后续子表同名合班课将对齐该日期';
          console.log(`  [合班定日期] ${courseItem.courseName} [${courseItem.classType}] → ${slot.date} ${slot.startTime}-${slot.endTime}（后续子表将对齐该日期）`);
        }
      } else {
        sheetFailed++;
        step.status = 'failed';
        step.note = '因无师资-课程空闲时间，排课失败';
      }
      reportSteps.push(step);
    }

    // v5.52：该子表分散方案候选明细（各策略评分 + 维度详情 + 模拟槽位序列），
    // 随子表统计一起暴露到 diagnostics.sheetStats，供排课报告展示
    // 「各分散策略详情与评分 + 模拟日历表」（candidates 为模拟阶段方案，含策略名/评分/detail/槽位）
    const sheetPlanEntry = dispersionPlans.get(sheet.sheetName);
    diagnostics.sheetStats.push({
      sheetName: sheet.sheetName,
      sheetIndex: sheet.sheetIndex,
      totalCourses: sheet.courses.length,
      scheduled: sheetScheduled,
      aligned: sheetAligned,
      failed: sheetFailed,
      teachers: [...new Set(sheet.courses.map(c => c.teacher))],
      dispersionPlan: sheetPlanEntry && sheetPlanEntry.candidates
        ? {
            totalCourses: sheetPlanEntry.totalCourses ?? sheet.courses.length,
            simulatedCourses: sheetPlanEntry.simulatedCourses ?? sheet.courses.length,
            selectedStrategy: sheetPlanEntry.selectedStrategy || null,
            selectedScore: sheetPlanEntry.selectedScore ?? null,
            candidates: sheetPlanEntry.candidates
          }
        : null
    });
    console.log(`[子表完成] ${sheet.sheetName}: ${sheetScheduled}/${sheet.courses.length} 成功（其中对齐 ${sheetAligned}，失败 ${sheetFailed}）\n`);
  }

  // ================================================================
  // 5. 诊断信息：师资统计 + 班级分布
  // ================================================================
  const allTeachersSet = new Set(newCourseSystemData.map(c => c.teacher));
  diagnostics.teacherStats = [...allTeachersSet].map(t => {
    const teacherCourses = newCourseSystemData.filter(c => c.teacher === t);
    const scheduledCount = teacherCourses.filter(c => c.scheduled).length;
    const availDays = new Set(monthAvailability.filter(a => a.teacher === t).map(a => a.date)).size;
    return {
      teacher: t,
      totalCourses: teacherCourses.length,
      scheduled: scheduledCount,
      failed: teacherCourses.length - scheduledCount,
      availableDates: availDays
    };
  });

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

  // v5.42：成功数以「课程体系表中已排课的行数」计算（含对齐课），
  // 与界面显示的排课结果（courses）不一致是预期 —— 对齐课只在界面显示一次
  const successCount = newCourseSystemData.filter(c => c.scheduled).length;
  const failedCount = newCourseSystemData.filter(c => !c.scheduled).length;

  // v5.50：子表区间一致性诊断 —— 子表内各课程起始/终止日期不完全一致时（多段
  // 排课窗口），提示存在区间断档与锚点失配风险，建议按段拆分子表或统一区间。
  // 仅用于排课报告/诊断展示，不影响排课结果。
  diagnostics.sheetRangeStats = sortedSheets.map(s => {
    const starts = [...new Set(s.courses.map(c => c.startDate).filter(Boolean))].sort();
    const ends = [...new Set(s.courses.map(c => c.endDate).filter(Boolean))].sort();
    return {
      sheetName: s.sheetName,
      startDate: starts.length === 1 ? starts[0] : (starts.length > 1 ? `[${starts.join(',')}]` : null),
      endDate: ends.length === 1 ? ends[0] : (ends.length > 1 ? `[${ends.join(',')}]` : null),
      rangeCount: Math.max(starts.length, ends.length),
      inconsistent: starts.length > 1 || ends.length > 1
    };
  });

  return {
    ok: true,
    courses: ctx.scheduledCourses,
    courseSystemData: newCourseSystemData,
    successCount,
    failedCount,
    diagnostics,
    scheduleTrace: {
      generatedAt: new Date().toISOString(),
      steps: reportSteps,
      firstLessons: sheetFirstLessons // v5.57：各子表排第一节课时的师资-班级空闲时间表快照 + 已扣除来源
    }
  };
}

/**
 * 返回指定日期（YYYY-MM-DD）的前一天
 */
function dayBefore(dateStr) {
  const dt = new Date(dateStr);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/**
 * v5.50：判断两门课是否可能共用排课日期（排课区间有交集）
 * 区间以各自 startDate/endDate 定义；未填写（null/undefined/''）视为不限（与任何区间相交）。
 * 例：A=[10-08,10-15] 与 B=[10-20,10-31] → B 起点晚于 A 终点，无交集 → false（B 不占用 A 区间的日期）
 * 作用：日期预算 reserveAfter 只统计与当前课程区间有交集的后续课程，
 *       避免区间完全错开的课程挤占紧区间的日期预算（修复区间不一致子表前排课失败）。
 */
function rangesOverlap(a, b) {
  const aStart = a?.startDate || null;
  const aEnd = a?.endDate || null;
  const bStart = b?.startDate || null;
  const bEnd = b?.endDate || null;
  if (aStart && bEnd && bEnd < aStart) return false; // b 完全早于 a
  if (bStart && aEnd && bStart > aEnd) return false; // b 完全晚于 a
  return true;
}

/**
 * v5.50：判断日期是否落在课程排课区间内（未填写区间视为不限）
 */
function inRangeSafe(date, c) {
  if (c?.startDate && date < c.startDate) return false;
  if (c?.endDate && date > c.endDate) return false;
  return true;
}

/**
 * 计算排课月份的整月日期列表（v5.40，供分散方案按整月时间轴评分）
 * 优先取 state.currentDate（Date），缺失时回退到第一个空闲数据的日期
 * @param {Date|string|undefined} currentDate
 * @param {Array} availabilityData
 * @returns {string[]} ['YYYY-MM-01', ..., 'YYYY-MM-月末']
 */
function getMonthDates(currentDate, availabilityData) {
  let d = currentDate instanceof Date && !isNaN(currentDate) ? currentDate : new Date(currentDate);
  if (isNaN(d) && availabilityData && availabilityData.length > 0) d = new Date(availabilityData[0].date);
  if (isNaN(d)) d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const daysInMonth = new Date(y, m, 0).getDate();
  const dates = [];
  for (let i = 1; i <= daysInMonth; i++) {
    dates.push(`${y}-${String(m).padStart(2, '0')}-${String(i).padStart(2, '0')}`);
  }
  return dates;
}

/**
 * 构建「子表整体」维度的分散方案（v5.41；v5.58 起改为逐子表排课前即时调用）
 * 合班课与所在子表前面的普通课程共享同一套分散锚点序列：
 * 以子表为单位（而非 v5.40 的「师资||班级」）生成锚点，保证子表全部课程
 * （普通课 + 合班课）整体均匀分散，合班课不再与前面课程脱节。
 * 子表空闲日期取子表内各师资空闲日期并集（合班课师资可能与普通课师资不同）。
 * v5.58：新增 ctx 参数 —— 模拟排课基于「排到该子表时的全局排课上下文（已含先前子表
 * 排课的师资/班级时段占用 + 本子表尾段预留）」生成，所有模拟策略槽位均落在
 * 该子表排课瞬间的真实师资-班级空闲时间表之内。
 * @param {Array} newCourseSystemData 课程体系数据（已重置 scheduled）
 * @param {Array} monthAvailability 师资空闲时间
 * @param {string[]} allMonthDates 整月日期
 * @param {Object|null} ctx 全局排课上下文（先前子表已排课程占用）
 * @param {Object|null} tailReserve 尾段预留配置（{dates, otherClasses}，随子表传递）
 * @param {string|null} onlySheetName 仅构建指定子表（null 时构建全部子表）
 * @param {Object|null} cutAfter 合班课之后截断配置（v5.59，{date, startTime}，随子表传递，
 *        含已排日期合班课的子表生成空闲表时删除第一个合班课之后的所有空闲时间）
 * @param {Map|null} [mergedScheduleMap] 已定日期合班课表（v5.61，courseName|teacher -> 固定槽），
 *        用于把本子表内已定日期合班课作为硬性槽位约束纳入模拟排课
 * @returns {Map<string, {dates: string[], index: number}>} key = sheetName
 */
function buildDispersionPlans(newCourseSystemData, monthAvailability, allMonthDates, ctx = null, tailReserve = null, onlySheetName = null, cutAfter = null, mergedScheduleMap = null) {
  const plans = new Map();
  const groups = new Map();
  for (const c of newCourseSystemData) {
    if (!c.teacher) continue;
    const sheet = c.sheetName || `sheet-${c.sheetIndex ?? 0}`;
    if (!groups.has(sheet)) groups.set(sheet, []);
    groups.get(sheet).push(c);
  }
  for (const [sheetName, courses] of groups) {
    if (onlySheetName && sheetName !== onlySheetName) continue;
    // 子表内各师资空闲日期并集
    const teacherSet = [...new Set(courses.map(c => c.teacher))];
    const availableDates = [...new Set(monthAvailability.filter(a => teacherSet.includes(a.teacher)).map(a => a.date))].sort();
    if (availableDates.length === 0) continue;
    let dates = [];
    let slots = []; // v5.51：锚点槽位序列 [{date, startTime, endTime, isEvening}]
    let sheetCandidates = null; // v5.52：候选方案明细暂存（最终 set 时合并，避免被覆盖）
    // v5.61:声明移到 try 外（锚点校正循环复用），try 内赋值
    let fixedMergeSlots = null;
    try {
      // v5.47：少课锚点在「子表课程区间」内等分，避免锚点落在课程区间外被过滤
      // （如 Sheet6 区间 09-15~09-30，整月等分锚点 09-09 在区间外）
      // v5.51：传入真实 courses，使模拟排课进入「师资×班级」维度、逐课遵循课程区间
      const rangeStarts = courses.map(c => c.startDate).filter(Boolean).sort();
      const rangeEnds = courses.map(c => c.endDate).filter(Boolean).sort();
      const rangeStart = rangeStarts[0] || null;
      const rangeEnd = rangeEnds[rangeEnds.length - 1] || null;
      // v5.61：本子表内「已由先前子表确定日期」的合班课固定槽 —— 模拟排课将其作为硬性槽位
      // 约束（不再自由模拟），使候选方案的槽位序列与主排（合班对齐 + 普通课整体锚点取用）
      // 完全同源，消除「选中策略展示 vs 最终排课结果」不一致。
      fixedMergeSlots = courses.map(c => {
        if (!mergedScheduleMap) return null;
        const k = `${c.courseName}|${c.teacher}`;
        const m = mergedScheduleMap.get(k);
        return m ? { date: m.date, startTime: m.startTime, endTime: m.endTime } : null;
      });
      const plan = findBestDispersionPlan(availableDates, courses.length, courses[0].teacher, monthAvailability, allMonthDates, rangeStart, rangeEnd, courses, ctx, tailReserve, cutAfter, fixedMergeSlots);
      if (plan && plan.primary) {
        // v5.52：候选方案明细（各策略评分 + 维度详情 + 模拟槽位序列）随锚点一起保留，
        // 供排课报告展示「各分散策略详情与评分 + 模拟日历表」（candidates 为模拟阶段的方案，
        // 评分与槽位一一对应；锚点校正仅作用于最终落用的槽位）
        if (plan.candidates && plan.candidates.length > 0) {
          const fixedMergeCount = fixedMergeSlots ? fixedMergeSlots.filter(Boolean).length : 0;
          sheetCandidates = {
            // v5.63：透传总课程数 / 实际参与模拟的自由课数（含已定日期合班课的子表，
            // 固定合班课不参与模拟，仅剩余自由课做多策略模拟选优），供排课报告展示
            totalCourses: courses.length,
            simulatedCourses: courses.length - fixedMergeCount,
            candidates: plan.candidates.map(c => ({
              strategy: c.strategy,
              score: c.score,
              baseScore: c.baseScore,
              timeScoreAvg: c.timeScoreAvg,
              detail: c.detail,
              slots: (c.slots || []).map(s => ({ ...s })),
              dates: [...(c.dates || [])],
              // v5.72：阶段三（非满分槽前后 2 天更优变体）与阶段四（分支组合评分选最优）明细
              stage3: c.stage3 || [],
              stage4: c.stage4 || { branches: 0, validBranches: 0, bestDelta: 0 }
            })),
            selectedStrategy: plan.primary.strategy,
            selectedScore: plan.primary.score
          };
        }
        if (plan.primary.slots && plan.primary.slots.length > 0) {
          slots = [...plan.primary.slots];
          dates = slots.map(s => s.date);
        } else {
          dates = plan.primary.dates ? [...plan.primary.dates] : [];
        }
      }
    } catch (e) {
      console.warn(`[分散方案] ${sheetName} 生成失败：${e && e.message}`);
    }
    // v5.50/v5.51：课程区间不一致时（子表内各课起始/终止日期不同），子表整体锚点
    // 可能落在部分课程的排课区间之外（inCourseRange 会将该日期过滤，锚点失效），
    // 或落在区间断档（如 10-16~10-19 空档）上。逐门校正锚点槽位：
    //   · 锚点本就落在课程区间内 → 保留原槽位（含时段，模拟排课已保证可行）
    //   · 锚点在区间外 → 就近映射到「该课程区间 ∩ 该课程师资可用日期」的最近日期，
    //     此时时段字段置 null（日期被移动，原时段不可信，排课时按日期锚点回退评分）
    //   · 区间内无该师资可用日期 → 保留原槽位（排课评分兜底，正确性由硬约束保障）
    // 区间一致的子表（锚点天然都在并集区间内）校正前后一致，零改动。
    const correctedSlots = [];
    const teacherAvailCache = new Map(); // teacher -> 该师资全部空闲日期（已排序）
    const teacherAvailOf = (t) => {
      if (!teacherAvailCache.has(t)) {
        teacherAvailCache.set(t, [...new Set(monthAvailability.filter(a => a.teacher === t).map(a => a.date))].sort());
      }
      return teacherAvailCache.get(t);
    };
    for (let i = 0; i < courses.length; i++) {
      const c = courses[i];
      const rawSlot = slots[i] || (dates[i] ? { date: dates[i], startTime: null, endTime: null, isEvening: false } : null);
      // v5.61：已定日期合班课固定槽为硬约束（日期/时段由先前子表确定）—— 跳过锚点校正，保持原槽
      if (fixedMergeSlots[i]) { correctedSlots.push(rawSlot); continue; }
      const raw = rawSlot ? rawSlot.date : null;
      if (!c.startDate && !c.endDate) { correctedSlots.push(rawSlot); continue; } // 无区间：锚点不动
      if (raw && inRangeSafe(raw, c)) { correctedSlots.push(rawSlot); continue; }
      if (!!process.env.SCHEDULE_DEBUG) {
        console.log(`  [锚点校正 v5.50] ${sheetName} 第 ${i + 1} 课「${c.courseName}」锚点 ${raw || '—'} 不在区间 ${c.startDate || '*'}-${c.endDate || '*'} 内，就近映射到区间内可用日期`);
      }
      const inRangeAvail = teacherAvailOf(c.teacher).filter(d => inRangeSafe(d, c));
      if (inRangeAvail.length === 0) { correctedSlots.push(rawSlot); continue; }
      if (!raw) { correctedSlots.push({ date: inRangeAvail[0], startTime: null, endTime: null, isEvening: false }); continue; }
      let best = inRangeAvail[0];
      let bestGap = Infinity;
      const rawTime = new Date(raw).getTime();
      for (const d of inRangeAvail) {
        const gap = Math.abs(new Date(d).getTime() - rawTime);
        if (gap < bestGap) { bestGap = gap; best = d; }
      }
      correctedSlots.push({ date: best, startTime: null, endTime: null, isEvening: false });
    }
    plans.set(sheetName, { slots: correctedSlots, index: 0, ...(sheetCandidates || {}) });
    // 详细日志（SCHEDULE_DEBUG=1）：子表锚点 vs 课程区间对照，检查锚点是否落在课程区间外
    if (!!process.env.SCHEDULE_DEBUG) {
      const rangeStarts = courses.map(c => c.startDate || '不限').filter(v => v !== '不限').sort();
      const rangeEnds = courses.map(c => c.endDate || '不限').filter(v => v !== '不限').sort();
      const minStart = rangeStarts[0] || '不限';
      const maxEnd = rangeEnds[rangeEnds.length - 1] || '不限';
      console.log(`[分散锚点] ${sheetName}（${courses.length}门, 师资: ${teacherSet.join('/')}）课程区间 ${minStart}~${maxEnd} | 锚点: ${correctedSlots.map(s => s ? (s.date + (s.startTime ? ` ${s.startTime}-${s.endTime}` : '')) : '—').join(', ')}${correctedSlots.some(s => s && s.date && (s.date < minStart || s.date > maxEnd)) ? '  ⚠ 有锚点落在课程区间外!' : ''}`);
    }
  }
  return plans;
}

/**
 * v5.60：判断某来源课程是否真实参与了「第一课」师资-班级空闲时间表的占用扣除。
 * buildTeacherClassAvailability 的扣除范围 = 同师资已排课程（师资维度，不限班级）
 * + 同班级已排课程（班级维度，不限师资）+ 尾段预留中「合班课其他班级」在尾段日期内的
 * 已排课程（v5.49）。三者皆不匹配的课程不会出现在当前子表的空闲表中，故不应列为
 * 「已减去来源子表课程」（此前版本直接记录当时所有已排子表的全部课程，导致报告中
 * 出现与当前子表师资/班级无关的课程）。
 * @param {Object} course 来源课程记录（{teacher, classType, date, ...}，来自 scheduledBySheet）
 * @param {Object} courseItem 当前子表第一门实际排课课程（快照对应的师资/班级）
 * @param {Object|null} tailReserve 当前子表尾段预留配置（{dates, otherClasses}）
 * @returns {boolean}
 */
function isRelevantExcludedCourse(course, courseItem, tailReserve) {
  // ① 同师资：该师资本人已排课程（师资维度扣除）
  if (course.teacher === courseItem.teacher) return true;
  // ② 同班级：组成班级有交集（班级维度扣除）
  const courseClasses = splitClassTypes(course.classType);
  const thisClasses = splitClassTypes(courseItem.classType);
  if (courseClasses.some(cl => thisClasses.includes(cl))) return true;
  // ③ 尾段预留：合班课「其他班级」在尾段日期内的已排课程
  if (tailReserve && Array.isArray(tailReserve.otherClasses)) {
    if (courseClasses.some(cl => tailReserve.otherClasses.includes(cl))) {
      if (Array.isArray(tailReserve.dates) && tailReserve.dates.includes(String(course.date))) return true;
    }
  }
  return false;
}

/**
 * 排单门课程：先按「师资-班级空闲时间表」正常排课（日期递增保证子表内行顺序），
 * 失败后补排（跳过分散度，使用原始空闲时间，hasConflict 兜底检测冲突）
 * @param {string|null} prevDate 日期递增下界
 * @param {string|null} latestDate 日期上界（v5.34：后子表合班课之前的普通课限定在合班课日期之前）
 * @param {boolean} earliestFirst 尽早优先（v5.34.1：合班课优先排早，避免被晚间时段偏好拖到月末）
 * @param {number} reserveAfter 本课及其后同师资课程所需的日期数量（v5.34.2：日期预算硬约束，
 *                               候选日期之后可用日期不足时禁选，保证后续课程有日期可排）
 * @param {Object|null} preferredSlot 分散方案锚点槽位（v5.51，{date, startTime, endTime}，
 *                                     传给 tryScheduleCourse 锚定奖励；startTime 为 null 时退化为
 *                                     纯日期锚点，由 tryScheduleCourse 按锚点日评分）
 * @param {Object|null} tailReserve 尾段预留配置（v5.49，首次排合班课子表时传入，
 *                                  见 generateSchedule 子表循环；格式 { dates, otherClasses }）
 * @param {Object|null} cutAfter 合班课之后截断配置（v5.59，本子表含有已排日期合班课时传入，
 *                               切割时刻为该合班课开始时间 − AVAIL_REMOVE_PAD；见 generateSchedule 子表循环）
 * @param {string|null} mergeRelaxFrom 跨子表推进日期（v5.72，合班课第一阶段 prevDate 中的
 *                                     lastMergeDateByTeacher 分量；第一阶段失败时逐天前移重试）
 * @param {string|null} mergeRelaxFloor 子表内链下界（v5.72，即 sheetPrevDate——降级不得越过，
 *                                      保住子表内行序递增）
 * @returns {{date, startTime, endTime} | null}
 */
function scheduleCourse(ctx, courseItem, monthAvailability, prevDate, latestDate = null, earliestFirst = false, reserveAfter = 1, trace = null, preferredSlot = null, tailReserve = null, cutAfter = null, mergeRelaxFrom = null, mergeRelaxFloor = null) {
  const teacher = courseItem.teacher;
  const classType = courseItem.classType;
  const durationMinutes = durationToMinutes(courseItem.duration);

  // 构建师资-班级空闲时间表（= 师资空闲 - 已排课占用的师资时间 - 已排课占用的班级时间，v5.39；
  // v5.49：首次排合班课子表时额外扣除该月尾段日期中合班课其他班级已排时间；
  // v5.59：本子表含有已排日期合班课时，截断该合班课开始时间 − AVAIL_REMOVE_PAD 之后的所有碎片）
  const teacherClassAvailability = buildTeacherClassAvailability(monthAvailability, teacher, classType, ctx, {
    ...(tailReserve ? { tailReserve } : {}),
    ...(cutAfter ? { cutAfter } : {})
  });
  // 排课轨迹：保留「排课时刻的师资-班级空闲时间表」快照（供生成排课报告）
  if (trace) trace.availability = teacherClassAvailability.map(a => ({ ...a }));
  if (teacherClassAvailability.length === 0) return null;

  // 临时上下文：用师资-班级空闲时间表替换 monthAvailability，日程映射与全局 ctx 共享
  const teacherCtx = { ...ctx, monthAvailability: teacherClassAvailability };

  const allTeacherDates = [...new Set(teacherClassAvailability.map(a => a.date))].sort();

  // 冲突感知过滤：剔除已被占满的日期
  const feasibleDates = allTeacherDates.filter(d =>
    hasAnyFeasibleSlot(teacherCtx, { teacher, classType, date: d, durationMinutes })
  );
  if (feasibleDates.length === 0) return null;

  // 详细日志（SCHEDULE_DEBUG=1）：排课入参——锚点/递增约束/可行日期
  const preferredLabel = preferredSlot ? (preferredSlot.date + (preferredSlot.startTime ? ` ${preferredSlot.startTime}-${preferredSlot.endTime}` : '')) : 'null';
  if (!!process.env.SCHEDULE_DEBUG) {
    console.log(`[scheduleCourse] ${courseItem.courseName} [${classType}] 师资=${teacher} 区间=${courseItem.startDate || '不限'}~${courseItem.endDate || '不限'} | preferred=${preferredLabel} prevDate=${prevDate} latestDate=${latestDate} earliestFirst=${earliestFirst} reserveAfter=${reserveAfter}`);
    console.log(`  可行日期(${feasibleDates.length}): ${feasibleDates.join(', ')}`);
  }

  // 第一阶段：正常排课（间隔统一 MIN_GAP，保留分散度奖励与时段偏好；
  // 原六级「仅晚上/所有空闲 × 10/5/0 分钟间隔」回退经后台真实数据验证 2-6 级从未触发，
  // 且 useEveningOnly 从未被读取，「仅晚上」语义实际由 timePriority.js 时间分数权重承载）
  // v5.34.2：reserveAfter 作为「日期预算硬约束」下传给 tryScheduleCourse——
  // 候选日期之后可用日期数不足（排不完本课及后续同师资课程）时禁选该日期。
  const slot = tryScheduleCourse(teacherCtx, courseItem, teacher, feasibleDates, MIN_GAP, prevDate, allTeacherDates, preferredSlot, latestDate, earliestFirst, reserveAfter);
  if (slot) {
    if (trace) trace.phase = 'normal';
    return slot;
  }

  // v5.72 合班课跨子表推进「逐天放松」降级：第一阶段（含跨子表推进硬下界）失败时，
  // 将该硬下界中 lastMergeDateByTeacher 的分量逐天前移重试，直至子表内链下界（不过越）。
  // 背景：跨子表推进保证「后子表合班课不早于前子表同师资合班课」的内容顺序，但会把合班课
  // 硬锁在月末；当月末物理可用日期不足（如李旭 10-28/10-31 无可排时间）而 reserveAfter
  // 又要求留足后续日期时，形成确定性死锁（v5.72 报告 9 门失败的主要来源）。
  // 逐天放松能保持顺序破坏最小：优先落在跨子表推进日期的前一天（内容上最接近），
  // 而不是直接去掉推进后按锚点贪心导致写作课早于阅读课穿插（NO_MERGE_ADVANCE 实验现象）。
  if (earliestFirst && mergeRelaxFrom) {
    let relaxDate = dayBefore(mergeRelaxFrom);
    let relaxAttempts = 0;
    while (relaxDate && relaxAttempts < 31) {
      relaxAttempts++;
      if (mergeRelaxFloor && relaxDate < mergeRelaxFloor) break;
      const relaxedSlot = tryScheduleCourse(teacherCtx, courseItem, teacher, feasibleDates, MIN_GAP, relaxDate, allTeacherDates, preferredSlot, latestDate, earliestFirst, reserveAfter);
      if (relaxedSlot) {
        if (trace) trace.phase = 'relaxed';
        return relaxedSlot;
      }
      relaxDate = dayBefore(relaxDate);
    }
  }

  // 第二阶段：补排（使用原始空闲时间，hasConflict 兜底检测冲突）
  const allDates = [...new Set(monthAvailability.filter(a => a.teacher === teacher).map(a => a.date))].sort();
  const makeupSlot = tryScheduleCourse(ctx, courseItem, teacher, allDates, MIN_GAP, prevDate, [], preferredSlot, latestDate, earliestFirst, reserveAfter);
  if (makeupSlot) {
    if (trace) trace.phase = 'makeup';
    return makeupSlot;
  }

  return null;
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
    teacher: teacher,
    type: 'scheduled',
    sourceItemId: itemId
  });
}
