// 合班课识别 + 子表排课形态分流（v6.1）
// ------------------------------------------------------------
// 合班课定义（v6.1）：**只有不同子表中某个课节的全部信息一致，才算合班课**。
//   比较字段（6 个）：班型 classType / 课程名称 courseName / 师资名称 teacher /
//                     时长 duration / 起始日期 startDate / 终止日期 endDate。
//   6 字段去空白后全部相等（空值与空值视为一致）且分处 **≥2 个不同子表** → 该课节为合班课。
//   同一子表内出现多次相同课节不计入（必须跨子表）。
//   旧的单行判定（班型含逗号 / 备注含「合班」）已废弃。
//
// 形态分流（依据子表内课程静态行序 orderInSheet，不依赖排课过程）：
//   - 无合班课                    → 'none'          普通子表，原有约束不变
//   - 普通课只在首个合班课之前      → 'pre-merge'     先分后合侧（尾段预留/cutAfter/latestDate）
//   - 普通课只在最后一个合班课之后  → 'post-merge'    先合后分侧（头段预留/cutBefore/日期下界）
//   - 首合班课之前与末合班课之后都有普通课 → 'mixed'   混合形态：不做排课处理，报告与上传页报错

/** 合班课比较字段（6 字段，v6.1）：空/未定义统一归一为 ''，去首尾空白后比较 */
function normField(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * 合班课判定键（v6.1，全项目统一）：
 * 班型 ▸ 课程名称 ▸ 师资名称 ▸ 时长 ▸ 起始日期 ▸ 终止日期（以 \u0001 连接，避免字段内分隔符碰撞）。
 * 该键既用于「跨子表合班课识别」，也用于排课侧 mergedScheduleMap 的跨子表同名合班课日期对齐。
 * @param {Object} item 课程体系表课程行
 * @returns {string} 6 字段拼接键
 */
export function mergeKeyOf(item) {
  if (!item) return '';
  return [
    normField(item.classType),
    normField(item.courseName),
    normField(item.teacher),
    normField(item.duration),
    normField(item.startDate),
    normField(item.endDate)
  ].join('\u0001');
}

/** 子表分组 key（全项目统一）：优先 sheetName，回退 sheet-{sheetIndex} */
export function sheetKeyOf(item) {
  return (item && item.sheetName) || `sheet-${(item && item.sheetIndex) ?? 0}`;
}

/**
 * 是否为合班课（v6.1）：由 buildMergeIndex 预计算并挂在课程行上的标记判定。
 * 标记字段：item.mergeCourseKey（命中跨子表合班时为 6 字段键，否则不存在）。
 * 注意：本函数必须在 buildMergeIndex 之后调用（analyzeSheetForms 内部会先构建索引）。
 */
export function isMergeCourse(item) {
  return Boolean(item && item.mergeCourseKey);
}

/**
 * 构建合班索引（v6.1）：对课程体系表做一次跨子表配对，并在命中行上打标记。
 * 该步骤在「排课之前」执行，用于分辨合班课、标注含合班课的子表。
 * @param {Array} list 课程体系表课程行（含 sheetName/orderInSheet 及 6 个比较字段）
 * @returns {{
 *   mergeKeys: Set<string>,
 *   mergeGroups: Array<{key, classType, courseName, teacher, duration, startDate, endDate,
 *                       sheetKeys: string[], sheets: Array<{sheetKey, orderInSheet}>}>,
 *   sheetMergeInfo: Map<string, {hasMerge: boolean, mergePeers: Set<string>, groupKeys: Set<string>}>
 * }}
 *   mergeGroups：每个跨子表合班组一条（sheetKeys 按课程行在 list 中首次出现顺序 = 默认排课顺序的基准）；
 *   sheetMergeInfo：sheetKey → { 是否含合班课, 共享合班课的其他子表集合, 涉及的合班组键集合 }
 */
export function buildMergeIndex(list) {
  const byKey = new Map();
  (list || []).forEach(item => {
    const key = mergeKeyOf(item);
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  });

  const mergeKeys = new Set();
  const mergeGroups = [];
  const sheetMergeInfo = new Map();

  const touch = sheetKey => {
    if (!sheetMergeInfo.has(sheetKey)) {
      sheetMergeInfo.set(sheetKey, { hasMerge: false, mergePeers: new Set(), groupKeys: new Set() });
    }
    return sheetMergeInfo.get(sheetKey);
  };

  for (const [key, items] of byKey) {
    // 首次出现顺序去重得到涉及子表（= list 中的默认出现顺序）
    const sheetKeys = [];
    const seen = new Set();
    for (const it of items) {
      const sk = sheetKeyOf(it);
      if (!seen.has(sk)) {
        seen.add(sk);
        sheetKeys.push(sk);
      }
    }
    // 必须跨 ≥2 个不同子表才算合班课
    if (sheetKeys.length < 2) continue;

    mergeKeys.add(key);
    // 命中行统一打标记（同一子表内多行命中亦一并标记）
    items.forEach(it => {
      it.mergeCourseKey = key;
    });

    const sample = items[0];
    mergeGroups.push({
      key,
      classType: sample.classType,
      courseName: sample.courseName,
      teacher: sample.teacher,
      duration: sample.duration,
      startDate: sample.startDate,
      endDate: sample.endDate,
      sheetKeys: sheetKeys.slice(),
      sheets: sheetKeys.map(sk => {
        const hit = items.find(it => sheetKeyOf(it) === sk);
        return { sheetKey: sk, orderInSheet: hit ? (hit.orderInSheet ?? 0) : 0 };
      })
    });

    for (const sk of sheetKeys) {
      const info = touch(sk);
      info.hasMerge = true;
      info.groupKeys.add(key);
      for (const other of sheetKeys) {
        if (other !== sk) info.mergePeers.add(other);
      }
    }
  }

  return { mergeKeys, mergeGroups, sheetMergeInfo };
}

/**
 * 形态判定：按行序（orderInSheet）找首/末合班课，统计两侧普通课数量。
 * 内部先构建合班索引（buildMergeIndex）以保证 isMergeCourse 有标记可用。
 * @param {Array} list 课程体系表解析后的课程列表（含 sheetName/sheetIndex/orderInSheet）
 * @returns {{ forms: Array, mixedSheets: Array, mergeIndex: Object }}
 *   forms: [{ sheetKey, sheetName, sheetIndex, form, mergeCount, preCount, postCount }]（每个子表一条）
 *   mixedSheets: 仅混合形态子表 [{ sheetKey, sheetName, sheetIndex, mergeCount, preCount, postCount, reason }]
 *   mergeIndex: buildMergeIndex 结果（跨子表合班组 / 含合班课子表信息）
 */
export function analyzeSheetForms(list) {
  const mergeIndex = buildMergeIndex(list);

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
  return { forms, mixedSheets, mergeIndex };
}

/** 便捷查询：substrate key → form 映射 */
export function buildFormMap(forms) {
  const map = new Map();
  (forms || []).forEach(f => map.set(f.sheetKey, f.form));
  return map;
}
