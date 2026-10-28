// 验证科目排课顺序：英语 > 政治 > 数学 > 408计算机 > 日语 > 未收录科目
// 用法：node scripts/verify-subject-order.mjs
import { generateSchedule } from '../src/scheduler/index.js';
import { getSubjectOfTeacher, getSubjectPriority, isSubjectConflict } from '../src/config/constants.js';
import { createScheduleContext, registerSlot, registerPresetClassSlots, buildTeacherClassAvailability, hasConflict } from '../src/scheduler/scheduleContext.js';
import { AVAIL_REMOVE_PAD } from '../src/scheduler/constants.js';
import { minutesToTime } from '../src/utils/dateUtils.js';

const MONTH = '2026-10';
const DAYS = ['05', '06', '07', '08', '09', '12', '13', '14', '15', '16'];

// 示例师资：覆盖 6 档科目（408计算机 三位 + 日语两位 + 未收录一位）
const TEACHERS = ['李旭', '石磊', '窦峥', '乔石磊', '白玉杰', '宋萍萍', 'aki', '洛洛', '张三'];

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

// 断言：科目优先级序列单调不减，且 408计算机/日语 位于 数学 与 未收录 之间
const seq = result.diagnostics.teacherOrder.map(r => r.subjectPriority);
const monotonic = seq.every((v, i) => i === 0 || v >= seq[i - 1]);
const order = result.diagnostics.teacherOrder.map(r => r.subject);
const lastMath = order.lastIndexOf('数学');
const first408 = order.indexOf('408计算机');
const last408 = order.lastIndexOf('408计算机');
const firstJapanese = order.indexOf('日语');
const lastJapanese = order.lastIndexOf('日语');
const firstUnknown = order.findIndex(s => s === null);
const between = first408 > lastMath && last408 < firstJapanese && lastJapanese < firstUnknown;

// 断言：科目互斥矩阵 —— 日语与政治/数学/日语互斥，与英语/408计算机不互斥，未知科目保守互斥
const conflictCases = [
  ['日语', '日语', true],
  ['日语', '政治', true],
  ['政治', '日语', true],
  ['日语', '数学', true],
  ['日语', '英语', false],
  ['英语', '日语', false],
  ['日语', '408计算机', false],
  ['408计算机', '日语', false],
  ['英语', '政治', true],
  ['日语', null, true]
];
const conflictResults = conflictCases.map(([a, b, expected]) => ({
  label: `${a ?? '未知'} ↔ ${b ?? '未知'}`,
  expected,
  actual: isSubjectConflict(a, b)
}));
const conflictOk = conflictResults.every(c => c.actual === c.expected);

// 断言：同班同时段互斥行为（日语 ↔ 英语/408 可并存，日语 ↔ 政治/日语 互斥）
const toMin = (s) => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};
const behaviorCtx = createScheduleContext([]);
const D = `${MONTH}-20`;
const D2 = `${MONTH}-21`;
const C = '27混排班';
// 课程时段之间留出 ≥ CLASS_MIN_GAP 的间隔，避免相邻时段本身触发班级冲突
registerSlot(behaviorCtx, { teacher: '李旭', classType: C, date: D, startTime: '18:00', endTime: '19:00' });   // 英语
registerSlot(behaviorCtx, { teacher: '石磊', classType: C, date: D, startTime: '20:00', endTime: '21:00' });   // 政治
registerSlot(behaviorCtx, { teacher: '乔石磊', classType: C, date: D, startTime: '22:00', endTime: '23:00' }); // 408
const conflictAt = (teacher, startTime, endTime, date = D) => hasConflict(behaviorCtx, {
  teacher, classType: C, date, slotStart: toMin(startTime), slotEnd: toMin(endTime), minGap: 0
});
const behaviorCases = [
  ['aki 与英语同时段（可并存）', conflictAt('aki', '18:00', '19:00'), false],
  ['aki 与政治同时段（互斥）', conflictAt('aki', '20:00', '21:00'), true],
  ['aki 与408同时段（可并存）', conflictAt('aki', '22:00', '23:00'), false]
];
// 日语课之间（同班）互斥：另取一天，先注册洛洛的日语课，再校验 aki 同时段
registerSlot(behaviorCtx, { teacher: '洛洛', classType: C, date: D2, startTime: '19:00', endTime: '20:00' });
behaviorCases.push(['aki 与洛洛（日语）同时段（互斥）', conflictAt('aki', '19:00', '20:00', D2), true]);
const behaviorOk = behaviorCases.every(([, actual, expected]) => actual === expected);

// 断言：已排课表（无科目信息）保守全互斥
const presetCtx = createScheduleContext([]);
registerPresetClassSlots(presetCtx, { classType: C, teacher: null, date: D, startTime: '19:00', endTime: '20:00', subject: null });
const presetOk = hasConflict(presetCtx, { teacher: 'aki', classType: C, date: D, slotStart: toMin('19:00'), slotEnd: toMin('20:00'), minGap: 0 }) === true;

