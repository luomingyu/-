// Excel 解析：纯函数，返回数据数组（不触碰 DOM、不写全局状态）
import * as XLSX from 'xlsx';
import { formatExcelDate, formatExcelTime } from './dateUtils.js';
import { normalizeClassType } from './classType.js';
import { classifyClassType } from './classRegistry.js';
import { analyzeSheetForms } from './sheetForm.js';

/** 读取文件为 workbook */
function readWorkbook(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        resolve(workbook);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsArrayBuffer(file);
  });
}

/** 解析单个 sheet 为数据行 */
function parseSheet(worksheet) {
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
  if (!rows || rows.length < 2) {
    return [];
  }
  return rows;
}

/** 在表头中按关键字定位列索引 */
function findColumnIndex(headers, keywords) {
  return headers.findIndex(h => keywords.some(kw => String(h).includes(kw)));
}

/**
 * 解析师资空闲时间表（支持多 sheet）
 * 列：师资名称 / 日期 / 开始时间 / 结束时间
 * @returns {Promise<Array<{teacher, date, startTime, endTime}>>}
 */
export async function parseAvailabilitySheet(file) {
  const workbook = await readWorkbook(file);
  const list = [];

  for (const sheetName of workbook.SheetNames) {
    const rows = parseSheet(workbook.Sheets[sheetName]);
    if (rows.length === 0) continue;

    const headers = rows[0].map(h => String(h).trim());
    const teacherIndex = findColumnIndex(headers, ['师资', '老师', '姓名', '教师']);
    const dateIndex = findColumnIndex(headers, ['日期']);
    const startTimeIndex = findColumnIndex(headers, ['开始', '起始']);
    const endTimeIndex = findColumnIndex(headers, ['结束', '终止']);

    if (teacherIndex === -1 || dateIndex === -1 || startTimeIndex === -1 || endTimeIndex === -1) {
      continue;
    }

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[dateIndex]) continue;

      const teacher = String(row[teacherIndex] || '').trim();
      const date = formatExcelDate(row[dateIndex]);
      const startTime = formatExcelTime(row[startTimeIndex]);
      const endTime = formatExcelTime(row[endTimeIndex]);

      if (teacher && startTime && endTime) {
        list.push({ teacher, date, startTime, endTime });
      }
    }
  }

  list.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.startTime.localeCompare(b.startTime);
  });

  return list;
}

/**
 * 解析课程体系表（支持多 sheet）
 * 班级列固定取每个子表第一列（A 列，v5.73）：识别并归类到 16 个标准班级（utils/classRegistry.js），
 * 未识别班级保留原值并收集警告（宽松模式，排课照常）
 * 其余列按表头关键字查找：课程名称 / 师资名称 / 时长 / 起始日期 / 终止日期
 * 起始/终止日期为可选列；填写后仅在该日期区间内排课
 * @returns {Promise<{list: Array, warnings: Array<string>, mixedSheets: Array<Object>}>}
 *   list 元素：{classType, courseName, teacher, duration, startDate, endDate, scheduled, sheetIndex}
 *   warnings 元素：未识别班级提示（含其出现过的全部子表名），按原始班级名去重
 *   mixedSheets 元素：混合形态子表（先分后合与先合后分并存，v5.83 暂不做排课处理），
 *   形如 {sheetKey, sheetName, sheetIndex, totalCourses, mergeCount, preCount, postCount, reason}
 */
