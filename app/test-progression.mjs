// 测试日期递增排课策略
import { generateSchedule } from './src/scheduler/index.js';

// 模拟用户的高数课程场景
const monthAvailability = [
  // 窦峥的空闲时间（分散在整个月）
  { teacher: '窦峥', date: '2026-09-01', startTime: '20:00', endTime: '22:00' },
  { teacher: '窦峥', date: '2026-09-03', startTime: '20:00', endTime: '22:00' },
  { teacher: '窦峥', date: '2026-09-08', startTime: '20:00', endTime: '22:00' },
  { teacher: '窦峥', date: '2026-09-10', startTime: '20:00', endTime: '22:00' },
  { teacher: '窦峥', date: '2026-09-15', startTime: '20:00', endTime: '22:00' },
  { teacher: '窦峥', date: '2026-09-17', startTime: '20:00', endTime: '22:00' },
  { teacher: '窦峥', date: '2026-09-22', startTime: '20:00', endTime: '22:00' },
  { teacher: '窦峥', date: '2026-09-24', startTime: '20:00', endTime: '22:00' },
  { teacher: '窦峥', date: '2026-09-29', startTime: '20:00', endTime: '22:00' },
  { teacher: '窦峥', date: '2026-09-30', startTime: '20:00', endTime: '22:00' },
];

// 课程体系（严格按用户上传顺序）
const courseSystemData = [
  { classType: '27OMO', courseName: '高数-选填题技巧与方法（一）', teacher: '窦峥', duration: '90', sheetIndex: 0, sheetName: '高数', orderInSheet: 0, scheduled: null },
  { classType: '27OMO', courseName: '高数-选填题技巧与方法（二）', teacher: '窦峥', duration: '90', sheetIndex: 0, sheetName: '高数', orderInSheet: 1, scheduled: null },
  { classType: '27OMO', courseName: '高数-解答题题型与方法', teacher: '窦峥', duration: '90', sheetIndex: 0, sheetName: '高数', orderInSheet: 2, scheduled: null },
  { classType: '27OMO', courseName: '高数-证明题思路与证明方法（一）', teacher: '窦峥', duration: '90', sheetIndex: 0, sheetName: '高数', orderInSheet: 3, scheduled: null },
  { classType: '27OMO', courseName: '高数-证明题思路与证明方法（二）', teacher: '窦峥', duration: '90', sheetIndex: 0, sheetName: '高数', orderInSheet: 4, scheduled: null },
  { classType: '27OMO', courseName: '高数-专部分题型与方法', teacher: '窦峥', duration: '90', sheetIndex: 0, sheetName: '高数', orderInSheet: 5, scheduled: null },
];

console.log('=== 测试日期递增排课策略 ===\n');
console.log('策略：先满足课程体系顺序 → 再按日期递增 → 最后优化分散度\n');

console.log('课程体系表顺序:');
courseSystemData.forEach((c, i) => console.log(`  ${i + 1}. ${c.courseName}`));

console.log('\n可用日期:');
const dates = [...new Set(monthAvailability.map(a => a.date))].sort();
dates.forEach(d => console.log(`  ${d}`));

const state = {
  currentDate: new Date(2026, 8, 1),
  availabilityData: monthAvailability,
  courseSystemData
};

const result = generateSchedule(state);

console.log('\n=== 排课结果 ===\n');

// 按课程体系顺序显示
const nameToIndex = {};
courseSystemData.forEach((c, i) => { nameToIndex[c.courseName] = i; });
const orderedCourses = [...result.courses].sort((a, b) => nameToIndex[a.name] - nameToIndex[b.name]);

orderedCourses.forEach((c, i) => {
  const day = parseInt(c.date.slice(-2), 10);
  console.log(`${i + 1}. ${c.name}`);
  console.log(`   日期: ${c.date} (第${day}日) | 时间: ${c.startTime} - ${c.endTime}`);
});

// 验证日期递增
console.log('\n=== 日期递增验证 ===\n');
const courseDateKeys = orderedCourses.map(c => c.date.slice(5)); // MM-DD
console.log('课程日期序列:', courseDateKeys.join(', '));

let isProgressive = true;
for (let i = 1; i < courseDateKeys.length; i++) {
  if (courseDateKeys[i] <= courseDateKeys[i - 1]) {
    console.log(`❌ 第${i + 1}门课(${courseDateKeys[i]}) 早于或等于 第${i}门课(${courseDateKeys[i - 1]})`);
    isProgressive = false;
  }
}

if (isProgressive) {
  console.log('✅ 所有课程按日期递增排列！');
}

// 检查课程是否都排入
const allScheduled = result.courses.length === courseSystemData.length;
console.log(`\n所有课程都排入: ${allScheduled ? '✅ 是' : '❌ 否'}`);

// 最终验证
console.log('\n' + '='.repeat(50));
if (allScheduled && isProgressive) {
  console.log('✅ 所有测试通过！');
} else {
  console.log('❌ 测试未通过');
}
