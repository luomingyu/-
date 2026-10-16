// 图片导出：把当前日历课表（已按班级/师资筛选）渲染为 PNG 图片
import html2canvas from 'html2canvas';
import { MONTHS, WEEKDAYS } from '../config/constants.js';
import { fillMonthGrid } from '../render/calendar.js';

/**
 * 生成并下载日历课表 PNG 图片
 * @param {object} state 当前应用状态（决定月份与筛选条件）
 * @param {string} fileName 下载文件名（含 .png）
 */
export async function exportCalendarImage(state, fileName) {
  const container = buildExportContainer(state);
  document.body.appendChild(container);
  try {
    const canvas = await html2canvas(container, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      logging: false,
    });
    await downloadCanvas(canvas, fileName);
  } finally {
    container.remove();
  }
}

/** 构建离屏导出容器（复用日历样式类，保证与页面观感一致） */
function buildExportContainer(state) {
  const year = state.currentDate.getFullYear();
  const month = state.currentDate.getMonth();

  const wrapper = document.createElement('div');
  wrapper.className = 'calendar-export';
  // 离屏定位：不影响页面布局，但仍在 DOM 中以便截图
  wrapper.style.position = 'absolute';
  wrapper.style.left = '-100000px';
  wrapper.style.top = '0';

  const header = document.createElement('div');
  header.className = 'calendar-header';
  const title = document.createElement('div');
  title.className = 'calendar-title';
  title.textContent = `${year}年${MONTHS[month]} 课表`;
  const subtitle = document.createElement('div');
  subtitle.className = 'calendar-subtitle';
  subtitle.textContent = `班级：${state.selectedClass || '全部班级'} ｜ 师资：${state.selectedTeacher || '全部师资'}`;
  header.appendChild(title);
  header.appendChild(subtitle);

  const body = document.createElement('div');
  body.className = 'calendar-body';

  const weekdays = document.createElement('div');
  weekdays.className = 'weekdays';
  WEEKDAYS.forEach(label => {
    const el = document.createElement('div');
    el.className = 'weekday';
    el.textContent = label;
    weekdays.appendChild(el);
  });

  const grid = document.createElement('div');
  grid.className = 'calendar-grid';
  fillMonthGrid(grid, state);

  body.appendChild(weekdays);
  body.appendChild(grid);
  wrapper.appendChild(header);
  wrapper.appendChild(body);

  return wrapper;
}

/** canvas → PNG Blob → 触发浏览器下载 */
function downloadCanvas(canvas, fileName) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve();
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      resolve();
    }, 'image/png');
  });
}
