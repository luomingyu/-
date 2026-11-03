// 事件绑定：月份导航、多文件累积上传、排课、删除联动、折叠切换（事件委托）
import {
  getState, setCurrentDate, setSelectedDate,
  addAvailabilityFile, addCourseSystemFile, addPresetFile, setUploadStatus, runSchedule,
  deleteAvailabilityFile, deleteCourseSystemFile, deletePresetFile,
  deleteAvailabilityItem, deleteCourseSystemItem, deletePresetItem, deleteScheduledCourse,
  toggleSection, toggleFile, setSelectedClasses, setSelectedTeachers, toggleShowAvailability, toggleAbbreviateClass,
  toggleAdjustMode, selectCourseForAdjust, applyCourseMove, setAdjustDragging, getAdjustChanges
} from '../state/store.js';
import { parseAvailabilitySheet, parseCourseSystemSheet, parsePresetSheet } from '../utils/excelParser.js';
import { exportScheduledToExcel, exportAvailabilityToExcel, exportAdjustDiffToExcel } from '../utils/excelExporter.js';
import { parseRequirements, generateAvailability } from '../utils/availabilityGenerator.js';
import { exportCalendarImage } from '../utils/imageExporter.js';
import { exportCalendarToFeishu, showFeishuNotice } from '../utils/feishuExporter.js';
import { abbreviateClassType } from '../utils/classRegistry.js';
import { timeToMinutes, minutesToTime } from '../utils/dateUtils.js';
import { computeStartTimes, resolveCourseDuration } from '../utils/adjustRange.js';
import { findAdjustableCourse } from '../state/selectors.js';

// ============ 查看区多选筛选（班级/师资，v6.0.13） ============

/** 收起所有多选筛选面板 */
function closeAllMultiFilterPanels() {
  ['classFilter', 'teacherFilter'].forEach(key => {
    const panel = document.getElementById(`${key}Panel`);
    const trigger = document.getElementById(`${key}Trigger`);
    if (panel) panel.hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
}

/**
 * 绑定一个多选筛选面板：触发器展开/收起（同时关闭另一面板）、勾选增删、清空。
 * 选项与勾选态由 render/index.js 渲染，这里只负责交互与写回 store。
 */
function bindMultiFilter({ triggerId, panelId, optionsId, clearId, getSelected, setSelected }) {
  const trigger = document.getElementById(triggerId);
  const panel = document.getElementById(panelId);
  const box = document.getElementById(optionsId);
  const clear = document.getElementById(clearId);
  if (!trigger || !panel || !box) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = panel.hidden;
    closeAllMultiFilterPanels();
    panel.hidden = !willOpen;
    trigger.setAttribute('aria-expanded', String(willOpen));
  });

  // 面板内点击不冒泡到 document（避免误关）
  panel.addEventListener('click', (e) => e.stopPropagation());

  box.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const current = getSelected();
    const next = cb.checked ? [...current, cb.value] : current.filter(v => v !== cb.value);
    setSelected(next);
  });

  clear?.addEventListener('click', (e) => {
    e.stopPropagation();
    setSelected([]);
  });
}

