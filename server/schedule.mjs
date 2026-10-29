// ============================================================
// 服务端排课：封装前后端共用的排课管线（方案 B）
// ------------------------------------------------------------
// 服务器不依赖 DOM，直接复用 app/src/scheduler 的纯函数链
//（runSchedulePipeline），保证同一份业务数据在服务器执行与
// 前端本地兜底执行的排课结果一致。
// 职责：
//   1. runServerSchedule   —— 处理 POST /api/schedule 请求
//   2. needsScheduleUpgrade —— 启动自检：判断数据版本是否落后
//   3. upgradeStoredData   —— 启动自检：按当前版本自动重排并返回新数据
// ============================================================
import { runSchedulePipeline } from '../app/src/scheduler/pipeline.js';
import { APP_VERSION } from '../app/src/config/constants.js';

export { APP_VERSION };

/**
 * 判断已持久化的业务数据是否需要自动升级
 *（排课报告版本落后于当前应用版本，且存在课程体系数据）
 * @param {Object|null} data 服务器内存中的业务数据
 * @returns {boolean}
 */
export function needsScheduleUpgrade(data) {
  if (!data) return false;
  if (!Array.isArray(data.courseSystemFiles) || data.courseSystemFiles.length === 0) return false;
  const reports = data.scheduleReports;
  if (!Array.isArray(reports) || reports.length === 0) return false;
  // 报告版本号已统一为应用版本 APP_VERSION：与当前代码不一致（含旧数据无该字段）即自动重排刷新报告
  return reports[0].appVersion !== APP_VERSION;
}

/**
 * 服务端执行排课（POST /api/schedule 处理函数）
 * @param {Object}   input
 * @param {Array}    input.availabilityFiles 师资空闲表（按文件分组）
 * @param {Array}    input.courseSystemFiles 课程体系表（按文件分组）
 * @param {Array}    [input.presetFiles] 已排课表（v5.85，按文件分组），可缺省
 * @param {string|Date} [input.currentDate] Date ISO 字符串或 Date 对象
 * @param {boolean} [input.abbreviateClass] 排课报告是否将班级缩写为批量简称（v6.0.8，默认 true）
 * @returns {Object} 与 runSchedulePipeline 相同结构的完整结果
 */
export function runServerSchedule({ availabilityFiles, courseSystemFiles, presetFiles, currentDate, abbreviateClass = true } = {}) {
  const date = typeof currentDate === 'string' ? new Date(currentDate) : currentDate;
  const result = runSchedulePipeline({
    availabilityFiles,
    courseSystemFiles,
    presetFiles,
    currentDate: date,
    abbreviateClass
  });
  if (result.ok) logScheduleSummary(result);
  return result;
}

/**
 * 启动自检自动升级：按当前应用版本重新排课，返回可直接落库的新数据。
 * 无需升级时返回 null。
 * @param {Object} data 服务器内存中的业务数据
 * @returns {Object|null} { availabilityFiles, courseSystemFiles, courses, scheduleReports }
 */
export function upgradeStoredData(data) {
  if (!needsScheduleUpgrade(data)) return null;
  const result = runServerSchedule({
    availabilityFiles: data.availabilityFiles || [],
    courseSystemFiles: data.courseSystemFiles || [],
    presetFiles: data.presetFiles || [],
    currentDate: new Date()
  });
  if (!result.ok) {
    console.warn(`[自检] 自动升级排课失败: ${result.error}`);
    return null;
  }
  return {
    availabilityFiles: data.availabilityFiles || [],
    courseSystemFiles: result.courseSystemFiles,
    presetFiles: data.presetFiles || [],
    courses: result.courses,
    scheduleReports: result.scheduleReports
  };
}

function logScheduleSummary(result) {
  const diag = result.diagnostics;
  console.log(`[排课] 服务器执行完成：成功 ${result.successCount} 门，失败 ${result.failedCount} 门 (版本 ${APP_VERSION})`);
  if (diag) {
    if (diag.sheetStats && diag.sheetStats.length > 0) {
      console.log('[排课] 子表统计:');
      diag.sheetStats.forEach(s => {
        console.log(`  ${s.sheetName}: ${s.scheduled}/${s.totalCourses} 成功 (对齐 ${s.aligned}, 失败 ${s.failed})`);
      });
    }
    if (diag.teacherStats && diag.teacherStats.length > 0) {
      console.log('[排课] 师资排课情况:');
      diag.teacherStats.forEach(s => {
        console.log(`  ${s.teacher}: ${s.scheduled}/${s.totalCourses} 成功`);
      });
    }
  }
}