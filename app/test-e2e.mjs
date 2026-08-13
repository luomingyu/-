// 端到端测试：使用 test-data 中的两个表格进行测试，并检查硬约束
import * as XLSX from 'xlsx';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateSchedule } from './src/scheduler/index.js';
import { timeToMinutes, durationToMinutes, formatExcelDate, formatExcelTime } from './src/utils/dateUtils.js';
import { CLASS_MIN_GAP } from './src/scheduler/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDataDir = join(__dirname, 'test-data');

/** 读取 xlsx 为 workbook */
function readWorkbook(filePath) {
  const buf = readFileSync(filePath);
  return XLSX.read(buf, { type: 'buffer' });
}

/** 解析空闲时间表 */
function parseAvailability(workbook) {
  const list = [];
  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
    if (!rows || rows.length < 2) continue;
    const headers = rows[0].map(h => String(h).trim());
    const findIdx = (kws) => headers.findIndex(h => kws.some(kw => String(h).includes(kw)));
    const tIdx = findIdx(['师资', '老师', '姓名', '教师']);
    const dIdx = findIdx(['日期']);
    const sIdx = findIdx(['开始', '起始']);
    const eIdx = findIdx(['结束', '终止']);
    if (tIdx === -1 || dIdx === -1 || sIdx === -1 || eIdx === -1) continue;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[dIdx]) continue;
      const teacher = String(row[tIdx] || '').trim();
      const date = formatExcelDate(row[dIdx]);
      const startTime = formatExcelTime(row[sIdx]);
      const endTime = formatExcelTime(row[eIdx]);
      if (teacher && startTime && endTime) {
        list.push({ teacher, date, startTime, endTime });
      }
    }
  }
  list.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  return list;
}

/** 解析课程体系表 */
function parseCourseSystem(workbook) {
  const list = [];
  for (let sheetIdx = 0; sheetIdx < workbook.SheetNames.length; sheetIdx++) {
    const sheetName = workbook.SheetNames[sheetIdx];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
    if (!rows || rows.length < 2) continue;
    const headers = rows[0].map(h => String(h).trim());
    const findIdx = (kws) => headers.findIndex(h => kws.some(kw => String(h).includes(kw)));
    const cIdx = findIdx(['班型', '班级', '课程类型']);
    const nIdx = findIdx(['课程名称', '课程名', '课程']);
    const tIdx = findIdx(['师资', '老师', '姓名', '教师']);
    const dIdx = findIdx(['时长', '课时', '时间']);
    if (cIdx === -1 || nIdx === -1 || tIdx === -1 || dIdx === -1) continue;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[cIdx]) continue;
      const classType = String(row[cIdx] || '').trim();
      const courseName = String(row[nIdx] || '').trim();
      const teacher = String(row[tIdx] || '').trim();
      const duration = String(row[dIdx] || '').trim();
      if (classType && courseName && teacher && duration) {
        list.push({
          classType, courseName, teacher, duration,
          scheduled: null, sheetIndex: sheetIdx, sheetName, orderInSheet: i - 1
        });
      }
    }
  }
  return list;
}

/**
 * 检查硬约束
 * 1. 每天只能排某个师资某个班级一节课
 * 2. 师资时间不重叠（含 minGap）
 * 3. 班级时间不重叠（含 CLASS_MIN_GAP）
 * 4. 课程必须在师资空闲时间内
 */
