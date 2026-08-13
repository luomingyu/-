// 将 5 师资 5 班级测试数据导出为 JSON 文件，方便直接复用
import * as XLSX from 'xlsx';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { formatExcelDate, formatExcelTime } from './src/utils/dateUtils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDataDir = join(__dirname, 'test-data');

// 读取 xlsx
function readWorkbook(filePath) {
  const buf = readFileSync(filePath);
  return XLSX.read(buf, { type: 'buffer' });
}

// 解析空闲时间表
function parseAvailability(workbook) {
  const list = [];
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
    if (!rows || rows.length < 2) continue;
    const headers = rows[0].map(h => String(h).trim());
    const findIdx = (kws) => headers.findIndex(h => kws.some(kw => String(h).includes(kw)));
    const tIdx = findIdx(['师资', '老师', '姓名', '教师']);
    const dIdx = findIdx(['日期']);
    const sIdx = findIdx(['开始', '起始']);
    const eIdx = findIdx(['结束', '终止']);
    if (tIdx === -1 || dIdx === -1 || sIdx === -1 || eIdx === -1) continue;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[dIdx]) continue;
      const teacher = String(row[tIdx] || '').trim();
      const date = formatExcelDate(row[dIdx]);
      const startTime = formatExcelTime(row[sIdx]);
      const endTime = formatExcelTime(row[eIdx]);
      if (teacher && startTime && endTime) {
        list.push({ teacher, date, startTime, endTime });
      }
    }
  }
  list.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  return list;
}

// 解析课程体系表
function parseCourseSystem(workbook) {
  const list = [];
  for (let sheetIdx = 0; sheetIdx < workbook.SheetNames.length; sheetIdx++) {
    const sheetName = workbook.SheetNames[sheetIdx];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
    if (!rows || rows.length < 2) continue;
    const headers = rows[0].map(h => String(h).trim());
    const findIdx = (kws) => headers.findIndex(h => kws.some(kw => String(h).includes(kw)));
    const cIdx = findIdx(['班型', '班级', '课程类型']);
    const nIdx = findIdx(['课程名称', '课程名', '课程']);
    const tIdx = findIdx(['师资', '老师', '姓名', '教师']);
    const dIdx = findIdx(['时长', '课时', '时间']);
    if (cIdx === -1 || nIdx === -1 || tIdx === -1 || dIdx === -1) continue;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[cIdx]) continue;
      const classType = String(row[cIdx] || '').trim();
      const courseName = String(row[nIdx] || '').trim();
      const teacher = String(row[tIdx] || '').trim();
      const duration = String(row[dIdx] || '').trim();
      if (classType && courseName && teacher && duration) {
        list.push({
          classType, courseName, teacher, duration,
          scheduled: null, sheetIndex: sheetIdx, sheetName, orderInSheet: i - 1
        });
      }
    }
  }
  return list;
}

// === 主流程 ===
const availWb = readWorkbook(join(testDataDir, '空闲时间表-5师资5班级.xlsx'));
const courseWb = readWorkbook(join(testDataDir, '课程体系表-5师资5班级.xlsx'));

const availabilityData = parseAvailability(availWb);
const courseSystemData = parseCourseSystem(courseWb);

const jsonData = {
  metadata: {
    description: '5师资5班级9月排课测试数据',
    generatedAt: new Date().toISOString(),
    teachers: [...new Set(availabilityData.map(a => a.teacher))],
    classes: [...new Set(courseSystemData.map(c => c.classType))],
    availabilityCount: availabilityData.length,
    courseCount: courseSystemData.length,
    scheduleMonth: '2026-09'
  },
  availabilityData,
  courseSystemData
};

const jsonPath = join(testDataDir, 'test-data-5cls5tch.json');
writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2), 'utf-8');

console.log(`已生成: ${jsonPath}`);
console.log(`  师资: ${jsonData.metadata.teachers.join(', ')}`);
console.log(`  班级: ${jsonData.metadata.classes.join(', ')}`);
console.log(`  空闲时间: ${jsonData.metadata.availabilityCount} 条`);
console.log(`  课程总数: ${jsonData.metadata.courseCount} 门`);
