// 事件绑定：月份导航、多文件累积上传、排课、删除联动、折叠切换（事件委托）
import {
  getState, setCurrentDate, setSelectedDate,
  addAvailabilityFile, addCourseSystemFile, setUploadStatus, runSchedule,
  deleteAvailabilityFile, deleteCourseSystemFile,
  deleteAvailabilityItem, deleteCourseSystemItem, deleteScheduledCourse,
  toggleSection, toggleFile, setSelectedClass
} from '../state/store.js';
import { parseAvailabilitySheet, parseCourseSystemSheet } from '../utils/excelParser.js';
import { exportScheduledToExcel } from '../utils/excelExporter.js';

export function bindEvents() {
  // 初始化年月选择器
  initMonthSelector();

  // 月份导航
  document.getElementById('prevMonthBtn')?.addEventListener('click', () => {
    const d = getState().currentDate;
    const newDate = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    setCurrentDate(newDate);
    syncMonthSelector(newDate);
  });

  document.getElementById('nextMonthBtn')?.addEventListener('click', () => {
    const d = getState().currentDate;
    const newDate = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    setCurrentDate(newDate);
    syncMonthSelector(newDate);
  });

  document.getElementById('todayBtn')?.addEventListener('click', () => {
    const now = new Date();
    setCurrentDate(now);
    setSelectedDate(now);
    syncMonthSelector(now);
  });

  // 年月选择器变更事件
  document.getElementById('yearSelect')?.addEventListener('change', onMonthSelectorChange);
  document.getElementById('monthSelect')?.addEventListener('change', onMonthSelectorChange);

  // 班级筛选变更事件
  document.getElementById('classFilter')?.addEventListener('change', (e) => {
    setSelectedClass(e.target.value);
  });

  // 阻止上传按钮、导出按钮的点击冒泡到 header（避免误触折叠）
  document.querySelectorAll('.upload-btn-wrapper, .section-export').forEach(wrapper => {
    wrapper.addEventListener('click', e => e.stopPropagation());
  });

  // 上传：师资空闲时间表（累积添加，每次上传生成一个文件节点）
  document.getElementById('fileInput')?.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    setUploadStatus('availability', '正在解析文件...', 'info');
    try {
      const list = await parseAvailabilitySheet(file);
      addAvailabilityFile(file.name, list);
      setUploadStatus('availability', `成功导入 ${list.length} 条（来自 ${file.name}）`, 'success');
    } catch (error) {
      setUploadStatus('availability', `导入失败：${error.message}`, 'error');
    }
    event.target.value = '';
  });

  // 上传：课程体系表（累积添加）
  document.getElementById('courseSystemFileInput')?.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    setUploadStatus('courseSystem', '正在解析文件...', 'info');
    try {
      const list = await parseCourseSystemSheet(file);
      addCourseSystemFile(file.name, list);
      setUploadStatus('courseSystem', `成功导入 ${list.length} 条（来自 ${file.name}）`, 'success');
    } catch (error) {
      setUploadStatus('courseSystem', `导入失败：${error.message}`, 'error');
    }
    event.target.value = '';
  });

  // 智能排课
  document.getElementById('scheduleBtn')?.addEventListener('click', () => {
    runSchedule();
  });

  // 导出排课结果（直接绑定，不受 stopPropagation 影响）
  document.getElementById('exportScheduledBtn')?.addEventListener('click', () => {
    const state = getState();
    if (!state.courses || state.courses.length === 0) {
      alert('暂无排课数据可导出');
      return;
    }
    const month = state.currentDate;
    const y = month.getFullYear();
    const m = String(month.getMonth() + 1).padStart(2, '0');
    exportScheduledToExcel(state.courses, `排课结果_${y}年${m}月.xlsx`);
  });

  // 统一事件委托：折叠切换 + 删除联动
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;

    switch (action) {
      case 'toggle-section': {
        const key = target.dataset.key;
        if (key) toggleSection(key);
        break;
      }
      case 'toggle-file': {
        const fileId = target.dataset.fileId;
        if (fileId) toggleFile(fileId);
        break;
      }
      case 'delete-availability-file': {
        const fileId = target.dataset.fileId;
        if (fileId) deleteAvailabilityFile(fileId);
        break;
      }
      case 'delete-availability-item': {
        const itemId = target.dataset.itemId;
        if (itemId) deleteAvailabilityItem(itemId);
        break;
      }
      case 'delete-course-file': {
        const fileId = target.dataset.fileId;
        if (fileId) deleteCourseSystemFile(fileId);
        break;
      }
      case 'delete-course-item': {
        const itemId = target.dataset.itemId;
        if (itemId) deleteCourseSystemItem(itemId);
        break;
      }
      case 'delete-scheduled': {
        const index = parseInt(target.dataset.index, 10);
        if (!isNaN(index)) deleteScheduledCourse(index);
        break;
      }
    }
  });
}

// ============ 年月选择器 ============

/** 初始化年月选择器 */
function initMonthSelector() {
  const yearSelect = document.getElementById('yearSelect');
  const monthSelect = document.getElementById('monthSelect');
  if (!yearSelect || !monthSelect) return;

  const currentYear = new Date().getFullYear();

  // 年份选项：当前年份前5年到后5年
  for (let y = currentYear - 5; y <= currentYear + 5; y++) {
    const option = document.createElement('option');
    option.value = String(y);
    option.textContent = `${y}年`;
    yearSelect.appendChild(option);
  }

  // 月份选项：1-12月
  const monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
  monthNames.forEach((name, idx) => {
    const option = document.createElement('option');
    option.value = String(idx);
    option.textContent = name;
    monthSelect.appendChild(option);
  });

  // 初始同步
  syncMonthSelector(getState().currentDate);
}

/** 同步选择器显示 */
function syncMonthSelector(date) {
  const yearSelect = document.getElementById('yearSelect');
  const monthSelect = document.getElementById('monthSelect');
  if (!yearSelect || !monthSelect) return;

  yearSelect.value = String(date.getFullYear());
  monthSelect.value = String(date.getMonth());
}

/** 年月选择器变更处理 */
function onMonthSelectorChange() {
  const yearSelect = document.getElementById('yearSelect');
  const monthSelect = document.getElementById('monthSelect');
  if (!yearSelect || !monthSelect) return;

  const year = parseInt(yearSelect.value, 10);
  const month = parseInt(monthSelect.value, 10);

  if (isNaN(year) || isNaN(month)) return;

  const newDate = new Date(year, month, 1);
  setCurrentDate(newDate);
  setSelectedDate(newDate);
}