export function bindEvents() {
  // 初始化年月选择器
  initMonthSelector();

  // 点击页面其他区域 / 按 Esc 收起多选筛选面板
  document.addEventListener('click', closeAllMultiFilterPanels);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllMultiFilterPanels(); });

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

  // 班级 / 师资筛选（多选复选框下拉面板，v6.0.13）
  bindMultiFilter({
    triggerId: 'classFilterTrigger',
    panelId: 'classFilterPanel',
    optionsId: 'classFilterOptions',
    clearId: 'classFilterClear',
    getSelected: () => getState().selectedClasses || [],
    setSelected: setSelectedClasses
  });
  bindMultiFilter({
    triggerId: 'teacherFilterTrigger',
    panelId: 'teacherFilterPanel',
    optionsId: 'teacherFilterOptions',
    clearId: 'teacherFilterClear',
    getSelected: () => getState().selectedTeachers || [],
    setSelected: setSelectedTeachers
  });

  // 空闲时间显示切换按钮
  document.getElementById('availabilityToggleBtn')?.addEventListener('click', () => {
    toggleShowAvailability();
  });

  // 班级缩写显示切换按钮
  document.getElementById('classAbbrToggleBtn')?.addEventListener('click', () => {
    toggleAbbreviateClass();
  });

  // 生成图片：按当前班级/师资筛选，将日历课表导出为 PNG
  document.getElementById('exportImageBtn')?.addEventListener('click', async () => {
    const state = getState();
    const month = state.currentDate;
    const y = month.getFullYear();
    const m = String(month.getMonth() + 1).padStart(2, '0');
    // 文件名带上当前筛选条件（如：课表_2026年10月_高一A班_张老师.png）
    const suffix = [
      ...(state.selectedClasses || []),
      ...(state.selectedTeachers || [])
    ].join('_');
    const fileName = `课表_${y}年${m}月${suffix ? '_' + suffix : ''}.png`;
    try {
      await exportCalendarImage(state, fileName);
    } catch (error) {
      alert(`生成图片失败：${error.message}`);
    }
  });

  // 生成飞书表格：按当前班级/师资筛选，将日历课表输出为飞书在线表格
  document.getElementById('exportFeishuBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    const label = btn.querySelector('span:last-child');
    const originalLabel = label?.textContent || '生成飞书表格';
    btn.disabled = true;
    if (label) label.textContent = '生成中...';
    // 页面内提示条：避免 alert 被拦截/预开空白页导致“点击无反应”
    showFeishuNotice('info', '正在生成飞书表格，请稍候…');
    try {
      const { url, permission } = await exportCalendarToFeishu(getState());
      if (permission && permission.ok === false) {
        showFeishuNotice('info', `飞书表格已生成，但链接分享未开启（${permission.error}），他人可能无法打开：`, url);
      } else {
        showFeishuNotice('success', '飞书表格已生成（组织内获得链接的人可编辑）：', url);
      }
      window.open(url, '_blank', 'noopener');
    } catch (error) {
      showFeishuNotice('error', `生成飞书表格失败：${error.message}`);
    } finally {
      btn.disabled = false;
      if (label) label.textContent = originalLabel;
    }
  });

  // 阻止上传按钮、示例表、导出按钮的点击冒泡到 header（避免误触折叠）
  document.querySelectorAll('.upload-btn-wrapper, .example-download, .section-export').forEach(wrapper => {
    wrapper.addEventListener('click', e => e.stopPropagation());
  });

  // 上传：师资空闲时间表（v5.98 支持一次选择多个文件，逐文件解析并累积添加）
  document.getElementById('fileInput')?.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    setUploadStatus('availability', files.length > 1 ? `正在解析 ${files.length} 个文件...` : '正在解析文件...', 'info');
    let total = 0;
    const okFiles = [];
    const errors = [];
    for (const file of files) {
      try {
        const list = await parseAvailabilitySheet(file);
        addAvailabilityFile(file.name, list);
        total += list.length;
        okFiles.push(file.name);
      } catch (error) {
        errors.push(`${file.name}：${error.message}`);
      }
    }
    if (okFiles.length > 0) {
      const msg = `成功导入 ${total} 条（来自 ${okFiles.length} 个文件）`;
      setUploadStatus(
        'availability',
        errors.length > 0 ? `${msg}；失败 ${errors.length} 个：${errors.join('；')}` : msg,
        errors.length > 0 ? 'warning' : 'success'
      );
    } else {
      setUploadStatus('availability', `导入失败：${errors.join('；')}`, 'error');
    }
    event.target.value = '';
  });

  // 上传：课程体系表（v5.98 支持一次选择多个文件，逐文件解析并累积添加）
  document.getElementById('courseSystemFileInput')?.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    setUploadStatus('courseSystem', files.length > 1 ? `正在解析 ${files.length} 个文件...` : '正在解析文件...', 'info');
    let total = 0;
    const okFiles = [];
    const errors = [];
    const warnParts = [];
    let hasMixed = false;
    for (const file of files) {
      try {
        const { list, warnings, mixedSheets } = await parseCourseSystemSheet(file);
        addCourseSystemFile(file.name, list);
        total += list.length;
        okFiles.push(file.name);
        const prefix = files.length > 1 ? `${file.name}：` : '';
        if (warnings && warnings.length > 0) {
          warnParts.push(`⚠ ${prefix}${warnings.join('；')}`);
        }
        // v5.83：混合形态子表（既有合班课之前的普通课、又有合班课之后的普通课）暂不做排课处理——
        // 允许导入但标红 error 警告（列出子表名），排课侧整表跳过并写入报告第八章
        if (mixedSheets && mixedSheets.length > 0) {
          hasMixed = true;
          warnParts.push(`🔴 ${prefix}混合形态子表不排课：${mixedSheets.map(m => m.sheetName).join('、')}（先分后合与先合后分并存，请拆分后重新导入）`);
        }
      } catch (error) {
        errors.push(`${file.name}：${error.message}`);
      }
    }
    if (okFiles.length > 0) {
      // v5.73：未识别班级已保留原值继续排课（宽松模式），黄色警告提示
      const base = `成功导入 ${total} 条（来自 ${okFiles.length} 个文件）`;
      const parts = [...warnParts];
      if (errors.length > 0) parts.push(`失败 ${errors.length} 个：${errors.join('；')}`);
      const msg = parts.length > 0 ? `${base}；${parts.join('；')}` : base;
      // v5.83：混合形态子表视为 error 标红（仍允许导入），其余未识别班级提示仍为 warning 黄色
      const level = (errors.length > 0 || hasMixed) ? 'error' : (warnParts.length > 0 ? 'warning' : 'success');
      setUploadStatus('courseSystem', msg, level);
    } else {
      setUploadStatus('courseSystem', `导入失败：${errors.join('；')}`, 'error');
    }
    event.target.value = '';
  });

  // 上传：已排课表（v5.90，跨科目班级占用约束；v5.98 支持一次选择多个文件并累积添加）
  document.getElementById('presetFileInput')?.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    setUploadStatus('preset', files.length > 1 ? `正在解析 ${files.length} 个文件...` : '正在解析文件...', 'info');
    let total = 0;
    const okFiles = [];
    const errors = [];
    const warnParts = [];
    for (const file of files) {
      try {
        const { list, warnings } = await parsePresetSheet(file);
        addPresetFile(file.name, list);
        total += list.length;
        okFiles.push(file.name);
        if (warnings && warnings.length > 0) {
          warnParts.push(`⚠ ${files.length > 1 ? `${file.name}：` : ''}${warnings.join('；')}`);
        }
      } catch (error) {
        errors.push(`${file.name}：${error.message}`);
      }
    }
    if (okFiles.length > 0) {
      const base = `成功导入 ${total} 条（来自 ${okFiles.length} 个文件）`;
      const parts = [...warnParts];
      if (errors.length > 0) parts.push(`失败 ${errors.length} 个：${errors.join('；')}`);
      const msg = parts.length > 0 ? `${base}；${parts.join('；')}` : base;
      const level = errors.length > 0 ? 'error' : (warnParts.length > 0 ? 'warning' : 'success');
      setUploadStatus('preset', msg, level);
    } else {
      setUploadStatus('preset', `导入失败：${errors.join('；')}`, 'error');
    }
    event.target.value = '';
  });

  // 智能排课
  document.getElementById('scheduleBtn')?.addEventListener('click', () => {
    runSchedule();
  });

  // 调课模式：按钮切换 + 课程拖拽 + 落点确认对话框
  setupAdjustInteractions();

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
    exportScheduledToExcel(state.courses, `排课结果_${y}年${m}月.xlsx`, state.abbreviateClass);
  });

  // 导出排课报告（.md）：优先导出最近一次排课的报告；若已多次排课，可保留历史报告在服务器
  document.getElementById('exportReportBtn')?.addEventListener('click', () => {
    const state = getState();
    const reports = state.scheduleReports || [];
    if (reports.length === 0) {
      alert('暂无排课报告，请先执行「排课」');
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

// ============ 调课模式：按钮 / 拖拽 / 落点对话框 ============

const ADJUST_DRAG_THRESHOLD = 4; // 拖动判定阈值（px）
const ADJUST_SCROLL_EDGE = 80;   // 拖拽时距日历可视区上下边缘多少像素内触发自动滚动（热区）
const ADJUST_SCROLL_MIN = 4;     // 刚进热区时每帧滚动像素（越深越快）
const ADJUST_SCROLL_MAX = 24;    // 贴到边缘时每帧滚动像素

let adjustDrag = null;    // 拖拽过程中的临时状态
let adjustPending = null; // 对话框待确认的调课请求

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 绑定调课模式的交互：按钮切换、课程拖拽、绿色段落点确认 */
function setupAdjustInteractions() {
  const adjustDialog = document.getElementById('adjustDialog');

  // 调课按钮：进入调课模式 / 完成调课（完成时对比变化并按需导出变化课程 Excel）
  document.getElementById('adjustBtn')?.addEventListener('click', () => {
    closeAdjustDialog();
    setAdjustDragging(false);

    // 「调课完成」：先对比快照取变化课程，再退出模式（退出会清空快照）
    if (getState().adjustMode) {
      const changes = getAdjustChanges();
      toggleAdjustMode();
      if (changes.length === 0) {
        alert('课程无变化');
        return;
      }
      const now = new Date();
      const stamp = `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月${String(now.getDate()).padStart(2, '0')}日`;
      exportAdjustDiffToExcel(changes, `调课变化_${stamp}.xlsx`);
      return;
    }

    toggleAdjustMode();
  });

  // 日历网格：按下课程卡片 → 选中并准备拖拽
  document.getElementById('calendarGrid')?.addEventListener('pointerdown', onAdjustPointerDown);

  // 对话框：关闭 / 遮罩点击 / 完成
  document.getElementById('adjustDialogClose')?.addEventListener('click', closeAdjustDialog);
  adjustDialog?.addEventListener('click', (e) => {
    if (e.target === adjustDialog) closeAdjustDialog();
  });
  document.getElementById('adjustDialogConfirm')?.addEventListener('click', confirmAdjustMove);
  // 小时变更 → 重算该小时的合法分钟；分钟变更 → 仅刷新结束时间提示
  document.getElementById('adjustDialogHour')?.addEventListener('change', () => {
    renderAdjustMinuteOptions(document.getElementById('adjustDialogMinute')?.value);
  });
  document.getElementById('adjustDialogMinute')?.addEventListener('change', updateAdjustHint);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAdjustDialog();
  });
}

function onAdjustPointerDown(e) {
  const state = getState();
  if (!state.adjustMode) return;
  if (e.button != null && e.button !== 0) return;

  const card = e.target.closest('.course-card--adjustable');
  if (!card) return;
  const sourceItemId = card.dataset.courseId;
  if (!sourceItemId) return;

  // 可拖拽对象 = 排课结果课程 或「已排课表」条目（二者 itemId 同源，统一按 sourceItemId 查找）
  const course = findAdjustableCourse(state, sourceItemId);
  if (!course) return;

  e.preventDefault();
  const rect = card.getBoundingClientRect();
  // 记下该课程的日期单元格当前视口位置：重绘会新增绿色可调课时间段，日历会变高
  const cellTop = card.closest('.day-cell')?.getBoundingClientRect().top ?? rect.top;

  // 选中该课程（触发重绘：高亮关联课程 + 生成绿色可调课时间段）
  selectCourseForAdjust(sourceItemId);

  // 重绘后按单元格重新对齐，保证页面停留在该课程所在位置
  alignAdjustCell(sourceItemId, cellTop);

  adjustDrag = {
    sourceItemId,
    course,
    anchorDate: course.date,
    duration: resolveCourseDuration(state.courseSystemData, course),
    startX: e.clientX,
    startY: e.clientY,
    lastX: e.clientX,
    lastY: e.clientY,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    width: rect.width,
    started: false,
    ghost: null,
    hoverSeg: null,
    scrollDir: 0,
    scrollRaf: 0
  };

  document.addEventListener('pointermove', onAdjustPointerMove);
  document.addEventListener('pointerup', onAdjustPointerUp);
}

/** 找到被调课程对应的卡片元素 */
function findAdjustCard(sourceItemId) {
  return Array.from(document.querySelectorAll('#calendarGrid .course-card'))
    .find(el => el.dataset.courseId === sourceItemId) || null;
}

/**
 * 解析「当前真正滚动的容器」。
 * 宽屏（>1100px）：.calendar-body 自身滚动（overflow:auto 且被 flex 限高）；
 * 窄屏（≤1100px）：body 高度 auto、日历不内部滚动（clientHeight == scrollHeight），
 *   真实滚动发生在 window 上。此时写 .calendar-body.scrollTop 会被夹取为 0，
 *   滚动补偿与自动滚动全部失效 → 进入拖拽态整月变高时页面直接跳走。
 * 注意选择器限定在 .calendar-container 内：导出图片时会临时向 body 追加一个同名离屏容器。
 */
function scrollHost() {
  const body = document.querySelector('.calendar-container .calendar-body');
  if (body && body.scrollHeight - body.clientHeight > 1) {
    return {
      // 日历内部滚动：可视区即滚动区域本身，再与视口求交（窗口过矮时日历可能被裁切）
      rect: () => visibleRect(body.getBoundingClientRect()),
      readScroll: () => body.scrollTop,
      scrollBy: (d) => { body.scrollTop += d; },
      canScroll: () => body.scrollHeight - body.clientHeight > 1
    };
  }
  return {
    // window 滚动时以视口为热区基准（日历可能已被滚到视口上方/下方）
    rect: () => visibleRect(body ? body.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }),
    readScroll: () => window.scrollY,
    scrollBy: (d) => window.scrollBy(0, d),
    canScroll: () => document.documentElement.scrollHeight - window.innerHeight > 1
  };
}

