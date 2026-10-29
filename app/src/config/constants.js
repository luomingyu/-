// 全局常量与魔数集中管理

// ============ 应用版本号 ============
// 单一真值：app/package.json 的 version 字段，由 scripts/gen-version.mjs
// 在 dev/build/serve 前生成 version.generated.js（含 APP_VERSION / BUILD_TIME / GIT_SHA）。
// 此处仅做转发，保证「页面徽标」「排课报告头部」「落库报告数据 scheduleReports[].appVersion」
// 「是否需要自动重排」判据、以及 Node 服务器侧全部使用同一份版本号，杜绝漂移。
export { APP_VERSION, BUILD_TIME, GIT_SHA } from './version.generated.js';

// 星期名称：索引与 JS Date.getDay() 对齐（0=周日），用于按 getDay() 取值。
export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
// 日历表头展示顺序：周一在最左、周日最右（不改动 WEEKDAYS 的 getDay() 索引语义）。
export const WEEKDAYS_MON_FIRST = ['一', '二', '三', '四', '五', '六', '日'];
export const MONTHS = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月'
];

// 时间优先级相关魔数（单位：分钟）
// v5.8：晚间优先级区间起点延伸至 16:00（16:00 起即进入晚间高优层，
//       使 16:00-18:00 这类"临傍晚黄金档"课程同样享受晚间高优先级），
//       19:00 仍为最优时间点
export const EVENING_START = 16 * 60;        // 16:00 = 960（晚间优先级区间起点）
export const EVENING_END = 23 * 60;         // 23:00 = 1380（晚间优先级区间终点）
export const OPTIMAL_EVENING = 19 * 60;     // 19:00 = 1140（最优时间点）
export const AFTERNOON_START = 14 * 60;     // 14:00 = 840
export const AFTERNOON_END = 17 * 60;       // 17:00 = 1020
export const MORNING_START = 9 * 60;        // 09:00 = 540
export const MORNING_END = 12 * 60;         // 12:00 = 720

// ============ 科目师资表与师资排课科目优先级（v5.25 / v5.95 新增日语 / v5.96 日语空闲表口径） ============
// 排课时师资优先级：先按科目（英语 > 政治 > 数学 > 408计算机 > 日语），科目内再按难易程度降序排课。
// 未在表中的师资按「未收录科目」处理，排在所有已收录科目之后。
export const SUBJECT_TEACHERS = {
  英语: ['李旭', '唐静', '连俊霞', '刘琦', '周兆鑫'],
  政治: ['石磊', '火星姐姐', '孔昱力', '刘贤'],
  数学: ['王喆', '李良', '窦峥', '方浩'],
  '408计算机': ['乔石磊', '白玉杰', '宋萍萍'],
  日语: ['aki', '洛洛']
};

/** 科目排课优先级顺序（数组下标即优先级，越小越优先） */
export const SUBJECT_PRIORITY = ['英语', '政治', '数学', '408计算机', '日语'];

/**
 * 科目部分互斥表（v5.95）：
 * 日语仅与「日语 / 政治 / 数学」互斥——日语与英语、408计算机可排在同一时间段；
 * 其余科目两两之间仍保持全互斥（沿用原「同班全科目互斥」口径）。
 */
const PARTIAL_EXCLUSION_SUBJECTS = {
  日语: new Set(['日语', '政治', '数学'])
};

/**
 * 判断两门科目在「同一班级同一时间段」是否互斥（v5.95）
 * @param {string|null|undefined} a 科目 A（null/undefined = 未收录/已排课表等未知科目）
 * @param {string|null|undefined} b 科目 B
 * @returns {boolean} true = 互斥；false = 可同时段并存
 */
export function isSubjectConflict(a, b) {
  // 未知科目保守处理：一律按互斥
  if (a == null || b == null) return true;
  const aExclusions = PARTIAL_EXCLUSION_SUBJECTS[a];
  if (aExclusions) return aExclusions.has(b);
  const bExclusions = PARTIAL_EXCLUSION_SUBJECTS[b];
  if (bExclusions) return bExclusions.has(a);
  return true;
}

/**
 * 「师资-班级空闲时间表」的班级占用扣除口径（v5.96）
 *
 * 日语师资：仅扣除同班「政治 / 数学」课节——英语、408计算机、日语（其他师资）等同班课节不扣除；
 * 其余科目：沿用科目互斥矩阵（当前为全科目扣除）。
 * 同师资自身课节不在此判断，由 teacherScheduleByDate 单独扣除。
 * 注意：此处只影响空闲时间表的候选时间扣除，硬冲突仍由 isSubjectConflict 判定。
 *
 * @param {string|null} currentSubject 当前待排师资的科目
 * @param {string|null|undefined} existingSubject 班级已占用课节的科目
 * @returns {boolean} true = 从空闲时间中扣除
 */
export function isAvailabilityClassConflict(currentSubject, existingSubject) {
  if (currentSubject === '日语') {
    return existingSubject === '政治' || existingSubject === '数学';
  }
  return isSubjectConflict(currentSubject, existingSubject);
}

/** 返回师资所属科目；不在科目表中的返回 null（未收录科目） */
export function getSubjectOfTeacher(teacher) {
  for (const subject of SUBJECT_PRIORITY) {
    if (SUBJECT_TEACHERS[subject].includes(teacher)) return subject;
  }
  return null;
}

/**
 * 推断已排课表条目的科目（v5.99）
 * 已排课表本身没有科目列，若不识别科目，subject 只能为 null，
 * 在互斥判定中会被保守视为「全互斥」——例如英语师资的已排课会错误阻挡日语。
 * 识别口径：只按**授课师资名称**归类（与课程体系表使用同一份师资名单）；
 * 师资不在名单中时返回 null（后续仍按全互斥保守处理）。
 *
 * @param {{ teacher?: string }} item 已排课表条目
 * @returns {string|null} 识别出的科目；无法识别返回 null
 */
export function inferPresetSubject(item) {
  if (!item || !item.teacher) return null;
  return getSubjectOfTeacher(item.teacher);
}

/** 师资科目优先级序号：英语0 < 政治1 < 数学2 < 408计算机3 < 日语4 < 未收录科目5（数字越小越优先） */
export function getSubjectPriority(teacher) {
  const subject = getSubjectOfTeacher(teacher);
  return subject === null ? SUBJECT_PRIORITY.length : SUBJECT_PRIORITY.indexOf(subject);
}

// ============ 科目卡片配色类（莫兰迪色系，仅用于日历课程卡片） ============
// 日历课程卡片按「科目」着色，科目由授课师资推断（getSubjectOfTeacher）。
// 未收录科目（师资不在名单中）使用 subject-unknown 中性灰兜底。
export const SUBJECT_CARD_CLASS = {
  英语: 'subject-english',
  政治: 'subject-politics',
  数学: 'subject-math',
  '408计算机': 'subject-cs408',
  日语: 'subject-japanese'
};
export const SUBJECT_CARD_CLASS_UNKNOWN = 'subject-unknown';

/** 由师资推断日历课程卡片使用的科目样式类；无法识别时返回灰色兜底类 */
export function getSubjectCardClass(teacher) {
  return SUBJECT_CARD_CLASS[getSubjectOfTeacher(teacher)] || SUBJECT_CARD_CLASS_UNKNOWN;
}
