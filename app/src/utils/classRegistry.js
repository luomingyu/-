// 班级识别与归类（v6.0.3）：课程体系表每个子表第一列（A 列）识别为班级名，
// 并按模糊规则归类到标准班级白名单；归类后的标准班级名贯穿排课、
// 师资-班级空闲时间表、UI 班级筛选与报告全链路。
//
// v6.0.3 班级清单结构化（2026-10-27 与业务确认）：白名单由「班级清单 CLASS_LIST」派生，
//   每条班级记录含三列——年份(27/28)、类型(线上/OMO/标准班/名师)、上架与否(已上架/未上架)。
//   类型判定规则：含 "OMO" → OMO；含 "标准" → 标准班；含 "名师" → 名师；否则 → 线上。
//   批量简称改为按属性查询（不再靠名字前缀 + 排除集）：
//     "27线上所有班" = 年份 27 + 类型 线上 + 已上架（28 同理）；
//     "27OMO所有班" = 年份 27 + 类型 OMO + 已上架（28 同理）。
//   新增未上架班级 28全程4期、28OMO5期：纳入白名单可被识别归类，但不参与上述简称展开。
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
//      "28线上标准" → "28标准"；OMO 班型（如 "27线上OMO1期"）与 名师 班
//      （类型为「名师」，业务确认不在线上映射范围）排除不入此映射，整体未识别
//   4.6 线上所有班展开（v6.0.3 改为属性查询）："27线上所有班" → 年份 27 + 类型 线上 + 已上架 的全部标准班
//      （早鸟/早鸟暑期/早鸟暑期强基、全程1~4期/寒假抢跑/寒假特训/全程培优、智学1~3期、暑期抢跑/暑期超越、百日/新大纲）共 17 个合班；
//      "28线上所有班" → 28 同上共 8 个（28早鸟1~5期、28全程1~3期；未上架的 28全程4期 与类型为标准班的 28标准 均不计入）合班；
//      在 classifyClassType 整行级处理（与期数区间展开同级，业务实际数据即此批量写法）
//   4.7 OMO 所有班展开（v6.0.3 改为属性查询）："27OMO所有班" → 年份 27 + 类型 OMO + 已上架（27OMO1~5期，5 个）合班；
//      "28OMO所有班" → 28 同上（28OMO1~4期，4 个；未上架的 28OMO5期 不计入）合班；同样在 classifyClassType 整行级处理
//   5. 命中 0 个或多个候选（歧义，如 "27全程" 无法区分期数）→ 未归类，
//      由调用方「警告保留原值」继续排课
//
// v6.0.8 逆向缩写：abbreviateClassType 把「包含某组全部标准班」的已归类班型串
//   缩写回批量简称（"27线上所有班" / "28线上所有班" / "27OMO所有班" / "28OMO所有班"），
//   仅供界面与导出展示（日历/列表/图片/Excel/飞书表格/排课报告），不影响排课口径。
// v6.0.10 期数区间缩写改造为通用规律（abbreviatePeriodRuns，替代逐个硬编码）：
//   同一「年份 + 系列（早鸟/全程/智学/OMO）」的极大连续期数段（长度 ≥ 2）合并为「年份+系列+起-止期」——
//   "28早鸟1~4期" → "28早鸟1-4期"、"28早鸟1~5期" → "28早鸟1-5期"、"28全程1期,28全程2期" → "28全程1-2期"。
//   正向展开沿用既有 expandClassRange，故缩写与展开仍严格互逆。
import { splitClassTypes } from './classType.js';

/**
 * 班级清单（v6.0.3，2026-10-27 业务确认）：白名单的唯一来源，每条记录三列——
 *   name     标准班级名
 *   year     年份：'27' | '28'
 *   type     类型：'线上' | 'OMO' | '标准班' | '名师'（判定：含 OMO→OMO；含 标准→标准班；含 名师→名师；否则 线上）
 *   launched 上架与否：true=已上架 / false=未上架（v6.0.3 新增 28全程4期、28OMO5期 为未上架，其余已上架）
 * 数组顺序即 STANDARD_CLASSES 顺序（27 系列 → 28 系列，未上架班随所属系列归组）。
 */