/**
 * 日历可视区：日历矩形 ∩ 视口。
 * 热区只按纵向区间判定（横向不限），因此指针拖到右侧汇总面板上时依旧能继续自动滚动。
 */
function visibleRect(r) {
  return { top: Math.max(r.top, 0), bottom: Math.min(r.bottom, window.innerHeight) };
}

/** 把元素拉回它原先的视口 top：按真实滚动体（内部滚动 / window 滚动）自动补偿 */
function restoreViewportTop(el, prevTop) {
  if (!el || prevTop == null) return;
  scrollHost().scrollBy(el.getBoundingClientRect().top - prevTop);
}

/** 指针所在的日期格：优先 elementFromPoint，取不到时按矩形兜底 */
function dayCellAt(clientX, clientY) {
  const cell = document.elementFromPoint(clientX, clientY)?.closest('.day-cell');
  if (cell) return cell;
  for (const el of document.querySelectorAll('#calendarGrid .day-cell')) {
    const r = el.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return el;
  }
  return null;
}

/**
 * 解析指针命中的绿色可调课时间段。
 * hover 高亮与松手落点共用本函数 → 从构造上保证「命中 == 显示」。
 * 先定位日期格，再在格内按矩形做纵向区间测试（不依赖直接命中绿段元素本身）。
 */