// 断言：日语师资的师资-班级空闲时间表扣除口径（v5.96）
//   仅扣除同班政治/数学课节 + 同师资自身课节；
//   同班英语、408计算机、日语（其他师资）不扣除。
const D3 = `${MONTH}-22`;
const availCtx = createScheduleContext([]);
// ① 英语不扣 / 政治扣除：19:00-21:00 中仅政治 20:00-21:00 扣除 → 19:00-19:55
registerSlot(availCtx, { teacher: '李旭', classType: C, date: D, startTime: '19:00', endTime: '20:00' });   // 英语
registerSlot(availCtx, { teacher: '石磊', classType: C, date: D, startTime: '20:00', endTime: '21:00' });   // 政治
const japaneseAvail = buildTeacherClassAvailability(
  [{ teacher: 'aki', date: D, startTime: '19:00', endTime: '21:00' }], 'aki', C, availCtx
);
const expectedEnd = minutesToTime(20 * 60 - AVAIL_REMOVE_PAD);
const availOk = japaneseAvail.length === 1
  && japaneseAvail[0].startTime === '19:00'
  && japaneseAvail[0].endTime === expectedEnd;

// ② 同班英语 / 408 / 洛洛日语（其他师资）不扣，数学 / 政治扣除：
//    09:00-14:00 中数学 12:00-13:00、政治 13:00-14:00 扣除 → 余 09:00-11:55
registerSlot(availCtx, { teacher: '李旭', classType: C, date: D3, startTime: '09:00', endTime: '10:00' });   // 英语
registerSlot(availCtx, { teacher: '乔石磊', classType: C, date: D3, startTime: '10:00', endTime: '11:00' }); // 408
registerSlot(availCtx, { teacher: '洛洛', classType: C, date: D3, startTime: '11:00', endTime: '12:00' });   // 日语（其他师资）
registerSlot(availCtx, { teacher: '窦峥', classType: C, date: D3, startTime: '12:00', endTime: '13:00' });   // 数学
registerSlot(availCtx, { teacher: '石磊', classType: C, date: D3, startTime: '13:00', endTime: '14:00' });   // 政治
const availCtx2 = createScheduleContext([]);
availCtx2.classScheduleByDate = availCtx.classScheduleByDate;
const mixedAvail = buildTeacherClassAvailability(
  [{ teacher: 'aki', date: D3, startTime: '09:00', endTime: '14:00' }], 'aki', C, availCtx2
);
const expectedMixedEnd = minutesToTime(12 * 60 - AVAIL_REMOVE_PAD);
const availMixedOk = mixedAvail.length === 1
  && mixedAvail[0].startTime === '09:00'
  && mixedAvail[0].endTime === expectedMixedEnd;

// ③ 同师资自身课节扣除（含 AVAIL_REMOVE_PAD_TEACHER=30 分钟缓冲）：
//    aki 14:00-18:00 空闲，自身 15:00-16:00 已排 → 余 14:00-14:30 与 16:30-18:00
const selfCtx = createScheduleContext([]);
registerSlot(selfCtx, { teacher: 'aki', classType: '28混排班', date: D3, startTime: '15:00', endTime: '16:00' });
const selfAvail = buildTeacherClassAvailability(
  [{ teacher: 'aki', date: D3, startTime: '14:00', endTime: '18:00' }], 'aki', C, selfCtx
);
const selfOk = selfAvail.length === 2
  && selfAvail[0].startTime === '14:00' && selfAvail[0].endTime === '14:30'
  && selfAvail[1].startTime === '16:30' && selfAvail[1].endTime === '18:00';

console.log('\n===== 结论 =====');
console.log(`科目优先级单调不减: ${monotonic ? '✅' : '❌'}`);
console.log(`408计算机/日语 位于 数学 之后、未收录科目 之前（408 → 日语）: ${between ? '✅' : '❌'}`);
console.log(`科目互斥矩阵（日语部分互斥）: ${conflictOk ? '✅' : '❌'}`);
console.log(`同班互斥行为（日语与英语/408 并存、与政治/日语 互斥）: ${behaviorOk ? '✅' : '❌'}`);
for (const [label, actual, expected] of behaviorCases) {
  if (actual !== expected) console.log(`  ❌ ${label}: 期望 ${expected}，实际 ${actual}`);
}
console.log(`已排课表保守全互斥: ${presetOk ? '✅' : '❌'}`);
console.log(`空闲时间表按科目过滤扣除（英语不扣/政治扣除，期望结束 ${expectedEnd}）: ${availOk ? '✅' : '❌'}`);
console.log(`空闲时间表扣除口径（英语/408/其他师资日语不扣，数学/政治扣除，期望结束 ${expectedMixedEnd}）: ${availMixedOk ? '✅' : '❌'}`);
console.log(`空闲时间表扣除同师资自身课节（含 30 分钟缓冲）: ${selfOk ? '✅' : '❌'}`);
console.log(`排课成功 ${result.successCount} / 失败 ${result.failedCount}`);
process.exit(monotonic && between && conflictOk && behaviorOk && presetOk && availOk && availMixedOk && selfOk ? 0 : 1);
