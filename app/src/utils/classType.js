// 班级类型工具：支持合班上课（v5.27）
// 课程体系表「班型/班级」列规则：
//   - 无逗号间隔 = 一个班级（如 "27OMO"），普通课
//   - 有逗号间隔（中英文逗号均可）= 多个班级（如 "班A,班B"），即合班课：
//     排课按一节课处理，同时满足所有班级空闲，结果显示复合班型
const CLASS_TYPE_SEPARATOR = /[,，]/;

/** 把班型字符串拆分为班级列表（trim 过滤空值）；单班级返回 [classType] */
export function splitClassTypes(classType) {
  if (classType == null) return [];
  return String(classType)
    .split(CLASS_TYPE_SEPARATOR)
    .map(s => s.trim())
    .filter(Boolean);
}

/** 规范化班型字符串：按中英文逗号拆分、去空白、去空项，统一英文逗号连接（如 "班A,班B"） */
export function normalizeClassType(classType) {
  return splitClassTypes(classType).join(',');
}

/** 是否为合班课（班型列包含多个班级，即有逗号间隔） */
export function hasMultipleClasses(classType) {
  return splitClassTypes(classType).length > 1;
}