function resolveAdjustSegment(clientX, clientY) {
  const cell = dayCellAt(clientX, clientY);
  if (!cell) return null;
  for (const el of cell.querySelectorAll('.adjust-segment')) {
    const r = el.getBoundingClientRect();
    if (clientY >= r.top && clientY <= r.bottom) return el;
  }
  return null;
}

/**
 * 让被调课程所在的日期单元格回到指定的视口位置（prevTop）。
 * 重绘 / 进入拖拽态都会改变日历高度，需按单元格重新对齐，页面才停留在该课程处。
 */
function alignAdjustCell(sourceItemId, prevTop) {
  restoreViewportTop(findAdjustCard(sourceItemId)?.closest('.day-cell'), prevTop);
}

/** 按授课日期把对应的日期单元格拉回指定视口位置（拖拽起点锚定用） */
function alignDayCell(dateStr, prevTop) {
  restoreViewportTop(dayCellByDate(dateStr), prevTop);
}

/**
 * 开始拖动时把「授课日期」格顶部的日期名称行滚到指针当前位置（行中心对齐指针）。
 * 进入拖拽态后该日期格被渲染成 400px 高的 24 小时时间轴，指针屏幕位置不变：
 * 若按日期格顶部对齐，指针会落到下一周同一列（如 12/18 → 12/25）；
 * 以指针为锚后，指针始终停在原授课日期的名称行上，落点不会跑到别的日期。
 */
