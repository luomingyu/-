// 验证课程体系表起始/终止日期排课约束
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateSchedule } from './src/scheduler/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const json = JSON.parse(readFileSync(join(__dirname, 'test-data', 'test-data-5cls5tch.json'), 'utf-8'));

const state = {
  currentDate: new Date(2026, 8, 1),
  availabilityData: json.availabilityData,
  courseSystemData: json.courseSystemData
};

const result = generateSchedule(state);

console.log(`\n=== 排课结果: 成功 ${result.successCount} / 失败 ${result.failedCount} ===`);

// 按班级统计日期范围
const classDates = {};
for (const c of result.courses) {
  if (!classDates[c.classType]) classDates[c.classType] = [];
  classDates[c.classType].push(c.date);
}

const expectedRanges = {
  'A班': ['2026-09-01', '2026-09-20'],
  'B班': ['2026-09-02', '2026-09-22'],
  'C班': ['2026-09-03', '2026-09-24'],
  'D班': ['2026-09-05', '2026-09-26'],
  'E班': ['2026-09-07', '2026-09-30']
};

let allPass = true;
for (const cls of Object.keys(expectedRanges)) {
  const [start, end] = expectedRanges[cls];
  const dates = (classDates[cls] || []).sort();
  let rangeOk = true;
  for (const d of dates) {
    if (d < start || d > end) {
      rangeOk = false;
      console.log(`❌ ${cls} 课程日期 ${d} 超出区间 [${start}, ${end}]`);
      allPass = false;
    }
  }
  const range = dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : '无';
  console.log(`${rangeOk ? '✅' : '❌'} ${cls}: ${dates.length}/${json.courseSystemData.filter(c => c.classType === cls).length} 课, 日期范围 ${range} (要求 ${start} ~ ${end})`);
}

console.log(allPass ? '\n✅ 所有课程均在各自起始/终止日期区间内' : '\n❌ 存在区间越界课程');