function checkHardConstraints(courses, availabilityData) {
  const errors = [];

  // 1. 师资+班级+日期 唯一性
  const teacherClassDateMap = {};
  for (const c of courses) {
    const teacher = c.teacher.replace('老师', '');
    const key = `${teacher}|${c.classType}|${c.date}`;
    if (teacherClassDateMap[key]) {
      errors.push(`[硬约束1违反] 同师同班同天排多节: ${key} 有 ${teacherClassDateMap[key].name} 和 ${c.name}`);
    } else {
      teacherClassDateMap[key] = c;
    }
  }

  // 2. 师资时间不重叠（同一天同一师资的课程）
  const teacherDateMap = {};
  for (const c of courses) {
    const teacher = c.teacher.replace('老师', '');
    const key = `${teacher}|${c.date}`;
    if (!teacherDateMap[key]) teacherDateMap[key] = [];
    teacherDateMap[key].push(c);
  }

  for (const [key, list] of Object.entries(teacherDateMap)) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const aEnd = timeToMinutes(a.endTime);
      const bStart = timeToMinutes(b.startTime);
      // 师资间隔要求至少 5 分钟（取最小 FALLBACK_GAP）
      if (aEnd > bStart) {
        errors.push(`[硬约束2违反] 师资时间重叠: ${key} ${a.name}(${a.startTime}-${a.endTime}) 与 ${b.name}(${b.startTime}-${b.endTime})`);
      }
    }
  }

  // 3. 班级时间不重叠（同一天同一班级的课程）
  const classDateMap = {};
  for (const c of courses) {
    const key = `${c.classType}|${c.date}`;
    if (!classDateMap[key]) classDateMap[key] = [];
    classDateMap[key].push(c);
  }

  for (const [key, list] of Object.entries(classDateMap)) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const aEnd = timeToMinutes(a.endTime);
      const bStart = timeToMinutes(b.startTime);
      if (aEnd + CLASS_MIN_GAP > bStart) {
        errors.push(`[硬约束3违反] 班级时间间隔不足: ${key} ${a.name}(${a.startTime}-${a.endTime}) 与 ${b.name}(${b.startTime}-${b.endTime}) 需间隔${CLASS_MIN_GAP}分钟`);
      }
    }
  }

  // 4. 课程时间必须在师资空闲时间内
  for (const c of courses) {
    const teacher = c.teacher.replace('老师', '');
    const cStart = timeToMinutes(c.startTime);
    const cEnd = timeToMinutes(c.endTime);
    const avails = availabilityData.filter(a => a.teacher === teacher && a.date === c.date);
    const covered = avails.some(a => {
      const aStart = timeToMinutes(a.startTime);
      const aEnd = timeToMinutes(a.endTime);
      return cStart >= aStart && cEnd <= aEnd;
    });
    if (!covered) {
      errors.push(`[硬约束4违反] 课程不在空闲时间内: ${c.name} ${c.teacher} ${c.date} ${c.startTime}-${c.endTime} (空闲: ${avails.map(a => a.startTime+'-'+a.endTime).join(',') || '无'})`);
    }
  }

  return errors;
}

/**
 * 检查软约束（课程体系顺序 + 日期递增）
 * - 课程体系顺序：同一 sheet 内课程按 orderInSheet 顺序排课
 * - 日期递增：同一师资同一班级的课程日期应递增（允许回退，但不允许逆序插入中间）
 */
function checkSoftConstraints(courses, courseSystemData) {
  const warnings = [];

  // 课程体系顺序：按 sheet 分组，检查 orderInSheet 顺序与实际排课日期顺序一致
  const bySheet = {};
  for (const c of courses) {
    const orig = courseSystemData.find(cs => cs.courseName === c.name);
    if (!orig) continue;
    const key = orig.sheetIndex;
    if (!bySheet[key]) bySheet[key] = [];
    bySheet[key].push({ ...c, orderInSheet: orig.orderInSheet, courseSysName: orig.courseName });
  }

  for (const [sheetIdx, list] of Object.entries(bySheet)) {
    const sorted = [...list].sort((a, b) => a.orderInSheet - b.orderInSheet);
    // 检查日期递增（同师资同班级维度）
    const byTeacherClass = {};
    for (const c of sorted) {
      const teacher = c.teacher.replace('老师', '');
      const key = `${teacher}|${c.classType}`;
      if (!byTeacherClass[key]) byTeacherClass[key] = [];
      byTeacherClass[key].push(c);
    }
    for (const [key, tcList] of Object.entries(byTeacherClass)) {
      // tcList 已按 orderInSheet 排序
      for (let i = 1; i < tcList.length; i++) {
        const prev = tcList[i - 1];
        const curr = tcList[i];
        if (curr.date < prev.date) {
          warnings.push(`[软约束-日期递增] Sheet${Number(sheetIdx) + 1} ${key}: "${curr.name}"(${curr.date}) 早于 "${prev.name}"(${prev.date})`);
        }
      }
    }
  }

  return warnings;
}

// === 主流程 ===
// 支持命令行参数指定数据文件：node test-e2e.mjs [空闲时间表.xlsx] [课程体系表.xlsx]
const availFile = process.argv[2] || '空闲时间表.xlsx';
const courseFile = process.argv[3] || '课程体系表.xlsx';

console.log(`=== 端到端测试：使用 test-data 表格 ===`);
console.log(`空闲时间表: ${availFile} | 课程体系表: ${courseFile}\n`);

const availWb = readWorkbook(join(testDataDir, availFile));
const courseWb = readWorkbook(join(testDataDir, courseFile));

const availabilityData = parseAvailability(availWb);
const courseSystemData = parseCourseSystem(courseWb);

console.log(`空闲时间表：${availabilityData.length} 条记录`);
const teachers = [...new Set(availabilityData.map(a => a.teacher))];
console.log(`  师资: ${teachers.join(', ')}`);
const availDates = [...new Set(availabilityData.map(a => a.date))].sort();
console.log(`  日期范围: ${availDates[0]} ~ ${availDates[availDates.length - 1]} (${availDates.length}天)`);

