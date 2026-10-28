// 飞书在线表格导出：把当前月历（含已排课程/预设课程）按日历形式输出到飞书表格
// 布局：7 列星期表头；每月按周分块，每块高度=当周单日最多课程数（至少 1 行）；
// 每列每天第一格是日期，其后每格是一节课（班级名称/课节名称/授课师资/授课时间）
import { MONTHS, WEEKDAYS } from '../config/constants.js';
import { formatDate } from './dateUtils.js';
import { getMonthDayData } from '../render/calendar.js';
import { getCoursesForDate, getPresetForDate } from '../state/selectors.js';

/**
 * 生成飞书在线表格并返回表格链接
 * @param {object} state 当前应用状态（决定月份与筛选条件）
 * @returns {Promise<string>} 飞书表格 URL
 */
export async function exportCalendarToFeishu(state) {
  const payload = buildFeishuPayload(state);
  // 建表需要调用 lark-cli，耗时可能到十几秒；设置超时避免按钮一直停在“生成中”
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const resp = await fetch('/api/feishu-sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      throw new Error(data.error || `服务返回错误（HTTP ${resp.status}）`);
    }
    if (!data.url) throw new Error('飞书未返回表格链接');
    return data.url;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('生成超时（超过 2 分钟），请检查本机服务与飞书凭证后重试');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// 页面内结果提示条：不依赖 alert / 新标签页，避免被浏览器拦截后表现为“点击没反应”
let noticeEl = null;

/**
 * 展示飞书导出结果提示
 * @param {'info'|'success'|'error'} kind 提示类型
 * @param {string} text 提示文字
 * @param {string} [url] 成功时附带的飞书表格链接
 */
export function showFeishuNotice(kind, text, url) {
  const themes = {
    info: { bg: '#EAF2FF', border: '#BFD3FF' },
    success: { bg: '#E8F7EE', border: '#A9DCBB' },
    error: { bg: '#FDECEC', border: '#F5B7B7' }
  };
  const theme = themes[kind] || themes.info;

  if (!noticeEl) {
    noticeEl = document.createElement('div');
    noticeEl.id = 'feishuNotice';
    document.body.appendChild(noticeEl);
  }
  noticeEl.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
    'z-index:9999', 'max-width:min(680px,92vw)', 'padding:12px 16px',
    'border-radius:10px', 'font-size:13px', 'line-height:1.6', 'word-break:break-all',
    'display:flex', 'gap:10px', 'align-items:flex-start',
    `background:${theme.bg}`, `border:1px solid ${theme.border}`,
    'box-shadow:0 8px 24px rgba(0,0,0,.16)'
  ].join(';');

  noticeEl.textContent = '';
  const msg = document.createElement('span');
  msg.textContent = text;
  noticeEl.appendChild(msg);

  if (url) {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '打开飞书表格';
    link.style.cssText = 'color:#1a73e8;font-weight:600;white-space:nowrap;text-decoration:underline';
    noticeEl.appendChild(link);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭提示');
  close.style.cssText = 'border:0;background:transparent;font-size:16px;line-height:1;cursor:pointer;padding:0 2px;color:#666';
  close.addEventListener('click', () => {
    noticeEl.remove();
    noticeEl = null;
  });
  noticeEl.appendChild(close);
}

/** 组装接口入参：标题 + 星期表头 + 按周分块的日期/课程格 */
function buildFeishuPayload(state) {
  const year = state.currentDate.getFullYear();
  const month = state.currentDate.getMonth();
  const suffix = [state.selectedClass, state.selectedTeacher].filter(Boolean).join(' · ');

  const days = getMonthDayData(year, month);
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push({
      days: days.slice(i, i + 7).map(({ date, isCurrentMonth }) => ({
        date: `${date.getMonth() + 1}/${date.getDate()} 周${WEEKDAYS[date.getDay()]}`,
        otherMonth: !isCurrentMonth,
        courses: isCurrentMonth ? buildDayCourses(state, date) : []
      }))
    });
  }

  return {
    title: `${year}年${MONTHS[month]} 课表${suffix ? ` · ${suffix}` : ''}`,
    subtitle: `班级：${state.selectedClass || '全部班级'} ｜ 师资：${state.selectedTeacher || '全部师资'}`,
    weekdays: WEEKDAYS.map(w => `周${w}`),
    weeks
  };
}

/** 单日课程列表：已排课程 + 预设课程，按开始时间排序，每节课四段式内容 */
function buildDayCourses(state, date) {
  const dateStr = formatDate(date);
  const timeline = [
    ...getCoursesForDate(state, dateStr),
    ...getPresetForDate(state, dateStr).map(p => ({
      classType: p.classType,
      name: p.courseName || '(未填课节名称)',
      teacher: p.teacher,
      startTime: p.startTime,
      endTime: p.endTime
    }))
  ].sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));

  return timeline.map(course => ({
    className: course.classType || '',
    lessonName: course.name || '',
    teacher: course.teacher || '',
    time: `${course.startTime || ''}-${course.endTime || ''}`
  }));
}