function scrollCellHeaderToPointer(dateStr, clientY) {
  const header = dayCellByDate(dateStr)?.querySelector('.day-header');
  if (!header) return;
  const r = header.getBoundingClientRect();
  scrollHost().scrollBy(r.top + r.height / 2 - clientY);
}

/** 按日期取当前渲染出的日期单元格 */
function dayCellByDate(dateStr) {
  return document.querySelector(`#calendarGrid .day-cell[data-date="${dateStr}"]`);
}

/** 高亮鼠标下的绿色可调课时间段 */
function updateAdjustHover(clientX, clientY) {
  if (!adjustDrag) return;
  const seg = resolveAdjustSegment(clientX, clientY);
  if (seg === adjustDrag.hoverSeg) return;
  adjustDrag.hoverSeg?.classList.remove('hover');
  seg?.classList.add('hover');
  adjustDrag.hoverSeg = seg;
}

/** 拖到日历上下边缘热区时自动滚动；越靠近边缘越快 */
function updateAdjustAutoScroll(clientX, clientY) {
  const drag = adjustDrag;
  if (!drag) return;
  drag.lastX = clientX;
  drag.lastY = clientY;

  const host = scrollHost();
  if (!host.canScroll()) {
    drag.scrollDir = 0;
    drag.scrollSpeed = 0;
    return;
  }

  const rect = host.rect();
  let dir = 0;
  let depth = 0;
  if (clientY < rect.top + ADJUST_SCROLL_EDGE) {
    dir = -1;
    depth = (rect.top + ADJUST_SCROLL_EDGE - clientY) / ADJUST_SCROLL_EDGE;
  } else if (clientY > rect.bottom - ADJUST_SCROLL_EDGE) {
    dir = 1;
    depth = (clientY - (rect.bottom - ADJUST_SCROLL_EDGE)) / ADJUST_SCROLL_EDGE;
  }
  depth = Math.min(1, Math.max(0, depth)); // 越深越快
  drag.scrollDir = depth > 0 ? dir : 0;
  drag.scrollSpeed = ADJUST_SCROLL_MIN + (ADJUST_SCROLL_MAX - ADJUST_SCROLL_MIN) * depth;

  if (drag.scrollDir !== 0 && !drag.scrollRaf) {
    drag.scrollRaf = requestAnimationFrame(stepAdjustAutoScroll);
  }
}

