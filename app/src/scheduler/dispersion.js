// 课程分散策略：生成方案 + 评分 + 选择最优方案
// v5.51：分散方案改为「模拟排课生成」——以师资-班级空闲时间表为候选时段池，
//        逐门模拟排课（时段可放性 + 师资并发互斥/班级冲突硬约束），多种策略
//        各产出一种完整可行的分散排课方案（{date, startTime, endTime} 槽位序列），
//        评分（分散度评分）后选择分数最高者作为最终方案。
import { registerSlot, createScheduleContext, buildTeacherClassAvailability, hasConflict } from './scheduleContext.js';
import { calculateTimePriorityScore } from './timePriority.js';
import { EVENING_START, EVENING_END, OPTIMAL_EVENING } from '../config/constants.js';
import { timeToMinutes, minutesToTime, durationToMinutes } from '../utils/dateUtils.js';
import { hasMultipleClasses } from '../utils/classType.js';

/**
 * 创建「基于全局上下文」的模拟上下文（v5.58）：
 * 深拷贝 baseCtx（全局排课上下文）中先前已排子表的课程占用
 * （师资日程 / 班级日程 / 师资-班级每日计数 / 已排课程列表 / 每日课程数），
 * 使模拟排课严格建立在「已扣除先前子表已排课程占用」的师资-班级空闲时间表之上；
 * 模拟上下文与全局 ctx 相互独立 —— 模拟累积不会污染真实排课状态。
 * @param {Array} monthAvailability 当月师资空闲时间
 * @param {Object|null} baseCtx 全局排课上下文（null 时为全新空上下文，兼容旧调用）
 * @returns {Object} 模拟排课上下文
 */
function seedSimContext(monthAvailability, baseCtx) {
  const ctx = createScheduleContext(monthAvailability);
  if (!baseCtx) return ctx;
  const state = JSON.parse(JSON.stringify({
    teacherScheduleByDate: baseCtx.teacherScheduleByDate,
    classScheduleByDate: baseCtx.classScheduleByDate,
    teacherClassScheduleByDate: baseCtx.teacherClassScheduleByDate,
    scheduledCourses: baseCtx.scheduledCourses,
    dayCourseCounts: baseCtx.dayCourseCounts
  }));
  Object.assign(ctx, state);
  return ctx;
}

/** 从 'YYYY-MM-DD' 提取当月第几天 */
function getDayOfMonth(dateStr) {
  return parseInt(dateStr.slice(-2), 10);
}

/**
 * 合班课识别（与 index.js 同一规则，v5.61）：
 * mergeNote 含「合班」标记，或 classType 为多个班级（需多个班级同时空闲）。
 * 模拟排课中合班课不受 cutAfter 截断（与主排 courseCutAfter=null 一致），
 * 已定日期合班课（fixedMergeSlots）则直接落定固定槽。
 */
function isMergeCourse(item) {
  return (item && item.mergeNote && String(item.mergeNote).includes('合班')) || hasMultipleClasses(item && item.classType);
}


/**
 * 两日期相差天数（v5.64）：Date.parse 差值换算，如 X1=10-01 → X2=10-22 = 21，同日 = 0。
 * 「不含端点」的空当计数由调用方自行 -1（如 8/21 → 8/26 空当 = 5-1 = 4 天，与用户口径一致）。
 */
