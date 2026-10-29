// 日历渲染
import { WEEKDAYS, MONTHS, getSubjectCardClass } from '../config/constants.js';
import { formatDate, isToday, isSelected } from '../utils/dateUtils.js';
import { getCoursesForDate, getAvailabilityForDate, getPresetForDate } from '../state/selectors.js';
import { setCurrentDate, setSelectedDate } from '../state/store.js';
import { abbreviateClassType } from '../utils/classRegistry.js';

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
export function fillMonthGrid(container, state) {
  const allDays = getMonthDayData(state.currentDate.getFullYear(), state.currentDate.getMonth());
  for (let weekIndex = 0; weekIndex < 6; weekIndex++) {
    const weekRow = document.createElement('div');
    weekRow.className = 'week-row';

    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      const dayData = allDays[weekIndex * 7 + dayIndex];
      weekRow.appendChild(createDayCell(dayData, state));
    }

    container.appendChild(weekRow);
  }
}

/** 渲染整个日历 */
export function renderCalendar(state) {
  const year = state.currentDate.getFullYear();
  const month = state.currentDate.getMonth();

  const titleEl = document.getElementById('calendarTitle');
  const subtitleEl = document.getElementById('calendarSubtitle');
  const gridEl = document.getElementById('calendarGrid');
  if (!titleEl || !gridEl) return;

  titleEl.textContent = `${year}年${MONTHS[month]}`;
  subtitleEl.textContent = `星期${WEEKDAYS[state.currentDate.getDay()]}`;
  gridEl.innerHTML = '';

  fillMonthGrid(gridEl, state);
}

function createDayCell(dayData, state) {
  const { day, date, isCurrentMonth } = dayData;
  const dateStr = formatDate(date);
  const dayCourses = getCoursesForDate(state, dateStr);
  const dayPresets = getPresetForDate(state, dateStr);
  const dayAvailability = getAvailabilityForDate(state, dateStr);

  const cell = document.createElement('div');
  cell.className = 'day-cell';
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
      teacher: c.teacher, startTime: c.startTime, endTime: c.endTime
    })),
    ...dayPresets.map(p => ({
      type: 'preset', classType: p.classType, name: p.courseName || '(未填课节名称)',
      teacher: p.teacher, startTime: p.startTime, endTime: p.endTime
    }))
  ].sort((a, b) => a.startTime.localeCompare(b.startTime));

  timeline.forEach(course => {
    const card = document.createElement('div');
    card.className = getCourseCardClass(course.type, course.teacher);
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

  return cell;
}