export async function parseCourseSystemSheet(file) {
  const workbook = await readWorkbook(file);
  const list = [];
  // rawClassType → 出现过的子表名集合（同一未识别班级跨多个子表时合并提示）
  const warnedRawClass = new Map();
  let globalIndex = 0;

  for (let sheetIdx = 0; sheetIdx < workbook.SheetNames.length; sheetIdx++) {
    const sheetName = workbook.SheetNames[sheetIdx];
    const rows = parseSheet(workbook.Sheets[sheetName]);
    if (rows.length === 0) continue;

    const headers = rows[0].map(h => String(h).trim());
    // v5.73：班级列固定取每个子表第一列（A 列，索引 0），不再按表头关键字查找
    const classTypeIndex = 0;
    const courseNameIndex = findColumnIndex(headers, ['课程名称', '课程名', '课程']);
    const teacherIndex = findColumnIndex(headers, ['师资', '老师', '姓名', '教师']);
    const durationIndex = findColumnIndex(headers, ['时长', '课时', '时间']);
    const startDateIndex = findColumnIndex(headers, ['起始日期', '开始日期', '起始']);
    const endDateIndex = findColumnIndex(headers, ['终止日期', '结束日期', '终止']);
    const mergeNoteIndex = findColumnIndex(headers, ['合班备注', '备注']);

    if (courseNameIndex === -1 || teacherIndex === -1 || durationIndex === -1) {
      continue;
    }

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[classTypeIndex]) continue;

      // 班型列规则（v5.27）：无逗号为单班级；中英文逗号间隔多个班级 = 合班课，
      // 保留为一条课程记录，排课时同时满足所有班级空闲（规则单一来源：utils/classType.js）
      const rawClassType = normalizeClassType(row[classTypeIndex]);
      // v5.73：归类到标准班级（utils/classRegistry.js）；全部组成班级归类成功才用标准名，否则保留原值并警告
      const className = classifyClassType(rawClassType);
      const classType = className || rawClassType;
      if (className === null) {
        // 未识别班级：记录原始班名及其所在子表，循环结束后统一生成提示
        if (!warnedRawClass.has(rawClassType)) warnedRawClass.set(rawClassType, new Set());
        warnedRawClass.get(rawClassType).add(sheetName);
      }
      const courseName = String(row[courseNameIndex] || '').trim();
      const teacher = String(row[teacherIndex] || '').trim();
      const duration = String(row[durationIndex] || '').trim();

      if (classType && courseName && teacher && duration) {
        // 起始/终止日期为可选列；仅当列存在且值有效时解析
        const startDate = startDateIndex !== -1 && row[startDateIndex] != null && row[startDateIndex] !== ''
          ? formatExcelDate(row[startDateIndex])
          : '';
        const endDate = endDateIndex !== -1 && row[endDateIndex] != null && row[endDateIndex] !== ''
          ? formatExcelDate(row[endDateIndex])
          : '';
        const mergeNote = mergeNoteIndex !== -1 && row[mergeNoteIndex] != null && String(row[mergeNoteIndex]).trim() !== ''
          ? String(row[mergeNoteIndex]).trim()
          : '';
        list.push({
          classType,
          courseName,
          teacher,
          duration,
          startDate,
          endDate,
          mergeNote,
          scheduled: null,
          sheetIndex: sheetIdx,
          sheetName: sheetName,
          orderInSheet: i - 1
        });
        globalIndex++;
      }
    }
  }

  if (list.length === 0) {
    throw new Error('Excel文件内容为空或格式不正确');
  }

  // 统一生成未识别班级提示：点名具体子表（同一班级跨多子表时合并提示）
  const warnings = [...warnedRawClass.entries()].map(([rawClassType, sheetNames]) =>
    `未识别班级「${rawClassType}」已保留原值（子表：${[...sheetNames].join('、')}）`
  );

  // v5.83：形态判定（与排课侧共享 analyzeSheetForms，规则单一来源）——
  // 混合形态子表（既有合班课之前的普通课、又有合班课之后的普通课）暂不做排课处理，
  // 上传页标红警告（不拦截导入），排课侧跳过并写入报告第八章。
  const { mixedSheets } = analyzeSheetForms(list);

  return { list, warnings, mixedSheets };
}

/**
 * 解析已排课表（v5.90）：已排课表为**跨科目占用约束**——声明「某班级在某日期某时间段
 * 已有课程」（可选记录「师资」）。排课时做班级 + 师资双维度互斥：
 *   班级维度（始终）：同一班级同一时间段只能上一门课；
 *   师资维度（v5.91，师资列非空）：同一师资同一时间段不能上两门课，按前后各
 *     Y（AVAIL_REMOVE_PAD_TEACHER）分钟缓冲扣除。与课程体系表科目隔离。
 * 支持多 sheet；班级列取子表第一列（A 列，索引 0，与课程体系表一致），
 * 归类到标准班级（可用 customHeaderxls/classRegistry）失败时保留原值并收集警告。
 * 授课时间支持两种写法：独立的「开始时间/结束时间」两列，或单列「授课时间」
 * 形如 "17:00-19:00"（中英文连字符均可）。
 * @returns {Promise<{list: Array, warnings: Array<string>}>}
 *   list 元素：{classType, courseName, teacher, date, startTime, endTime, sheetIndex, sheetName, orderInSheet}
 *   warnings 元素：未识别班级提示（含其出现过的全部子表名），按原始班级名去重
 */