function dateDiffDays(a, b) {
  if (!a || !b) return 0;
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

/**
 * 线性衰减系数（v5.66）：偏差 D 天的项分 = 100×max(0, 1−r·|D|)，r=0.1 → 每偏差 1 天线性扣 10 分、
 * 偏差 ≥10 天归零 —— 偏差 0 分最高、偏差越大分越低。
 *（v5.64 曾为高斯 e^(-0.1·D²)：偏差 1 天 ≈ 90.5、2 天 ≈ 67、3 天 ≈ 40.7，对远偏差惩罚过陡；
 *  v5.66 改为线性，保持「偏差 1 天约扣 10%」的同斜率，远偏差按恒定每 1 天 10 分线性递减。）
 */
const LINEAR_DECAY_STEP = 0.1;

/**
 * 计算分散方案各维度得分明细（v5.64 起「Z 规则分散基础分」；配套排课报告展示评分详情）。
 * 排课前最终版师资-课程空闲时间表区间 [X1, X2]、未定时间课程数 Y：
 *   Z = round((X2-X1-1-Y)/Y) —— 理想排课节奏（相邻课程间隔天数 = Z，起止两端留白各 = Z/2）
 * 三项核心评分（偏差 |D| 越大分越低，线性衰减 100×max(0, 1−0.1·|D|)，v5.66；v5.64 曾为高斯）：
 *   leadEdge      起始留白分：首课日期 W1，dev = (W1-X1-1) - Z/2
 *   tailEdge      终止留白分：末课日期 W2，dev = (X2-W2-1) - Z/2
 *   intervalMatch 间隔匹配分：相邻课程日期间隔 W3（8/21→8/26 = 4 天），dev = W3 - Z（逐对线性取均值）
 * 沿用维度（与旧分散基础分同源）：
 *   uniformity  均匀度分（= 1/(1+间隔标准差) × 50）
 *   coverage    覆盖范围分（= 首末日期跨整月比例 × 100）
 *   midCoverageBonus 中间覆盖奖励（日期落月 10%~90% 区间的比例 × 30，v5.44）
 * 移除维度：minGap / balance / largeGapPenalty / smallGapPenalty / edgeBuffScore
 * （平衡性已由间隔匹配项承接，v5.64 同名替换）。
 * @param {string[]} dates 模拟方案日期（未排序亦可）
 * @param {string[]} allDates 整月所有日期
 * @param {{X1?: string, X2?: string, Y?: number}} [meta] 排课前最终版师资-课程空闲时间表
 *        起始日期 X1、终止日期 X2、未定时间课程数 Y
 */
function computeDispersionScoreDetail(dates, allDates, { X1 = null, X2 = null, Y = null } = {}) {
  const emptyDetail = {
    uniformity: 0, coverage: 0, midCoverageBonus: 0,
    leadEdge: 0, tailEdge: 0, intervalMatch: 0,
    leadGapDays: null, tailGapDays: null, minGapDays: null, maxGapDays: null, Z: 0
  };
  if (dates.length === 0 || !X1 || !X2 || !(Y >= 1)) {
    return { total: -Infinity, detail: emptyDetail };
  }

  const sortedDates = [...dates].sort();
  // 理想节奏 Z（四舍五入）：[X1, X2] 空当总长扣去 Y 天课程后均分给 Y 门课
  const Z = Math.max(0, Math.round((dateDiffDays(X1, X2) - 1 - Y) / Y));
  const idealHalf = Z / 2;
  const linear = (dev) => 100 * Math.max(0, 1 - LINEAR_DECAY_STEP * Math.abs(dev));

  // —— 起始留白 / 终止留白（v5.64）：首课/末课两侧空当天数尽量贴近 Z/2（两端各半）——
  const W1 = sortedDates[0];
  const W2 = sortedDates[sortedDates.length - 1];
  const leadGapDays = dateDiffDays(X1, W1) - 1;
  const tailGapDays = dateDiffDays(W2, X2) - 1;
  const leadEdge = linear(leadGapDays - idealHalf);
  const tailEdge = linear(tailGapDays - idealHalf);

  // —— 间隔匹配（v5.64）：相邻课程间隔 W3 尽量贴近 Z，逐对线性衰减后取均值 ——
  const gapDaysList = [];
  for (let i = 1; i < sortedDates.length; i++) {
    gapDaysList.push(dateDiffDays(sortedDates[i - 1], sortedDates[i]) - 1);
  }
  let intervalMatch = 0;
  if (gapDaysList.length > 0) {
    intervalMatch = gapDaysList.reduce((sum, g) => sum + linear(g - Z), 0) / gapDaysList.length;
  }

  // —— 沿用维度（与旧分散基础分同源，基于整月 allDates 索引）——
  const dateIndices = sortedDates.map(d => allDates.indexOf(d)).filter(i => i >= 0);
  let coverageScore = 0;
  let minGapDays = null;
  let maxGapDays = null;
  let uniformityScore = 0;
  let midCoverageBonus = 0;
  const totalRange = allDates.length - 1;
  if (dateIndices.length > 0 && totalRange > 0) {
    const firstIdx = dateIndices[0];
    const lastIdx = dateIndices[dateIndices.length - 1];
    if (dateIndices.length >= 2) coverageScore = ((lastIdx - firstIdx) / totalRange) * 100;
    const gaps = [];
    for (let i = 1; i < dateIndices.length; i++) gaps.push(dateIndices[i] - dateIndices[i - 1]);
    if (gaps.length > 0) {
      minGapDays = Math.min(...gaps);
      maxGapDays = Math.max(...gaps);
      const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const variance = gaps.reduce((sum, g) => sum + Math.pow(g - meanGap, 2), 0) / gaps.length;
      uniformityScore = (1 / (1 + Math.sqrt(variance))) * 50;
    }
    const midStartIdx = Math.floor(totalRange * 0.10);
    const midEndIdx = Math.ceil(totalRange * 0.90);
    const midCount = dateIndices.filter(idx => idx >= midStartIdx && idx <= midEndIdx).length;
    midCoverageBonus = (midCount / dateIndices.length) * 30;
  }

  return {
    total: uniformityScore + coverageScore + midCoverageBonus + leadEdge + tailEdge + intervalMatch,
    detail: {
      uniformity: uniformityScore,
      coverage: coverageScore,
      midCoverageBonus,
      leadEdge,
      tailEdge,
      intervalMatch,
      leadGapDays,
      tailGapDays,
      minGapDays,
      maxGapDays,
      Z
    }
  };
}


// ==================== 模拟排课生成方案（v5.51） ====================

/** 日期是否落在区间内（rangeStart/rangeEnd 为 null 表示不限） */
function dateInRange(date, rangeStart, rangeEnd) {
  if (rangeStart && date < rangeStart) return false;
  if (rangeEnd && date > rangeEnd) return false;
  return true;
}

/** 槽位是否视为「晚间优先级」槽（v5.6x 晚间区间扩展为 17:00-23:00）：
 *  1) 开始时刻不早于 17:00（如 19:00-21:00、17:00-19:00 均属晚间优先级区间）；
 *  2) 或开始早于 17:00 但结束已覆盖 17:00（跨界槽，如 15:00-18:00、16:00-18:00）按晚间兜底，
 *     使其与该日晚间槽同池竞争——晚间槽时间分显著更高，16:00-18:00 会被 19:00-21:00 取代 */
function isEveningSlot(startMinutes, endMinutes) {
  return startMinutes >= EVENING_START || endMinutes >= EVENING_START;
}

/** 该师资该日期的空闲时段是否覆盖晚间优先级区间（与 [17:00, 23:00] 有交集） */
function dateHasEvening(dateAvailabilities) {
  for (const a of dateAvailabilities) {
    const start = timeToMinutes(a.startTime);
    const end = timeToMinutes(a.endTime);
    if (end >= EVENING_START && start <= EVENING_END) return true;
  }
  return false;
}

/** 解析课程时长（分钟）：数字直接使用数字，字符串经 durationToMinutes 解析 */
function courseDurationMinutes(course) {
  const raw = course.duration;
  return typeof raw === 'number' ? raw : durationToMinutes(raw ? String(raw) : '90');
}

/** 调用方未传 courses 时构造合成课程（兼容旧调用：退化为师资维度日期级模拟） */
function buildSyntheticCourses(totalCourses, teacher, availableDates, rangeStart, rangeEnd) {
  const courses = [];
  const startDate = rangeStart || availableDates[0] || null;
  const endDate = rangeEnd || availableDates[availableDates.length - 1] || null;
  for (let i = 0; i < totalCourses; i++) {
    courses.push({ teacher, classType: 'A', duration: 90, startDate, endDate });
  }
  return courses;
}

/**
 * 枚举某课在师资-班级空闲碎片内所有「可放」时段槽（5 分钟步长，最宽松 minGap=0）
 * 每个候选槽均通过 hasConflict 校验（师资同天不重叠 + 班级时段互斥 + 师资班级每天一节）
 */
function enumerateFeasibleSlots(fragments, course, simCtx) {
  const duration = courseDurationMinutes(course);
  const slots = [];
  for (const f of fragments) {
    const availStart = timeToMinutes(f.startTime);
    const availEnd = timeToMinutes(f.endTime);
    for (let offset = 0; offset <= availEnd - availStart - duration; offset += 5) {
      const slotStart = availStart + offset;
      const slotEnd = slotStart + duration;
      if (slotEnd > availEnd) break;
      if (hasConflict(simCtx, { teacher: course.teacher, classType: course.classType, date: f.date, slotStart, slotEnd, minGap: 0 })) continue;
      slots.push({
        date: f.date,
        startMinutes: slotStart,
        endMinutes: slotEnd,
        startTime: minutesToTime(slotStart),
        endTime: minutesToTime(slotEnd),
        timeScore: calculateTimePriorityScore(slotStart),
        isEvening: isEveningSlot(slotStart, slotEnd)
      });
    }
  }
  return slots;
}

// ==================== 模拟排课策略特征表（v5.53） ====================
// 每个策略由三个维度刻画，组合出差异化候选方案：
//   dayWeight   （日期层）理想位置分布：uniform 均铺 / front 月初前载 / back 月末后载 /
//                mid 月中向两边最大分散（v5.55，以月中 15/16 为轴心全额铺满可行跨度）/
//                heuristic 贪心+启发式（v5.56，每步选一天、启发式估计剩余课潜在分散评分）
//   dayPref     （日期层）额外日期偏好：evening 偏向「该师资当日确有覆盖晚间空档」的日期 +12；
//                weekend 偏向周六/周日 +10；可组合（'evening+weekend'）
//   slotMode    （槽位层）选槽偏好：evening 晚间槽优先 / time 时间分最高 /
//                daytime 日间槽优先（晚间兜底）/ alternate 奇偶课交替晚间-日间 /
//                earliest 贪心取最早时段（v5.54）
//   timeEveningBonus （slotMode=time 时）晚间槽小幅加成，维持策略间差异
const STRATEGY_META = {
  'evening-spread':          { dayWeight: 'uniform', dayPref: 'evening',     slotMode: 'evening',  timeEveningBonus: 0 },
  'evening-spread-reversed': { dayWeight: 'uniform', dayPref: 'evening',     slotMode: 'evening',  timeEveningBonus: 0, reversed: true },
  'spread-first':            { dayWeight: 'uniform', dayPref: null,          slotMode: 'time',     timeEveningBonus: 8 },
  'evening-time':            { dayWeight: 'uniform', dayPref: 'evening',     slotMode: 'evening',  timeEveningBonus: 0 },
  'time-first':              { dayWeight: 'uniform', dayPref: null,          slotMode: 'time',     timeEveningBonus: 0 },
  // —— v5.53 新增 5 个策略，扩大候选对比面 ——
  'weekend-spread':          { dayWeight: 'uniform', dayPref: 'evening+weekend', slotMode: 'evening', timeEveningBonus: 0 }, // 晚间+周末日期偏好
  'daytime-first':           { dayWeight: 'uniform', dayPref: null,          slotMode: 'daytime',  timeEveningBonus: 0 }, // 日间时段优先（晚间兜底）
  'front-weighted':          { dayWeight: 'front',   dayPref: null,          slotMode: 'time',     timeEveningBonus: 8 }, // 月初前载分散
  'back-weighted':           { dayWeight: 'back',    dayPref: null,          slotMode: 'time',     timeEveningBonus: 8 }, // 月末后载分散
  'alternate-evening-day':   { dayWeight: 'uniform', dayPref: 'evening',     slotMode: 'alternate', timeEveningBonus: 0 }, // 奇偶课交替晚间/日间
  // —— v5.54 新增 1 个策略 ——
  'greedy-earliest':         { dayWeight: 'front',   dayPref: null,          slotMode: 'earliest', timeEveningBonus: 0 }, // 贪心：从第一个空闲时间段开始逐日排课
  // —— v5.55 新增 1 个策略 ——
  'mid-spread':              { dayWeight: 'mid',     dayPref: null,          slotMode: 'time',     timeEveningBonus: 0 }, // 月中向两边最大分散（以月中 15/16 为轴心全额铺满可行跨度）
  // —— v5.56 新增 1 个策略（贪心+启发式）——
  'greedy-heuristic':        { dayWeight: 'heuristic', dayPref: null,        slotMode: 'time',     timeEveningBonus: 0 } // 贪心+启发：每步按启发式估计的剩余课潜在分散分选一天，权重随子表数据自适应并迭代至最优
};

/** 该日期是否为周六/周日 */
function isWeekendDate(dateStr) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  return dow === 0 || dow === 6;
}