export const CLASS_LIST = [
  // ===== 27 系列（27 考研 23 班）=====
  { name: '27早鸟', year: '27', type: '线上', launched: true },
  { name: '27早鸟暑期', year: '27', type: '线上', launched: true },
  { name: '27早鸟暑期强基', year: '27', type: '线上', launched: true },
  { name: '27全程1期', year: '27', type: '线上', launched: true },
  { name: '27全程2期', year: '27', type: '线上', launched: true },
  { name: '27全程3期', year: '27', type: '线上', launched: true },
  { name: '27全程4期', year: '27', type: '线上', launched: true },
  { name: '27全程寒假抢跑', year: '27', type: '线上', launched: true },
  { name: '27全程寒假特训', year: '27', type: '线上', launched: true },
  { name: '27全程培优', year: '27', type: '线上', launched: true },
  { name: '27智学1期', year: '27', type: '线上', launched: true },
  { name: '27智学2期', year: '27', type: '线上', launched: true },
  { name: '27智学3期', year: '27', type: '线上', launched: true },
  { name: '27暑期抢跑', year: '27', type: '线上', launched: true },
  { name: '27暑期超越', year: '27', type: '线上', launched: true },
  { name: '27百日', year: '27', type: '线上', launched: true },
  { name: '27新大纲', year: '27', type: '线上', launched: true },
  { name: '27名师', year: '27', type: '名师', launched: true },
  { name: '27OMO1期', year: '27', type: 'OMO', launched: true },
  { name: '27OMO2期', year: '27', type: 'OMO', launched: true },
  { name: '27OMO3期', year: '27', type: 'OMO', launched: true },
  { name: '27OMO4期', year: '27', type: 'OMO', launched: true },
  { name: '27OMO5期', year: '27', type: 'OMO', launched: true },
  // ===== 28 系列（28 考研 15 班）=====
  { name: '28早鸟1期', year: '28', type: '线上', launched: true },
  { name: '28早鸟2期', year: '28', type: '线上', launched: true },
  { name: '28早鸟3期', year: '28', type: '线上', launched: true },
  { name: '28早鸟4期', year: '28', type: '线上', launched: true },
  { name: '28早鸟5期', year: '28', type: '线上', launched: true },
  { name: '28全程1期', year: '28', type: '线上', launched: true },
  { name: '28全程2期', year: '28', type: '线上', launched: true },
  { name: '28全程3期', year: '28', type: '线上', launched: true },
  { name: '28全程4期', year: '28', type: '线上', launched: false }, // v6.0.3 新增：未上架
  { name: '28标准', year: '28', type: '标准班', launched: true },
  { name: '28OMO1期', year: '28', type: 'OMO', launched: true },
  { name: '28OMO2期', year: '28', type: 'OMO', launched: true },
  { name: '28OMO3期', year: '28', type: 'OMO', launched: true },
  { name: '28OMO4期', year: '28', type: 'OMO', launched: true },
  { name: '28OMO5期', year: '28', type: 'OMO', launched: false } // v6.0.3 新增：未上架
];

/** 标准班级白名单（由 CLASS_LIST 派生，保持既有顺序；38 个：27 考研 23 班 + 28 考研 15 班） */
export const STANDARD_CLASSES = CLASS_LIST.map(c => c.name);

// 业务别名映射（2026-09-03 业务确认）：
// 营销/宣传班名 → 标准班级名；key 为 normalizeForCompare 后的规范化串
const CLASS_ALIASES = {
  '28早鸟': '28早鸟1期', // 28 早鸟无期数写法 = 28早鸟1期（28 早鸟带 1~5 期，缺省取 1 期）
  '28早鸟腾飞班': '28早鸟1期',
  '27全程智达培优班': '27全程1期',
  '27omo': '27OMO1期' // 27OMO 无期数写法 = 27OMO1期
};

