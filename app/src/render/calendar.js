// 日历渲染
import { MONTHS, getSubjectCardClass } from '../config/constants.js';
import { formatDate, isToday, isSelected, timeToMinutes } from '../utils/dateUtils.js';
import { getCoursesForDate, getAvailabilityForDate, getPresetForDate, findAdjustableCourse, getAdjustableForDate } from '../state/selectors.js';
import { setCurrentDate, setSelectedDate } from '../state/store.js';
import { abbreviateClassType } from '../utils/classRegistry.js';
import { splitClassTypes } from '../utils/classType.js';
import { computeAdjustSegments, resolveCourseSheetKeys } from '../utils/adjustRange.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function getCourseCardClass(type, teacher) {
  return `course-card ${type} ${getSubjectCardClass(teacher)}`;
}

/** 计算月历 42 格（6 周）的日期数据（含上下月补位） */
export function getMonthDayData(year, month) {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  // 表头为周一开头，故首列偏移以「周一=0」计算
  const startDay = (firstDay.getDay() + 6) % 7;
  const totalDays = lastDay.getDate();

  const allDays = [];

  // 上月尾部
  const prevMonthLastDay = new Date(year, month, 0).getDate();
  for (let i = startDay - 1; i >= 0; i--) {
    const day = prevMonthLastDay - i;
    const date = new Date(year, month - 1, day);
    allDays.push({ day, date, isCurrentMonth: false });
  }

  // 本月
  for (let day = 1; day <= totalDays; day++) {
    const date = new Date(year, month, day);
    allDays.push({ day, date, isCurrentMonth: true });
  }

  // 下月头部，凑满 42 格
  const remainingDays = 42 - allDays.length;
  for (let day = 1; day <= remainingDays; day++) {
    const date = new Date(year, month + 1, day);
    allDays.push({ day, date, isCurrentMonth: false });
  }

  return allDays;
}

/** 将月历 42 格写入指定容器（日历视图与导出图片共用同一套渲染） */
export function fillMonthGrid(container, state, opts = {}) {
  const allDays = getMonthDayData(state.currentDate.getFullYear(), state.currentDate.getMonth());
  // 导出图片时不渲染调课态的绿色段/高亮
  const adjust = opts.forExport ? null : buildAdjustContext(state, allDays);
  for (let weekIndex = 0; weekIndex < 6; weekIndex++) {
    const weekRow = document.createElement('div');
    weekRow.className = 'week-row';

    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      const dayData = allDays[weekIndex * 7 + dayIndex];
      weekRow.appendChild(createDayCell(dayData, state, adjust));
    }

    container.appendChild(weekRow);
  }
}

/**
 * 构建调课高亮上下文（仅在调课模式且已选中课程时有效）。
 * 返回 { course, segments, selectedSheetKeys, selectedClasses, sheetKeysOf }
 */
function buildAdjustContext(state, allDays) {
  if (!state.adjustMode || !state.selectedCourseId) return null;
  // 被调对象可以是排课结果课程，也可以是「已排课表」条目
  const course = findAdjustableCourse(state, state.selectedCourseId);
  if (!course) return null;

  const dates = allDays.map(d => formatDate(d.date));
  const segments = computeAdjustSegments({
    course,
    courses: state.courses,
    presets: state.presetData,
    courseSystemData: state.courseSystemData,
    dates
  });

  // 选中课程在课程体系表中对应的子表（排课结果按 sourceItemId 精确命中，
  // 「已排课表」条目按属性匹配），作为黄色高亮的依据
  const selectedSheetKeys = resolveCourseSheetKeys(course, state.courseSystemData);

  // 日历上每门课（排课结果 or「已排课表」条目）→ 其对应子表 key 集合，按 sourceItemId 缓存
  const sheetKeysCache = new Map();
  const sheetKeysOf = (c) => {
    if (!sheetKeysCache.has(c.sourceItemId)) {
      sheetKeysCache.set(c.sourceItemId, resolveCourseSheetKeys(c, state.courseSystemData));
    }
    return sheetKeysCache.get(c.sourceItemId);
  };

  return {
    course,
    segments,
    dragging: !!state.adjustDragging,
    selectedSheetKeys,
    selectedClasses: new Set(splitClassTypes(course.classType)),
    sheetKeysOf
  };
}

