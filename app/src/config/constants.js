// 全局常量与魔数集中管理

export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
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

// ============ 科目师资表与师资排课科目优先级（v5.25） ============
// 排课时师资优先级：先按科目（英语 > 政治 > 数学），科目内再按难易程度降序排课。
// 未在表中的师资按「未收录科目」处理，排在所有已收录科目之后。
export const SUBJECT_TEACHERS = {
  英语: ['李旭', '唐静', '连俊霞', '刘琦', '周兆鑫'],
  政治: ['石磊', '火星姐姐', '孔昱力', '刘贤'],
  数学: ['王喆', '李良', '窦峥', '方浩']
};

/** 科目排课优先级顺序（数组下标即优先级，越小越优先） */
export const SUBJECT_PRIORITY = ['英语', '政治', '数学'];

/** 返回师资所属科目；不在科目表中的返回 null（未收录科目） */
export function getSubjectOfTeacher(teacher) {
  for (const subject of SUBJECT_PRIORITY) {
    if (SUBJECT_TEACHERS[subject].includes(teacher)) return subject;
  }
  return null;
}

/** 师资科目优先级序号：英语0 < 政治1 < 数学2 < 未收录科目3（数字越小越优先） */
export function getSubjectPriority(teacher) {
  const subject = getSubjectOfTeacher(teacher);
  return subject === null ? SUBJECT_PRIORITY.length : SUBJECT_PRIORITY.indexOf(subject);
}
