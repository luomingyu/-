// Excel 解析：纯函数，返回数据数组（不触碰 DOM、不写全局状态）
import * as XLSX from 'xlsx';
import { formatExcelDate, formatExcelTime } from './dateUtils.js';

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
 * 列：班型 / 课程名称 / 师资名称 / 时长
 * @returns {Promise<Array<{classType, courseName, teacher, duration, scheduled, sheetIndex}>>}
 */
export async function parseCourseSystemSheet(file) {
  const workbook = await readWorkbook(file);
  const list = [];
  let globalIndex = 0;

  for (let sheetIdx = 0; sheetIdx < workbook.SheetNames.length; sheetIdx++) {
    const sheetName = workbook.SheetNames[sheetIdx];
    const rows = parseSheet(workbook.Sheets[sheetName]);
    if (rows.length === 0) continue;

    const headers = rows[0].map(h => String(h).trim());
    const classTypeIndex = findColumnIndex(headers, ['班型', '班级', '课程类型']);
    const courseNameIndex = findColumnIndex(headers, ['课程名称', '课程名', '课程']);
    const teacherIndex = findColumnIndex(headers, ['师资', '老师', '姓名', '教师']);
    const durationIndex = findColumnIndex(headers, ['时长', '课时', '时间']);

    if (classTypeIndex === -1 || courseNameIndex === -1 || teacherIndex === -1 || durationIndex === -1) {
      continue;
    }

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[classTypeIndex]) continue;

      const classType = String(row[classTypeIndex] || '').trim();
      const courseName = String(row[courseNameIndex] || '').trim();
      const teacher = String(row[teacherIndex] || '').trim();
      const duration = String(row[durationIndex] || '').trim();

      if (classType && courseName && teacher && duration) {
        list.push({
          classType,
          courseName,
          teacher,
          duration,
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

  return list;
}