/**
 * 【v5.56 贪心+启发式日期层】每步选一天，启发式估计函数预估「剩余课程的潜在分散评分」，
 * 取（当前已实现分散 + 未来潜在分散）最高者；权重随每个子表的后台数据自适应；全部落位后
 * 再按整组真实评分做多轮局部爬山迭代，收敛到该子表数据下的最优日期序列。
 *
 * 启发式估计函数（estimateFutureSpread）自行设计：把剩余课程按「虚拟理想均铺外推
 * （从当前日向可行跨度最远端等分铺开）→ 各自可行日期池内就近 + 预算感知（候选后仍须为
 * 更后面的课留足更大日期）落位」，得到预期完整日期集，再用与最终验收同源的分散评分公式
 * （computeDispersionScoreDetail）计量其潜在分散总评分——估计值越高，剩余课越有可能
 * 排得分散、覆盖越广。
 *
 * 自适应权重（根据后台数据中每个子表情况迭代调整，达到该子表最优）：
 *   跨度疏密（idealGap = 跨度/(N-1)）→ 稀疏时加重「覆盖延伸/均匀」、拥挤时加重「最小间隔」；
 *   受限课程占比（可行日少的课程比例）→ 约束越强越加重「未来可行性/防死锁」。
 * 选择公式（每步对当前课每个候选日 d）：
 *   h(d) = 已选段真实分散分 + W.future × 剩余课潜在分散分（启发式估计）
 *          − W.feasibility × 后续课程日期短缺数 − 死锁重罚（1e6）
 */
function simulateHeuristicDates(courses, pools, unionDates, allMonthDates) {
  const N = courses.length;
  if (N === 0) return null;
  const dayNum = getDayOfMonth;
  const totalRange = allMonthDates.length - 1;
  const startDay = dayNum(unionDates[0]);
  const endDay = dayNum(unionDates[unionDates.length - 1]);
  const span = endDay - startDay;
  // —— 子表数据特征（后台数据自适应）——
  const idealGap = N > 1 ? span / (N - 1) : 0;   // 期望间隔（天）
  const crowded = idealGap < 2.5;                 // 间隔紧张：跨度过窄，无法真正铺开
  const sparse = idealGap >= 7;                   // 跨度充裕：优先把课铺向月两端
  const tightPoolRatio = pools.filter(p => p.length <= Math.max(2, Math.ceil(N / 2))).length / N;
  const W = {
    future: 0.35 + (sparse ? 0.15 : 0) + (crowded ? -0.1 : 0), // 剩余课潜在分散分权重
    feasibility: 1.5 + tightPoolRatio * 2.0,                   // 未来可行性/防死锁权重
    coverage: sparse ? 1.0 : 0.5,
    uniformity: crowded ? 0.4 : 0.8,
    minGap: crowded ? 1.5 : 0.4
  };
  const countAfter = (pool, d) => { let n = 0; for (const x of pool) if (x > d) n++; return n; };
  // 完整分散评分（与最终验收同源，保证启发式估计与真实评分一致；v5.64 起按
  // [X1, X2] = 师资-课程空闲时间表首尾、Y = 未定时间课程数，计算 Z 规则三项评分）
  const fullScore = (dates) => computeDispersionScoreDetail(
    dates, allMonthDates,
    { X1: unionDates[0], X2: unionDates[unionDates.length - 1], Y: N }
  ).total;
  // —— 启发式估计函数：预估「选定当前日后，剩余课程的潜在分散评分」——
  const estimateFutureSpread = (curDate, chosenList, placedCount) => {
    const remain = N - placedCount;
    if (remain === 0) return { estScore: 0, deadlock: false };
    const tail = unionDates.filter(x => x > curDate);
    if (tail.length === 0) return { estScore: 0, deadlock: true };
    const anchorEnd = tail[tail.length - 1]; // 剩余课可延伸的最远可行日
    const edgeDay = dayNum(curDate);
    const farDay = dayNum(anchorEnd);
    const futureDates = [];
    let prevF = curDate;
    for (let k = 1; k <= remain; k++) {
      // 虚拟理想位：在 (curDate, anchorEnd] 上等分（向外铺开 → 覆盖外推）
      const idealPos = edgeDay + (k / (remain + 1)) * (farDay - edgeDay);
      const pool = pools[placedCount - 1 + k];
      if (!pool) return { estScore: 0, deadlock: true };
      const candsF = pool.filter(x => x > prevF);
      if (candsF.length === 0) return { estScore: 0, deadlock: true };
      let best = null;
      let bestDist = Infinity;
      for (const x of candsF) {
        const need = remain - k; // 预算感知：x 后仍须为更后面的课留足更大日期
        if (countAfter(pool, x) < need) continue;
        const dist = Math.abs(dayNum(x) - idealPos);
        if (dist < bestDist) { bestDist = dist; best = x; }
      }
      if (!best) best = candsF[candsF.length - 1]; // 兜底：取仍支撑预算的最近落位
      futureDates.push(best);
      prevF = best;
    }
    return { estScore: fullScore([...chosenList, ...futureDates]), deadlock: false };
  };

  // —— 贪心：每步选一天（选 h 最大者）——
  const dateByIndex = {};
  const chosenList = [];
  for (let i = 0; i < N; i++) {
    let cands = pools[i];
    if (cands.length === 0) return null;
    const floor = chosenList.length ? chosenList[chosenList.length - 1] : null;
    if (floor) cands = cands.filter(d => d > floor);
    if (cands.length === 0) return null;
    let bestD = null;
    let bestH = -Infinity;
    for (const d of cands) {
      const trial = [...chosenList, d];
      const est = estimateFutureSpread(d, trial, i + 1);
      let h = fullScore(trial); // 当前已实现分散分
      if (est.deadlock) {
        h -= 1e6; // 未来某课放不下 → 死锁重罚
      } else {
        h += W.future * est.estScore; // + 剩余课潜在分散评分（启发式估计）
      }
      // 预算硬约束松弛信号：d 之后不足以给后续课程各配足够更大日期 → 罚重分
      for (let j = i + 1; j < N; j++) {
        const shortage = (N - 1 - j) - countAfter(pools[j], d);
        if (shortage > 0) h -= W.feasibility * shortage;
      }
      if (h > bestH) { bestH = h; bestD = d; }
    }
    if (!bestD) return null;
    dateByIndex[i] = bestD;
    chosenList.push(bestD);
  }

  // —— 迭代精炼（v5.56）：多轮局部爬山，整组按真实评分验收，收敛到该子表数据下的最优 ——
  let curScore = fullScore(chosenList);
  for (let iter = 0; iter < 6; iter++) {
    let improved = false;
    for (let i = 0; i < N; i++) {
      const old = dateByIndex[i];
      const lower = i > 0 ? dateByIndex[i - 1] : null;
      const upper = i < N - 1 ? dateByIndex[i + 1] : null;
      for (const alt of pools[i]) {
        if (alt === old) continue;
        if (lower && alt <= lower) continue;
        if (upper && alt >= upper) continue;
        dateByIndex[i] = alt;
        const s = fullScore(Object.values(dateByIndex));
        if (s > curScore + 0.001) {
          curScore = s;
          improved = true;
          break;
        }
        dateByIndex[i] = old; // 回退
      }
    }
    if (!improved) break; // 收敛：无提升即该子表数据下的（局部）最优
  }

  return dateByIndex;
}

