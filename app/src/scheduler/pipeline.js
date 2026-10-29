// ============================================================
// 排课执行管线：输入「按文件分组的业务数据」，输出排课结果。
// ------------------------------------------------------------
// 纯函数、无 DOM —— 前端（store.runSchedule 本地兜底）与服务器
//（server/schedule.mjs 执行排课）共用同一份逻辑，保证前后端排课结果一致。
// 管线职责：组装算法入参 → generateSchedule → scheduled 状态回写文件
// → 生成排课报告 → 返回可直接落库/落盘的完整业务数据。
// ============================================================
import { generateScheduleWithReorder } from './reorder.js';
import { buildScheduleReportMarkdown, scheduleReportFileName } from './report.js';
import { APP_VERSION } from '../config/constants.js';

/**
 * 执行排课管线
 * @param {Object} input
 * @param {Array}  input.availabilityFiles 师资空闲表（按文件分组，{items:[...]})
 * @param {Array}  input.courseSystemFiles 课程体系表（按文件分组，{items:[...]})
 * @param {Array}  [input.presetFiles] 已排课表（v5.90，按文件分组，{items:[...]})
 *                                      跨科目班级/师资双维度占用约束（师资维度 v5.91），
 *                                      缺省/空数组时零影响
 * @param {Date}   [input.currentDate] 排课月份基准（服务器不传 → 用当前时间，
 *                                      与前端当天打开页面 state.currentDate 一致）
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   courseSystemFiles?: Array,   // scheduled 回写后的课程表（按文件分组）
 *   courseSystemData?: Array,    // 扁平缓存
 *   courses?: Array,             // 排课结果
 *   scheduleReports?: Array,     // [排课报告]
 *   successCount?: number,
 *   failedCount?: number,
 *   diagnostics?: Object,
 *   appVersion?: string
 * }}
 */
export function runSchedulePipeline({ availabilityFiles, courseSystemFiles, presetFiles, currentDate, abbreviateClass = true } = {}) {
  const availabilityData = (availabilityFiles || []).flatMap(f => f.items);
  const flatCourseSystemData = (courseSystemFiles || []).flatMap(f => f.items);
  const flatPresetData = (presetFiles || []).flatMap(f => f.items);

  // v6.0.15：在第③步无解的子表上做「同师资子表重排重试」（generateScheduleWithReorder
  // 内部先按默认顺序排一次，失败再枚举同师资子表排列重排；详见 scheduler/reorder.js）
  const result = generateScheduleWithReorder({
    currentDate: effectiveDate(currentDate),
    availabilityData,
    courseSystemData: flatCourseSystemData,
    presetData: flatPresetData
  });
  if (!result.ok) return { ok: false, error: result.error };

  // scheduled 状态回写到文件条目（itemId 对齐，与前端逻辑一致）
  const scheduledMap = new Map(result.courseSystemData.map(it => [it.itemId, it.scheduled]));
  const nextCourseSystemFiles = (courseSystemFiles || []).map(f => ({
    ...f,
    items: f.items.map(it => ({
      ...it,
      scheduled: scheduledMap.has(it.itemId) ? scheduledMap.get(it.itemId) : it.scheduled
    }))
  }));
  const courseSystemData = nextCourseSystemFiles.flatMap(f => f.items);

  // 生成排课报告：月份取课程体系最早起始日期所在月，与排课槽位月份一致
  const startDates = courseSystemData.map(i => i.startDate).filter(Boolean).sort();
  const scheduleDate = new Date(startDates[0] || effectiveDate(currentDate));
  const year = scheduleDate.getFullYear();
  const month = scheduleDate.getMonth() + 1;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const reportMeta = {
    year,
    month,
    reportAt: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    appVersion: APP_VERSION
  };
  const report = {
    id: `report-${now.getTime()}`,
    year,
    month,
    fileName: scheduleReportFileName(now, year, month),
    content: buildScheduleReportMarkdown(reportMeta, result, { abbreviateClass }),
    generatedAt: now.toISOString(),
    appVersion: APP_VERSION,
    successCount: result.successCount,
    failedCount: result.failedCount,
    // 失败课程按子表汇总（仅含失败数 > 0 的子表），供「最近报告」行展示失败课程所属子表
    failedBySheet: (result.diagnostics?.sheetStats || [])
      .filter(s => s.failed > 0)
      .map(s => ({ sheetName: s.sheetName, failed: s.failed }))
  };
  // 每次排课只保留本次报告（与既有行为一致）
  const scheduleReports = [report];

  return {
    ok: true,
    courseSystemFiles: nextCourseSystemFiles,
    courseSystemData,
    courses: result.courses,
    scheduleReports,
    successCount: result.successCount,
    failedCount: result.failedCount,
    diagnostics: result.diagnostics,
    appVersion: APP_VERSION
  };
}

/**
 * 排课月份基准：优先显式传入的 Date，否则用当前时间
 *（与前端 initialState.currentDate = new Date() 的语义一致）
 */
function effectiveDate(currentDate) {
  return currentDate instanceof Date && !Number.isNaN(currentDate.getTime())
    ? currentDate
    : new Date();
}