/**
 * 判定某课程相对当前选中课程的调课高亮关系：selected / yellow / red / null
 * 优先级：所选课程自身 > 同子表其它课程（黄）> 同师资/同班级（红）。
 * 注意：一个子表的班级（A 列）通常一致，同子表课程往往同时满足「同班级」，
 * 若先判红则黄色永不出现；故必须把「同子表」判定前置，保证需求
 * 「该课程同一子表的其他课程用黄色显示」生效（普通视图 + 拖拽时间轴共用本函数）。
 */
function getAdjustRelation(course, adjust) {
  if (!adjust) return null;
  if (course.sourceItemId === adjust.course.sourceItemId) return 'selected';
  const sheetKeys = adjust.sheetKeysOf(course);
  if (sheetKeys.size > 0 && [...sheetKeys].some(k => adjust.selectedSheetKeys.has(k))) return 'yellow';
  const sameTeacher = !!course.teacher && course.teacher === adjust.course.teacher;
  const sameClass = splitClassTypes(course.classType).some(c => adjust.selectedClasses.has(c));
  if (sameTeacher || sameClass) return 'red';
  return null;
}

const DAY_MINUTES = 24 * 60; // 一天按 1440 分钟计，用于时间轴高度比例

/**
 * 拖动调课中：把某日期格渲染为 00:00–23:59 的时间轴。
 * 绿=可落点（adjust-segment，可被 elementFromPoint 命中）、红=同师资/同班级占用、
 * 黄=同子表其它课程、蓝=被调课程自身（原时间）、灰=其它时段。
 * 每项 flexGrow = 分钟数、flexBasis = 0 → 高度严格按真实时间比例分配，绿段不再与卡片错位。
 */