/**
 * 按指定策略两阶段模拟排课，产出完整可行的「日期+时段」槽位序列。
 *
 * 阶段一（日期层）：先在全部课程可行日期的跨度上按 meta.dayWeight 分布理想位置
 *   （uniform 等分中位点 / front 月初前载 / back 月末后载 / mid 月中向两边铺开），逐课把
 *   理想位置就近映射到「该课程可行日期池 ∩ 递增约束」的日期，并施加与主排课 reserveAfter
 *   等价的日期预算硬约束（lookahead：任一后续课程仍须保有足够更大/更小的日期，链式勾稽），
 *   从根上杜绝「逐门贪心把前几课推到月尾 → 后续课程无更大日期可取」的死锁（v5.51.1 缺陷 C：
 *   4 个含分散项的晚间策略因此全部不可行）。就近等价内按 meta.dayPref 加成（evening 偏向
 *   「该师资当日确有覆盖晚间空档」的日期 +12；weekend 偏向周六/周日 +10）。
 *   dayWeight=heuristic（v5.56）时改为贪心+启发式选日：每步选一天、启发式估计剩余课的
 *   潜在分散评分，权重随子表数据自适应并迭代精炼至最优（见 simulateHeuristicDates）。
 *   选出的日期集：天然分散（等分骨架）+ 严格递增（与主排课 prevDate 递增约束一致）+
 *   预算保障（后续课程必有日期）。
 *
 * 阶段二（槽位层）：逐课在已选日期上按 meta.slotMode 枚举可行时段槽（evening 晚间槽优先 /
 *   time 时间分最高（保留 timeEveningBonus 小幅晚间加成）/ daytime 日间槽优先（晚间兜底）/
 *   alternate 序偶晚间-序奇日间交替 / earliest 贪心取当日最早时段（v5.54）），注册到独立临时
 *   ctx 累积师资/班级互斥；该日放不下时向该课程池中的相邻可行日期局部修复（仍保持全局日期
 *   严格递增）；仍失败则该策略不可行 → null。
 *
 * 严格遵循师资-班级空闲时间表：槽位一律来自 buildTeacherClassAvailability 的空闲碎片
 * （已排除班级占用±缓冲与师资自身已排时段），经 hasConflict 校验后以 registerSlot 落账。
 *
 * @param {string} strategy 策略名（v5.56 起 13 个，特征见 STRATEGY_META）：
 *        evening-spread（晚间优先+分散）/ evening-spread-reversed（反序）/ spread-first（分散优先）/
 *        evening-time（晚间+时间分）/ time-first（时间分优先）/ weekend-spread（晚间+周末）/
 *        daytime-first（日间优先）/ front-weighted（月初前载）/ back-weighted（月末后载）/
 *        alternate-evening-day（晚间/日间交替）/ greedy-earliest（贪心：从第一个空闲时间段排课）/
 *        mid-spread（月中向两边最大分散：以 15/16 为轴心全额铺满可行跨度）/
 *        greedy-heuristic（贪心+启发式：每步选一天，启发式估计剩余课潜在分散分，v5.56）
 * @returns {{slots: Array, dates: string[]}|null} 任一课程无可行槽则整体不可行 → null
 */