export async function parsePresetSheet(file) {
  const workbook = await readWorkbook(file);
  const list = [];
  const warnedRawClass = new Map();
  // 日期无法解析的行：跳过并提示（避免写入 "NaN-NaN-NaN" 导致页面上看不到）
  const dateWarnings = [];

  const pickTimeRange = (row, startIndex, endIndex, rangeIndex, headers, rowIdx, sheetName) => {
    const result = { startTime: '', endTime: '', warn: '' };
    if (startIndex !== -1 && endIndex !== -1) {
      result.startTime = formatExcelTime(row[startIndex]);
      result.endTime = formatExcelTime(row[endIndex]);
    }
    if ((!result.startTime || !result.endTime) && rangeIndex !== -1 && row[rangeIndex] != null) {
      // 单列授课时间形如 "17:00-19:00" / "17:00~19:00"
      const text = String(row[rangeIndex]).trim();
      const mm = text.match(/^\s*(\d{1,2}:\d{2})\s*(?:-|–|~|至)\s*(\d{1,2}:\d{2})\s*$/);
      if (mm) {
        result.startTime = formatExcelTime(mm[1]);
        result.endTime = formatExcelTime(mm[2]);
      } else {
        result.warn = `第 ${rowIdx + 1} 行「授课时间」无法解析：${text}`;
      }
    }
    return result;
  };

  for (let sheetIdx = 0; sheetIdx < workbook.SheetNames.length; sheetIdx++) {
    const sheetName = workbook.SheetNames[sheetIdx];
    const rows = parseSheet(workbook.Sheets[sheetName]);
    if (rows.length === 0) continue;

    const headers = rows[0].map(h => String(h).trim());
    // 班级列固定取子表第一列（A 列，索引 0，与课程体系表 v5.73 一致）
    const classTypeIndex = 0;
    const courseNameIndex = findColumnIndex(headers, ['课节名称', '课节', '课程名称', '课程']);
    const teacherIndex = findColumnIndex(headers, ['师资', '老师', '教师', '姓名']);
    const dateIndex = findColumnIndex(headers, ['授课日期', '上课日期', '日期']);
    const startTimeIndex = findColumnIndex(headers, ['开始', '起始']);
    const endTimeIndex = findColumnIndex(headers, ['结束', '终止']);
    const rangeTimeIndex = findColumnIndex(headers, ['授课时间', '上课时间', '时间']);

    if (dateIndex === -1) continue;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[classTypeIndex] && !row[dateIndex]) continue;

      const rawClassType = normalizeClassType(row[classTypeIndex]);
      if (!rawClassType) continue;

      // 归类到标准班级（utils/classRegistry.js）；失败保留原值并警告
      const className = classifyClassType(rawClassType);
      const classType = className || rawClassType;
      if (className === null) {
        if (!warnedRawClass.has(rawClassType)) warnedRawClass.set(rawClassType, new Set());
        warnedRawClass.get(rawClassType).add(sheetName);
      }

      const courseName = String(row[courseNameIndex] || '').trim();
      const teacher = teacherIndex !== -1 ? String(row[teacherIndex] || '').trim() : '';
      const rawDate = row[dateIndex];
      const date = formatExcelDate(rawDate);
      const { startTime, endTime, warn } = pickTimeRange(
        row, startTimeIndex, endTimeIndex, rangeTimeIndex, headers, i, sheetName
      );

      if (classType && startTime && endTime) {
        // 日期无法解析时不写入坏数据，收集提示（否则页面按日期匹配不到，表现为「不显示」）
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          dateWarnings.push(`第 ${i + 1} 行「授课日期」无法解析：${String(rawDate ?? '').trim() || '(空)'}（子表：${sheetName}）`);
          continue;
        }
        list.push({
          classType,
          courseName,
          teacher,
          date,
          startTime,
          endTime,
          sheetIndex: sheetIdx,
          sheetName,
          orderInSheet: i - 1,
          warnings: warn ? [warn] : []
        });
      }
    }
  }

  const warnings = [...warnedRawClass.entries()].map(([rawClassType, sheetNames]) =>
    `未识别班级「${rawClassType}」已保留原值（子表：${[...sheetNames].join('、')}）`
  );

  list.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.startTime.localeCompare(b.startTime);
  });

  return { list, warnings: [...dateWarnings, ...warnings] };
}
