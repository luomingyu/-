// 合班课排课形态分流（v5.83）
// 依据子表内课程静态行序（orderInSheet）判定排课形态：
//   - 无合班课                    → 'none'          普通子表，原有约束不变
//   - 普通课只在首个合班课之前      → 'pre-merge'     先分后合侧（尾段预留/cutAfter/latestDate）
//   - 普通课只在最后一个合班课之后  → 'post-merge'    先合后分侧（头段预留/cutBefore/日期下界）
//   - 首合班课之前与末合班课之后都有普通课 → 'mixed'   混合形态：不做排课处理，报告与上传页报错
import { hasMultipleClasses } from './classType.js';

/** 是否为合班课：合并备注含「合班」或班型含多个班级（与 index.js/dispersion.js 同规则） */
export function isMergeCourse(item) {
  return Boolean(
    (item && item.mergeNote && String(item.mergeNote).includes('合班')) ||
      hasMultipleClasses(item && item.classType)
  );
}

/** 子表分组 key（全项目统一）：优先 sheetName，回退 sheet-{sheetIndex} */
export function sheetKeyOf(item) {
  return (item && item.sheetName) || `sheet-${(item && item.sheetIndex) ?? 0}`;
}

/**
 * 形态判定：按行序（orderInSheet）找首/末合班课，统计两侧普通课数量。
 * @param {Array} list 课程体系表解析后的课程列表（含 sheetName/sheetIndex/orderInSheet）
 * @returns {{ forms: Array, mixedSheets: Array }}
 *   forms: [{ sheetKey, sheetName, sheetIndex, form, mergeCount, preCount, postCount }]（每个子表一条）
 *   mixedSheets: 仅混合形态子表 [{ sheetKey, sheetName, sheetIndex, mergeCount, preCount, postCount, reason }]
 */
export function analyzeSheetForms(list) {
  const groups = new Map();
  (list || []).forEach(item => {
    const key = sheetKeyOf(item);
    if (!groups.has(key)) {
      groups.set(key, { sheetName: item.sheetName, sheetIndex: item.sheetIndex ?? 0, items: [] });
    }
    groups.get(key).items.push(item);
  });

  const forms = [];
  const mixedSheets = [];
  for (const [sheetKey, group] of groups) {
    // 按行序排列（orderInSheet 缺省时保持原插入顺序稳定）
    const sorted = group.items.slice().sort((a, b) => (a.orderInSheet ?? 0) - (b.orderInSheet ?? 0));
    let firstMerge = -1;
    let lastMerge = -1;
    sorted.forEach((item, idx) => {
      if (isMergeCourse(item)) {
        if (firstMerge === -1) firstMerge = idx;
        lastMerge = idx;
      }
    });

    const mergeCount = lastMerge === -1 ? 0 : lastMerge - firstMerge + 1;
    let form = 'none';
    // v5.83 修复：preCount/postCount 需在 forms.push 所在作用域声明（此前在 if 块内声明，
    // 块外简写引用时抛 ReferenceError: preCount is not defined）
    let preCount = 0;
    let postCount = 0;
    if (mergeCount > 0) {
      for (let i = 0; i < firstMerge; i++) if (!isMergeCourse(sorted[i])) preCount++;
      for (let i = lastMerge + 1; i < sorted.length; i++) if (!isMergeCourse(sorted[i])) postCount++;
      if (preCount > 0 && postCount > 0) {
        form = 'mixed';
        mixedSheets.push({
          sheetKey,
          sheetName: group.sheetName,
          sheetIndex: group.sheetIndex,
          mergeCount,
          preCount,
          postCount,
          reason: `子表「${group.sheetName}」既有合班课之前的普通课（${preCount} 节）又有合班课之后的普通课（${postCount} 节），先分后合与先合后分同时存在`,
        });
      } else if (preCount > 0) {
        form = 'pre-merge';
      } else {
        // 普通课只在合班课之后（含全合班课子表）→ 先合后分侧
        form = 'post-merge';
      }
    }

    forms.push({
      sheetKey,
      sheetName: group.sheetName,
      sheetIndex: group.sheetIndex,
      form,
      mergeCount,
      preCount,
      postCount,
    });
  }
  return { forms, mixedSheets };
}

/** 便捷查询：substrate key → form 映射 */
export function buildFormMap(forms) {
  const map = new Map();
  (forms || []).forEach(f => map.set(f.sheetKey, f.form));
  return map;
}