export function simulateScheduleOnce(courses, monthAvailability, allMonthDates, strategy, rangeStart, rangeEnd, baseCtx, tailReserve, cutAfter, fixedMergeSlots = null, headReserve = null, cutBefore = null) {
  const N = courses.length;
  if (N === 0) return null;
  const meta = STRATEGY_META[strategy] || STRATEGY_META['evening-spread'];
  const reversed = !!meta.reversed;
  // 处理顺序：正向 0..N-1；reversed 从 N-1 往前（锚定/占槽方向相反，产出差异化方案）
  const order = reversed ? [...Array(N).keys()].reverse() : [...Array(N).keys()];

  // ---------------- 阶段一：日期层 ----------------
  // 每门课自身区间内可行的日期池（基线 ctx：v5.58 起为「当前全局 ctx + 空模拟累积」，
  // 即已扣除先前子表/前序排课占用的师资与班级时段，与本子表排课瞬间的
  // 师资-班级空闲时间表一致；本子表课程尚未排，无本子表内部干扰）。
  // v5.61：已定日期合班课（fixedMergeSlots）为硬约束 —— 日期池仅含固定日期，槽位层直接
  // 落定固定槽，不参与自由模拟；普通课受 cutAfter 截断（与主排 courseCutAfter 一致），
  // 合班课（含未定日期合班课）不受截断（与主排 courseCutAfter=null 一致）。
  const baselineCtx = seedSimContext(monthAvailability, baseCtx);
  const pools = courses.map((c, idx) => {
    const fx = fixedMergeSlots && fixedMergeSlots[idx];
    if (fx) return [fx.date]; // 已定日期合班课：仅固定日期可排
    const cStart = c.startDate || rangeStart;
    const cEnd = c.endDate || rangeEnd;
    const frags = buildTeacherClassAvailability(monthAvailability, c.teacher, c.classType, baselineCtx, { ...(tailReserve ? { tailReserve } : {}), ...(((cutAfter && !isMergeCourse(c)) ? { cutAfter } : {})), ...(headReserve ? { headReserve } : {}), ...(((cutBefore && !isMergeCourse(c)) ? { cutBefore } : {})) })
      .filter(f => dateInRange(f.date, cStart, cEnd));
    return [...new Set(frags.map(f => f.date))].sort();
  });
  // 任一课程在其区间内毫无可行日期 → 该策略整体不可行
  if (pools.some(p => p.length === 0)) {
    if (!!process.env.SCHEDULE_DEBUG) {
      const empties = pools.map((p, i) => (p.length === 0 ? courses[i].courseName : null)).filter(Boolean);
      console.log(`[模拟内部-D] 策略 ${strategy} 日期层不可行：${empties.length} 门课区间内可行日期为空 → ${empties.join(' / ')}`);
    }
    return null;
  }

  const unionDates = [...new Set(pools.flat())].sort();
  const startDay = getDayOfMonth(unionDates[0]);
  const endDay = getDayOfMonth(unionDates[unionDates.length - 1]);
  const span = endDay - startDay;
  // 理想位置按 meta.dayWeight 分布（v5.53）：uniform 均铺（mid-centered 等分中位点，第二门起
  // 不再被"分散贪心"推向月尾）/ front 月初前载（每门落其序号对应跨度的头部）/
  // back 月末后载（每门落其序号对应跨度的尾部）/ mid 月中向两边最大分散（v5.55）
  const idealDay = [];
  for (let i = 0; i < N; i++) {
    if (span <= 0) { idealDay.push(startDay); continue; }
    if (meta.dayWeight === 'front') idealDay.push(startDay + (i / N) * span);
    else if (meta.dayWeight === 'back') idealDay.push(startDay + ((i + 1) / N) * span);
    else if (meta.dayWeight === 'mid') {
      // 月中向两边最大分散（v5.55）：以「月中 15/16（不在可行跨度内则退化为跨度中点）」为轴心，
      // 将 N 门课在可行跨度 [startDay, endDay] 上全额均匀铺开 —— 端点全额、覆盖两端最远
      // （比 uniform 的半点留白更外扩）→ 覆盖范围最大 + 间隔均匀 = 分散程度最大。
      // 受「同班课程日期严格递增」硬约束（与主排课 prevDate 一致），落位序列按升序呈现；
      // 「从中间开始」由就近映射平局取更靠近月中体现（见下）。
      if (N === 1) { idealDay.push(Math.round((startDay + endDay) / 2)); continue; }
      idealDay.push(startDay + (i / (N - 1)) * span);
    }
    else idealDay.push(startDay + ((i + 0.5) / N) * span);
  }

  const dateByIndex = {}; // 原序 index -> 选定日期（全局严格递增）
  // —— v5.56 贪心+启发式可选分支（dayWeight=heuristic）：跳过等分理想日+就近映射，
  //     改为每步选一天、用启发式估计函数预估剩余课潜在分散评分，并迭代精炼至最优 ——
  if (meta.dayWeight === 'heuristic') {
    const res = simulateHeuristicDates(courses, pools, unionDates, allMonthDates);
    if (!res) return null;
    Object.assign(dateByIndex, res);
  } else {
    let prevChosen = null;  // 正向处理的下界
    let nextChosen = null;  // 反向处理的上界

  const countAfter = (pool, d) => { let n = 0; for (const x of pool) if (x > d) n++; return n; };
  const countBefore = (pool, d) => { let n = 0; for (const x of pool) if (x < d) n++; return n; };

  // 日期预算硬约束（等价主排课 reserveAfter 的 lookahead 上提）：
  //   正向：候选日期 d 后，任一后续课程 j 仍须保有 ≥ (j-i) 个更大日期；
  //   反向：候选日期 d 前，任一先序课程 j 仍须保有 ≥ (i-j) 个更小日期。
  // 链式勾稽保证「逐个选日」时后续课程必然仍有日期可取，从根上杜绝贪心死锁。
  const budgetOk = (i, d) => {
    if (reversed) {
      for (let j = 0; j < i; j++) if (countBefore(pools[j], d) < (i - j)) return false;
    } else {
      for (let j = i + 1; j < N; j++) if (countAfter(pools[j], d) < (j - i)) return false;
    }
    return true;
  };

  // 日期偏好加成（v5.53 按 meta.dayPref 组合）：
  //   evening → 该师资当日确有覆盖晚间空档 +12；weekend → 周六/周日 +10
  const eveningBonus = (i, d) => {
    if (!meta.dayPref) return 0;
    let bonus = 0;
    if (meta.dayPref.includes('evening')) {
      bonus += dateHasEvening(monthAvailability.filter(a => a.date === d && a.teacher === courses[i].teacher)) ? 12 : 0;
    }
    if (meta.dayPref.includes('weekend') && isWeekendDate(d)) bonus += 10;
    return bonus;
  };

  for (const i of order) {
    const lower = reversed ? null : prevChosen;
    const upper = reversed ? nextChosen : null;
    const inBounds = (d) => (lower ? d > lower : true) && (upper ? d < upper : true);
    const cands = pools[i].filter(inBounds);
    if (cands.length === 0) {
      if (!!process.env.SCHEDULE_DEBUG) console.log(`[模拟内部-D] 策略 ${strategy} 日期层不可行：第 ${i+1} 门「${courses[i].courseName}」在 ${reversed ? '上界后' : '下界前'} 无递增候选（池: ${pools[i].join(',')}）`);
      return null;
    }
    // 先按日期预算硬约束过滤（保后续课程有日期可取）；全被拦下时放宽到递增约束，
    // 宁可局部次优也不让整体死锁（极端数据下退化为"能排上优先"）。
    let strict = cands.filter(d => budgetOk(i, d));
    if (strict.length === 0) strict = cands;

    // 就近选择理想位置（减去晚间偏好加成；平局取更早日期，保守给后续留余量；
    // v5.55 mid 策略平局取更靠近月中 15/16 —— 体现「从中间开始」向两边分散）
    let chosen = null;
    if (meta.slotMode === 'earliest') {
      // 贪心策略（v5.54）：不做理想位置锚定，直接从最早可行日期开始逐日排课
      // pools[i]/cands/strict 均按日期升序，strict[0] = 满足预算约束的最早可行日期
      chosen = strict.length > 0 ? strict[0] : cands[0];
    } else {
      // v5.55：mid 策略的月中轴心（真实 15/16；不在可行跨度内则退化用跨度中点）
      const midAnchor = (15.5 >= startDay && 15.5 <= endDay) ? 15.5 : (startDay + endDay) / 2;
      let bestPick = Infinity;
      for (const d of strict) {
        const dist = Math.abs(getDayOfMonth(d) - idealDay[i]) - eveningBonus(i, d);
        if (dist < bestPick) {
          bestPick = dist;
          chosen = d;
        } else if (dist === bestPick && chosen) {
          if (meta.dayWeight === 'mid') {
            // 「从中间开始」（v5.55）：平局取更靠近月中 15/16 的日期
            if (Math.abs(getDayOfMonth(d) - midAnchor) < Math.abs(getDayOfMonth(chosen) - midAnchor)) {
              chosen = d;
            }
          } else if (d < chosen) {
            chosen = d;
          }
        }
      }
    }
    if (!chosen) {
      if (!!process.env.SCHEDULE_DEBUG) console.log(`[模拟内部-D] 策略 ${strategy} 日期层不可行：第 ${i+1} 门「${courses[i].courseName}」严格候选被预算拦截后仍无选中`);
      return null;
    }

    dateByIndex[i] = chosen;
    if (reversed) nextChosen = chosen; else prevChosen = chosen;
  }
  } // —— end else 分支（等分理想日+就近映射的日期层，非 heuristic 策略用） ——

  // ---------------- 阶段二：槽位层 ----------------
  const simCtx = seedSimContext(monthAvailability, baseCtx);
  const slotByIndex = {};
  const dayNumOf = (d) => getDayOfMonth(d);

  // 在某日期上选槽（v5.54 按 meta.slotMode 差异化选槽，制造策略间时段分布差异）：
  //   earliest 贪心：取该日开始时间最早的槽（从第一个空闲时间段开始排课）
  //   evening   晚间槽优先（晚间不足回退该日全部槽，同档取时间分最高）
  //   time      时间分最高（按 meta.timeEveningBonus 保留晚间小幅加成，维持策略间差异）
  //   daytime   日间槽优先（晚间仅作兜底）
  //   alternate 按课程序号奇偶交替：序号偶选晚间优先 / 序号奇选日间优先，制造「晚间-日间」交错
  const pickSlot = (slots, courseIndex) => {
    if (slots.length === 0) return null;
    // 粒度层级：整点/半点(2) > 整10分(1) > 整5分(0)。
    // 在既定语义池（晚间/日间等）内优先选更规整的时段，同层级内再比时间分
    const granularityLevel = (mins) => {
      const m = mins % 60;
      if (m === 0 || m === 30) return 2;
      if (m % 10 === 0) return 1;
      return 0;
    };
    const bestByScore = (pool) => {
      let best = null;
      for (const s of pool) {
        if (!best) { best = s; continue; }
        const lvl = granularityLevel(s.startMinutes);
        const bestLvl = granularityLevel(best.startMinutes);
        if (lvl > bestLvl || (lvl === bestLvl && s.timeScore > best.timeScore)) best = s;
      }
      return best;
    };
    if (meta.slotMode === 'earliest') {
      // 贪心策略（v5.54）：显式取 startMinutes 最小的槽（第一个空闲时间段），
      // 不依赖 fragment 排序假设；同秒数取第一个
      let earliest = slots[0];
      for (const s of slots) if (s.startMinutes < earliest.startMinutes) earliest = s;
      return earliest;
    }
    if (meta.slotMode === 'time') {
      // 排序：晚间优先 > 粒度层级（整点/半点 > 整10分 > 整5分）> 时间分（含晚间加成）。
      // 同语义池内优先规整时段，避免 19:10 这类「接近 19:00 的非整点」虚高胜出
      let best = null;
      for (const s of slots) {
        if (!best) { best = s; continue; }
        const me = s.isEvening ? 1 : 0;
        const be = best.isEvening ? 1 : 0;
        if (me !== be) {
          if (me > be) best = s;
          continue;
        }
        const mg = granularityLevel(s.startMinutes);
        const bg = granularityLevel(best.startMinutes);
        if (mg !== bg) {
          if (mg > bg) best = s;
          continue;
        }
        const sc = s.timeScore + (s.isEvening ? meta.timeEveningBonus : 0);
        const bsc = best.timeScore + (best.isEvening ? meta.timeEveningBonus : 0);
        if (sc > bsc) best = s;
      }
      return best;
    }
    let preferEvening = meta.slotMode === 'evening';
    if (meta.slotMode === 'alternate') preferEvening = (courseIndex % 2 === 0);
    const evening = slots.filter(s => s.isEvening);
    const daytime = slots.filter(s => !s.isEvening);
    if (preferEvening && evening.length > 0) return bestByScore(evening);
    if (!preferEvening && daytime.length > 0) return bestByScore(daytime);
    if (evening.length > 0) return bestByScore(evening);
    return bestByScore(daytime);
  };

  const placeOn = (course, date, courseIndex) => {
    const frags = buildTeacherClassAvailability(monthAvailability, course.teacher, course.classType, simCtx, { ...(tailReserve ? { tailReserve } : {}), ...(((cutAfter && !isMergeCourse(course)) ? { cutAfter } : {})), ...(headReserve ? { headReserve } : {}), ...(((cutBefore && !isMergeCourse(course)) ? { cutBefore } : {})) })
      .filter(f => f.date === date);
    return pickSlot(enumerateFeasibleSlots(frags, course, simCtx), courseIndex);
  };

  for (const i of order) {
    const course = courses[i];
    // v5.61：已定日期合班课槽位为硬约束 —— 直接落定固定槽（该时段已由先前子表注册占用，
    // 模拟上下文同步注册，使后续普通课模拟避开其时段），不参与自由选槽
    const fx = fixedMergeSlots && fixedMergeSlots[i];
    if (fx) {
      const fxStart = timeToMinutes(fx.startTime);
      const fxEnd = timeToMinutes(fx.endTime);
      slotByIndex[i] = { date: fx.date, startTime: fx.startTime, endTime: fx.endTime, isEvening: isEveningSlot(fxStart, fxEnd) };
      registerSlot(simCtx, { teacher: course.teacher, classType: course.classType, date: fx.date, startTime: fx.startTime, endTime: fx.endTime });
      continue;
    }
    let chosenSlot = placeOn(course, dateByIndex[i], i);
    if (!chosenSlot) {
      // 局部修复：保持「原序全局严格递增」前提下，就近尝试该课程池中相邻可行日期
      const target = dateByIndex[i];
      const lower = i > 0 ? dateByIndex[i - 1] : null;
      const upper = i < N - 1 ? dateByIndex[i + 1] : null;
      const repairPool = pools[i].filter(d =>
        d !== target && (lower ? d > lower : true) && (upper ? d < upper : true)
      );
      repairPool.sort((a, b) =>
        Math.abs(dayNumOf(a) - dayNumOf(target)) - Math.abs(dayNumOf(b) - dayNumOf(target))
      );
      for (const d of repairPool) {
        const s = placeOn(course, d, i);
        if (s) { chosenSlot = s; dateByIndex[i] = d; break; }
      }
      if (!chosenSlot) {
        if (!!process.env.SCHEDULE_DEBUG) console.log(`[模拟内部-D] 策略 ${strategy} 槽位层不可行：第 ${i+1} 门「${courses[i].courseName}」在 ${target}（及就近修复日期）均放不下`);
        return null; // 该策略下某课放不下 → 方案整体不可行
      }
    }

    registerSlot(simCtx, {
      teacher: course.teacher, classType: course.classType,
      date: dateByIndex[i], startTime: chosenSlot.startTime, endTime: chosenSlot.endTime
    });
    slotByIndex[i] = { ...chosenSlot, date: dateByIndex[i] };
  }

  // 按 courses 原序输出槽位序列（日期严格递增，与主排课逐课锚点一一对应）
  // v5.67：保留 timeScore（enumerateFeasibleSlots 选槽时已写入）供评分 timeScoreAvg 使用
  const slots = Array.from({ length: N }, (_, i) => ({
    date: slotByIndex[i].date,
    startTime: slotByIndex[i].startTime,
    endTime: slotByIndex[i].endTime,
    isEvening: slotByIndex[i].isEvening,
    timeScore: slotByIndex[i].timeScore || 0
  }));

  // ---------------- 阶段三/四（v5.72）：非满分槽前后 2 天寻优 + 分支组合取总分最高 ----------------
  // 阶段三：对阶段二选中槽 timeScore 未达「时间优先级满分」（19:00 整点 = MAX_TIME_SCORE）的课，
  //   在其选中日期前后各 2 天（须落在该课可行日期池内，含区间/师资班级空闲/尾段预留/截断约束）
  //   逐日按本策略 pickSlot 选当日最优槽，若其 timeScore 高于当前选中槽，则列为可选变体
  //   （date + startTime + endTime + timeScore）；满分课仅保留原槽一个变体，不参与寻优。
  // 阶段四：各课变体做笛卡尔积组合成分支方案（日期须保持全局严格递增，与主排课逐课锚点一致），
  //   每个分支按 scoreSimulatedPlan 全量评分（分散基础分 + 槽位时间优先级均值），
  //   取总分最高者为该策略最终方案；组合数超上限（MAX_BRANCHES）时按变体 timeScore
  //   由高到低截断剪枝（保留高分变体，逼近最优）。
  const MAX_TIME_SCORE = calculateTimePriorityScore(OPTIMAL_EVENING); // OPTIMAL_EVENING 已是分钟数(19:00=1140) → 315
  const MAX_BRANCHES = 2000;
  const shiftDay = (dateStr, delta) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d + delta);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  };
  const stage3 = [];                   // 阶段三明细（非满分课的可选更优槽）
  const variantsByIndex = [];          // 每课可选变体（原槽 + 阶段三更优槽）
  for (let i = 0; i < N; i++) {
    const cur = slots[i];
    variantsByIndex[i] = [{ ...cur }];
    const fx = fixedMergeSlots && fixedMergeSlots[i];
    if (fx) continue;                  // 已定日期合班课：固定槽，不可变
    if ((cur.timeScore || 0) >= MAX_TIME_SCORE) continue; // 时间优先级满分 → 仅原槽
    const course = courses[i];
    const better = [];
    for (let delta = -2; delta <= 2; delta++) {
      if (delta === 0) continue;
      const dayStr = shiftDay(cur.date, delta);
      if (!pools[i].includes(dayStr)) continue;
      const frags = buildTeacherClassAvailability(monthAvailability, course.teacher, course.classType, simCtx,
        { ...(tailReserve ? { tailReserve } : {}), ...(((cutAfter && !isMergeCourse(course)) ? { cutAfter } : {})), ...(headReserve ? { headReserve } : {}), ...(((cutBefore && !isMergeCourse(course)) ? { cutBefore } : {})) })
        .filter(f => f.date === dayStr);
      const slotList = enumerateFeasibleSlots(frags, course, simCtx);
      const best = pickSlot(slotList, i); // 该日按本策略语义的最优槽
      if (best && best.timeScore > (cur.timeScore || 0)) {
        better.push({ date: dayStr, startTime: best.startTime, endTime: best.endTime, isEvening: best.isEvening, timeScore: best.timeScore });
      }
    }
    if (better.length > 0) {
      variantsByIndex[i] = [...variantsByIndex[i], ...better];
      stage3.push({ idx: i, courseName: course.courseName, base: { date: cur.date, startTime: cur.startTime, endTime: cur.endTime, timeScore: cur.timeScore }, better });
    }
  }

  // 组合爆炸保护：乘积超限时从变体最多的课开始截断，保留 timeScore 高的变体
  let capped = variantsByIndex.map(v => [...v]);
  const comboCnt = () => capped.reduce((p, v) => p * v.length, 1);
  if (comboCnt() > MAX_BRANCHES) {
    const orderBySize = capped.map((_, i) => i).sort((a, b) => capped[b].length - capped[a].length);
    for (const i of orderBySize) {
      if (comboCnt() <= MAX_BRANCHES) break;
      let rest = 1;
      for (let j = 0; j < N; j++) if (j !== i) rest *= capped[j].length;
      const need = Math.max(1, Math.min(capped[i].length, Math.floor(MAX_BRANCHES / Math.max(1, rest))));
      if (capped[i].length > need) {
        capped[i] = [...capped[i]].sort((a, b) => (b.timeScore || 0) - (a.timeScore || 0)).slice(0, need);
      }
    }
  }

  // 枚举全部分支并评分选优（分支须保持日期严格递增，与主排课一致）
  let combos = [[]];
  for (let i = 0; i < N; i++) {
    const next = [];
    for (const prefix of combos) for (const v of capped[i]) next.push([...prefix, v]);
    combos = next;
  }
  const stage4 = { branches: combos.length, validBranches: 0, bestDelta: 0 };
  let bestBranch = null;
  let bestBranchScore = -Infinity;
  for (const combo of combos) {
    let asc = true;
    for (let i = 1; i < N; i++) if (combo[i].date <= combo[i - 1].date) { asc = false; break; }
    if (!asc) continue;
    stage4.validBranches++;
    const s = scoreSimulatedPlan({ slots: combo, dates: combo.map(v => v.date), unionDates }, allMonthDates).score;
    if (s > bestBranchScore) { bestBranchScore = s; bestBranch = combo; }
  }
  if (bestBranch) {
    // 阶段四最终方案：总分最高的分支（原槽组合必在其中且日期递增，故一定有解）
    const baseScore = scoreSimulatedPlan({ slots, dates: slots.map(s => s.date), unionDates }, allMonthDates).score;
    stage4.bestDelta = bestBranchScore - baseScore;
    return {
      slots: bestBranch,
      dates: bestBranch.map(s => s.date),
      unionDates,
      stage3,
      stage4
    };
  }

  // v5.64：附带 unionDates（该子表师资-班级空闲时间表日期并集，含 cutAfter 截断，
  // 已定日期合班课不参与）供评分取排课前最终版空闲区间 [X1, X2]
  return { slots, dates: slots.map(s => s.date), unionDates, stage3, stage4 };
}