function stepAdjustAutoScroll() {
  const drag = adjustDrag;
  if (!drag || !drag.started || !drag.scrollDir) {
    if (drag) drag.scrollRaf = 0;
    return;
  }
  const host = scrollHost();
  const before = host.readScroll();
  host.scrollBy(drag.scrollDir * (drag.scrollSpeed || ADJUST_SCROLL_MIN));
  // 已滚到顶/底则停止，避免空转
  if (host.readScroll() === before) {
    drag.scrollRaf = 0;
    return;
  }
  drag.scrollRaf = requestAnimationFrame(stepAdjustAutoScroll);
  updateAdjustHover(drag.lastX, drag.lastY);
}

function onAdjustPointerMove(e) {
  if (!adjustDrag) return;
  const dx = e.clientX - adjustDrag.startX;
  const dy = e.clientY - adjustDrag.startY;
  if (!adjustDrag.started && Math.hypot(dx, dy) < ADJUST_DRAG_THRESHOLD) return;

  if (!adjustDrag.started) {
    adjustDrag.started = true;
    adjustDrag.ghost = createDragGhost(adjustDrag);
    // 进入拖拽态会切换为 24 小时时间轴渲染、整月变高：
    setAdjustDragging(true);
    adjustDrag.hoverSeg = null; // 节点已被重绘替换
    // 页面跳到该课程的授课日期：把该日期名称行滚到指针处（指针仍停在本课程原授课日期格内）
    scrollCellHeaderToPointer(adjustDrag.anchorDate, e.clientY);
    // 页面刚滚过 → 指针下的日期格/绿段已变，下面统一重算 hover，命中的是滚动后的实际落点。
  }

  adjustDrag.ghost.style.left = `${e.clientX - adjustDrag.offsetX}px`;
  adjustDrag.ghost.style.top = `${e.clientY - adjustDrag.offsetY}px`;

  updateAdjustHover(e.clientX, e.clientY);
  updateAdjustAutoScroll(e.clientX, e.clientY);
}

