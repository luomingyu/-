// 班级识别与归类（v5.93）：课程体系表每个子表第一列（A 列）识别为班级名，
// 并按模糊规则归类到 36 个标准班级白名单；归类后的标准班级名贯穿排课、
// 师资-班级空闲时间表、UI 班级筛选与报告全链路。
//
// 归类规则（2026-09-03 与业务确认）：
//   1. 精确匹配：trim/去空白/全角转半角后与标准名完全相等
//   2. 特征匹配：仅对带期数系列（全程/智学/OMO），提取「年份(27) + 系列 + 期数(N期)」，
//      组合 `${年份}${系列}${期数}期` 唯一在白名单内 → 归类（如 "27全程第2期" → "27全程2期"）
//   3. 包含匹配：原始值包含标准名，或标准名包含原始值（去冗余前后缀），
//      候选集合内取「最长优先」（被更长候选包含者剔除），剩唯一才归类
//      （如 "27早鸟暑期强基班" → "27早鸟暑期强基"；"27早鸟班" → "27早鸟"）
//   4. 别名映射：业务确认的营销班名精确映射到标准班（如 "28早鸟腾飞班" → "28早鸟1期"、
//      "28早鸟" → "28早鸟1期"、"27全程智达培优班" → "27全程1期"），key 为 normalizeForCompare 后的规范化串
//   4.5 线上班规则：去掉 "线上" 后重新走 1)~4) 归类，"27线上早鸟1期" → "27早鸟1期"、
//      "28线上标准" → "28标准"；OMO 班型（如 "27线上OMO1期"）与 27名师
//      （业务确认不在线上映射范围）排除不入此映射，整体未识别
//   4.6 线上所有班展开："27线上所有班" → 27 所有班（除 OMO 班型与 27名师）共 17 个
//      标准班合班；"28线上所有班" → 28 所有班（除 OMO 班型与 28标准）共 8 个标准班合班
//      （v5.84 随 28全程2期 加入由 7 增至 8；v5.86 业务确认 28标准 属线下基础班剔除回 7；
//       v5.93 随 27新大纲 / 28全程3期 加入分别为 16 → 17、7 → 8）；
//      在 classifyClassType 整行级处理（与期数区间展开同级，业务实际数据即此批量写法）
//   4.7 OMO 所有班展开（v5.85）："27OMO所有班" → 27 所有 OMO 班型 5 个标准班（27OMO1~5期）合班；
//      "28OMO所有班" → 28 所有 OMO 班型 4 个标准班（28OMO1~4期，v5.93 由 3 增至 4）合班；同样在 classifyClassType 整行级处理
//   5. 命中 0 个或多个候选（歧义，如 "27全程" 无法区分期数）→ 未归类，
//      由调用方「警告保留原值」继续排课
import { splitClassTypes } from './classType.js';

/** 36 个标准班级白名单（2026-09-03 业务更新：27 考研 23 班 + 28 考研 13 班；v5.84 新增 28全程2期、28OMO3期；v5.93 新增 27新大纲、28全程3期、28OMO4期） */
export const STANDARD_CLASSES = [
  '27早鸟', '27早鸟暑期', '27早鸟暑期强基',
  '27全程1期', '27全程2期', '27全程3期', '27全程4期',
  '27全程寒假抢跑', '27全程寒假特训', '27全程培优',
  '27智学1期', '27智学2期', '27智学3期',
  '27暑期抢跑', '27暑期超越', '27百日', '27新大纲', '27名师',
  '27OMO1期', '27OMO2期', '27OMO3期', '27OMO4期', '27OMO5期',
  '28早鸟1期', '28早鸟2期', '28早鸟3期', '28早鸟4期', '28早鸟5期',
  '28全程1期', '28全程2期', '28全程3期', '28标准',
  '28OMO1期', '28OMO2期', '28OMO3期', '28OMO4期'
];

