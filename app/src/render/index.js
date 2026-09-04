// 渲染编排：订阅 store 变更后统一重绘各区域
import { renderCalendar } from './calendar.js';
import { renderCourseSystem } from './courseSystem.js';
import { renderAvailabilityList, renderScheduledList, renderStatus } from './dataLists.js';
import { getAllClasses, getAllTeachers } from '../state/selectors.js';
import { setSelectedClass, setSelectedTeacher } from '../state/store.js';

/** 更新班级筛选下拉选项 */
function renderClassFilter(state) {
  const select = document.getElementById('classFilter');
  if (!select) return;

  const classes = getAllClasses(state);
  let current = state.selectedClass || '';

  // 若所选班级已不存在（如删除了对应文件），重置为全部班级
  if (current && !classes.includes(current)) {
    current = '';
    setSelectedClass('');
  }

  // 如果选项未变化则跳过（避免重置选中项）
  const existing = [...select.options].map(o => o.value);
  const expected = ['', ...classes];
  if (existing.length === expected.length && existing.every((v, i) => v === expected[i])) {
    select.value = current;
    return;
  }

  select.innerHTML = '<option value="">全部班级</option>';
  classes.forEach(cls => {
    const opt = document.createElement('option');
    opt.value = cls;
    opt.textContent = cls;
    select.appendChild(opt);
  });
  select.value = current;
}

/** 更新师资筛选下拉选项 */
function renderTeacherFilter(state) {
  const select = document.getElementById('teacherFilter');
  if (!select) return;

  const teachers = getAllTeachers(state);
  let current = state.selectedTeacher || '';

  // 若所选师资已不存在（如删除了对应文件），重置为全部师资
  if (current && !teachers.includes(current)) {
    current = '';
    setSelectedTeacher('');
  }

  // 如果选项未变化则跳过（避免重置选中项）
  const existing = [...select.options].map(o => o.value);
  const expected = ['', ...teachers];
  if (existing.length === expected.length && existing.every((v, i) => v === expected[i])) {
    select.value = current;
    return;
  }

  select.innerHTML = '<option value="">全部师资</option>';
  teachers.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    select.appendChild(opt);
  });
  select.value = current;
}

/** 全量重绘 */
export function renderAll(state) {
  renderClassFilter(state);
  renderTeacherFilter(state);
  renderAvailabilityList(state);
  renderScheduledList(state);
  renderCourseSystem(state);
  renderCalendar(state);
  renderStatus(state);
}