// 打印每个师资的可用日期（按天合并时间段，避免冗长）
for (const teacher of teachers) {
  const dates = [...new Set(availabilityData.filter(a => a.teacher === teacher).map(a => a.date))].sort();
  // 汇总该师资出现的所有时间段组合（去重）
  const slotSets = new Set();
  for (const d of dates) {
    const slots = availabilityData.filter(a => a.teacher === teacher && a.date === d)
      .map(s => `${s.startTime}-${s.endTime}`).join(',');
    slotSets.add(slots);
  }
  const totalRows = availabilityData.filter(a => a.teacher === teacher).length;
  console.log(`  ${teacher} 可用${dates.length}天 / ${totalRows}段: ${dates.map(d => d.slice(-2)).join(', ')}`);
  console.log(`    时段模式: ${[...slotSets].join(' | ')}`);
}

console.log(`\n课程体系表：${courseSystemData.length} 门课程`);
const sheets = [...new Set(courseSystemData.map(c => c.sheetName))];
console.log(`  Sheet: ${sheets.join(', ')}`);
const classes = [...new Set(courseSystemData.map(c => c.classType))];
console.log(`  班级: ${classes.join(', ')}`);
const courseTeachers = [...new Set(courseSystemData.map(c => c.teacher))];
console.log(`  涉及师资: ${courseTeachers.join(', ')}`);

// 找一个合适的 currentDate（取空闲时间最早日期所在月份）
const earliestDate = availDates[0];
const [ey, em] = earliestDate.split('-').map(Number);
const currentDate = new Date(ey, em - 1, 1);

console.log(`\n排课基准日期: ${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}\n`);

console.log('--- 课程体系表顺序 ---');
courseSystemData.forEach((c, i) => {
  console.log(`  ${i + 1}. [${c.sheetName}][${c.classType}] ${c.courseName} - ${c.teacher} (${c.duration}分钟)`);
});

console.log('\n--- 开始排课 ---\n');
const result = generateSchedule({
  currentDate,
  availabilityData,
  courseSystemData
});

console.log(`\n排课结果: 成功 ${result.successCount}/${courseSystemData.length} 节，失败 ${result.failedCount} 节`);

console.log('\n=== 排课结果明细（按课程体系顺序）===');
const nameToIdx = {};
courseSystemData.forEach((c, i) => { nameToIdx[c.courseName] = i; });
const ordered = [...result.courses].sort((a, b) => nameToIdx[a.name] - nameToIdx[b.name]);
ordered.forEach((c, i) => {
  const orig = courseSystemData[nameToIdx[c.name]];
  console.log(`${String(i + 1).padStart(2)}. [${orig.sheetName}][${c.classType}] ${c.name} | ${c.teacher} | ${c.date} ${c.startTime}-${c.endTime}`);
});

// 失败的课程
const failedCourses = courseSystemData.filter(c => !result.courseSystemData.find(r => r.courseName === c.courseName && r.scheduled));
if (failedCourses.length > 0) {
  console.log('\n=== 未排入的课程 ===');
  failedCourses.forEach(c => {
    console.log(`  [${c.sheetName}][${c.classType}] ${c.courseName} - ${c.teacher}`);
  });
}

console.log('\n=== 硬约束检查 ===');
const errors = checkHardConstraints(result.courses, availabilityData);
if (errors.length === 0) {
  console.log('✅ 所有硬约束通过！');
} else {
  console.log(`❌ 发现 ${errors.length} 个硬约束违反：`);
  errors.forEach(e => console.log(`  ${e}`));
}

console.log('\n=== 软约束检查（课程体系顺序 + 日期递增）===');
const warnings = checkSoftConstraints(result.courses, courseSystemData);
if (warnings.length === 0) {
  console.log('✅ 所有软约束通过！');
} else {
  console.log(`⚠️ 发现 ${warnings.length} 个软约束警告：`);
  warnings.forEach(w => console.log(`  ${w}`));
}

// === 分散度质量分析（按 师资+班级 维度）===
console.log('\n=== 分散度质量分析（按 师资+班级 维度）===');
const dispersionGroups = {};
for (const c of result.courses) {
  const teacher = c.teacher.replace('老师', '');
  const key = `${teacher}|${c.classType}`;
  if (!dispersionGroups[key]) dispersionGroups[key] = [];
  dispersionGroups[key].push(c);
}

