// 排课验证脚本：从 test-data 读取 Excel → 构造 state → 调用 generateSchedule
// 用于复现/验证合班课排课问题（合班课被推到月末、第三门排不上）
import XLSX from 'xlsx';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatExcelDate, formatExcelTime } from '../src/utils/dateUtils.js';
import { generateSchedule } from '../src/scheduler/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(__dirname, '..', 'test-data');

/** 解析师资空闲时间表（与 excelParser.js 相同的列匹配逻辑） */
function parseAvailability(filePath) {
  const wb = XLSX.readFile(filePath);
  const list = [];
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
    if (!rows || rows.length < 2) continue;
    const headers = rows[0].map(h => String(h).trim());
    const findIdx = (kws) => headers.findIndex(h => kws.some(k => h.includes(k)));
    const teacherIdx = findIdx(['师资', '老师', '姓名', '教师']);
    const dateIdx = findIdx(['日期']);
    const startIdx = findIdx(['开始', '起始']);
    const endIdx = findIdx(['结束', '终止']);
    if (teacherIdx === -1 || dateIdx === -1 || startIdx === -1 || endIdx === -1) continue;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[dateIdx]) continue;
      const teacher = String(row[teacherIdx] || '').trim();
      const date = formatExcelDate(row[dateIdx]);
      const startTime = formatExcelTime(row[startIdx]);
      const endTime = formatExcelTime(row[endIdx]);
      if (teacher && startTime && endTime) list.push({ teacher, date, startTime, endTime });
    }
  }
  list.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  return list;
}

/** 解析课程体系表（支持多 sheet + 合班课） */
function parseCourseSystem(filePath) {
  const wb = XLSX.readFile(filePath);
  const list = [];
  for (let sheetIdx = 0; sheetIdx < wb.SheetNames.length; sheetIdx++) {
    const sheetName = wb.SheetNames[sheetIdx];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1 });
    if (!rows || rows.length < 2) continue;
    const headers = rows[0].map(h => String(h).trim());
    const findIdx = (kws) => headers.findIndex(h => kws.some(k => h.includes(k)));
    const classIdx = findIdx(['班型', '班级', '课程类型']);
    const courseIdx = findIdx(['课程名称', '课程名', '课程']);
    const teacherIdx = findIdx(['师资', '老师', '姓名', '教师']);
    const durationIdx = findIdx(['时长', '课时', '时间']);
    const startIdx = findIdx(['起始日期', '开始日期', '起始']);
    const endIdx = findIdx(['终止日期', '结束日期', '终止']);
    const noteIdx = findIdx(['合班备注', '备注']);
    if (classIdx === -1 || courseIdx === -1 || teacherIdx === -1 || durationIdx === -1) continue;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[classIdx]) continue;
      const classType = String(row[classIdx] || '')
        .split(/[,，]/).map(s => s.trim()).filter(Boolean).join(',');
      const courseName = String(row[courseIdx] || '').trim();
      const teacher = String(row[teacherIdx] || '').trim();
      const duration = String(row[durationIdx] || '').trim();
      if (!(classType && courseName && teacher && duration)) continue;
      const startDate = startIdx !== -1 && row[startIdx] != null && row[startIdx] !== ''
        ? formatExcelDate(row[startIdx]) : '';
      const endDate = endIdx !== -1 && row[endIdx] != null && row[endIdx] !== ''
        ? formatExcelDate(row[endIdx]) : '';
      const mergeNote = noteIdx !== -1 && row[noteIdx] != null && String(row[noteIdx]).trim() !== ''
        ? String(row[noteIdx]).trim() : '';
      list.push({
        classType, courseName, teacher, duration, startDate, endDate, mergeNote,
        scheduled: null, sheetIndex: sheetIdx, sheetName, orderInSheet: i - 1
      });
    }
  }
  return list;
}

const availabilityData = parseAvailability(path.join(testDataDir, '空闲时间表.xlsx'));
const courseSystemData = parseCourseSystem(path.join(testDataDir, '课程体系表 - 副本 - 副本.xlsx'));

console.log(`空闲时间 ${availabilityData.length} 条，课程体系 ${courseSystemData.length} 门`);

const state = { availabilityData, courseSystemData };
const result = generateSchedule(state);

console.log('\n===== 排课结果 =====');
result.courses
  .slice()
  .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
  .forEach(c => {
    console.log(`${c.date} ${c.startTime}-${c.endTime} | ${c.classType} | ${c.name} | ${c.teacher}`);
  });

console.log(`\n成功: ${result.successCount} / 失败: ${result.failedCount}`);
console.log('合班课（备注含"合班"或班型含逗号）:');
result.courseSystemData
  .filter(it => String(it.mergeNote || '').includes('合班') || String(it.classType).includes(','))
  .forEach(it => console.log(`  ${it.courseName} [${it.classType}] scheduled=${it.scheduled}`));

// 找出未排上的课程
console.log('\n未排上（scheduled=false）:');
result.courseSystemData.filter(it => it.scheduled === false).forEach(it =>
  console.log(`  ${it.sheetName} | ${it.courseName} | ${it.classType} | ${it.teacher} | ${it.duration}分钟`)
);

// --export：把排课结果导出为 Excel（与 excelExporter.js 相同格式）
if (process.argv.includes('--export')) {
  const outFile = path.join(testDataDir, '排课结果_2026年09月.xlsx');
  const aoa = [
    ['班级', '课程名称', '日期', '授课时间', '授课师资'],
    ...result.courses
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
      .map(c => [c.classType || '', c.name || '', c.date || '',
        `${c.startTime || ''} - ${c.endTime || ''}`, c.teacher || ''])
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 22 }, { wch: 24 }, { wch: 12 }, { wch: 16 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '排课结果');
  XLSX.writeFile(wb, outFile);
  console.log(`\n已导出排课结果: ${outFile}（${result.courses.length} 条）`);
}
