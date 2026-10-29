// 临时调试：复跑 10 月排课，输出每门课排课轨迹（prevDate / 跨子表推进 / phase / mergeRelax）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSchedule } from '../src/scheduler/index.js';
import { buildScheduleReportMarkdown } from '../src/scheduler/report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'server-data', 'data.json'), 'utf8'));
const availabilityData = (data.availabilityFiles || []).flatMap(f => f.items || []);
const courseSystemData = (data.courseSystemFiles || []).flatMap(f => f.items || []);

const startDates = courseSystemData.map(i => i.startDate).filter(Boolean).sort();
const currentDate = new Date(startDates[0] || '2026-10-01');
console.log(`排课月份：${currentDate.getFullYear()} 年 ${currentDate.getMonth() + 1} 月`);

const result = generateSchedule({ currentDate, availabilityData, courseSystemData });
console.log(`成功 ${result.successCount} / 失败 ${result.failedCount}\n`);

// 每门课轨迹（reportSteps 在 result.diagnostics 或发回数据里？尝试从 result 找）
if (result.diagnostics) {
  console.log('=== diagnostics keys ===', Object.keys(result.diagnostics));
}

// 排课结果按子表/行序输出
const bySheet = new Map();
for (const c of result.courses) {
  const it = courseSystemData.find(x => x.courseName === c.name && String(x.classType).includes(String(c.classType)));
  // 简单按名字+班级匹配 sheet
  const src = courseSystemData.find(x => x.courseName === c.name && x.startDate === '2026-10-01');
  bySheet.set(c.name, c);
}
console.log('\n===== 排课结果（按日期） =====');
result.courses.slice().sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)).forEach(c => {
  console.log(`${c.date} ${c.startTime}-${c.endTime} | ${c.classType} | ${c.name} | ${c.teacher}`);
});

// 每门课在课程体系表中的子表归属
console.log('\n===== 课程 → 子表 → 排课状态 =====');
for (const f of data.courseSystemFiles) {
  console.log(`\n--- ${f.fileName || f.name || 'file'} ---`);
  for (const it of f.items) {
    const scheduled = String(it.scheduled);
    console.log(`${it.sheetName} | order ${it.orderInSheet} | ${it.courseName} | [${it.classType}] | ${it.teacher} | ${it.startDate}~${it.endDate || ''} | scheduled=${scheduled}`);
  }
}