// 业务确认不在线上班映射范围内的班型（v6.0.3 由类型派生）：类型为「名师」的班（27名师）
// 属线下营销班，不纳入 "27线上X" 单班映射；"线上所有班" 的排除由类型（非线上）自动实现，无需额外集合
const ONLINE_EXCLUDE = new Set(CLASS_LIST.filter(c => c.type === '名师').map(c => c.name));

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
 * 按属性查询标准班级（v6.0.3）：year / type / launched 任一为 undefined 则该维度不限制；
 * 返回命中的标准班名数组（保持 CLASS_LIST 顺序），无命中返回 null
 */
function queryClasses({ year, type, launched }) {
  const names = CLASS_LIST
    .filter(c => (year === undefined || c.year === year) &&
                 (type === undefined || c.type === type) &&
                 (launched === undefined || c.launched === launched))
    .map(c => c.name);
  return names.length ? names : null;
}

/**
 * 线上所有班批量写法展开（v6.0.3 改为按属性查询）："27线上所有班" → 年份 27 + 类型 线上 + 已上架
 * 共 17 个标准班合班（早鸟/早鸟暑期/早鸟暑期强基、全程1~4期/寒假抢跑/寒假特训/全程培优、
 * 智学1~3期、暑期抢跑/暑期超越、百日/新大纲）；"28线上所有班" → 28 同上共 8 个标准班合班
 * （28早鸟1~5期、28全程1~3期；未上架的 28全程4期 与类型为标准班 的 28标准 均不计入）。
 * 无命中返回 null
 */
function expandOnlineAll(raw) {
  const m = normalizeForCompare(raw).match(/^(2[78])线上所有班$/);
  if (!m) return null;
  return queryClasses({ year: m[1], type: '线上', launched: true });
}

/**
 * OMO 所有班批量写法展开（v6.0.3 改为按属性查询）："27OMO所有班" → 年份 27 + 类型 OMO + 已上架
 * （27OMO1~5期，5 个）合班；"28OMO所有班" → 28 同上（28OMO1~4期，4 个；未上架的 28OMO5期 不计入）合班。
 * 随班级清单增减自动生效，无需维护班级个数。无命中返回 null
 */
function expandOmoAll(raw) {
  const m = normalizeForCompare(raw).match(/^(2[78])omo(?:所有|全部)班$/);
  if (!m) return null;
  return queryClasses({ year: m[1], type: 'OMO', launched: true });
}

/**
 * 批量简称分组（v6.0.8 反向缩写用）：仅覆盖「整组所有班」类简称——year / type
 * （口径 = 年份 + 类型 + 已上架），与 expandOnlineAll / expandOmoAll 同源，随班级清单增减自动生效。
 * 顺序即匹配优先级：范围更大的组排在前面（如「28线上所有班」含早鸟 1~5 期与全程 1~3 期），
 * 命中后其成员已并入简称，后续范围更小的组自然不再命中。
 * 期数区间类简称（如 "28早鸟1-4期"）不在此列，由 abbreviatePeriodRuns 按通用规律生成。
 */
const CLASS_GROUPS = [
  { label: '27线上所有班', year: '27', type: '线上' },
  { label: '28线上所有班', year: '28', type: '线上' },
  { label: '27OMO所有班', year: '27', type: 'OMO' },
  { label: '28OMO所有班', year: '28', type: 'OMO' }
];

/**
 * 期数区间通用缩写（v6.0.10）：把展示串里同一「年份 + 带期数系列（早鸟/全程/智学/OMO）」的
 * **极大连续期数段（长度 ≥ 2）** 合并为「年份+系列+起期-止期」简称——
 *   "28早鸟1期,28早鸟2期,28早鸟3期,28早鸟4期" → "28早鸟1-4期"；
 *   含 5 期时 → "28早鸟1-5期"；"28全程1期,28全程2期" → "28全程1-2期"。
 * 与正向展开 expandClassRange 严格互逆；单期或不足连续两期的系列保持原样。
 * 简称插在该段首个成员的原位置，其余班级原样保留、顺序不变。
 * @param {string[]} display 班级名数组（已由属性组替换后的展示串）
 * @returns {{ display: string[], changed: boolean }} 缩写后的数组与是否发生变化
 */
