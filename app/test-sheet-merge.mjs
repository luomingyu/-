// 合班排课端到端测试（v5.30 子表维度排课 + v5.34 合班课与子表课程体系顺序一起排课）
// 场景（与业务示例同构）：
//   子表B（班级乙：前 5 节单独 + 第 6、7 节合班，共 7 门，课程多）先排 →
//     子表内所有课程（含合班课）一起按行序排课，合班课日期随之确定；
//   子表A（班级甲：前 3 节单独 + 第 4、5 节合班，共 5 门，课程少）后排 →
//     合班课行自动对齐已确定日期（不重复排），前 3 节单独课限定在
//     第一个合班课日期前一天之前排课（从本月初到第一个合班课日期前一天）；
//   递增约束（v5.34）：子表内全序列（含合班课）按行顺序日期严格递增
import { generateSchedule } from './src/scheduler/index.js';
import { timeToMinutes } from './src/utils/dateUtils.js';
import { splitClassTypes } from './src/utils/classType.js';
import { CLASS_MIN_GAP } from './src/scheduler/constants.js';

// ===== 测试数据 =====
const days = Array.from({ length: 20 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
const teachers = ['张甲', '李乙', '王合']; // 张甲教甲班单独课，李乙教乙班单独课，王合教合班课

const availabilityData = [];
for (const t of teachers) {
  for (const d of days) {
    availabilityData.push({ teacher: t, date: d, startTime: '18:00', endTime: '22:30' });
  }
}

let itemSeq = 1;
const mk = (classType, courseName, teacher, orderInSheet, sheetName, sheetIndex, mergeNote = '') => ({
  classType, courseName, teacher, duration: '120', startDate: '', endDate: '',
  mergeNote, scheduled: null, sheetIndex, sheetName, orderInSheet, itemId: itemSeq++
});

const sheetB = [ // 子表B（班级乙）：前 5 节单独 + 第 6、7 节合班（与业务示例同构）
  mk('28OMO', '乙-第1讲', '李乙', 1, '子表B', 1),
  mk('28OMO', '乙-第2讲', '李乙', 2, '子表B', 1),
  mk('28OMO', '乙-第3讲', '李乙', 3, '子表B', 1),
  mk('28OMO', '乙-第4讲', '李乙', 4, '子表B', 1),
  mk('28OMO', '乙-第5讲', '李乙', 5, '子表B', 1),
  mk('27OMO,28OMO', '合班-英语综合', '王合', 6, '子表B', 1, '合班'),
  mk('27OMO,28OMO', '合班-数学强化', '王合', 7, '子表B', 1, '合班')
];
const sheetA = [ // 子表A（班级甲）：前 3 节单独 + 第 4、5 节合班（v5.75：合班课与子表B 同名同班型但师资不同，仍应对齐日期）
  mk('27OMO', '甲-第1讲', '张甲', 1, '子表A', 0),
  mk('27OMO', '甲-第2讲', '张甲', 2, '子表A', 0),
  mk('27OMO', '甲-第3讲', '张甲', 3, '子表A', 0),
  mk('27OMO,28OMO', '合班-英语综合', '张甲', 4, '子表A', 0, '合班'),
  mk('27OMO,28OMO', '合班-数学强化', '张甲', 5, '子表A', 0, '合班')
];

const courseSystemData = [...sheetA, ...sheetB];

console.log('=== 测试数据 ===');
console.log(`子表A: ${sheetA.length} 门（3 单独 + 2 合班） | 子表B: ${sheetB.length} 门（5 单独 + 2 合班）`);
console.log(`师资: ${teachers.join(', ')} | 空闲: 每天 18:00-22:30（${days.length} 天）`);

// ===== 执行排课 =====
const currentDate = new Date(2026, 8, 1);
const result = generateSchedule({ currentDate, availabilityData, courseSystemData });

let pass = 0;
let fail = 0;
const check = (ok, msg) => {
  if (ok) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
};

console.log('\n=== 1. 子表排课顺序（课程数量多的先排）===');
check(result.ok, '排课成功');
check(
  result.diagnostics.schedulingOrder[0] === '子表B(7门)' && result.diagnostics.schedulingOrder[1] === '子表A(5门)',
  `子表顺序: ${result.diagnostics.schedulingOrder.join(' → ')}（应为 子表B(7门) → 子表A(5门)）`
);
check(
  result.diagnostics.sheetStats[0].sheetName === '子表B',
  `子表B 先排（scheduled=${result.diagnostics.sheetStats[0].scheduled}/${result.diagnostics.sheetStats[0].totalCourses}）`
);

console.log('\n=== 2. 合班课去重（两子表各一行 → 只排一节，后表对齐日期）===');
const mergedNames = ['合班-英语综合', '合班-数学强化'];
const mergedDateBySheet = {};
for (const m of mergedNames) {
  const scheduled = result.courses.filter(c => c.name === m);
  check(scheduled.length === 1, `${m}: 时间表中仅 1 节（实际 ${scheduled.length} 节）`);
  if (scheduled.length === 1) {
    const s = scheduled[0];
    console.log(`     → ${s.date} ${s.startTime}-${s.endTime} (${s.teacher}) 复合班型 [${s.classType}]`);
    // 子表B（先排）与子表A（后排）两行都应标记已排
    for (const sheetName of ['子表B', '子表A']) {
      const row = result.courseSystemData.find(c => c.sheetName === sheetName && c.courseName === m);
      if (row) {
        check(row.scheduled === true, `  ${sheetName} 中的「${m}」行已标记为已排`);
      }
    }
  }
}

console.log('\n=== 3. 递增约束（v5.34：子表内全序列行序递增，后表前段单独课限于合班课前）===');
const isMergeRow = r =>
  (r.mergeNote && String(r.mergeNote).includes('合班')) ||
  splitClassTypes(r.classType).length > 1;
const sheetMap = {};
for (const c of result.courseSystemData) {
  if (!sheetMap[c.sheetName]) sheetMap[c.sheetName] = [];
  sheetMap[c.sheetName].push(c);
}
for (const sheetName of ['子表A', '子表B']) {
  const rows = sheetMap[sheetName].sort((a, b) => a.orderInSheet - b.orderInSheet);
  const dated = rows
    .map(r => {
      const sc = result.courses.find(c => c.sourceItemId === r.itemId);
      return { r, date: sc ? sc.date : (r.scheduled ? '已排(对齐)' : null) };
    });
  console.log(`  ${sheetName} 行顺序:`);
  for (const { r, date } of dated) {
    const label = date === null ? '未排' : (date === '已排(对齐)' ? '已排(对齐)' : date);
    console.log(`    ${r.orderInSheet}. [${r.classType}] ${r.courseName} → ${label}`);
  }
}
// 3a. 同班普通课（非合班）在子表内按行顺序日期递增（不同班级互不阻塞）
let normalOrderOk = true;
const lastNormalDateByClass = {};
for (const sheetName of ['子表A', '子表B']) {
  const rows = sheetMap[sheetName]
    .filter(r => !isMergeRow(r))
    .sort((a, b) => a.orderInSheet - b.orderInSheet);
  for (const r of rows) {
    const sc = result.courses.find(c => c.sourceItemId === r.itemId);
    if (!sc) continue;
    for (const cls of splitClassTypes(r.classType)) {
      const key = `${sheetName}|${cls}`;
      if (lastNormalDateByClass[key] && sc.date < lastNormalDateByClass[key]) {
        normalOrderOk = false;
        console.log(`    ❌ 班级 ${cls} 普通课日期回退: ${sc.date} < ${lastNormalDateByClass[key]} (${r.courseName})`);
      }
      lastNormalDateByClass[key] = sc.date;
    }
  }
}
check(normalOrderOk, '同班普通课按行顺序日期递增（不同班级互不阻塞）');

// 3b. 子表内全序列（含合班课）按行序日期严格递增（v5.34：合班课与子表课程体系顺序一起排课）
const sheetDateOf = row => {
  const sc = result.courses.find(c => c.sourceItemId === row.itemId);
  if (sc) return sc.date;
  // 对齐行（未实际排入时间表）：取同一门合班课在时间表中的日期
  if (isMergeRow(row)) {
    const merged = result.courses.find(c => c.name === row.courseName && isMergeRow(c));
    return merged ? merged.date : null;
  }
  return null;
};
let sheetFullOrderOk = true;
for (const sheetName of ['子表A', '子表B']) {
  const rows = sheetMap[sheetName].sort((a, b) => a.orderInSheet - b.orderInSheet);
  let prev = null;
  for (const r of rows) {
    const d = sheetDateOf(r);
    if (d === null) { sheetFullOrderOk = false; console.log(`    ❌ ${sheetName} ${r.courseName} 未获得日期`); break; }
    if (prev && d <= prev) {
      sheetFullOrderOk = false;
      console.log(`    ❌ ${sheetName} 行序日期未递增: ${r.courseName} ${d} <= 前一课程 ${prev}`);
    }
    prev = d;
  }
}
check(sheetFullOrderOk, '子表内全序列（含合班课）按行序日期严格递增');

// 3c. 后表（子表A）中位于第一门合班课之前的单独课，限定在合班课日期之前排课
// （v5.34 用户规则：从本月初到第一个合班课日期前一天，在此时间段内排子表A前 3 节课）
let frontBeforeMergeOk = true;
const aRows = sheetMap['子表A'].sort((a, b) => a.orderInSheet - b.orderInSheet);
const firstMergeInA = aRows.find(r => isMergeRow(r)); // 子表A 行序中第一门合班课（对齐日期已定）
const firstMergeDateA = firstMergeInA ? sheetDateOf(firstMergeInA) : null;
const frontNormals = aRows.filter(r => !isMergeRow(r) && firstMergeInA && r.orderInSheet < firstMergeInA.orderInSheet);
for (const r of frontNormals) {
  const d = sheetDateOf(r);
  if (!d || (firstMergeDateA && d >= firstMergeDateA)) {
    frontBeforeMergeOk = false;
    console.log(`    ❌ ${r.courseName} ${d} 应在第一个合班课日期 ${firstMergeDateA} 之前`);
  }
}
check(frontBeforeMergeOk, `子表A 前 ${frontNormals.length} 节单独课均在第一个合班课日期 ${firstMergeDateA} 之前（本月初至合班课前一天）`);

console.log('\n=== 4. 子表A 单独课程避开合班课日期 ===');
const mergedDates = new Set(
  result.courses.filter(c => mergedNames.includes(c.name)).map(c => c.date)
);
const mergedConflict = result.courses.some(c => {
  if (!mergedNames.includes(c.name)) {
    // 若该课任一组成班级与合班课同班且同天 → 冲突（时间表层面不应出现，硬约束会兜底）
    return mergedDates.has(c.date) && splitClassTypes(c.classType).some(cls =>
      mergedNames.some(mn => {
        const mc = result.courses.find(x => x.name === mn);
        return mc && splitClassTypes(mc.classType).includes(cls);
      })
    );
  }
  return false;
});
check(!mergedConflict, '子表A 单独课程未占用合班课日期（班级冲突自动规避）');

console.log('\n=== 5. 硬约束检查 ===');
const errors = checkHardConstraints(result.courses, availabilityData);
if (errors.length === 0) {
  check(true, '所有硬约束通过（师资不重叠 / 班级不重叠 / 同师同班同日仅一节）');
} else {
  check(false, `硬约束违反 ${errors.length} 项`);
  errors.forEach(e => console.log(`    ${e}`));
}

console.log(`\n=== 结果 ===`);
console.log(`排课完成率: ${result.successCount}/${courseSystemData.length}`);
console.log(`通过 ${pass} 项 / 失败 ${fail} 项`);
if (fail > 0) {
  console.log('❌ 测试未通过');
  process.exit(1);
} else {
  console.log('✅ 全部通过！');
}

// ===== 硬约束检查（与 test-e2e.mjs 一致）=====
function checkHardConstraints(courses, availabilityData) {
  const errors = [];
  // 1. 师资+班级+日期 唯一性
  const teacherClassDateMap = {};
  for (const c of courses) {
    for (const eachClass of splitClassTypes(c.classType)) {
      const key = `${c.teacher}|${eachClass}|${c.date}`;
      if (teacherClassDateMap[key]) {
        errors.push(`[硬约束1违反] 同师同班同天排多节: ${key} ${teacherClassDateMap[key].name} / ${c.name}`);
      } else {
        teacherClassDateMap[key] = c;
      }
    }
  }
  // 2. 师资时间不重叠
  const teacherDateMap = {};
  for (const c of courses) {
    const key = `${c.teacher}|${c.date}`;
    if (!teacherDateMap[key]) teacherDateMap[key] = [];
    teacherDateMap[key].push(c);
  }
  for (const [key, list] of Object.entries(teacherDateMap)) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (timeToMinutes(a.endTime) > timeToMinutes(b.startTime)) {
        errors.push(`[硬约束2违反] 师资时间重叠: ${key} ${a.name}(${a.startTime}-${a.endTime}) / ${b.name}(${b.startTime}-${b.endTime})`);
      }
    }
  }
  // 3. 班级时间不重叠（合班课按单班展开）
  const classDateMap = {};
  for (const c of courses) {
    for (const eachClass of splitClassTypes(c.classType)) {
      const key = `${eachClass}|${c.date}`;
      if (!classDateMap[key]) classDateMap[key] = [];
      classDateMap[key].push(c);
    }
  }
  for (const [key, list] of Object.entries(classDateMap)) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (timeToMinutes(a.endTime) + CLASS_MIN_GAP > timeToMinutes(b.startTime)) {
        errors.push(`[硬约束3违反] 班级时间间隔不足: ${key} ${a.name}(${a.startTime}-${a.endTime}) / ${b.name}(${b.startTime}-${b.endTime})`);
      }
    }
  }
  return errors;
}
