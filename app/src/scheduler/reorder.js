// ============================================================
// 同师资子表重排重试驱动（v6.1）
// ------------------------------------------------------------
// 背景：simulation-first 模式下，某子表在宏观第③步（忽略整日封锁的 13 策略模拟）仍无解时，
// 原实现直接整表报告失败、不再兜底。本驱动在其外层做「同师资子表重排再排课」：
//   ① 先按默认顺序排一次（generateSchedule）；
//   ② 找出「第③步无解」的失败子表（failed > 0 且 planValidation.relaxed === true）；
//   ③ 取其主师资 owner，把该师资名下「参与排课的非混合子表」重排后整表重跑；
//   ④ 若某排列使「该师资名下全部（参与排课的）子表」排课成功，则采用该结果，
//      再继续处理其余失败师资；
//   ⑤ 逐个师资独立重试（已采用的排列累积为后续重试的基线）；某师资排列穷尽仍失败 → 保留其结果并记录。
//
// 说明（v6.1 偏序约束）：
//   - 允许排列 = 组内全部子表的**带偏序约束的线性扩展**（不再是无约束全排列）：
//     凡「同属某个跨子表合班组」的子表，需保持其**默认排课顺序中的相对先后**不变
//     （中间可插入任意其它子表）；无合班约束的子表之间仍可自由换位。
//     理论总数随子表数膨胀，故设上限 MAX_ORDERS_PER_OWNER（默认顺序优先），达上限即停止枚举；
//   - 「全部子表成功」判定排除混合形态（form === 'mixed'）子表（该类子表本就整表跳过、
//     由报告「未处理子表」章节单独说明，不参与重排成功判定）；
//   - 重排记录写入 result.diagnostics.sheetReorder，供排课报告展示尝试排列、次数与是否截断。
// ============================================================
import { generateSchedule } from './index.js';

/** 单师资允许排列枚举上限：防止线性扩展数过大导致重排耗时过长（默认顺序优先） */
const MAX_ORDERS_PER_OWNER = 50;

/**
 * 生成「同师资全部子表」的允许排列（带偏序约束的线性扩展枚举）。
 * 偏序约束：凡同属一个跨子表合班组的子表，保持默认顺序中的相对先后（可插入其它子表）；
 * 无约束子表之间自由排列。超过 limit 时截断（默认顺序优先输出）。
 * @param {Array} groupSheets 同师资子表（默认排课顺序），元素含 { sheetName, form }
 * @param {number} limit 生成排列数上限
 * @param {Array<[string, string]>} [precedence] 偏序约束对 [先, 后]（同组合班对需保持相对顺序）
 * @returns {{ orders: string[][], truncated: boolean }} 允许的子表名排列与是否因达上限被截断
 */
function allowedOrders(groupSheets, limit, precedence = []) {
  const names = groupSheets.map(s => s.sheetName);
  const idxOf = new Map(names.map((n, i) => [n, i]));
  // preds[i] = 必须先于第 i 位出现的子表下标集合（来自合班偏序约束）
  const preds = names.map(() => new Set());
  for (const [before, after] of precedence) {
    const bi = idxOf.get(before);
    const ai = idxOf.get(after);
    if (bi == null || ai == null || bi === ai) continue;
    preds[ai].add(bi);
  }

  const orders = [];
  let truncated = false;
  const used = new Array(names.length).fill(false);
  const acc = [];

  // 有界线性扩展枚举：每步只允许选择「全部前置约束均已选择」的子表，达 limit 即停
  const dfs = () => {
    if (orders.length >= limit) { truncated = true; return; }
    if (acc.length === names.length) { orders.push(acc.slice()); return; }
    for (let i = 0; i < names.length; i++) {
      if (used[i]) continue;
      let ok = true;
      for (const p of preds[i]) { if (!used[p]) { ok = false; break; } }
      if (!ok) continue;
      used[i] = true;
      acc.push(names[i]);
      dfs();
      acc.pop();
      used[i] = false;
      if (orders.length >= limit) { truncated = true; return; }
    }
  };
  dfs();

  // 默认顺序（groupSheets 原顺序）优先：枚举中已覆盖则置顶，未覆盖（被截断）则补入并保持在 limit 内
  const defaultOrder = names.slice();
  const defaultKey = defaultOrder.join('\u0000');
  const di = orders.findIndex(o => o.join('\u0000') === defaultKey);
  if (di > 0) {
    const [d] = orders.splice(di, 1);
    orders.unshift(d);
  } else if (di === -1) {
    orders.unshift(defaultOrder);
    if (orders.length > limit) orders.pop();
  }
  return { orders, truncated };
}