function onAdjustPointerUp(e) {
  document.removeEventListener('pointermove', onAdjustPointerMove);
  document.removeEventListener('pointerup', onAdjustPointerUp);

  const drag = adjustDrag;
  adjustDrag = null;
  if (!drag) return;

  if (drag.scrollRaf) cancelAnimationFrame(drag.scrollRaf);
  drag.ghost?.remove();
  drag.hoverSeg?.classList.remove('hover');

  if (!drag.started) return; // 纯点击 → 仅保持选中（页面已停在原处）

  // 先取落点（此时绿色段仍在 DOM 中），再退出拖拽态恢复普通渲染。
  // 与 hover 高亮共用 resolveAdjustSegment → 松手落点与高亮一致。
  const seg = resolveAdjustSegment(e.clientX, e.clientY);
  // 退出拖拽态会把整月从 400px 缩回原高度，同样需要滚动补偿，
  // 否则释放瞬间页面再跳一次。锚定「落点所在日期格」，取不到时退回授课日期。
  const dropDate = seg?.dataset.date || drag.anchorDate;
  const cellTop = dayCellByDate(dropDate)?.getBoundingClientRect().top;
  setAdjustDragging(false);
  alignDayCell(dropDate, cellTop);
  if (!seg) return;

  openAdjustDialog(drag, seg);
}

/** 创建跟随鼠标的课程拖拽幽灵元素 */
function createDragGhost(drag) {
  const state = getState();
  const course = drag.course;
  const displayClass = state.abbreviateClass
    ? abbreviateClassType(course.classType || '')
    : (course.classType || '');

  const ghost = document.createElement('div');
  ghost.className = 'course-drag-ghost';
  ghost.style.width = `${drag.width}px`;
  ghost.innerHTML = `
    ${displayClass ? `<div class="course-class">${escapeHtml(displayClass)}</div>` : ''}
    <div class="course-name">${escapeHtml(course.name)}</div>
    <div class="course-teacher">${escapeHtml(course.teacher || '')}</div>
    <div class="course-time">${course.startTime} - ${course.endTime}</div>
  `;
  document.body.appendChild(ghost);
  return ghost;
}