/** 模拟方案的评分 = 分散度评分（日期排序后计算，顺序无关） + 时间优先级（槽位时间分均值，v5.67）；
 *  v5.64：X1/X2 = 排课前最终版师资-课程空闲时间表区间（simulateScheduleOnce 返回的
 *  unionDates 首尾，含 cutAfter 截断），Y = 未定时间课程数（自由课数），据此计算
 *  Z 后按「起始留白 / 终止留白 / 间隔匹配」三项线性衰减评分（v5.66；v5.64 曾为高斯） + 沿用维度；
 *  返回 detail（各维度得分明细，供排课报告展示评分详情） */
export function scoreSimulatedPlan(plan, allMonthDates) {
  const sortedDates = [...plan.dates].sort();
  const unionDates = plan.unionDates && plan.unionDates.length > 0 ? plan.unionDates : sortedDates;
  const meta = {
    X1: unionDates[0],
    X2: unionDates[unionDates.length - 1],
    Y: sortedDates.length
  };
  const scored = sortedDates.length > 0 && meta.X1 && meta.X2 && meta.Y >= 1
    ? computeDispersionScoreDetail(sortedDates, allMonthDates, meta)
    : null;
  const base = scored ? scored.total : -Infinity;
  // v5.67：时间优先级评分（槽位时间优先级分均值，slots 由 simulateScheduleOnce 枚举时已调
  //   calculateTimePriorityScore 写入 timeScore）加入模拟总分。
  const timeScoreAvg = plan.slots.length > 0
    ? plan.slots.reduce((sum, s) => sum + (s.timeScore || 0), 0) / plan.slots.length
    : 0;
  return {
    score: base + timeScoreAvg,
    baseScore: base,
    timeScoreAvg,
    detail: scored
      ? scored.detail
      : { uniformity: 0, coverage: 0, midCoverageBonus: 0, leadEdge: 0, tailEdge: 0, intervalMatch: 0, leadGapDays: null, tailGapDays: null, minGapDays: null, maxGapDays: null, Z: 0 }
  };
}

