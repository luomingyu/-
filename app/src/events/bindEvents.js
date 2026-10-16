// 事件绑定：月份导航、多文件累积上传、排课、删除联动、折叠切换（事件委托）
import {
  getState, setCurrentDate, setSelectedDate,
  addAvailabilityFile, addCourseSystemFile, addPresetFile, setUploadStatus, runSchedule,
  deleteAvailabilityFile, deleteCourseSystemFile, deletePresetFile,
  deleteAvailabilityItem, deleteCourseSystemItem, deletePresetItem, deleteScheduledCourse,
  toggleSection, toggleFile, setSelectedClass, setSelectedTeacher, toggleShowAvailability
} from '../state/store.js';
import { parseAvailabilitySheet, parseCourseSystemSheet, parsePresetSheet } from '../utils/excelParser.js';
import { exportScheduledToExcel, exportAvailabilityToExcel } from '../utils/excelExporter.js';
import { parseRequirements, generateAvailability } from '../utils/availabilityGenerator.js';
import { exportCalendarImage } from '../utils/imageExporter.js';

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

  // 师资筛选变更事件
  document.getElementById('teacherFilter')?.addEventListener('change', (e) => {
    setSelectedTeacher(e.target.value);
  });

  // 空闲时间显示切换按钮
  document.getElementById('availabilityToggleBtn')?.addEventListener('click', () => {
    toggleShowAvailability();
  });

  // 生成图片：按当前班级/师资筛选，将日历课表导出为 PNG
  document.getElementById('exportImageBtn')?.addEventListener('click', async () => {
    const state = getState();
    const month = state.currentDate;
    const y = month.getFullYear();
    const m = String(month.getMonth() + 1).padStart(2, '0');
    // 文件名带上当前筛选条件（如：课表_2026年10月_高一A班_张老师.png）
    const suffix = [state.selectedClass, state.selectedTeacher].filter(Boolean).join('_');
    const fileName = `课表_${y}年${m}月${suffix ? '_' + suffix : ''}.png`;
    try {
      await exportCalendarImage(state, fileName);
    } catch (error) {
      alert(`生成图片失败：${error.message}`);
    }
  });

  // 阻止上传按钮、示例表、导出按钮的点击冒泡到 header（避免误触折叠）
  document.querySelectorAll('.upload-btn-wrapper, .example-download, .section-export').forEach(wrapper => {
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
      const { list, warnings, mixedSheets } = await parseCourseSystemSheet(file);
      addCourseSystemFile(file.name, list);
      // v5.83：混合形态子表（既有合班课之前的普通课、又有合班课之后的普通课）暂不做排课处理——
      // 允许导入但标红 error 警告（列出子表名），排课侧整表跳过并写入报告第八章
      const mixedWarn = (mixedSheets && mixedSheets.length > 0)
        ? `🔴 混合形态子表不排课：${mixedSheets.map(m => m.sheetName).join('、')}（先分后合与先合后分并存，请拆分后重新导入）`
        : '';
      const warnMsg = (warnings && warnings.length > 0) ? `⚠ ${warnings.join('；')}` : '';
      const warnParts = [warnMsg, mixedWarn].filter(Boolean);
      if (warnParts.length > 0) {
        // v5.73：未识别班级已保留原值继续排课（宽松模式），黄色警告提示
        const msg = `成功导入 ${list.length} 条（来自 ${file.name}）；${warnParts.join('；')}`;
        // v5.83：混合形态子表视为 error 标红（仍允许导入），其余未识别班级提示仍为 warning 黄色
        setUploadStatus('courseSystem', msg, mixedSheets && mixedSheets.length > 0 ? 'error' : 'warning');
      } else {
        setUploadStatus('courseSystem', `成功导入 ${list.length} 条（来自 ${file.name}）`, 'success');
      }
    } catch (error) {
      setUploadStatus('courseSystem', `导入失败：${error.message}`, 'error');
    }
    event.target.value = '';
  });

  // 上传：已排课表（v5.90，跨科目班级占用约束；累积添加）
  document.getElementById('presetFileInput')?.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    setUploadStatus('preset', '正在解析文件...', 'info');
    try {
      const { list, warnings } = await parsePresetSheet(file);
      addPresetFile(file.name, list);
      const warnMsg = (warnings && warnings.length > 0) ? `⚠ ${warnings.join('；')}` : '';
      const msg = warnMsg ? `成功导入 ${list.length} 条（来自 ${file.name}）；${warnMsg}` : `成功导入 ${list.length} 条（来自 ${file.name}）`;
      setUploadStatus('preset', msg, warnings && warnings.length > 0 ? 'warning' : 'success');
    } catch (error) {
      setUploadStatus('preset', `导入失败：${error.message}`, 'error');
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

  // 导出排课报告（.md）：优先导出最近一次排课的报告；若已多次排课，可保留历史报告在服务器
  document.getElementById('exportReportBtn')?.addEventListener('click', () => {
    const state = getState();
    const reports = state.scheduleReports || [];
    if (reports.length === 0) {
      alert('暂无排课报告，请先执行「智能排课」');
      return;
    }
    const latest = reports[reports.length - 1];
    downloadTextFile(latest.fileName, latest.content);
  });

  // ===== 空闲时间表「生成」模态框 =====
  const availabilityModal = document.getElementById('availabilityModal');

  // 打开模态框（生成页面）；stopPropagation 避免冒泡触发区块折叠
  document.getElementById('genAvailabilityBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    availabilityModal?.classList.remove('hidden');
  });

  // 关闭：关闭按钮 / 点击遮罩
  document.getElementById('availabilityModalClose')?.addEventListener('click', () => {
    availabilityModal?.classList.add('hidden');
  });
  availabilityModal?.addEventListener('click', (e) => {
    if (e.target === availabilityModal) availabilityModal.classList.add('hidden');
  });

  // Esc 键关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') availabilityModal?.classList.add('hidden');
  });

  // 输出 Excel：按「底层要求（每天 09:00-12:00、14:00-23:00）+ 框内要求（师资约束）」生成空闲时间表并导出
  document.getElementById('availabilityExportExcelBtn')?.addEventListener('click', () => {
    const state = getState();
    const note = document.getElementById('availabilityModalNote')?.value.trim() || '';
    const requirements = parseRequirements(note);
    if (requirements.length === 0) {
      alert('请先填写排课要求，格式：师资名，年月，每周二18点后不排课，周末不排课');
      return;
    }
    const month = state.currentDate;
    const y = month.getFullYear();
    const m = month.getMonth();
    const rows = generateAvailability({ year: y, month: m, requirements });
    if (rows.length === 0) {
      alert('未生成任何空闲时间，请检查排课要求');
      return;
    }
    // v5.74：文件名从实际生成的 rows 推导年月（与直接录入一致），
    // 避免 requirements 中写"26年10月"（两位年份）时文件名仍标成 currentDate 对应月份
    const monthSet = new Set(rows.map(r => {
      const [ry, rm] = r.date.split('-');
      return `${ry}年${parseInt(rm, 10)}月`;
    }));
    exportAvailabilityToExcel(rows, `空闲时间表_${[...monthSet].join('、')}.xlsx`);
  });

  // ===== 直接录入：按排课要求生成空闲时间表并直接录入 =====
  document.getElementById('availabilityDirectBtn')?.addEventListener('click', () => {
    const state = getState();
    const note = document.getElementById('availabilityModalNote')?.value.trim() || '';
    const requirements = parseRequirements(note);
    if (requirements.length === 0) {
      alert('请先填写排课要求，格式：师资名，年月，每周二18点后不排课，周末不排课');
      return;
    }
    const month = state.currentDate;
    const y = month.getFullYear();
    const m = month.getMonth();
    const rows = generateAvailability({ year: y, month: m, requirements });
    if (rows.length === 0) {
      alert('未生成任何空闲时间，请检查排课要求');
      return;
    }
    // 文件名：师资-年月-师资空闲时间表（如：罗明宇-2026年9月-师资空闲时间表；多名师资/多月用顿号分隔）
    const teacherSet = new Set(rows.map(r => r.teacher));
    const monthSet = new Set(rows.map(r => {
      const [ry, rm] = r.date.split('-');
      return `${ry}年${parseInt(rm, 10)}月`;
    }));
    const fileName = `${[...teacherSet].join('、')}-${[...monthSet].join('、')}-师资空闲时间表`;
    addAvailabilityFile(fileName, rows);
    setUploadStatus('availability', `已生成并录入 ${rows.length} 条空闲时间（${fileName}）`, 'success');
    availabilityModal?.classList.add('hidden');
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
      case 'delete-preset-file': {
        const fileId = target.dataset.fileId;
        if (fileId) deletePresetFile(fileId);
        break;
      }
      case 'delete-preset-item': {
        const itemId = target.dataset.itemId;
        if (itemId) deletePresetItem(itemId);
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

/** 下载文本文件（utf-8，用于导出 Markdown 排课报告） */
function downloadTextFile(fileName, content) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
