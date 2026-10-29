// 渲染编排：订阅 store 变更后统一重绘各区域
import { renderCalendar } from './calendar.js';
import { renderCourseSystem } from './courseSystem.js';
import { renderAvailabilityList, renderPresetList, renderScheduledList, renderStatus } from './dataLists.js';
import { getAllClasses, getAllTeachers } from '../state/selectors.js';
import { setSelectedClasses, setSelectedTeachers } from '../state/store.js';

/**
 * 渲染「多选筛选」控件（班级/师资共用，v6.0.13）
 * 选项集变化时重建复选框；否则只同步勾选态与摘要文案（避免重建丢焦点/滚动）。
 * 若已选值不在最新选项中（如删除了对应文件），自动剔除并写回 store。
 * @returns {string[]} 修正后的选中项
 */
function renderMultiFilter(cfg) {
  const trigger = document.getElementById(cfg.triggerId);
  const label = document.getElementById(cfg.labelId);
  const panel = document.getElementById(cfg.panelId);
  const box = document.getElementById(cfg.optionsId);
  if (!trigger || !label || !panel || !box) return cfg.selected;

  const options = cfg.options;
  let selected = cfg.selected.filter(v => options.includes(v));
  if (selected.length !== cfg.selected.length) cfg.onPrune(selected);

  // 选项集变化时重建
  const optionsSig = options.join('\u0001');
  if (box.dataset.optionsSig !== optionsSig) {
    box.innerHTML = '';
    if (options.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'multi-select__empty';
      empty.textContent = cfg.emptyLabel;
      box.appendChild(empty);
    } else {
      options.forEach(opt => {
        const item = document.createElement('label');
        item.className = 'multi-select__option';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = opt;
        const span = document.createElement('span');
        span.textContent = opt;
        item.appendChild(cb);
        item.appendChild(span);
        box.appendChild(item);
      });
    }
    box.dataset.optionsSig = optionsSig;
  }

  // 同步勾选态与摘要
  box.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = selected.includes(cb.value);
  });
  const on = selected.length > 0;
  label.textContent = on ? `${cfg.name}：已选 ${selected.length} 项` : cfg.allLabel;
  trigger.classList.toggle('active', on);
  return selected;
}

/** 更新班级筛选（多选） */
function renderClassFilter(state) {
  renderMultiFilter({
    options: getAllClasses(state),
    selected: state.selectedClasses || [],
    triggerId: 'classFilterTrigger',
    labelId: 'classFilterLabel',
    panelId: 'classFilterPanel',
    optionsId: 'classFilterOptions',
    name: '班级',
    allLabel: '全部班级',
    emptyLabel: '暂无班级',
    onPrune: setSelectedClasses
  });
}

/** 更新师资筛选（多选） */
function renderTeacherFilter(state) {
  renderMultiFilter({
    options: getAllTeachers(state),
    selected: state.selectedTeachers || [],
    triggerId: 'teacherFilterTrigger',
    labelId: 'teacherFilterLabel',
    panelId: 'teacherFilterPanel',
    optionsId: 'teacherFilterOptions',
    name: '师资',
    allLabel: '全部师资',
    emptyLabel: '暂无师资',
    onPrune: setSelectedTeachers
  });
}

/** 更新空闲时间显示切换按钮文案（开=显示，关=隐藏） */
function renderAvailabilityToggle(state) {
  const btn = document.getElementById('availabilityToggleBtn');
  const label = document.getElementById('availabilityToggleLabel');
  if (!btn || !label) return;
  const on = state.showAvailability;
  label.textContent = on ? '空闲开' : '空闲关';
  btn.classList.toggle('active', on);
  btn.title = on ? '点击隐藏日历中的空闲时间' : '点击显示日历中的空闲时间';
}

/** 更新班级缩写显示切换按钮文案（开=缩写，关=完整展示）；v6.0.8 */
function renderAbbreviateToggle(state) {
  const btn = document.getElementById('classAbbrToggleBtn');
  const label = document.getElementById('classAbbrToggleLabel');
  if (!btn || !label) return;
  const on = state.abbreviateClass;
  label.textContent = on ? '班级缩写开' : '班级缩写关';
  btn.classList.toggle('active', on);
  btn.title = on ? '点击显示班级完整列表' : '点击将班级缩写为批量简称（如 27线上所有班）';
}

/** 全量重绘 */
export function renderAll(state) {
  renderClassFilter(state);
  renderTeacherFilter(state);
  renderAvailabilityToggle(state);
  renderAbbreviateToggle(state);
  renderAvailabilityList(state);
  renderPresetList(state);
  renderScheduledList(state);
  renderCourseSystem(state);
  renderCalendar(state);
  renderStatus(state);
}