/**
 * 选择最优分散方案（v5.51 模拟排课生成）
 * 以师资-班级空闲时间表为候选时段池，多种策略各执行一次逐门模拟排课，
 * 产出多种完整可行的 {date, startTime, endTime} 槽位方案，按
 * 「分散度评分 + 槽位时间优先级均值」选取分数最高者作为最终方案。
 * @param {string[]} availableDates 师资空闲日期并集（已排序）
 * @param {number} totalCourses 课程数
 * @param {string} teacher 师资
 * @param {Array} monthAvailability 师资空闲时间
 * @param {string[]} allMonthDates 整月所有日期
 * @param {string|null} rangeStart 排课区间起始（YYYY-MM-DD）
 * @param {string|null} rangeEnd 排课区间结束（YYYY-MM-DD）
 * @param {Array|null} [courses] 课程列表（含 teacher/classType/duration/startDate/endDate），
 *        缺省时构造合成课程降级为师资维度日期级模拟（旧调用兼容）
 * @param {Object|null} [fixedMergeSlots] 已定日期合班课固定槽数组（索引与 courses 对齐，
 *        元素为 null 或 {date, startTime, endTime}，v5.61）—— 模拟将其作为硬性槽位约束，
 *        使候选方案槽位序列与主排（合班对齐 + 普通课锚点取用）完全同源，消除
 *        「选中策略展示 vs 最终排课结果」不一致
 * @returns {{ primary: Plan, secondary: Plan, candidates: Array<Plan> }}
 *         candidates = 全部候选方案（含策略名/评分/各维度明细 detail/槽位序列，按评分降序），
 *         供排课报告展示「各分散策略详情与评分 + 模拟日历表」（v5.51.1）
 */
