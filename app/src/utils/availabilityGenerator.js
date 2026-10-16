// 师资空闲时间表生成器：按「底层要求（默认可排时段）+ 输入框要求（师资约束）」生成标准格式空闲时间表
// 底层要求：每天 09:00-12:00、14:00-23:00 为可排课时间段
// 输入框要求示例（每行一个师资）：
//   王喆，2026年9月，每周二18点后不排课，周末不排课
//   石磊，2026年9月，周三不排课，周六14:00后不排课，11日不排课
//   罗明宇，2026年9月，11日不排课，周末不排课，周一上午9-12点不排课，周五晚上17点后不排课
//   李华，9月，周五不排课        ← 年月可省略年份（用默认年份），也可整体省略（用当前选中年月）
// 支持约束：周X不排课 / 周X Y点后不排课 / 周X Y点前不排课 / 周X 上午Y-Z点不排课 / X日不排课 / 多日X,Y,Z日不排课或Y点后排课 / 周末不排课 / 周X到周Y（含"至/-/~"，跨周环绕）
// 增强（v5.54）：
//   1. 一周可写多个周几："每周二三四"、"周三周四"、"周六日"
//   2. 时间支持"上午/下午/晚上"12小时制："周三周四下午1:00后不排课"=13:00 后不排
//   3. "不排课/不上课"容忍插入字："不能排课"、"也不能排课"、"不可以上课"
//   4. 数字周几（周1~周7）与时间数字自动区分，不被误读
//   5. 时间段支持纯冒号写法："13:00-18:00不排课"（不必带"点/时"）
//   6. 支持"前/后"单边时间窗（v5.75）："周五17点前不排课"=周五 17 点前不排（保留 17 点后）
//   7. 多日列表与日时间窗（v5.76）："6,7,9,10日不排课"=这些天整天不排；
//      "6,7,9,10日20点后排课"=这些天 20 点后才可排（等价"20点前不排课"）；日列表内逗号不会被误拆
//   8. 其余时间不排课（v5.77）："6,7,9日20点后排课，其余时间不排课"=仅这 3 天 20 点后可排，其余日期整天不排
//   9. 师资冒号分隔（v5.83）："王喆：2026年10月，…"（全角/半角冒号均可，年月不再并进师资名）
//   10. 日范围（v5.83）："10月1号-10月5号不排课"=1~5 号整天不排（"-/~/到/至"分隔）
//   11. 无周几时间约束（v5.83）："晚上22点后不排课"=每天 22 点后不排（不必写"每天晚上"）
// 输出格式与师资空闲时间表标准格式一致：师资名称 | 日期 | 开始时间 | 结束时间

/** 周几中文/数字 → JS getDay() 值（0=周日） */
const WEEKDAY_MAP = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 0
};

/** 底层要求：每天可排课时间段 */
const DEFAULT_SEGMENTS = [
  { start: '09:00', end: '12:00' },
  { start: '14:00', end: '23:00' }
];

/** 「不排课」类意图（容忍"不能/不可以/可"等插入字）：不排课/不能排课/不上课/不能上课/无空闲（v5.54） */
const BLOCK_WORDS = /不(?:能|可以|可)?(?:排课|上课|授课)|无空闲/;

/**
 * 解析一行排课要求："师资名，年月，约束1，约束2..."
 * 年月可省略年份（如"9月"，年份用默认值）或整体省略（用当前选中年月）
 * @param {string} line
 * @returns {{teacher: string, year?: number, month?: number, constraints: Array} | null}
 */
