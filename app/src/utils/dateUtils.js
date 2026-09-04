// 日期 / 时间处理纯函数（无副作用，无 DOM 依赖）

/** Date → 'YYYY-MM-DD' */
export function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 'HH:MM' → 分钟数 */
export function timeToMinutes(timeStr) {
  const [hours, minutes] = String(timeStr).split(':').map(Number);
  return hours * 60 + minutes;
}

/** 分钟数 → 'HH:MM' */
export function minutesToTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * 时长字符串 → 分钟数
 * 兼容：'90'（纯数字按分钟）、'90分钟'、'1小时'、'1h'
 */
export function durationToMinutes(duration) {
  const str = String(duration).trim();
  if (/^\d+(\.\d+)?$/.test(str)) {
    return Math.round(parseFloat(str));
  }
  const match = str.match(/(\d+)\s*(分钟|小时|h|hr|min)?/);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2] || '分钟';
    if (unit.includes('小时') || unit === 'h' || unit === 'hr') {
      return value * 60;
    }
    return value;
  }
  return 60;
}

/** 获取某年某月的天数 */
export function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

/** Excel 日期序列号 → Date（基准 25569，+8 时区） */
export function parseExcelDate(excelDate) {
  if (!isNaN(excelDate)) {
    const date = new Date((excelDate - 25569) * 86400 * 1000);
    date.setHours(date.getHours() + 8);
    return date;
  }
  return new Date(excelDate);
}

/** Excel 日期 → 'YYYY-MM-DD' */
export function formatExcelDate(excelDate) {
  const date = parseExcelDate(excelDate);
  return formatDate(date);
}

/**
 * Excel 时间 → 'HH:MM'
 * 兼容：小数（0.375 → 09:00）、'9:00' 字符串
 */
export function formatExcelTime(excelTime) {
  if (typeof excelTime === 'number' && !isNaN(excelTime)) {
    // Excel 时间以天的小数存储，浮点精度会导致 17:00 被算成 16:59（0.708333...×24=16.999...）
    // 先四舍五入到总分钟数再拆分，避免 floor 丢失一分钟
    const totalMinutes = Math.round(excelTime * 24 * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }
  const timeStr = String(excelTime || '').trim();
  if (timeStr.match(/^\d{1,2}:\d{2}$/)) {
    const [h, m] = timeStr.split(':');
    return `${String(parseInt(h, 10)).padStart(2, '0')}:${String(parseInt(m, 10)).padStart(2, '0')}`;
  }
  return timeStr;
}

/** 日期 + 时间 → 单一可比分钟数（用于时间顺序约束） */
export function dateTimeToMinutes(dateStr, timeStr) {
  const date = new Date(dateStr);
  const timeParts = String(timeStr).split(':').map(Number);
  return (
    date.getFullYear() * 525600 +
    date.getMonth() * 43800 +
    date.getDate() * 1440 +
    timeParts[0] * 60 +
    timeParts[1]
  );
}

/** 是否今天 */
export function isToday(date) {
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

/** 是否选中日期 */
export function isSelected(date, selectedDate) {
  if (!selectedDate) return false;
  return (
    date.getFullYear() === selectedDate.getFullYear() &&
    date.getMonth() === selectedDate.getMonth() &&
    date.getDate() === selectedDate.getDate()
  );
}