/** 打开调课确认对话框：日期只读 + 开始时间（小时/分钟两个下拉，仅列绿色段内合法值） + 完成按钮 */
function openAdjustDialog(drag, segEl) {
  const date = segEl.dataset.date;
  const startTime = segEl.dataset.start;
  const endTime = segEl.dataset.end;
  // 绿色段内的全部合法开始时间（5 分钟刻度，且 开始时间 + 课时长 ≤ 段末）
  const times = computeStartTimes({ startTime, endTime }, drag.duration);
  if (times.length === 0) return;

  // 该课程原时间若落在本段内则优先选中 —— 原时间点不得被删除
  const originalStart = drag.course.startTime;
  const preferred = times.includes(originalStart) ? originalStart : times[0];

  adjustPending = {
    sourceItemId: drag.sourceItemId,
    date,
    duration: drag.duration,
    segment: { startTime, endTime },
    originalStart,
    legalTimes: times
  };

  const dateEl = document.getElementById('adjustDialogDate');
  if (dateEl) dateEl.textContent = date;
  renderAdjustHourOptions(preferred);

  document.getElementById('adjustDialog')?.classList.remove('hidden');
}

/** 某小时内全部合法开始分钟（两位字符串数组） */
function adjustMinutesForHour(hour) {
  return (adjustPending?.legalTimes || [])
    .filter(t => t.slice(0, 2) === hour)
    .map(t => t.slice(3, 5));
}

/** 填充「小时」下拉并联动「分钟」下拉；preferred 形如 'HH:MM' */
function renderAdjustHourOptions(preferred) {
  const hourEl = document.getElementById('adjustDialogHour');
  if (!hourEl || !adjustPending) return;
  const hours = [...new Set(adjustPending.legalTimes.map(t => t.slice(0, 2)))];
  hourEl.innerHTML = hours.map(h => `<option value="${h}">${h}</option>`).join('');
  hourEl.value = preferred.slice(0, 2);
  renderAdjustMinuteOptions(preferred.slice(3, 5));
}

/** 按当前小时填充「分钟」下拉（只列合法值）；preferMin 合法则保留，否则取该小时第一个 */
function renderAdjustMinuteOptions(preferMin) {
  const minuteEl = document.getElementById('adjustDialogMinute');
  const hourEl = document.getElementById('adjustDialogHour');
  if (!minuteEl || !hourEl) return;
  const mins = adjustMinutesForHour(hourEl.value);
  minuteEl.innerHTML = mins.map(m => `<option value="${m}">${m}</option>`).join('');
  minuteEl.value = mins.includes(preferMin) ? preferMin : (mins[0] || '');
  updateAdjustHint();
}

/** 读取「小时 + 分钟」组合出的开始时间（'HH:MM'） */
function readAdjustStartTime() {
  const hour = document.getElementById('adjustDialogHour')?.value;
  const minute = document.getElementById('adjustDialogMinute')?.value;
  if (!hour || minute == null || minute === '') return null;
  return `${hour}:${minute}`;
}

/** 刷新提示：课时长 · 绿色时间段 · 结束时间（原时间额外标注） */
function updateAdjustHint() {
  const hintEl = document.getElementById('adjustDialogHint');
  const startTime = readAdjustStartTime();
  if (!hintEl || !startTime || !adjustPending) return;
  const endTime = minutesToTime(timeToMinutes(startTime) + adjustPending.duration);
  const { segment, duration, originalStart } = adjustPending;
  const tag = startTime === originalStart ? '（原时间）' : '';
  hintEl.textContent = `课程时长 ${duration} 分钟 · 绿色时间段 ${segment.startTime} - ${segment.endTime} · 结束时间 ${endTime}${tag}`;
}

/** 确认调课：按所选开始时间写回排课结果 */
function confirmAdjustMove() {
  if (!adjustPending) return;
  const startTime = readAdjustStartTime();
  if (!startTime) return;
  const endTime = minutesToTime(timeToMinutes(startTime) + adjustPending.duration);
  applyCourseMove(adjustPending.sourceItemId, adjustPending.date, startTime, endTime);
  closeAdjustDialog();
}

function closeAdjustDialog() {
  adjustPending = null;
  document.getElementById('adjustDialog')?.classList.add('hidden');
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