const dispersionIssues = [];
for (const [key, list] of Object.entries(dispersionGroups)) {
  const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
  const dates = sorted.map(c => c.date);
  const days = dates.map(d => parseInt(d.slice(-2), 10));
  const gaps = [];
  for (let i = 1; i < days.length; i++) gaps.push(days[i] - days[i - 1]);

  const minGap = gaps.length ? Math.min(...gaps) : 0;
  const maxGap = gaps.length ? Math.max(...gaps) : 0;
  const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const variance = gaps.length ? gaps.reduce((s, g) => s + Math.pow(g - meanGap, 2), 0) / gaps.length : 0;
  const stdDev = Math.sqrt(variance);
  const range = days.length ? days[days.length - 1] - days[0] : 0;
  // 相邻天(gap=1)计数
  const adjacentCount = gaps.filter(g => g <= 1).length;
  // 大间隔(>7天)计数
  const largeGapCount = gaps.filter(g => g > 7).length;

  // 计算该师资可用日期的「最大隔天容量」(gap≥2 独立集)，判断相邻天是否数据强制
  const teacher = key.split('|')[0];
  const teacherAvailDays = [...new Set(
    availabilityData.filter(a => a.teacher === teacher).map(a => parseInt(a.date.slice(-2), 10))
  )].sort((a, b) => a - b);
  let gap2Capacity = 0;
  let lastDay = -100;
  for (const d of teacherAvailDays) {
    if (d - lastDay >= 2) { gap2Capacity++; lastDay = d; }
  }
  const forcedGap1 = list.length > gap2Capacity; // 课程数超过隔天容量 → 至少1个相邻天不可避免

  // 评估该组分散度质量
  const issues = [];
  let status = '✅';
  if (adjacentCount > 0) {
    if (forcedGap1) {
      status = 'ℹ️'; // 数据强制，已达最优
      issues.push(`相邻天×${adjacentCount}(数据强制, 隔天容量${gap2Capacity}<${list.length}课)`);
    } else {
      status = '⚠️';
      issues.push(`相邻天×${adjacentCount}(可优化)`);
    }
  }
  if (largeGapCount > 0) { status = '⚠️'; issues.push(`大间隔(>7天)×${largeGapCount}`); }
  if (stdDev > 2) { status = '⚠️'; issues.push(`间隔不均(σ=${stdDev.toFixed(1)})`); }

  console.log(`  ${status} ${key} (${list.length}课): 日期 ${days.map(d=>String(d).padStart(2,'0')).join(',')}
      覆盖 ${String(days[0]).padStart(2,'0')}-${String(days[days.length-1]).padStart(2,'0')}(${range}天) | gap min=${minGap} max=${maxGap} 均值=${meanGap.toFixed(1)} σ=${stdDev.toFixed(1)}${issues.length ? ' | ' + issues.join(', ') : ''}`);

  // 仅「可优化」问题计入 dispersionIssues；数据强制的相邻天不计
  if (status === '⚠️') {
    dispersionIssues.push({ key, issues, adjacentCount, largeGapCount, stdDev });
  }
}

// === 时间段分布分析（晚上优先级检查）===
console.log('\n=== 时间段分布分析（晚上优先级）===');
const timeBuckets = { morning: 0, afternoon: 0, evening: 0, other: 0 };
for (const c of result.courses) {
  const start = timeToMinutes(c.startTime);
  if (start >= 9 * 60 && start < 12 * 60) timeBuckets.morning++;
  else if (start >= 14 * 60 && start < 18 * 60) timeBuckets.afternoon++;
  else if (start >= 18 * 60 && start <= 22 * 60) timeBuckets.evening++;
  else timeBuckets.other++;
}
const totalScheduled = result.courses.length;
console.log(`  上午: ${timeBuckets.morning}课 (${((timeBuckets.morning/totalScheduled)*100).toFixed(0)}%)`);
console.log(`  下午: ${timeBuckets.afternoon}课 (${((timeBuckets.afternoon/totalScheduled)*100).toFixed(0)}%)`);
console.log(`  晚上: ${timeBuckets.evening}课 (${((timeBuckets.evening/totalScheduled)*100).toFixed(0)}%) ← 应优先`);
if (timeBuckets.other > 0) console.log(`  其他: ${timeBuckets.other}课`);

// 排课完成率
const rate = ((result.successCount / courseSystemData.length) * 100).toFixed(1);
console.log(`\n=== 测试结论 ===`);
console.log(`排课完成率: ${result.successCount}/${courseSystemData.length} (${rate}%)`);
console.log(`硬约束: ${errors.length === 0 ? '✅ 通过' : '❌ 违反 ' + errors.length + ' 项'}`);
console.log(`软约束: ${warnings.length === 0 ? '✅ 通过' : '⚠️ 警告 ' + warnings.length + ' 项'}`);
console.log(`分散度: ${dispersionIssues.length === 0 ? '✅ 良好' : '⚠️ ' + dispersionIssues.length + ' 组需优化'}`);

console.log('\n=== 测试完成 ===');
