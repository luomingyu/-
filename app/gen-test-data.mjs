// 生成 5 师资 9 月空闲时间表 + 1 个班级（28OMO）5 师资课程体系表
// 每个师资至少 60 个时间段；每个师资至少 10 次课
import * as XLSX from 'xlsx';
import { writeFile } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'test-data');

// ===== 师资空闲时间配置 =====
// slots: [开始时分, 结束时分]，单位分钟
const DAY_MIN = 1440;
const SLOTS_FULL = [['09:00', '12:00'], ['14:00', '17:00'], ['18:00', '22:30']];     // 3 段/天
const SLOTS_PM = [['14:00', '17:00'], ['18:00', '22:30']];                            // 2 段/天（下午+晚上）
const SLOTS_EVE_SPLIT = [['18:00', '20:00'], ['20:00', '22:30']];                     // 2 段/天（仅晚上，拆分）
const SLOTS_FULL4 = [['09:00', '12:00'], ['14:00', '17:00'], ['18:00', '20:00'], ['20:00', '22:30']]; // 4 段/天

const pickDays = (arr) => arr.map(d => `2026-09-${String(d).padStart(2, '0')}`);

const teachers = [
  // 张明（高数）：20 天 × 3 段 = 60 行；10 课 × 150min。易
  { name: '张明', subject: '高数', courses: 10, duration: 150,
    days: pickDays([1,2,3,4,5,6,8,9,10,11,12,13,15,16,17,18,19,20,22,23]), slots: SLOTS_FULL },
  // 李华（英语）：22 天 × 3 段 = 66 行；12 课 × 120min。易
  { name: '李华', subject: '英语', courses: 12, duration: 120,
    days: pickDays([1,2,3,4,5,6,8,9,10,11,12,13,15,16,17,18,19,20,22,23,24,25]), slots: SLOTS_FULL },
  // 王强（物理）：30 天 × 2 段 = 60 行；12 课 × 120min。中
  { name: '王强', subject: '物理', courses: 12, duration: 120,
    days: pickDays(Array.from({length:30}, (_,i)=>i+1)), slots: SLOTS_PM },
  // 赵伟（化学）：30 天 × 2 段（仅晚上）= 60 行；10 课 × 120min。难（仅晚上）
  { name: '赵伟', subject: '化学', courses: 10, duration: 120,
    days: pickDays(Array.from({length:30}, (_,i)=>i+1)), slots: SLOTS_EVE_SPLIT },
  // 陈静（线代）：15 天 × 4 段 = 60 行；10 课 × 120min。难（天数最少）
  { name: '陈静', subject: '线代', courses: 10, duration: 120,
    days: pickDays([1,3,4,5,8,10,11,15,17,18,22,24,25,29,30]), slots: SLOTS_FULL4 },
];

// ===== 工具：日期 → Excel 序列号；时间 → 小数 =====
// Excel 序列号基准：1899-12-30 = 0；2026-09-01 = 46266
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
function dateToSerial(dateStr) {
  // dateStr: 'YYYY-MM-DD'
  const [y, m, d] = dateStr.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) - EXCEL_EPOCH;
  return Math.round(ms / 86400000);
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
// 强制日期/时间为数字格式
availWs['!cols'] = [{ wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }];
const availWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(availWb, availWs, 'Sheet1');
const availPath = join(outDir, '空闲时间表-5师资.xlsx');
XLSX.writeFile(availWb, availPath);
console.log(`已生成: ${availPath} (${availAoa.length - 1} 行)`);
for (const t of teachers) {
  const rows = t.days.length * t.slots.length;
  console.log(`  ${t.name}(${t.subject}): ${t.days.length}天 × ${t.slots.length}段 = ${rows}行`);
}

// ===== 生成课程体系表（5 个 sheet，每师资一个）=====
// 每 sheet 带起始/终止日期，课程仅在该区间内排课
const courseRanges = {
  '高数': ['2026-09-01', '2026-09-15'],
  '英语': ['2026-09-06', '2026-09-22'],
  '物理': ['2026-09-01', '2026-09-30'],
  '化学': ['2026-09-08', '2026-09-26'],
  '线代': ['2026-09-10', '2026-09-30'],
};

const courseWb = XLSX.utils.book_new();
let totalCourses = 0;
for (const t of teachers) {
  // 起始/终止日期以 Excel 序列号写入
  const [startDate, endDate] = courseRanges[t.subject] || [];
  const aoa = [['班型', '课程名称', '师资名称', '时长', '起始日期', '终止日期']];
  for (let i = 1; i <= t.courses; i++) {
    aoa.push(['28OMO', `${t.subject}-第${i}讲`, t.name, t.duration,
      startDate ? dateToSerial(startDate) : '', endDate ? dateToSerial(endDate) : '']);
    totalCourses++;
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 10 }, { wch: 28 }, { wch: 10 }, { wch: 8 }, { wch: 12 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(courseWb, ws, t.subject);
}
const coursePath = join(outDir, '课程体系表-5师资.xlsx');
XLSX.writeFile(courseWb, coursePath);
console.log(`\n已生成: ${coursePath} (${totalCourses} 门课, 5 个 sheet)`);
for (const t of teachers) {
  console.log(`  ${t.name}(${t.subject}): ${t.courses}课 × ${t.duration}min, 区间 ${courseRanges[t.subject]?.join(' ~ ') || '不限'}`);
}