export function findBestDispersionPlan(availableDates, totalCourses, teacher, monthAvailability, allMonthDates, rangeStart = null, rangeEnd = null, courses = null, baseCtx = null, tailReserve = null, cutAfter = null, fixedMergeSlots = null, headReserve = null, cutBefore = null) {
  const courseArr = courses && courses.length > 0
    ? courses
    : buildSyntheticCourses(totalCourses, teacher, availableDates, rangeStart, rangeEnd);

  // —— 所有课程（含 <4 门）：统一走 13 策略模拟排课 → 评分 → 选优 ——
  //（v5.62：取消少课（<4 门）month-division-anchor 锚点分支，全部课程按 13 策略模拟并选总分最高）
  //（v5.56：v5.55 的 12 个 + greedy-heuristic 贪心+启发式）
// （v5.55：v5.54 的 11 个 + mid-spread 月中向两边最大分散）
// （v5.54：10 个 + greedy-earliest 贪心从第一个空闲时间段排课）
// （v5.53：原 5 个 + weekend-spread/daytime-first/front-weighted/back-weighted/alternate-evening-day）
// v5.63：含已定日期合班课（fixedMergeSlots 非空）的子表，只对「剩余自由课」做多策略
// 模拟排课并评分选优 —— 固定合班课槽位为既定事实（日期/时段已由先前子表确定），不参与
// 模拟与评分，避免其固定日期拖累自由课的分散评分对比；模拟结果再映射回全量索引（固定槽
// 占位），保证槽位序列与主排（锚点逐课取用）索引对齐。
  const strategies = [
    'evening-spread', 'evening-spread-reversed', 'spread-first', 'evening-time', 'time-first',
    'weekend-spread', 'daytime-first', 'front-weighted', 'back-weighted', 'alternate-evening-day',
    'greedy-earliest', 'mid-spread', 'greedy-heuristic'
  ];
  const hasFixedMerge = !!(fixedMergeSlots && fixedMergeSlots.some(Boolean));
  const freeIndexes = hasFixedMerge ? courseArr.map((_, i) => i).filter(i => !fixedMergeSlots[i]) : null;
  const freeCourses = freeIndexes ? freeIndexes.map(i => courseArr[i]) : courseArr;
  if (hasFixedMerge && freeCourses.length === 0) {
    // 全部课程均为已定日期合班课：没有可自由模拟的课
    if (!!process.env.SCHEDULE_DEBUG) console.log(`    [模拟排课] 师资=${teacher} 全部课程均为已定日期合班课，无可模拟自由课`);
    return null;
  }
  const plans = [];
  for (const strategy of strategies) {
    try {
      // 只对自由课模拟（freeIndexes 存在时一律传 null 的 fixedMergeSlots，避免索引错位）
      const rawFree = simulateScheduleOnce(freeCourses, monthAvailability, allMonthDates, strategy, rangeStart, rangeEnd, baseCtx, tailReserve, cutAfter, freeIndexes ? null : fixedMergeSlots, headReserve, cutBefore);
      if (!rawFree) {
        if (!!process.env.SCHEDULE_DEBUG) console.log(`    [模拟排课] 策略 ${strategy} 不可行（两阶段模拟：日期层无解或槽位层放不下）`);
        continue;
      }
      // 先对「自由课方案」评分（固定合班课槽位不参与评分，v5.63）
      const scored = scoreSimulatedPlan(rawFree, allMonthDates);
      // 结果映射回全量索引：固定合班课槽位按原样占位，自由课槽位按原序填充
      const raw = freeIndexes ? (() => {
        let fi = 0;
        const fullSlots = fixedMergeSlots.map((fx, i) => {
          if (fx) {
            const fxStart = timeToMinutes(fx.startTime);
            const fxEnd = timeToMinutes(fx.endTime);
            return { date: fx.date, startTime: fx.startTime, endTime: fx.endTime, isEvening: isEveningSlot(fxStart, fxEnd) };
          }
          return rawFree.slots[fi++];
        });
        return { ...rawFree, slots: fullSlots, dates: fullSlots.map(s => s.date) };
      })() : rawFree;
      plans.push({ ...raw, strategy, score: scored.score, baseScore: scored.baseScore, timeScoreAvg: scored.timeScoreAvg, detail: scored.detail });
    } catch (e) {
      if (!!process.env.SCHEDULE_DEBUG) console.warn(`  [模拟排课] 策略 ${strategy} 异常：${e && e.message}`);
    }
  }


  // 13 个策略全部模拟不可行（极端情况）：返回 null，由调用方（index.js 已有 null 防护）处理
  if (plans.length === 0) return null;

  plans.sort((a, b) => b.score - a.score);
  const primary = plans[0];
  const secondary = plans[1] || primary;

  if (!!process.env.SCHEDULE_DEBUG) {
    console.log(`  [模拟排课候选方案] 师资=${teacher} 课程数=${totalCourses}${hasFixedMerge ? `（自由课 ${freeCourses.length}）` : ''}`);
    for (const p of plans) {
      console.log(`    ${p.strategy}: score=${p.score.toFixed(2)} 分散基础分=${p.baseScore.toFixed(2)} 时间优先级=${(p.timeScoreAvg ?? 0).toFixed(2)} 槽位=[${p.slots.map(s => `${s.date.slice(5)} ${s.startTime}-${s.endTime}`).join(', ')}]`);
    }
  }
  console.log('分散方案选择:', primary.strategy, '评分:', primary.score.toFixed(2), '日期:', primary.dates.map(d => parseInt(d.slice(-2))));

  return { primary, secondary, candidates: plans };
}