export function parseRequirementLine(line) {
  // v5.76：把"数字,数字"（多日列表如"6,7,9,10"）中的逗号临时替换为占位符，
  // 避免被约束分隔符拆分；拆分后统一还原为顿号
  const masked = String(line || '').replace(/(\d)\s*[,，]\s*(?=\d)/g, '$1\u0007');
  let parts = masked.split(/[,，;；]/).map(s => s.trim().replace(/\u0007/g, '、')).filter(Boolean);
  if (parts.length === 0) return null;
  // v5.83：兼容"师资：年月/约束…"写法（如"王喆：2026年10月，晚上22点后不排课"）——
  // 全角/半角冒号仅在第一段（师资段）内拆开，拆出的内容若为年月会被下方 parseYearMonth
  // 识别，否则作为普通约束段解析；时间写法（13:00 / 13：00）位于约束段，不受影响。
  const colonSplit = parts[0].match(/^(.+?)\s*[:：]\s*(.+)$/);
  if (colonSplit) {
    parts[0] = colonSplit[1].trim();
    parts.splice(1, 0, colonSplit[2].trim());
    parts = parts.filter(Boolean);
  }
  const teacher = parts[0];
  if (!teacher) return null;

  const constraints = [];
  let idx = 1;
  const ym = parts[1] ? parseYearMonth(parts[1]) : null;
  if (ym) idx = 2;
  for (const part of parts.slice(idx)) {
    parseConstraint(part, constraints);
  }
  const req = { teacher, constraints };
  if (ym) {
    if (ym.year != null) req.year = ym.year;
    if (ym.month != null) req.month = ym.month;
  }
  return req;
}

/**
 * 解析"年月"部分："2026年9月" / "2026-9" / "9月"
 * @returns {{year: number|null, month: number}|null} month 为 0-11
 */
function parseYearMonth(text) {
  if (!text) return null;
  let year = null;
  let month = null;
  // v5.74：年份支持 2 位简写（"26年10月"→2026年10月）与 4 位（"2026年10月"），避免简写被误吞导致静默回退默认月份
  const cnMatch = text.match(/^(\d{2,4})\s*年\s*(\d{1,2})\s*月?$/);
  const dashMatch = text.match(/^(\d{2,4})[-/](\d{1,2})$/);
  const monthOnlyMatch = text.match(/^(\d{1,2})\s*月$/);
  if (cnMatch) {
    year = parseInt(cnMatch[1], 10);
    if (year < 100) year += 2000;
    month = parseInt(cnMatch[2], 10);
  } else if (dashMatch) {
    year = parseInt(dashMatch[1], 10);
    if (year < 100) year += 2000;
    month = parseInt(dashMatch[2], 10);
  } else if (monthOnlyMatch) {
    month = parseInt(monthOnlyMatch[1], 10);
  } else {
    return null;
  }
  if (month < 1 || month > 12) return null;
  return { year, month: month - 1 };
}

/**
 * 提取文本中所有周几（支持区间："周一到周五"→[1,2,3,4,5]、连续写法："每周二三四"→[2,3,4]、"周三周四"→[3,4]）
 * 中文周几串与数字周几分开匹配，避免时间数字被误读：
 *   "每周二18点" 的 18 → 仅识别"二"，不会把 1 当成周一
 *   "周六14:00"  的 14 → 仅识别"六"，不会把 1、4 当成周一、周四
 * @returns {number[]} JS getDay() 值数组
 */
function extractWeekdays(text) {
  const weekdays = [];
  const push = (wd) => { if (wd != null && !weekdays.includes(wd)) weekdays.push(wd); };

  // 周几区间："周一到周五" / "周一至周五" / "周三-周日" / "周五~周一" / "周1到5"
  // 展开为连续周几；跨周环绕（"周五到周一"→[5,6,0,1]）
  const rangeRe = /(?:周|星期)([一二三四五六日天1-7])\s*[-~到至]\s*(?:周|星期)?([一二三四五六日天1-7])/g;
  let rangeMatch;
  while ((rangeMatch = rangeRe.exec(text))) {
    const from = WEEKDAY_MAP[rangeMatch[1]];
    const to = WEEKDAY_MAP[rangeMatch[2]];
    if (from == null || to == null) continue;
    for (let i = 0; i < 7; i++) {
      const wd = (from + i) % 7;
      push(wd);
      if (wd === to) break;
    }
  }

  // 中文周几连串："每周二三四" / "周三周四" / "周六日"
  const cnRe = /(?:周|星期)([一二三四五六日天]+)/g;
  let m;
  while ((m = cnRe.exec(text))) {
    for (const ch of m[1]) push(WEEKDAY_MAP[ch]);
  }
  // 数字周几："周1"~"周7"（要求后不跟数字，避免"18点"的 1 被误读）
  const numRe = /(?:周|星期)([1-7])(?!\d)/g;
  while ((m = numRe.exec(text))) push(WEEKDAY_MAP[m[1]]);

  // 兜底：未带"周/星期"前缀时取单个中文周几（与旧行为一致）
  if (weekdays.length === 0) {
    const single = text.match(/[一二三四五六日天]/);
    if (single) push(WEEKDAY_MAP[single[0]]);
  }
  return weekdays;
}

