// 日历渲染
import { WEEKDAYS, MONTHS } from '../config/constants.js';
import { formatDate, isToday, isSelected } from '../utils/dateUtils.js';
import { getCoursesForDate, getAvailabilityForDate } from '../state/selectors.js';
import { setCurrentDate, setSelectedDate } from '../state/store.js';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function getCourseCardClass(type) {
  return `course-card ${type}`;
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

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startDay = firstDay.getDay();
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

  for (let weekIndex = 0; weekIndex < 6; weekIndex++) {
    const weekRow = document.createElement('div');
    weekRow.className = 'week-row';

    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      const dayData = allDays[weekIndex * 7 + dayIndex];
      const cell = createDayCell(dayData, state);
      weekRow.appendChild(cell);
    }

    gridEl.appendChild(weekRow);
  }
}

function createDayCell(dayData, state) {
  const { day, date, isCurrentMonth } = dayData;
  const dateStr = formatDate(date);
  const dayCourses = getCoursesForDate(state, dateStr);
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

  if ((dayCourses.length > 0 || dayAvailability.length > 0) && isCurrentMonth) {
    const dayDot = document.createElement('div');
    dayDot.className = 'day-dot';
    dayHeader.appendChild(dayDot);
  }

  cell.appendChild(dayHeader);

  const dayCoursesEl = document.createElement('div');
  dayCoursesEl.className = 'day-courses';

  dayAvailability.forEach(item => {
    const card = document.createElement('div');
    card.className = 'availability-card';
    card.innerHTML = `
      <div class="availability-time">${item.startTime} - ${item.endTime}</div>
      <div class="availability-teacher">👤 ${item.teacher}</div>
    `;
    dayCoursesEl.appendChild(card);
  });

  dayCourses.forEach(course => {
    const card = document.createElement('div');
    card.className = getCourseCardClass(course.type);
    const displayClass = course.classType || '';
    const displayTeacher = course.teacher || '';
    card.innerHTML = `
      ${displayClass ? `<div class="course-class">${escapeHtml(displayClass)}</div>` : ''}
      <div class="course-name">${escapeHtml(course.name)}</div>
      <div class="course-time">${course.startTime} - ${course.endTime}</div>
      <div class="course-teacher">${escapeHtml(displayTeacher)}</div>
    `;
    dayCoursesEl.appendChild(card);
  });

  cell.appendChild(dayCoursesEl);

  return cell;
}