// 业务别名映射（2026-09-03 业务确认）：
// 营销/宣传班名 → 标准班级名；key 为 normalizeForCompare 后的规范化串
const CLASS_ALIASES = {
  '28早鸟': '28早鸟1期', // 28 早鸟无期数写法 = 28早鸟1期（28 早鸟带 1~5 期，缺省取 1 期）
  '28早鸟腾飞班': '28早鸟1期',
  '27全程智达培优班': '27全程1期',
  '27omo': '27OMO1期' // 27OMO 无期数写法 = 27OMO1期
};

// 业务确认不在线上班映射范围内的班型（v5.80）：27名师 属于线下营销班，不纳入 "27线上X" 映射
const ONLINE_EXCLUDE = new Set(['27名师']);

// 线上所有班批量写法排除的标准班（v5.86，2026-09-11 业务确认）：28标准 属线下基础班，
// 不在 "28线上所有班" 范围（28 由 8 个减至 7 个）；27名师 属线下营销班（v5.80 确认）同样排除
const ONLINE_ALL_EXCLUDE = new Set(['27名师', '28标准']);

// 带期数的班级系列（特征匹配与区间展开用；系列名互不包含，唯一命中才归类）。
// 注意：27 早鸟无期数（27早鸟/27早鸟暑期/27早鸟暑期强基），28 早鸟带 1~5 期，
// 特征匹配组合 `27早鸟N期` 不在白名单时自然落入包含匹配（如 "27早鸟1期" → "27早鸟"）
const PERIOD_SERIES = ['早鸟', '全程', '智学', 'OMO'];

// 中文数字 → 阿拉伯数字（期数用）
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 规范化比较串：去全部空白（含全角空格）、全角数字/字母转半角、统一小写 */
function normalizeForCompare(text) {
  return String(text)
    .replace(/\s+/g, '')
    .replace(/[\uff10-\uff19]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\uff21-\uff3a]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\uff41-\uff5a]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

/** 提取考研年份（27/28），无则 null */
function parseYear(text) {
  const m = String(text).match(/(2[78])/);
  return m ? m[1] : null;
}

/** 提取带期数系列（全程/智学/OMO）：唯一命中返回系列名，命中多个或零个返回 null */
function parseSeries(text) {
  const hits = PERIOD_SERIES.filter(s => normalizeForCompare(text).includes(s.toLowerCase()));
  return hits.length === 1 ? hits[0] : null;
}

/** 提取期数（如 "1期"/"一期"/"第2期"），归一为阿拉伯数字，无则 null */
function parsePeriod(text) {
  const m = String(text).match(/第?\s*([0-9]+|[一二三四五六七八九十]+)\s*期/);
  if (!m) return null;
  const num = /^\d+$/.test(m[1]) ? Number(m[1]) : CN_NUM[m[1]];
  return Number.isInteger(num) ? String(num) : null;
}

/**
 * 提取期数区间（如 "1-4期"、"一至四期"、"2~3期"），归一为 { start, end } 阿拉伯数字；
 * 无区间语法返回 null
 */
