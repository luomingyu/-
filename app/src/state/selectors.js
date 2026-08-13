// 派生查询（纯函数，接收 state 片段）

/** 获取某日的课程（按开始时间排序，支持班级筛选） */
export function getCoursesForDate(state, dateStr) {
  const { selectedClass } = state;
  return state.courses
    .filter(course => course.date === dateStr)
    .filter(course => !selectedClass || course.classType === selectedClass)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** 获取排课结果列表（支持班级筛选） */
export function getScheduledCourses(state) {
  const { selectedClass } = state;
  return state.courses
    .filter(course => !selectedClass || course.classType === selectedClass)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
}

/** 获取所有班级列表（从课程体系表 + 排课结果中收集） */
export function getAllClasses(state) {
  const classSet = new Set();
  state.courseSystemData.forEach(item => classSet.add(item.classType));
  state.courses.forEach(c => classSet.add(c.classType));
  return [...classSet].sort();
}

/** 获取某日的空闲时间（按开始时间排序） */
export function getAvailabilityForDate(state, dateStr) {
  return state.availabilityData
    .filter(item => item.date === dateStr)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** 获取当前月份范围内的空闲时间 */
export function getMonthAvailability(state) {
  const { currentDate, availabilityData } = state;
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const totalDays = new Date(year, month + 1, 0).getDate();

  const currentMonthDates = new Set();
  for (let i = 1; i <= totalDays; i++) {
    const d = new Date(year, month, i);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    currentMonthDates.add(`${year}-${m}-${day}`);
  }

  return availabilityData.filter(a => currentMonthDates.has(a.date));
}

/** 课程体系表统计 */
export function getCourseSystemStats(state) {
  const data = state.courseSystemData;
  const uniqueClasses = new Set(data.map(item => item.classType));
  const uniqueTeachers = new Set(data.map(item => item.teacher));
  const scheduledCount = data.filter(item => item.scheduled === true).length;
  const unscheduledCount = data.filter(item => item.scheduled === false).length;

  return {
    uniqueClasses: uniqueClasses.size,
    uniqueTeachers: uniqueTeachers.size,
    total: data.length,
    scheduledCount,
    unscheduledCount
  };
}