/**
 * 组内合班偏序约束：同一 owner 组内，凡同属某个跨子表合班组的子表，
 * 需保持默认顺序（groupSheets 顺序）中的相对先后。
 * @param {Object} result 排课结果（读 diagnostics.mergeGroups）
 * @param {Array} groupSheets 该 owner 组的子表（默认顺序）
 * @returns {Array<[string, string]>} 相邻约束对 [先, 后]
 */
function mergePrecedence(result, groupSheets) {
  const groups = (result.diagnostics && result.diagnostics.mergeGroups) || [];
  const names = groupSheets.map(s => s.sheetName);
  const pairs = [];
  for (const g of groups) {
    const keys = g.sheetKeys || [];
    const seq = names.filter(n => keys.includes(n)); // 保持 groupSheets（默认顺序）
    for (let i = 0; i + 1 < seq.length; i++) pairs.push([seq[i], seq[i + 1]]);
  }
  return pairs;
}

/** 该师资名下「参与排课」（非混合形态）的子表是否全部成功（failed === 0） */
function ownerSheetsAllOk(result, owner) {
  const stats = result.diagnostics?.sheetStats || [];
  const group = stats.filter(s => s.owner === owner && s.form !== 'mixed');
  if (group.length === 0) return false;
  return group.every(s => s.failed === 0);
}

/** 失败子表清单（供重排记录展示） */
function failedSheets(result) {
  return (result.diagnostics?.sheetStats || [])
    .filter(s => s.failed > 0)
    .map(s => ({ sheetName: s.sheetName, failed: s.failed }));
}

/**
 * 同师资子表重排重试（在 generateSchedule 之上包一层）
 * @param {Object} state generateSchedule 入参
 * @param {Object} [options] 透传给 generateSchedule；`maxReorderOrders` 可覆盖单师资枚举上限
 */
export function generateScheduleWithReorder(state, options = {}) {
  const limit = Number.isFinite(options.maxReorderOrders) && options.maxReorderOrders > 0
    ? Math.floor(options.maxReorderOrders)
    : MAX_ORDERS_PER_OWNER;

  const base = generateSchedule(state, options);
  if (!base.ok) return base;

  const attempts = [];
  const attemptedOwners = new Set(); // 已穷尽允许排列仍失败的 owner
  const appliedOverrides = {}; // 已采用的排列（逐师资累积，作为后续重试的基线）
  let current = base;
  const MAX_ROUNDS = 50; // 安全上限（正常远达不到，仅防异常循环）

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const stats = current.diagnostics?.sheetStats || [];
    // 目标：第③步无解（relaxed）且仍有失败课程的子表，其 owner 尚未被判为无解
    const target = stats.find(s =>
      s.failed > 0 && s.planValidation?.relaxed === true && s.owner && !attemptedOwners.has(s.owner)
    );
    if (!target) break;

    const owner = target.owner;
    const group = stats.filter(s => s.owner === owner && s.form !== 'mixed');
    const defaultOrder = group.map(s => s.sheetName);
    const precedence = mergePrecedence(current, group);
    const { orders, truncated } = allowedOrders(group, limit, precedence);

    let accepted = null;
    for (const order of orders) {
      // 累积已采用的排列，避免后续师资重试覆盖（丢失）先前已采用的顺序
      const attempt = generateSchedule(state, {
        ...options,
        sheetOrderOverride: { ...appliedOverrides, [owner]: order }
      });
      const allOk = ownerSheetsAllOk(attempt, owner);
      attempts.push({
        owner,
        order,
        isDefault: order.join('\u0000') === defaultOrder.join('\u0000'),
        allOk,
        truncated,
        // 本组生效的合班偏序约束数（>0 表示含合班课的子表相对顺序被锁定）
        constrainedPairs: precedence.length,
        failedSheets: failedSheets(attempt)
      });
      if (allOk) { accepted = attempt; appliedOverrides[owner] = order; break; }
    }

    if (accepted) {
      current = accepted; // 采用该排列，继续处理其余失败师资
    } else {
      attemptedOwners.add(owner); // 该师资允许排列穷尽仍失败
    }
  }

  current.diagnostics = current.diagnostics || {};
  current.diagnostics.sheetReorder = {
    // 是否有重排被采用（即最终结果来自某次重排）
    applied: attempts.some(a => a.allOk),
    maxOrders: limit,
    attempts
  };
  return current;
}