function parsePeriodRange(text) {
  const m = String(text).match(
    /第?\s*([0-9]+|[一二三四五六七八九十]+)\s*(?:-|–|~|至|到)\s*([0-9]+|[一二三四五六七八九十]+)\s*期/
  );
  if (!m) return null;
  const toNum = s => (/^\d+$/.test(s) ? Number(s) : CN_NUM[s]);
  const start = toNum(m[1]);
  const end = toNum(m[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  return { start, end };
}

/**
 * 区间班级展开（如 "27全程1-4期" → 27全程1期,2期,3期,4期 四个标准班）：
 * 年份 + 带期数系列 + 期数区间均有效，且展开出的每个标准班都在白名单内 → 返回标准班名数组；
 * 任一环节无效返回 null（含 start >= end 的退化区间）
 */
function expandClassRange(raw) {
  const range = parsePeriodRange(raw);
  if (!range || range.start >= range.end) return null;
  const year = parseYear(raw);
  const series = parseSeries(raw);
  if (!year || !series) return null;
  const names = [];
  for (let p = range.start; p <= range.end; p++) {
    const name = `${year}${series}${p}期`;
    if (!STANDARD_CLASSES.includes(name)) return null;
    names.push(name);
  }
  return names;
}

/**
 * 线上所有班批量写法展开（如 "27线上所有班" → 27 所有班（除 OMO 班型与 27名师）共 17 个
 * 标准班合班，"28线上所有班" → 28 所有班（除 OMO 班型与 28标准）共 8 个标准班合班，v5.93）：
 * 班级清单从 STANDARD_CLASSES 动态筛出（年份匹配、剔除 OMO 班型与 ONLINE_ALL_EXCLUDE，
 * 业务确认 27名师/28标准 属线下班级不在线上范围）。
 * 若筛选结果非空返回标准班名数组，否则返回 null
 */
function expandOnlineAll(raw) {
  const m = normalizeForCompare(raw).match(/^(2[78])线上所有班$/);
  if (!m) return null;
  const year = m[1];
  const names = STANDARD_CLASSES.filter(
    s => s.startsWith(year) && !s.includes('OMO') && !ONLINE_ALL_EXCLUDE.has(s)
  );
  return names.length ? names : null;
}

/**
 * OMO 所有班批量写法展开（"27OMO所有班" → 27 所有 OMO 班型（27OMO1~5期）5 个标准班合班，
 * "28OMO所有班" → 28 所有 OMO 班型（28OMO1~4期）4 个标准班合班，v5.93）：
 * 班级清单从 STANDARD_CLASSES 动态筛出（年份匹配、班名含 OMO），
 * 随白名单增减自动生效，无需维护班级个数。若筛出非空返回标准班名数组，否则返回 null
 */
function expandOmoAll(raw) {
  const m = normalizeForCompare(raw).match(/^(2[78])omo(?:所有|全部)班$/);
  if (!m) return null;
  const year = m[1];
  const names = STANDARD_CLASSES.filter(s => s.startsWith(year) && s.includes('OMO'));
  return names.length ? names : null;
}

/**
 * 单个班级名归类到标准班级
 * @param {string} raw 原始班级名（如 "27早鸟班"、"27全程2期"）
 * @returns {{ matched: boolean, className: string|null, raw: string }}
 *   matched=true 时 className 为标准班级名；matched=false 时 className=null（保留原值）
 */
export function classifyClassName(raw) {
  if (raw == null) return { matched: false, className: null, raw: '' };
  const origin = String(raw).trim();
  if (!origin) return { matched: false, className: null, raw: origin };

  // 1) 精确匹配
  const exact = STANDARD_CLASSES.find(s => normalizeForCompare(s) === normalizeForCompare(origin));
  if (exact) return { matched: true, className: exact, raw: origin };

  // 2) 业务别名映射（营销班名 → 标准班，如 "28早鸟腾飞班" → "28早鸟1期"）
  const aliased = CLASS_ALIASES[normalizeForCompare(origin)];
  if (aliased) return { matched: true, className: aliased, raw: origin };

  // 2.5) 线上班规则：业务确认「27线上所有班 → 27 所有班除去 OMO 班型」（28 同），
  // 且 27名师 不在映射范围（业务确认）。"27线上早鸟1期" → "27早鸟1期"、"28线上标准" → "28标准"；
  // OMO 班型（如 "27线上OMO1期"）与 27名师 → 整体未识别，保留原值
  if (origin.includes('线上')) {
    if (parseSeries(origin) === 'OMO') {
      return { matched: false, className: null, raw: origin };
    }
    const stripped = origin.replace(/线上/g, '');
    if (stripped !== origin) {
      const online = classifyClassName(stripped);
      if (online.matched && !ONLINE_EXCLUDE.has(online.className)) {
        return { matched: true, className: online.className, raw: origin };
      }
      // 去掉 "线上" 后仍无法唯一归类，或命中排除班型 → 整体未识别（防止残留 "线上" 干扰后续包含匹配）
      return { matched: false, className: null, raw: origin };
    }
  }

  // 3) 特征匹配：年份 + 带期数系列 + 期数 组合唯一在白名单内
  //（区间写法如 "27全程1-4期" 不在此匹配——parsePeriod 会误取区间尾号 "4期"，
  //   由 classifyClassType 的 expandClassRange 整体展开为多个标准班）
  const year = parseYear(origin);
  const series = parseSeries(origin);
  const period = parsePeriodRange(origin) ? null : parsePeriod(origin);
  if (year && series && period) {
    const combo = `${year}${series}${period}期`;
    if (STANDARD_CLASSES.includes(combo)) {
      // v5.85 整体性检查：origin 去除 年份/系列/期数 后不得有残余描述词，
      // 防非期数系列词（如 "培优"）随系列被吞（"27全程培优1期" 系列命中 "全程"、
      //   combo = 27全程1期 在白名单 → 会误归 "27全程1期"；应落入包含匹配归 "27全程培优" 更贴近业务）
      const residue = normalizeForCompare(origin)
        .replace(year, '')
        .replace(series.toLowerCase(), '')
        .replace(/第?[0-9一二三四五六七八九十]+期/, '');
      if (residue === '') {
        return { matched: true, className: combo, raw: origin };
      }
    }
  }

  // 4) 包含匹配：互含候选集合内取最长优先（被更长候选包含者剔除），剩唯一才归类
  const norm = normalizeForCompare(origin);
  const candidates = STANDARD_CLASSES.filter(s => {
    const ns = normalizeForCompare(s);
    return ns.includes(norm) || norm.includes(ns);
  });
  const longest = candidates.filter(
    c => !candidates.some(o => o !== c && normalizeForCompare(o).includes(normalizeForCompare(c)))
  );
  if (longest.length === 1) {
    return { matched: true, className: longest[0], raw: origin };
  }

  // 5) 无法唯一归类（0 或多个候选）
  return { matched: false, className: null, raw: origin };
}

/**
 * 整行班型值归类（支持合班课逗号拆分与期数区间展开，如 "27全程1-4期"
 * 展开为 27全程1期,2期,3期,4期 四个标准班合班）：所有组成班级均归类成功
 * → 用标准名逗号重组；任一班级未归类（含区间语法但展开失败）→ 整行保留原值返回 null
 * @param {string} classType 班型列原始值（如 "27全程1期,27早鸟" 或 "27全程1-4期"）
 * @returns {string|null} 归类后的标准班型串，未全部归类时返回 null
 */
export function classifyClassType(classType) {
  const classes = splitClassTypes(classType);
  if (classes.length === 0) return null;
  const expanded = [];
  for (const raw of classes) {
    // ① 期数区间写法优先展开（"27全程1-4期" → 4 个标准班）
    const rangeNames = expandClassRange(raw);
    if (rangeNames) {
      expanded.push(...rangeNames);
      continue;
    }
    // ①.5 线上所有班批量写法（"27线上所有班" → 17 个标准班合班；"28线上所有班" → 8 个，
    // v5.86 剔除 28标准；v5.93 随 27新大纲 / 28全程3期 加入）
    const allOnline = expandOnlineAll(raw);
    if (allOnline) {
      expanded.push(...allOnline);
      continue;
    }
    // ①.6 OMO 所有班批量写法（"27OMO所有班" → 5 个 OMO 班型；"28OMO所有班" → 4 个，v5.93）
    const allOmo = expandOmoAll(raw);
    if (allOmo) {
      expanded.push(...allOmo);
      continue;
    }
    // ② 含区间语法但展开失败（区间越界/退化/系列缺失）→ 整行未归类
    if (parsePeriodRange(raw)) return null;
    // ③ 单班归类
    const single = classifyClassName(raw);
    if (!single.matched) return null;
    expanded.push(single.className);
  }
  return expanded.join(',');
}