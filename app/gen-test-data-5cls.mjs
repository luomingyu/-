// 生成 5 师资 5 班级 9 月测试数据
// 每个师资至少 60 个时间段；每个师资在每个班级至少 6 次课
// 总课程数：5 师资 × 5 班级 × 6 课 = 150 门
import * as XLSX from 'xlsx';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'test-data');

const DAY_MIN = 1440;
const SLOTS_FULL = [['09:00', '12:00'], ['14:00', '17:00'], ['18:00', '22:30']];
const SLOTS_PM = [['14:00', '17:00'], ['18:00', '22:30']];
const SLOTS_EVE = [['18:00', '20:00'], ['20:00', '22:30']];
const SLOTS_FULL4 = [['09:00', '12:00'], ['14:00', '17:00'], ['18:00', '20:00'], ['20:00', '22:30']];

const pickDays = (arr) => arr.map(d => `2026-09-${String(d).padStart(2, '0')}`);

// 5 位师资，每位在 5 个班级各 6 课 = 30 课/师资
const teachers = [
  { name: '张明', subject: '高数', duration: 120,
    days: pickDays([1,2,3,4,5,6,8,9,10,11,12,13,15,16,17,18,19,20,22,23]), slots: SLOTS_FULL },
  { name: '李华', subject: '英语', duration: 120,
    days: pickDays([1,2,3,4,5,6,8,9,10,11,12,13,15,16,17,18,19,20,22,23,24,25]), slots: SLOTS_FULL },
  { name: '王强', subject: '物理', duration: 120,
    days: pickDays(Array.from({length:30}, (_,i)=>i+1)), slots: SLOTS_PM },
  { name: '赵伟', subject: '化学', duration: 120,
    days: pickDays(Array.from({length:30}, (_,i)=>i+1)), slots: SLOTS_EVE },
  { name: '陈静', subject: '线代', duration: 120,
    days: pickDays([1,3,4,5,8,10,11,15,17,18,22,24,25,29,30]), slots: SLOTS_FULL4 },
];

const classes = ['A班', 'B班', 'C班', 'D班', 'E班'];
const COURSES_PER_TEACHER_PER_CLASS = 6;

// Excel 日期/时间工具
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
function dateToSerial(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - EXCEL_EPOCH) / 86400000);
}
function timeToFraction(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return (h * 60 + m) / DAY_MIN;
}

// ===== 生成空闲时间表 =====
const availAoa = [['师资名称', '日期', '开始时间', '结束时间']];
for (const t of teachers) {
  for (const date of t.days) {
    const serial = dateToSerial(date);
    for (const [s, e] of t.slots) {
      availAoa.push([t.name, serial, timeToFraction(s), timeToFraction(e)]);
    }
  }
}
const availWs = XLSX.utils.aoa_to_sheet(availAoa);
availWs['!cols'] = [{ wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }];
const availWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(availWb, availWs, 'Sheet1');
const availPath = join(outDir, '空闲时间表-5师资5班级.xlsx');
XLSX.writeFile(availWb, availPath);
console.log(`已生成: ${availPath} (${availAoa.length - 1} 行)`);
for (const t of teachers) {
  const rows = t.days.length * t.slots.length;
  console.log(`  ${t.name}(${t.subject}): ${t.days.length}天 × ${t.slots.length}段 = ${rows}行`);
}

// ===== 生成课程体系表（5 个 sheet，每班一个）=====
// 每班带起始/终止日期，课程仅在该区间内排课
const classRanges = {
  'A班': ['2026-09-01', '2026-09-20'],
  'B班': ['2026-09-02', '2026-09-22'],
  'C班': ['2026-09-03', '2026-09-24'],
  'D班': ['2026-09-05', '2026-09-26'],
  'E班': ['2026-09-07', '2026-09-30'],
};

const courseWb = XLSX.utils.book_new();
let totalCourses = 0;
for (const cls of classes) {
  const [startDate, endDate] = classRanges[cls] || [];
  const aoa = [['班型', '课程名称', '师资名称', '时长', '起始日期', '终止日期']];
  for (const t of teachers) {
    for (let i = 1; i <= COURSES_PER_TEACHER_PER_CLASS; i++) {
      aoa.push([cls, `${cls}-${t.subject}-第${i}讲`, t.name, t.duration,
        startDate ? dateToSerial(startDate) : '', endDate ? dateToSerial(endDate) : '']);
      totalCourses++;
    }
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 10 }, { wch: 28 }, { wch: 10 }, { wch: 8 }, { wch: 12 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(courseWb, ws, cls);
}
const coursePath = join(outDir, '课程体系表-5师资5班级.xlsx');
XLSX.writeFile(courseWb, coursePath);
console.log(`\n已生成: ${coursePath} (${totalCourses} 门课, ${classes.length} 个 sheet)`);
console.log(`  每班: ${teachers.length}师资 × ${COURSES_PER_TEACHER_PER_CLASS}课 = ${teachers.length * COURSES_PER_TEACHER_PER_CLASS}课`);
for (const cls of classes) {
  console.log(`  ${cls}: 区间 ${classRanges[cls]?.join(' ~ ') || '不限'}`);
}
