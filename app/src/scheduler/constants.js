// 排课算法相关常量

/** 同班级课程最小间隔（分钟） */
export const CLASS_MIN_GAP = 5;
/**
 * 师资-班级空闲时间表「多扣除」缓冲 X（分钟）——可临时设定，缺省 5。
 * 作用于除「师资占用」外的全部扣减情形（师资占用改用独立的 Y，见下）：
 *   ① 占用型（班级占用 / 尾段预留 / 头段预留）：
 *      扣除已排课程时段时，开头与结尾各多扣 X 分钟；
 *   ② 截断型（合班课之后截断 cutAfter / 合班课之前截断 cutBefore）：
 *      切割时刻相对合班课开始 / 结束时间各偏移 X 分钟。
 * 运行期可调用 setAvailRemovePad(X) 临时调整（影响其后所有空闲时间表生成）。
 */
export let AVAIL_REMOVE_PAD = 5;

/** 临时设定「多扣除」缓冲 X（分钟）；非数字或负数时忽略，保持原值 */
export function setAvailRemovePad(x) {
  const n = Number(x);
  if (Number.isFinite(n) && n >= 0) AVAIL_REMOVE_PAD = n;
}

/**
 * 师资占用「多扣除」缓冲 Y（分钟）——独立于 X，可临时设定，缺省 30。
 * 仅作用于「师资占用」维度：该师资自身此前已排课程（不限班级），
 * 扣除其时段时开头与结尾各多扣 Y 分钟。
 * 其余 5 类扣减（班级占用 / 头段预留 / 尾段预留 / cutAfter / cutBefore）仍用 X。
 * 当同一门已排课程同时命中「师资占用」与「班级占用」时，两段占用区间在
 * buildTeacherClassAvailability 内合并取并集，等效于取 max(X, Y)。
 * 运行期可调用 setAvailRemovePadTeacher(Y) 临时调整。
 *
 * 同时作为「同一师资课程最小间隔」——v6.0.6 起师资间隔全局统一取 Y（缺省 30 分钟）：
 *   阶段一正常排课、第三阶段兜底放宽、模拟枚举（enumerateFeasibleSlots）、
 *   整表重放校验（verifySimulatedPlan）均以 Y 作为同一师资课程之间的最小间隔；
 *   此前独立的常量 MIN_GAP=10 已删除。
 */
export let AVAIL_REMOVE_PAD_TEACHER = 30;

/** 临时设定「师资占用多扣除」缓冲 Y（分钟）；非数字或负数时忽略，保持原值 */
export function setAvailRemovePadTeacher(y) {
  const n = Number(y);
  if (Number.isFinite(n) && n >= 0) AVAIL_REMOVE_PAD_TEACHER = n;
}
