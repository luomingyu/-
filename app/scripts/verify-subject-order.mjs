// 验证科目排课顺序：英语 > 政治 > 数学 > 408计算机 > 未收录科目
// 用法：node scripts/verify-subject-order.mjs
import { generateSchedule } from '../src/scheduler/index.js';
import { getSubjectOfTeacher, getSubjectPriority } from '../src/config/constants.js';

const MONTH = '2026-10';
const DAYS = ['05', '06', '07', '08', '09', '12', '13', '14', '15', '16'];

// 示例师资：覆盖 5 档科目（408计算机 三位 + 未收录一位）
const TEACHERS = ['李旭', '石磊', '窦峥', '乔石磊', '白玉杰', '宋萍萍', '张三'];

const availabilityData = [];
for (const teacher of TEACHERS) {
  for (const d of DAYS) {
    availabilityData.push({ teacher, date: `${MONTH}-${d}`, startTime: '19:00', endTime: '21:00' });
  }
}

const courseSystemData = [];
TEACHERS.forEach((teacher, sheetIndex) => {
  const subject = getSubjectOfTeacher(teacher) || '未收录科目';
  const sheetName = `${subject}-${teacher}`;
  for (let i = 0; i < 2; i++) {
    courseSystemData.push({
      classType: `27${subject}班`,
      courseName: `${subject}-第${i + 1}讲`,
      teacher,
      duration: '60',
      startDate: '',
      endDate: '',
      scheduled: null,
      sheetIndex,
      sheetName,
      orderInSheet: i
    });
  }
});

const result = generateSchedule({ currentDate: new Date(`${MONTH}-01`), availabilityData, courseSystemData });
if (!result.ok) {
  console.error('排课失败：', result.error);
  process.exit(1);
}

console.log('\n===== 师资排课次序（diagnostics.teacherOrder）=====');
for (const r of result.diagnostics.teacherOrder) {
  console.log(`${String(r.order).padStart(2)}. ${(r.subject || '未收录科目').padEnd(6)} | ${r.teacher.padEnd(4)} | 科目优先级=${r.subjectPriority}`);
}

console.log('\n===== 子表排课次序（diagnostics.schedulingOrder）=====');
result.diagnostics.schedulingOrder.forEach((s, i) => console.log(`${i + 1}. ${s}`));

// 断言：科目优先级序列单调不减，且 408计算机 位于 数学 与 未收录 之间
const seq = result.diagnostics.teacherOrder.map(r => r.subjectPriority);
const monotonic = seq.every((v, i) => i === 0 || v >= seq[i - 1]);
const order = result.diagnostics.teacherOrder.map(r => r.subject);
const lastMath = order.lastIndexOf('数学');
const first408 = order.indexOf('408计算机');
const last408 = order.lastIndexOf('408计算机');
const firstUnknown = order.findIndex(s => s === null);
const between = first408 > lastMath && last408 < firstUnknown;

console.log('\n===== 结论 =====');
console.log(`科目优先级单调不减: ${monotonic ? '✅' : '❌'}`);
console.log(`408计算机 位于 数学 之后、未收录科目 之前: ${between ? '✅' : '❌'}`);
console.log(`排课成功 ${result.successCount} / 失败 ${result.failedCount}`);
process.exit(monotonic && between ? 0 : 1);
