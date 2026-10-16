// 用后台真实数据（server-data/data.json）复跑排课（当前算法版本），并同步更新：
//   1. 排课结果（courses + 课程体系表 scheduled 标记）→ POST 回本机服务器（/api/data）
//   2. 排课报告 markdown → 写入项目根目录（文件名含时间戳，与报告生成器一致）
//   3. 排课结果 Excel → 写入 app/test-data/排课结果_2026年09月.xlsx（与 excelExporter 同格式）
// 用法：node scripts/regen-backend-schedule.mjs
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { fileURLToPath } from 'node:url';
import { generateSchedule } from '../src/scheduler/index.js';
import { buildScheduleReportMarkdown, scheduleReportFileName } from '../src/scheduler/report.js';
import { APP_VERSION } from '../src/config/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const root = path.resolve(appRoot, '..');
const dataFile = path.join(root, 'server-data', 'data.json');

// ---------- 读取后台数据并重建排课入参 ----------
const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const availabilityData = (data.availabilityFiles || []).flatMap(f => f.items || []);
const courseSystemData = (data.courseSystemFiles || []).flatMap(f => f.items || []);
console.log(`后台数据：空闲 ${availabilityData.length} 条，课程体系 ${courseSystemData.length} 门`);

// 排课月份 = 课程体系表中最早的起始日期所在月（后台数据为 2026-09）
const startDates = courseSystemData.map(i => i.startDate).filter(Boolean).sort();
const currentDate = new Date(startDates[0] || '2026-09-01');
console.log(`排课月份：${currentDate.getFullYear()} 年 ${currentDate.getMonth() + 1} 月`);

// ---------- 复跑排课 ----------
const result = generateSchedule({ currentDate, availabilityData, courseSystemData });
if (!result.ok) {
  console.error('排课失败:', result.error);
  process.exit(1);
}
console.log(`排课完成：成功 ${result.successCount} / 失败 ${result.failedCount}（版本 ${APP_VERSION}）`);

// ---------- 生成排课报告（与 store.js runSchedule 一致） ----------
const y = currentDate.getFullYear();
const month = currentDate.getMonth() + 1;
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const reportMeta = {
  year: y,
  month,
  reportAt: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
  appVersion: APP_VERSION
};
const report = {
  id: `report-${now.getTime()}`,
  year: y,
  month,
  fileName: scheduleReportFileName(now, y, month),
  content: buildScheduleReportMarkdown(reportMeta, result),
  generatedAt: now.toISOString(),
  appVersion: APP_VERSION,
  successCount: result.successCount,
  failedCount: result.failedCount
};

// 报告写入项目根目录（覆盖旧的同月报告，保留最新一份）
const rootReportFile = path.join(root, report.fileName);
fs.readdirSync(root)
  .filter(f => f.startsWith('排课报告_') && f.endsWith('.md'))
  .forEach(f => fs.unlinkSync(path.join(root, f)));
fs.writeFileSync(rootReportFile, report.content, 'utf8');
console.log(`已更新排课报告：${rootReportFile}`);

// ---------- 排课结果回写（课程表 scheduled 标记 + courses + 报告） ----------
const scheduledMap = new Map(result.courseSystemData.map(it => [it.itemId, it.scheduled]));
const courseSystemFiles = data.courseSystemFiles.map(f => ({
  ...f,
  items: f.items.map(it => ({
    ...it,
    scheduled: scheduledMap.has(it.itemId) ? scheduledMap.get(it.itemId) : it.scheduled
  }))
}));
const payload = {
  availabilityFiles: data.availabilityFiles,
  courseSystemFiles,
  courses: result.courses,
  scheduleReports: [report]
};
const resp = await fetch('http://localhost:5000/api/data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});
if (!resp.ok) throw new Error(`服务器回写失败：HTTP ${resp.status}`);
console.log(`已回写服务器数据：courses ${result.courses.length} 条，课程表 scheduled 已更新`);

// ---------- 导出排课结果 Excel（与 excelExporter.js / verify-schedule.mjs 相同格式） ----------
const outFile = path.join(appRoot, 'test-data', `排课结果_${y}年0${month}月.xlsx`);
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
console.log(`已导出排课结果 Excel：${outFile}（${result.courses.length} 条）`);