function renderDragTimeline(container, state, adjust, dateStr, dayCourses) {
  container.classList.add('day-courses--timeline');

  // 覆盖块：红=同师资/同班级，黄=同子表其它课程，self=被调课程自身（原时间）
  const overlays = [];
  dayCourses.forEach(c => {
    const relation = getAdjustRelation(c, adjust);
    if (relation !== 'red' && relation !== 'yellow' && relation !== 'selected') return;
    overlays.push({
      kind: relation === 'selected' ? 'self' : relation,
      course: c,
      start: timeToMinutes(c.startTime),
      end: timeToMinutes(c.endTime)
    });
  });

  // 绿色可调课时间段：被覆盖块切分后，每一片仍指向同一整段
  // → 无论落在原时间上还是绿段其余位置，落点范围都保持为该整段（原时间点不会被删除）
  const freeSegs = (adjust.segments[dateStr] || []).map(seg => ({
    seg,
    start: timeToMinutes(seg.startTime),
    end: timeToMinutes(seg.endTime)
  }));

  const items = [];
  freeSegs.forEach(s => {
    let pieces = [{ kind: 'free', start: s.start, end: s.end, seg: s.seg }];
    overlays.forEach(ov => {
      const next = [];
      pieces.forEach(p => {
        if (ov.end <= p.start || ov.start >= p.end) { next.push(p); return; }
        if (ov.start > p.start) next.push({ ...p, end: ov.start });
        if (ov.end < p.end) next.push({ ...p, start: ov.end });
      });
      pieces = next;
    });
    items.push(...pieces);
  });

  // 覆盖块：落在绿色段内的（如课程原时间、同子表黄课）同样挂 .adjust-segment，保证仍是合法落点
  overlays.forEach(ov => {
    const host = freeSegs.find(s => ov.start < s.end && ov.end > s.start);
    items.push({ ...ov, seg: host ? host.seg : null });
  });

  items.sort((a, b) => a.start - b.start || b.end - a.end);

  // 用灰色占位补全 00:00–24:00，并裁剪重叠，保证各块高度与真实分钟数成比例
  const filled = [];
  let cursor = 0;
  items.forEach(item => {
    const start = Math.max(item.start, cursor);
    if (start > cursor) filled.push({ kind: 'gap', start: cursor, end: start });
    if (item.end <= start) return;
    filled.push({ ...item, start });
    cursor = item.end;
  });
  if (cursor < DAY_MINUTES) filled.push({ kind: 'gap', start: cursor, end: DAY_MINUTES });

  filled.forEach(item => {
    const el = document.createElement('div');
    el.className = `adjust-timeline__item adjust-timeline__item--${item.kind}`;
    el.style.flexGrow = String(Math.max(1, item.end - item.start));
    el.style.flexBasis = '0';

    // 落在绿色段内的块复用 adjust-segment：拖拽落点判定与 hover 高亮都依赖该类
    if (item.seg) {
      el.classList.add('adjust-segment');
      el.dataset.date = dateStr;
      el.dataset.start = item.seg.startTime;
      el.dataset.end = item.seg.endTime;
    }

    if (item.kind === 'free') {
      el.textContent = `${item.seg.startTime}-${item.seg.endTime}`;
    } else if (item.kind !== 'gap') {
      const displayClass = state.abbreviateClass
        ? abbreviateClassType(item.course.classType || '')
        : (item.course.classType || '');
      el.innerHTML = `
        ${item.kind === 'self' ? '<div class="adjust-timeline__tag">原时间</div>' : ''}
        ${displayClass ? `<div class="course-class">${escapeHtml(displayClass)}</div>` : ''}
        <div class="course-name">${escapeHtml(item.course.name)}</div>
        <div class="course-time">${item.course.startTime} - ${item.course.endTime}</div>
      `;
    }
    container.appendChild(el);
  });
}

/** 渲染整个日历 */
export function renderCalendar(state) {
  const year = state.currentDate.getFullYear();
  const month = state.currentDate.getMonth();

  const titleEl = document.getElementById('calendarTitle');
  const gridEl = document.getElementById('calendarGrid');
  if (!titleEl || !gridEl) return;

  titleEl.textContent = `${year}年${MONTHS[month]}`;
  gridEl.innerHTML = '';
  // 拖拽态由状态驱动（不靠手工加减类），重绘后依然生效
  gridEl.classList.toggle('adjust-dragging', !!state.adjustDragging);

  fillMonthGrid(gridEl, state);
}