function abbreviatePeriodRuns(display) {
  // 按 (年份, 系列) 归组，只收带期数的标准班写法
  const byGroup = new Map();
  for (const name of display) {
    const year = parseYear(name);
    const series = parseSeries(name);
    const period = parsePeriod(name);
    if (!year || !series || !period) continue;
    const key = `${year}${series}`;
    if (!byGroup.has(key)) byGroup.set(key, { year, series, items: [] });
    byGroup.get(key).items.push({ name, period: Number(period) });
  }

  // 每组内按期数升序找极大连续段，长度 ≥ 2 的段标记简称
  const labelByMember = new Map();
  for (const { year, series, items } of byGroup.values()) {
    const sorted = [...items].sort((a, b) => a.period - b.period);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1].period === sorted[j].period + 1) j++;
      if (j > i) {
        const label = `${year}${series}${sorted[i].period}-${sorted[j].period}期`;
        for (let k = i; k <= j; k++) labelByMember.set(sorted[k].name, label);
      }
      i = j + 1;
    }
  }
  if (labelByMember.size === 0) return { display, changed: false };

  const out = [];
  const emitted = new Set();
  for (const name of display) {
    const label = labelByMember.get(name);
    if (!label) { out.push(name); continue; }
    if (emitted.has(label)) continue; // 同段其余成员已由首个成员位置输出简称
    emitted.add(label);
    out.push(label);
  }
  return { display: out, changed: true };
}

/**
 * 班型串反向缩写（v6.0.8，与 classifyClassType 的展开严格互逆；v6.0.10 增加通用期数区间规则）：
 * 已归类班型串中**包含某组全部标准班**时，把这些标准班替换为该组批量简称
 * （如 27 个线上班全在 → "27线上所有班"）；随后对剩余项按 abbreviatePeriodRuns 规律合并
 * 同系列连续期数（如 28早鸟1~4期全在 → "28早鸟1-4期"）。触发口径为「包含即缩写」，
 * 其余班级原样保留、顺序不变（如 "27线上所有班,27OMO1期"）。可同时命中多组。
 * 未命中任何组时原样返回（不对分隔符做任何规范化）。
 * @param {string} classType 已归类班型串（如 "27早鸟,27早鸟暑期,..."）
 * @returns {string} 缩写后的班型串；入参为空/未命中时返回原值
 */
export function abbreviateClassType(classType) {
  const classes = splitClassTypes(classType);
  if (classes.length === 0) return classType;

  let display = classes;
  let changed = false;
  // 1) 「整组所有班」类简称优先（范围更大），命中后其成员并入简称
  for (const group of CLASS_GROUPS) {
    const members = queryClasses({ year: group.year, type: group.type, launched: true }) || [];
    if (members.length === 0) continue;
    if (!members.every(name => display.includes(name))) continue;
    // 缩写串插到该组首个成员的原位置（先剔除该组全部成员，再按原位置插入）
    const insertAt = display.slice(0, display.findIndex(name => members.includes(name)))
      .filter(name => !members.includes(name)).length;
    const rest = display.filter(name => !members.includes(name));
    rest.splice(insertAt, 0, group.label);
    display = rest;
    changed = true;
  }
  // 2) 期数区间通用缩写：对剩余的同系列连续期数做区间合并
  const runs = abbreviatePeriodRuns(display);
  if (runs.changed) {
    display = runs.display;
    changed = true;
  }
  return changed ? display.join(',') : classType;
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
    // ①.5 线上所有班批量写法（v6.0.3 属性查询：年份 + 类型线上 + 已上架 → "27线上所有班" 17 个、
    // "28线上所有班" 8 个；未上架的 28全程4期 与类型为标准班 的 28标准 不计入）
    const allOnline = expandOnlineAll(raw);
    if (allOnline) {
      expanded.push(...allOnline);
      continue;
    }
    // ①.6 OMO 所有班批量写法（v6.0.3 属性查询：年份 + 类型 OMO + 已上架 → "27OMO所有班" 5 个、"28OMO所有班" 4 个）
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