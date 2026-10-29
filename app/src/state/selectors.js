// 派生查询（纯函数，接收 state 片段）
import { splitClassTypes } from '../utils/classType.js';

/** 筛选课程是否命中选中的班级（多选：空=全部；合班课展开后与任一选中班级有交集即命中） */
function matchesSelectedClass(course, selectedClasses) {
  if (!selectedClasses || selectedClasses.length === 0) return true;
  const classes = splitClassTypes(course.classType);
  return selectedClasses.some(cls => classes.includes(cls));
}

/** 筛选是否命中选中的师资（多选：空=全部；命中任一选中师资即通过） */
function matchesSelectedTeacher(item, selectedTeachers) {
  if (!selectedTeachers || selectedTeachers.length === 0) return true;
  return selectedTeachers.includes(item.teacher);
}

/** 获取某日的课程（按开始时间排序，支持班级/师资多选筛选） */
export function getCoursesForDate(state, dateStr) {
  const { selectedClasses, selectedTeachers } = state;
  return state.courses
    .filter(course => course.date === dateStr)
    .filter(course => matchesSelectedClass(course, selectedClasses))
    .filter(course => matchesSelectedTeacher(course, selectedTeachers))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** 获取排课结果列表（支持班级/师资多选筛选） */
export function getScheduledCourses(state) {
  const { selectedClasses, selectedTeachers } = state;
  return state.courses
    .filter(course => matchesSelectedClass(course, selectedClasses))
    .filter(course => matchesSelectedTeacher(course, selectedTeachers))
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
}

/** 获取所有班级列表（从课程体系表 + 已排课表 + 排课结果中收集；合班课展开为单班去重） */
export function getAllClasses(state) {
  const classSet = new Set();
  state.courseSystemData.forEach(item =>
    splitClassTypes(item.classType).forEach(cls => classSet.add(cls)));
  (state.presetData || []).forEach(item =>
    splitClassTypes(item.classType).forEach(cls => classSet.add(cls)));
  state.courses.forEach(c =>
    splitClassTypes(c.classType).forEach(cls => classSet.add(cls)));
  return [...classSet].sort();
}

/** 获取所有师资列表（从空闲时间表 + 课程体系表 + 已排课表 + 排课结果中收集） */
export function getAllTeachers(state) {
  const teacherSet = new Set();
  state.availabilityData.forEach(item => { if (item.teacher) teacherSet.add(item.teacher); });
  state.courseSystemData.forEach(item => { if (item.teacher) teacherSet.add(item.teacher); });
  (state.presetData || []).forEach(item => { if (item.teacher) teacherSet.add(item.teacher); });
  state.courses.forEach(c => { if (c.teacher) teacherSet.add(c.teacher); });
  return [...teacherSet].sort();
}

/** 获取某日的空闲时间（按开始时间排序，支持师资多选筛选） */
export function getAvailabilityForDate(state, dateStr) {
  const { selectedTeachers } = state;
  return state.availabilityData
    .filter(item => item.date === dateStr)
    .filter(item => matchesSelectedTeacher(item, selectedTeachers))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** 是否命中已排课表的班级/师资多选筛选 */
function matchesPresetFilter(item, selectedClasses, selectedTeachers) {
  if (!matchesSelectedClass(item, selectedClasses)) return false;
  if (!matchesSelectedTeacher(item, selectedTeachers)) return false;
  return true;
}

/** 获取某日的已排课表条目（按开始时间排序，支持班级/师资多选筛选；师资为空时不参与师资筛选） */
export function getPresetForDate(state, dateStr) {
  const { selectedClasses, selectedTeachers } = state;
  return (state.presetData || [])
    .filter(item => item.date === dateStr)
    .filter(item => matchesPresetFilter(item, selectedClasses, selectedTeachers))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** 已排课表文件（按选中班级/师资多选过滤条目；过滤后无条目的文件不返回） */
export function getFilteredPresetFiles(state) {
  const { selectedClasses, selectedTeachers } = state;
  return (state.presetFiles || [])
    .map(file => ({
      ...file,
      items: file.items.filter(item => matchesPresetFilter(item, selectedClasses, selectedTeachers))
    }))
    .filter(file => file.items.length > 0);
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
  // 合班课按单班展开统计班级数（"班A,班B" 记 2 个班级）
  const classSet = new Set();
  data.forEach(item => splitClassTypes(item.classType).forEach(cls => classSet.add(cls)));
  const uniqueTeachers = new Set(data.map(item => item.teacher));
  const scheduledCount = data.filter(item => item.scheduled === true).length;
  const unscheduledCount = data.filter(item => item.scheduled === false).length;

  return {
    uniqueClasses: classSet.size,
    uniqueTeachers: uniqueTeachers.size,
    total: data.length,
    scheduledCount,
    unscheduledCount
  };
}