function createDayCell(dayData, state, adjust) {
  const { day, date, isCurrentMonth } = dayData;
  const dateStr = formatDate(date);
  const dayCourses = getCoursesForDate(state, dateStr);
  const dayPresets = getPresetForDate(state, dateStr);
  const dayAvailability = getAvailabilityForDate(state, dateStr);

  const cell = document.createElement('div');
  cell.className = 'day-cell';
  // 供拖拽时按日期定位单元格（锚定「授课日期」）
  cell.dataset.date = dateStr;
  if (!isCurrentMonth) cell.classList.add('other-month');

  const dayHeader = document.createElement('div');
  dayHeader.className = 'day-header';

  const dayNumber = document.createElement('div');
  dayNumber.className = 'day-number';
  dayNumber.textContent = day;

  if (isToday(date)) dayNumber.classList.add('today');
  if (isSelected(date, state.selectedDate)) dayNumber.classList.add('selected');

  dayNumber.addEventListener('click', () => {
    if (!isCurrentMonth) {
      setCurrentDate(new Date(date.getFullYear(), date.getMonth(), 1));
    }
    setSelectedDate(date);
  });

  dayHeader.appendChild(dayNumber);

  if ((dayCourses.length > 0 || dayAvailability.length > 0 || dayPresets.length > 0) && isCurrentMonth) {
    const dayDot = document.createElement('div');
    dayDot.className = 'day-dot';
    dayHeader.appendChild(dayDot);
  }

  cell.appendChild(dayHeader);

  const dayCoursesEl = document.createElement('div');
  dayCoursesEl.className = 'day-courses';

  // 拖动调课中：整格改为 00:00–23:59 时间轴（绿=可落点，红=同师资/同班级占用，灰=其它时段）
  // 覆盖对象包含排课结果课程与「已排课表」条目，与落点占用判定口径一致
  if (adjust && adjust.dragging) {
    renderDragTimeline(dayCoursesEl, state, adjust, dateStr, getAdjustableForDate(state, dateStr));
    cell.appendChild(dayCoursesEl);
    return cell;
  }

  if (state.showAvailability) {
    dayAvailability.forEach(item => {
      const card = document.createElement('div');
      card.className = 'availability-card';
      card.innerHTML = `
      <div class="availability-time">${item.startTime} - ${item.endTime}</div>
      <div class="availability-teacher">👤 ${item.teacher}</div>
    `;
      dayCoursesEl.appendChild(card);
    });
  }

  // 已排课表条目与排课结果合并，按开始时间排序后展示（已排课表卡片带 preset 样式区分）
  const timeline = [
    ...dayCourses.map(c => ({
      type: c.type, classType: c.classType, name: c.name,
      teacher: c.teacher, startTime: c.startTime, endTime: c.endTime,
      sourceItemId: c.sourceItemId
    })),
    ...dayPresets.map(p => ({
      type: 'preset', classType: p.classType, name: p.courseName || '(未填课节名称)',
      teacher: p.teacher, startTime: p.startTime, endTime: p.endTime,
      // 「已排课表」条目同样可调课：itemId 作为 sourceItemId，使其与排课结果课程走同一套拖拽链路
      sourceItemId: p.itemId
    }))
  ].sort((a, b) => a.startTime.localeCompare(b.startTime));

  timeline.forEach(course => {
    const card = document.createElement('div');
    card.className = getCourseCardClass(course.type, course.teacher);
    // 调课模式：标注所选课程与关联课程（红=同师资/同班级，黄=同子表其它课程）
    if (course.sourceItemId) {
      card.dataset.courseId = course.sourceItemId;
      card.classList.add('course-card--adjustable');
      const relation = getAdjustRelation(course, adjust);
      if (relation === 'selected') card.classList.add('adjust-selected');
      else if (relation === 'red') card.classList.add('adjust-related-red');
      else if (relation === 'yellow') card.classList.add('adjust-related-yellow');
    }
    const displayClass = state.abbreviateClass
      ? abbreviateClassType(course.classType || '')
      : (course.classType || '');
    const displayTeacher = course.teacher || '';
    card.innerHTML = `
      ${displayClass ? `<div class="course-class">${escapeHtml(displayClass)}</div>` : ''}
      <div class="course-name">${escapeHtml(course.name)}</div>
      <div class="course-teacher">${escapeHtml(displayTeacher)}</div>
      <div class="course-time">${course.startTime} - ${course.endTime}</div>
    `;
    dayCoursesEl.appendChild(card);
  });

  cell.appendChild(dayCoursesEl);

  // 调课模式：渲染该日期的绿色可调课时间段（拖拽落点）
  const daySegments = adjust && adjust.segments[dateStr];
  if (daySegments && daySegments.length > 0) {
    const segWrap = document.createElement('div');
    segWrap.className = 'adjust-segments';
    daySegments.forEach(seg => {
      const segEl = document.createElement('div');
      segEl.className = 'adjust-segment';
      segEl.dataset.date = dateStr;
      segEl.dataset.start = seg.startTime;
      segEl.dataset.end = seg.endTime;
      segEl.textContent = `${seg.startTime}-${seg.endTime}`;
      segWrap.appendChild(segEl);
    });
    cell.appendChild(segWrap);
  }

  return cell;
}