/**
 * 结合"上午/下午/晚上"修饰词换算 12 小时制小时（v5.54）：
 * 下(午)/晚(上) → 小时 < 12 时 +12（"下午1点"="13:00"，"晚上17点"保持"17:00"）；上(午)不调整
 */
function timedHour(text, hour) {
  const h = parseInt(hour, 10);
  if (/下午|晚上/.test(text) && h > 0 && h < 12) return h + 12;
  return h;
}

/** 解析单个约束文本，追加到 constraints 数组 */
function parseConstraint(text, constraints) {
  // 周末不排课 → 周六、周日整天不排
  if (/周末/.test(text) && BLOCK_WORDS.test(text)) {
    constraints.push({ type: 'weekdayOff', weekday: 6 });
    constraints.push({ type: 'weekdayOff', weekday: 0 });
    return;
  }

  // v5.77："其余时间不排课" / "其他时间不排课" → 仅被日级约束（dayOff/dayAfter/dayBefore）覆盖的日期可排，
  // 其余日期整天不排（覆盖范围在 generateAvailability 中按整个要求计算）
  if (/(?:其余|其他|剩下)/.test(text) && BLOCK_WORDS.test(text)) {
    constraints.push({ type: 'restOff' });
    return;
  }

  // 日范围："10月1号-10月5号不排课" / "1日-5日不排课" → 展开为连续日列表整体禁排
  // （v5.83；段首/段间容忍"月"字前缀如"10月1号"；"13:00-15:00"时间范围不带"日/号"尾缀不匹配；
  //   范围+时间窗组合暂不支持，命中即整天禁排）
  const dayRangeMatch = text.match(/(?:\d{1,2}\s*月)?\s*(\d{1,2})\s*(?:日|号)\s*[-~到至]\s*(?:\d{1,2}\s*月)?\s*(\d{1,2})\s*(?:日|号)/);
  if (dayRangeMatch && BLOCK_WORDS.test(text)) {
    const a = parseInt(dayRangeMatch[1], 10);
    const b = parseInt(dayRangeMatch[2], 10);
    const lo = Math.max(1, Math.min(a, b));
    const hi = Math.min(31, Math.max(a, b));
    for (let d = lo; d <= hi; d++) constraints.push({ type: 'dayOff', day: d });
    return;
  }

  // 日期列表："11日不排课" / "6,7,9,10日不排课"（多日整体禁排）/ "29日20点后排课"（该日 20 点后才可排）
  // （v5.76；需先于周几/时间匹配，避免"11日"被误读为时间或周一；"周X日"是周几不被当作日列表）
  const dayListMatch = text.match(/(?<![周星])(\d{1,2}(?:\s*[,，、]\s*\d{1,2})*)\s*(?:日|号)/);
  if (dayListMatch) {
    const days = dayListMatch[1].split(/[,，、]/).map(s => parseInt(s, 10)).filter(d => d >= 1 && d <= 31);
    if (days.length > 0) {
      // X日Y点后/前…：时间窗取"日/号"之后的时间（避免把日列数字当时间）
      const dayTime = text.match(/(?:日|号)\s*(\d{1,2})(?:[点时:：](\d{1,2})?)?分?/);
      const hasBefore = /前/.test(text);
      const hasAfter = /后/.test(text);
      const pos = /排课|上课|授课/.test(text);
      const neg = BLOCK_WORDS.test(text);
      const keepAfter = (hasAfter && pos) || (hasBefore && neg);   // "日20点后排课"="日20点前不排课"
      const keepBefore = (hasAfter && neg) || (hasBefore && pos);  // "日20点后不排课"="日20点前排课"
      if (dayTime && hasBefore !== hasAfter && (pos || neg)) {
        const time = toHHMM(timedHour(text, dayTime[1]), dayTime[2]);
        constraints.push(keepAfter
          ? { type: 'dayAfter', days, time }
          : { type: 'dayBefore', days, time });
        return;
      }
      // 无时间窗 → 该日期整天不排
      if (neg) {
        for (const d of days) constraints.push({ type: 'dayOff', day: d });
      }
      return;
    }
  }

  // 提取周几（支持多个，如"每周二三四"）
  let weekdays = extractWeekdays(text);
  if (weekdays.length === 0) {
    // v5.83：无周几前缀但含"X点后/前"时间约束（如"晚上22点后不排课"）→ 视为每天生效，
    // 避免此类无界输入被静默忽略（日/号列表类约束已在上方分支处理）
    const hasTime = /(\d{1,2})(?:[点时:：](\d{1,2})?)?分?/.test(text);
    if (hasTime && (BLOCK_WORDS.test(text) || /排课|上课|授课/.test(text))) {
      weekdays = [0, 1, 2, 3, 4, 5, 6];
    }
  }
  if (weekdays.length === 0) return; // 无法识别周几的约束暂不支持

  // v5.84：剔除周几区间（如"周1到5"）后再做时间匹配，避免区间中的数字周几被误读为时间范围
  const timeText = text.replace(/(?:周|星期)[一二三四五六日天1-7]\s*[-~到至]\s*(?:周|星期)?[一二三四五六日天1-7]/g, '');

  // 时间段不排课："周一上午9-12点不排课" / "周五晚上17-18点不排课" / "周二13:00-15:00不排课"
  // → 该周几在此时间窗内不排课（不排除整周几，仅扣除该时间段）
  // 末段"点时"为可选项：纯冒号写法（"13:00-18:00不排课"）也能识别（v5.54）
  const rangeMatch = timeText.match(/(\d{1,2})(?::(\d{1,2}))?\s*[-~到至]\s*(\d{1,2})(?::(\d{1,2}))?(?:\s*[点时])?/);
  if (rangeMatch && BLOCK_WORDS.test(text)) {
    const start = toHHMM(timedHour(text, rangeMatch[1]), rangeMatch[2]);
    const end = toHHMM(timedHour(text, rangeMatch[3]), rangeMatch[4]);
    for (const wd of weekdays) {
      constraints.push({ type: 'weekdayRange', weekday: wd, start, end });
    }
    return;
  }

  // 提取时间（如 18点 / 18:00 / 18点30分 / 下午1:00）
  const timeMatch = timeText.match(/(\d{1,2})(?:[点时:：](\d{1,2})?)?分?/);
  const hasTime = !!timeMatch;
  const isAfter = /后\s*(?:也|都|均|同样)?\s*(?:不(?:能)?(?:排课|上课)|无空闲)/.test(text);
  const isBefore = /前\s*(?:也|都|均|同样)?\s*(?:不(?:能)?(?:排课|上课)|无空闲)/.test(text);

  if (hasTime && isAfter) {
    const time = toHHMM(timedHour(text, timeMatch[1]), timeMatch[2]);
    for (const wd of weekdays) {
      constraints.push({ type: 'weekdayAfter', weekday: wd, time });
    }
  } else if (hasTime && isBefore) {
    // v5.75："周五17点前不排课" → 该周几 17 点前不排（保留 17 点后的空闲段）
    const time = toHHMM(timedHour(text, timeMatch[1]), timeMatch[2]);
    for (const wd of weekdays) {
      constraints.push({ type: 'weekdayBefore', weekday: wd, time });
    }
  } else if (BLOCK_WORDS.test(text)) {
    // 周X不排课 → 该周几整天不排
    for (const wd of weekdays) {
      constraints.push({ type: 'weekdayOff', weekday: wd });
    }
  }
}

/** 时/分 → "HH:MM"，超界收拢到 00-23:59 */
function toHHMM(hour, minute) {
  const h = Math.min(23, parseInt(hour, 10));
  const mi = minute != null ? Math.min(59, parseInt(minute, 10)) : 0;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/** 从空闲时间段中扣除 [cutStart, cutEnd) 窗口，返回剩余段（无交集则保留整段） */
function cutSegments(segments, cutStart, cutEnd) {
  const result = [];
  for (const seg of segments) {
    if (cutEnd <= seg.start || cutStart >= seg.end) {
      result.push(seg); // 无交集
      continue;
    }
    if (seg.start < cutStart) result.push({ ...seg, end: cutStart });
    if (cutEnd < seg.end) result.push({ ...seg, start: cutEnd });
  }
  return result;
}

/**
 * 解析输入框要求文本（按行拆分）
 * @param {string} text
 * @returns {Array<{teacher: string, constraints: Array}>}
 */
export function parseRequirements(text) {
  const requirements = [];
  for (const line of String(text || '').split('\n')) {
    const req = parseRequirementLine(line);
    if (req) requirements.push(req);
  }
  return requirements;
}

/**
 * 按底层要求 + 师资约束生成空闲时间表
 * 每行要求的年月（req.year/req.month）优先，缺省时用 opts.year/opts.month
 * @param {{year: number, month: number, requirements: Array}} opts month 为 0-11
 * @returns {Array<{teacher, date, startTime, endTime}>} 标准格式
 */
export function generateAvailability({ year, month, requirements }) {
  const rows = [];

  for (const req of requirements) {
    const y = req.year != null ? req.year : year;
    const m = req.month != null ? req.month : month;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const mm = String(m + 1).padStart(2, '0');

    // v5.77："其余时间不排课" → 仅被日级约束（dayOff/dayAfter/dayBefore）覆盖的日期可排，其余日期整天不排
    const coveredDays = req.constraints.some(c => c.type === 'restOff') ? new Set() : null;
    if (coveredDays) {
      for (const c of req.constraints) {
        if (c.type === 'dayOff') coveredDays.add(c.day);
        else if (c.type === 'dayAfter' || c.type === 'dayBefore') c.days.forEach(x => coveredDays.add(x));
      }
    }

    for (let d = 1; d <= daysInMonth; d++) {
      if (coveredDays && !coveredDays.has(d)) continue;
      const date = new Date(y, m, d);
      const weekday = date.getDay(); // 0=周日

      let segments = DEFAULT_SEGMENTS.map(s => ({ ...s }));
      for (const c of req.constraints) {
        if (c.type === 'dayOff' && c.day === d) {
          segments = [];
          break;
        }
        if (c.type === 'dayAfter' && c.days.includes(d)) {
          segments = segments
            .map(s => (s.start < c.time ? { ...s, start: c.time } : s))
            .filter(s => s.start < s.end);
        }
        if (c.type === 'dayBefore' && c.days.includes(d)) {
          segments = segments
            .map(s => (s.end > c.time ? { ...s, end: c.time } : s))
            .filter(s => s.start < s.end);
        }
        if (c.type === 'weekdayOff' && c.weekday === weekday) {
          segments = [];
          break;
        }
        if (c.type === 'weekdayAfter' && c.weekday === weekday) {
          segments = segments
            .map(s => (s.end > c.time ? { ...s, end: c.time } : s))
            .filter(s => s.start < s.end);
        }
        if (c.type === 'weekdayBefore' && c.weekday === weekday) {
          segments = segments
            .map(s => (s.start < c.time ? { ...s, start: c.time } : s))
            .filter(s => s.start < s.end);
        }
        if (c.type === 'weekdayRange' && c.weekday === weekday) {
          segments = cutSegments(segments, c.start, c.end);
        }
      }

      const dd = String(d).padStart(2, '0');
      for (const seg of segments) {
        rows.push({
          teacher: req.teacher,
          date: `${y}-${mm}-${dd}`,
          startTime: seg.start,
          endTime: seg.end
        });
      }
    }
  }

  rows.sort((a, b) =>
    a.teacher.localeCompare(b.teacher) ||
    a.date.localeCompare(b.date) ||
    a.startTime.localeCompare(b.startTime)
  );
  return rows;
}
