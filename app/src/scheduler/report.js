// ============================================================
// 排课报告（Markdown）生成器
// ------------------------------------------------------------
// 每次排课成功后生成一份 markdown 文档，包含：
//   一、排课逻辑说明
//   二、师资难易程度评估与排课顺序
//   三、排课结果摘要
//   四、各子表分散排课策略详情与评分（v5.62 起独立成章；此前为「三之（下）」）
//   五、各子表选中方案模拟日历表（v5.62 起独立成章，便于按子表快速定位）
//   六、排课师资次序
//   七、各子表排第一节课时的师资-班级空闲时间表（v5.57）
//   首部另含目录（TOC，v5.62），可快速跳转各章节
// 输入：generateSchedule() 的返回值 result（含 diagnostics.teacherOrder / scheduleTrace.steps / scheduleTrace.firstLessons）
// ============================================================
import { CLASS_MIN_GAP } from './constants.js';
import { applyCutAfter } from './scheduleContext.js';

export const ALGORITHM_VERSION = 'v5.72';

/** 章节中文序号（报告目录/章节自动编号） */
const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八'];

/** 目录锚点（github-slugger 兼容：小写后删除 ASCII/中文全角标点（如「、」），字母数字/CJK/连字符/下划线保留，空格逐个转连字符；与 GitHub / VS Code / Typora 渲染生成的标题 id 一致） */
function mdAnchor(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '').replace(/ /g, '-');
}

/** markdown 表格单元格转义（| 与换行） */
function mdCell(v) {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** 排课逻辑说明（静态文本，与 scheduler/index.js 实现保持一致） */
const LOGIC_SECTIONS = [
  ['师资排课顺序', '先按科目确立大体师资顺序（英语 > 政治 > 数学 > 未收录科目，v5.25 科目师资表）；科目内再按师资难易程度降序确定最终师资排课顺序，难排的师资优先排课（v5.36/v5.37，见第二章）。'],
  ['师资难易程度', '难易程度 = 该师资课程时间总需求 ÷ 空闲时间总量（v5.11）。比值越大排课越困难越优先；无空闲时间的师资（∞）在该科目内最优先排课。'],
  ['子表间排序', '按师资排课顺序排对应子表（v5.37）：先遍历师资（科目 → 科目内难易程度），每位师资的所有子表按课程数量降序排列（数量多的子表先排）；子表归属师资取该子表内课时数最多的师资。示例：师资A 的课程在子表 1/2/3/4 → 按课程数量降序排子表 2,4,1,3，师资B 的课程在子表 5/7 → 子表 5,7，整体排课次序为 子表 2,4,1,3,5,7,6。'],
  ['子表内行序', '严格按行顺序（orderInSheet）排课；同一班级的课程日期严格递增（v5.32 班级维度递增，不同班级互不阻塞）。'],
  ['合班课识别', '班型列有中英文逗号间隔（多个班级，如 "27OMO,28OMO"）或「合班备注」列含"合班"字样即为合班课；合班课按一节课处理，同时满足所有组成班级空闲。'],
  ['合班课与子表顺序', '合班课与所在子表课程体系顺序一起排课（v5.34）：递增约束取「子表内同班上一门课程日期」与「该师资最近一门合班课日期」的较大值，合班课不脱离所在子表行序。'],
  ['合班课对齐', '同名合班课（课程名称 + 师资）先排的子表确定日期，后处理的子表自动对齐该日期，不重复占用新日期。v5.42 起对齐课不再写入排课结果列表，界面中同一门合班课只出现一次；课程体系表中对应行仍标记为已排课（日期与先排子表一致）。后子表中位于该合班课之前的普通课限定在合班课日期前一天之前排课。'],
  ['尾段预留', 'v5.49 首次排含合班课子表时，按「合班课数量 ÷ 子表总课数量 × 130%」计算尾段比例 N（如 3/8 → 48.75%），尾段天数 = 当月天数 × N 取整（如 30 × 48.75% = 14.625 → 15 天）。生成师资-班级空闲时间表时，将该月尾段日期中「合班课其他班级」已排课程时间一并扣除，使子表内普通课避开尾段，为合班课（需多个班级同时空闲）腾出位置。'],
  ['合班课之后截断', 'v5.59 若子表中含有「已排日期」的合班课（日期已由先前排课的子表确定，或本子表排课过程中首次确定），在生成该子表师资-班级空闲时间表时，删除第一个合班课时间段之后的所有空闲时间：切割时刻 = 合班课开始时间 − 5 分钟缓冲（如合班课 8/22 17:00-19:00 → 切割时刻 8/22 16:55，删除 16:55 起的全部碎片，含 8/25 07:00 之后的所有时段），使本子表普通课的候选时间域收缩到第一个合班课开始时间之前，避免普通课占用合班课及其后的日期域。'],
  ['日期预算', 'v5.34.1 合班课优先尽早排入；v5.34.2 按「本课及后续同师资课程所需日期数」做日期预算硬约束，避免分散度偏好拖占后续课程的可用日期。'],
  ['分散方案锚定', 'v5.51 起「模拟排课生成」：以师资-班级空闲时间表为候选时段池，按师资×班级逐门模拟排课（时段可放性 + 师资并发互斥/班级冲突硬约束，已排槽位逐步注册累积为后续课程的占用约束），多种策略各产出一种完整可行的「日期+时段」槽位序列方案，按「分散度评分（v5.64 起 Z 规则：均匀度 + 覆盖范围 + 中段覆盖奖励 + 起始留白 + 终止留白 + 间隔匹配）+ 槽位时间优先级均值（v5.67）」选分数最高者为最终方案。v5.53 起策略扩为 10 个（原 5 个：晚间优先分散、晚间优先分散倒序、分散优先、晚间+时间分、时间分优先；新增 5 个：晚间+周末、日间优先、月初前载、月末后载、晚间/日间交替），v5.54 增 1 个贪心策略（greedy-earliest：日期层从最早可行日期逐日排课 + 槽位层取当日最早空闲时段），v5.55 再增 1 个月中向两边最大分散策略（mid-spread：以每月中间 15/16 日为轴心、在可行跨度上向月初/月末两侧全额铺开，覆盖范围最大化），v5.56 再增 1 个贪心+启发式策略（greedy-heuristic：每步选一天，启发式估计函数按子表数据预估剩余课程的潜在分散评分，权重随跨度疏密/受限课程占比自适应并迭代精炼至该子表最优），共 13 个，由 STRATEGY_META 按 dayWeight（日期层位置分布）+ dayPref（日期偏好）+ slotMode（选槽偏好）三特征组合出差异化方案。排课时将方案中按行序对应的锚点槽位（日期+时段）作为计划槽传入：槽位完整可行时直接锁定（最高优先级，10000 分阈值），槽位被占用/不可行时自动近邻回退评分（锚点日奖励权重×10，±1天→70/±3天→50/±7天→30），避免月底课程被局部递增奖励持续挤压成连排。少课（<4门）沿用 v5.47 区间等分锚点并升级为就近选取「覆盖晚间」的可行时段槽；v5.41 子表整体分散语义保留（合班课与所在子表前面普通课共享同一套锚点序列）。v5.52 起排课报告新增「各子表分散排课策略详情与评分 + 模拟日历表」章节：逐策略展示评分明细（均匀度/覆盖范围/中段覆盖/起始留白/终止留白/间隔匹配）与模拟槽位序列，并对选中方案生成模拟日历表。v5.64 起分散基础分改为「Z 规则」三项核心评分：以排课前最终版师资-课程空闲时间表区间 [X1, X2] 与未定时间课程数 Y 计算理想节奏 Z = round((X2-X1-1-Y)/Y)；三项偏差（起始留白 (W1-X1-1)-Z/2、终止留白 (X2-W2-1)-Z/2、相邻间隔 W3-Z）各按线性衰减 100×max(0, 1−0.1·|D|) 评分（v5.66；v5.64 曾为高斯 100×e^(-0.1·D²)，对远偏差惩罚过陡），偏差 0 分最高、偏差越大分越低；同名替换旧「最小间隔/平衡性/大小间隔惩罚/端距留白」维度（平衡性并入间隔项），保留均匀度/覆盖范围/中段覆盖。'],
  ['兜底补排', '每门课先按师资-班级空闲时间表 + Z 规则分散方案锚点/时段偏好正常排课（间隔统一 MIN_GAP=10 分钟，晚间偏好由时间分数权重承载；v5.10 六级「仅晚上/所有空闲 × 10/5/0 分钟间隔」回退仅第一级实际触发，2-6 级从未生效已移除；v5.65 移除 v5.10 槽位级间隔天数分散度奖励 calculateDispersionBonus——实测选中槽位 100% 为锚点全等锁定且去掉该奖励后胜者 0 次变化，分散语义由 v5.64 Z 规则方案评分唯一承载）；失败后第二阶段用原始空闲时间兜底补排，冲突由 hasConflict 兜底检测。']
];

/**
 * 生成排课报告 markdown
 * @param {Object} meta { year, month, reportAt, algorithmVersion }
 * @param {Object} result generateSchedule() 返回值（含 diagnostics / scheduleTrace）
 * @returns {string} markdown 文本
 */
export function buildScheduleReportMarkdown(meta, result) {
  const steps = result.scheduleTrace?.steps || [];
  const diag = result.diagnostics || {};
  const title = `${meta.year}年${meta.month}月排课报告`;

  // 实际排课师资次序（按排课调度中师资首次出现的先后顺序）+ 各师资排课门数 + 实际次序映射
  const seenTeachers = [];
  const seenSet = new Set();
  const teacherCourseCount = {};
  for (const s of steps) {
    if (!seenSet.has(s.teacher)) {
      seenSet.add(s.teacher);
      seenTeachers.push(s.teacher);
    }
    teacherCourseCount[s.teacher] = (teacherCourseCount[s.teacher] || 0) + 1;
  }
  const actualOrderMap = {};
  seenTeachers.forEach((t, i) => { actualOrderMap[t] = i + 1; });

  const lines = [];

  // ---------- 头部 ----------
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`> 生成时间：${meta.reportAt}　排课算法版本：${meta.algorithmVersion}`);
  lines.push('');
  lines.push(`课程总数：**${result.successCount}**　成功：**${result.successCount}**　失败：**${result.failedCount}**`);
  lines.push('');
  lines.push(`子表排课顺序：${(diag.schedulingOrder || []).join(' → ') || '—'}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ---------- 目录（v5.62） ----------
  const tocChapters = [
    `${CN[1]}、排课逻辑说明`,
    `${CN[2]}、师资难易程度评估与排课顺序`,
    `${CN[3]}、排课结果摘要`,
    `${CN[4]}、各子表分散排课策略详情与评分`,
    `${CN[5]}、各子表选中方案模拟日历表`,
    `${CN[6]}、排课师资次序`,
    `${CN[7]}、各子表排第一节课时的师资-班级空闲时间表`
  ];
  lines.push('## 目录');
  lines.push('');
  for (const t of tocChapters) {
    lines.push(`- [${t}](#${mdAnchor(t)})`);
  }
  lines.push('');
  lines.push('> 点击上方章节链接可快速跳转到对应内容（锚点与 GitHub / VS Code / Typora 渲染的标题 id 一致）。');
  lines.push('');
  lines.push('---');
  lines.push('');

  // ---------- 一、排课逻辑说明 ----------
  lines.push(`## ${CN[1]}、排课逻辑说明`);
  lines.push('');
  lines.push('| 环节 | 说明 |');
  lines.push('|---|---|');
  for (const [name, desc] of LOGIC_SECTIONS) {
    lines.push(`| **${name}** | ${mdCell(desc)} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ---------- 二、师资难易程度评估与排课顺序（v5.36） ----------
  lines.push(`## ${CN[2]}、师资难易程度评估与排课顺序`);
  lines.push('');
  lines.push('> **难易程度** = 该师资课程时间总需求（分钟）÷ 空闲时间总量（分钟）。比值越大 = 排课越困难 = 越优先排课；' +
    '无空闲时间的师资显示为 **∞**（该科目内最优先）。**师资排课顺序**：先按科目确立大体师资顺序，科目内再按难易程度确定最终师资排课顺序。');
  lines.push('');
  lines.push('| 理论次序 | 科目 | 师资 | 课程需求(分钟) | 空闲时间(分钟) | 难易程度 | 实际排课次序 | 排课门数 |');
  lines.push('|--:|:--|:--|--:|--:|:--|:--|--:|');
  const teacherOrder = diag.teacherOrder || [];
  for (const r of teacherOrder) {
    const actual = actualOrderMap[r.teacher];
    const diffText = r.difficulty === Infinity ? '∞' : (r.difficultyPercent == null ? '0%' : `${r.difficultyPercent}%`);
    const actualText = actual ? String(actual) : '—';
    lines.push(`| ${r.order} | ${mdCell(r.subject || '未收录科目')} | ${mdCell(r.teacher)} | ${r.courseMinutes} | ${r.availMinutes} | ${diffText} | ${actualText} | ${teacherCourseCount[r.teacher] || 0} |`);
  }
  lines.push('');
  // 评估结论：实际排课师资次序与理论次序（科目 → 科目内难易程度）的偏离情况
  const mismatched = teacherOrder.filter(r => actualOrderMap[r.teacher] && actualOrderMap[r.teacher] !== r.order);
  if (mismatched.length === 0) {
    lines.push('**评估结论**：实际排课师资次序与理论师资次序（科目 → 科目内难易程度）完全一致，先排的课程均为科目优先级更高、科目内更难排的师资。');
  } else {
    lines.push(`**评估结论**：有 ${mismatched.length} 位师资的实际排课次序偏离理论师资次序（受子表/班级/合班日期约束影响，属预期偏差）：`);
    for (const m of mismatched) {
      lines.push(`- ${mdCell(m.subject || '未收录科目')} · ${mdCell(m.teacher)}：理论第 ${m.order} 位，实际第 ${actualOrderMap[m.teacher]} 位（难易程度 ${m.difficulty === Infinity ? '∞' : m.difficultyPercent + '%'}）`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ---------- 三、排课结果摘要 ----------
  lines.push(`## ${CN[3]}、排课结果摘要`);
  lines.push('');
  lines.push('| 子表 | 课程数 | 成功 | 对齐 | 失败 | 涉及师资 |');
  lines.push('|---|--:|--:|--:|--:|---|');
  for (const s of diag.sheetStats || []) {
    lines.push(`| ${mdCell(s.sheetName)} | ${s.totalCourses} | ${s.scheduled} | ${s.aligned} | ${s.failed} | ${s.teachers.map(mdCell).join('、')} |`);
  }
  lines.push('');

  // 各子表最终排课分散策略：每门课程按行序对应的「最终排课日期」，
  // 取自排课轨迹 steps 的实际时间槽（与「六、逐课排课明细」一致）；
  // 未排入的课程显示 —。失败/对齐课程均含在 steps 中，按 orderInSheet 行序展示
  const finalDispBySheet = new Map();
  for (const s of steps) {
    if (!finalDispBySheet.has(s.sheetName)) finalDispBySheet.set(s.sheetName, []);
    finalDispBySheet.get(s.sheetName).push({ orderInSheet: s.orderInSheet, date: s.slot ? s.slot.date : null });
  }
  if (finalDispBySheet.size > 0) {
    lines.push('**各子表最终排课分散策略（按行序对应各门课程的最终排课日期）：**');
    lines.push('');
    lines.push('| 子表 | 最终排课分散策略 |');
    lines.push('|---|---|');
    for (const s of diag.sheetStats || []) {
      const entries = (finalDispBySheet.get(s.sheetName) || [])
        .slice()
        .sort((a, b) => (a.orderInSheet ?? 0) - (b.orderInSheet ?? 0));
      const dayText = entries.length > 0
        ? entries.map(e => (e.date ? parseInt(String(e.date).slice(-2), 10) : '—')).join('、') + '日'
        : '—';
      lines.push(`| ${mdCell(s.sheetName)} | ${dayText} |`);
    }
    lines.push('');
  }

  // ---------- 四、各子表分散排课策略详情与评分（v5.62 独立成章；此前为「三之（下）」前半） ----------
  // 模拟排课阶段：每个子表的分散锚点按多种策略各执行一次逐门模拟排课，产出多种
  // 完整可行的「日期+时段」槽位方案，按总分（各维度分散评分 + 槽位时间优先级均值）取最高者；
  // 候选方案含各维度评分明细 detail 与模拟槽位序列，随 sheetStats.dispersionPlan 传入。
  const sheetsWithPlan = (diag.sheetStats || [])
    .filter(s => s.dispersionPlan && s.dispersionPlan.candidates && s.dispersionPlan.candidates.length > 0);
  if (sheetsWithPlan.length > 0) {
    // v5.63：课程数展示 —— 含已定日期合班课的子表仅剩余自由课参与模拟选优，附加「模拟 N 门」
    const courseCountLabel = (p, s) => {
      const total = p && p.totalCourses != null ? p.totalCourses : s.totalCourses;
      const sim = p && p.simulatedCourses != null ? p.simulatedCourses : total;
      return sim !== total ? `${total} 门课（模拟 ${sim} 门）` : `${total} 门课`;
    };
    lines.push(`## ${CN[4]}、各子表分散排课策略详情与评分`);
    lines.push('');
    lines.push('> 每行说明：总分 = 分散基础分（均匀度 + 覆盖范围 + 中段覆盖 + 起始留白 + 终止留白 + 间隔匹配）**+ 时间优先级（槽位时间优先级分均值，v5.67）**；v5.64 起按理想节奏 Z = round((X2-X1-1-Y)/Y) 评分（X1/X2 = 排课前最终版师资-课程空闲时间表区间、Y = 未定时间课程数），起始/终止留白理想值各 = Z/2、相邻间隔理想值 = Z，偏差 0 分最高、偏差越大分越低（v5.66 起线性衰减）；**★** 为该子表选中策略。各子表选中方案对应的**模拟日历表**见下一章（五）。');
    lines.push('');

    // （1）选中策略概览
    lines.push('**（1）各子表选中策略概览：**');
    lines.push('');
    lines.push('| 子表 | 课程数 | 选中策略 | 总分 | 分散基础分 | 时间优先级 | 模拟槽位序列 |');
    lines.push('|---|---|:--|--:|--:|--:|---|');
    for (const s of sheetsWithPlan) {
      const p = s.dispersionPlan;
      const selected = p.candidates.find(c => c.strategy === p.selectedStrategy) || p.candidates[0];
      if (!selected) continue;
      lines.push(`| ${mdCell(s.sheetName)} | ${courseCountLabel(p, s)} | **${mdCell(selected.strategy || '—')}** | ${fmtScore(selected.score)} | ${fmtScore(selected.baseScore)} | ${fmtScore(selected.timeScoreAvg)} | ${formatSlots(selected.slots)} |`);
    }
    lines.push('');

    // （2）候选策略评分明细（分子表）
    lines.push('**（2）候选策略评分明细（分子表，按总分降序）：**');
    lines.push('');
    for (const s of sheetsWithPlan) {
      const p = s.dispersionPlan;
      lines.push(`#### ${mdCell(s.sheetName)}（${courseCountLabel(p, s)}）`);
      lines.push('');
      lines.push('| 策略 | 总分 | 分散基础分 | 时间优先级 | 均匀度 | 覆盖范围 | 中段覆盖 | 起始留白 | 终止留白 | 间隔匹配 | 理想节奏Z | 起始留白(天) | 终止留白(天) | 实际最小间隔(天) | 实际最大间隔(天) | 模拟日期/时段 |');
      lines.push('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|');
      for (const c of p.candidates) {
        const d = c.detail || {};
        const star = c.strategy === p.selectedStrategy ? ' ★' : '';
        lines.push(`| ${mdCell((c.strategy || '—') + star)} | ${fmtScore(c.score)} | ${fmtScore(c.baseScore)} | ${fmtScore(c.timeScoreAvg)} | ${fmtScore(d.uniformity)} | ${fmtScore(d.coverage)} | ${fmtScore(d.midCoverageBonus)} | ${fmtScore(d.leadEdge)} | ${fmtScore(d.tailEdge)} | ${fmtScore(d.intervalMatch)} | ${fmtGapDays(d.Z)} | ${fmtGapDays(d.leadGapDays)} | ${fmtGapDays(d.tailGapDays)} | ${fmtGapDays(d.minGapDays)} | ${fmtGapDays(d.maxGapDays)} | ${formatSlots(c.slots, c.dates)} |`);
      }
      // v5.72：阶段三/四说明 —— 对阶段二未达时间优先级满分（19:00 整点 = 315 分）的课程，
      // 在选中日期前后各 2 天按本策略寻更优时间槽作为变体；各课变体（原槽 + 更优槽）
      // 笛卡尔积组合成分支方案（日期严格递增），按总分取最高者为该策略最终方案。
      const s34 = p.candidates.filter(c => (c.stage3 && c.stage3.length > 0) || ((c.stage4 || {}).branches || 0) > 1);
      if (s34.length > 0) {
        lines.push('');
        lines.push(`> **阶段三/阶段四（v5.72）**：仅对未满时间优先级满分槽的候选列出 —— 变体 = 原槽 + 前后 2 天更高分槽；分支数 = 各课变体数乘积（日期须严格递增）。`);
        lines.push('');
        for (const c of s34) {
          const s4 = c.stage4 || {};
          lines.push(`**${mdCell(c.strategy)}${c.strategy === p.selectedStrategy ? ' ★' : ''}**：总分 ${fmtScore(c.score)}，分支 ${s4.branches ?? '—'} 个 / 有效 ${s4.validBranches ?? '—'} 个 / 相对原方案提升 ${fmtScore(s4.bestDelta)}`);
          for (const v of (c.stage3 || [])) {
            const betterText = v.better.map(b => `${b.date.slice(5)} ${b.startTime}-${b.endTime}（${fmtScore(b.timeScore)}）`).join('、');
            lines.push(`- ${mdCell(v.courseName)}：原槽 ${v.base.date.slice(5)} ${v.base.startTime}-${v.base.endTime}（${fmtScore(v.base.timeScore)}）→ ${betterText}`);
          }
        }
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('');

    // ---------- 五、各子表选中方案模拟日历表（v5.62 独立成章；此前为「三之（下）」后半） ----------
    lines.push(`## ${CN[5]}、各子表选中方案模拟日历表`);
    lines.push('');
    lines.push('> 行 = 周（周一开头），列 = 周一~周日；**加粗日期** 为该方案排课日，下方为模拟时段（时段为空表示纯日期锚点，最终排课时按锚点日评分就近回退选取时段）。');
    lines.push('');
    for (const s of sheetsWithPlan) {
      const p = s.dispersionPlan;
      const selected = p.candidates.find(c => c.strategy === p.selectedStrategy) || p.candidates[0];
      if (!selected || !selected.slots || selected.slots.length === 0) continue;
      const slotMap = {};
      for (const sl of selected.slots) {
        if (!sl || !sl.date) continue;
        const mmdd = String(sl.date).slice(5);
        slotMap[mmdd] = sl.startTime ? `${sl.startTime}-${sl.endTime || ''}` : '';
      }
      lines.push(`#### ${mdCell(s.sheetName)} · 选中策略「${mdCell(selected.strategy || '—')}」（总分 ${fmtScore(selected.score)}）`);
      lines.push('');
      lines.push('| 周一 | 周二 | 周三 | 周四 | 周五 | 周六 | 周日 |');
      lines.push('|---|---|---|---|---|---|---|');
      const calRows = buildCalendarRows(meta.year, meta.month, slotMap);
      for (const row of calRows) {
        lines.push(`| ${row.map(cell => cell === null ? ' ' : (cell.slot ? `**${cell.day}**<br>${cell.slot}` : String(cell.day))).join(' | ')} |`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  // ---------- 六、排课师资次序 ----------
  // 实际排课师资次序：按排课调度步骤中师资首次出现的顺序排列
  lines.push(`## ${CN[6]}、排课师资次序`);
  lines.push('');
  lines.push('（按实际排课调度中师资首次出现的先后顺序排列；理论次序见第二章师资难易程度评估）');
  lines.push('');
  lines.push('| 实际次序 | 科目 | 师资 | 难易程度 | 理论次序 | 排课门数 | 首次排课（子表 · 行序 · 课程） |');
  lines.push('|--:|:--|:--|:--|:--|--:|---|');
  seenTeachers.forEach((t, i) => {
    const first = steps.find(s => s.teacher === t);
    const firstLabel = first ? `${first.sheetName} · order ${first.orderInSheet} · ${first.courseName}` : '—';
    const rankInfo = teacherOrder.find(r => r.teacher === t);
    const subject = rankInfo ? (rankInfo.subject || '未收录科目') : (first?.subject || '—');
    const diffText = rankInfo
      ? (rankInfo.difficulty === Infinity ? '∞' : (rankInfo.difficultyPercent == null ? '0%' : `${rankInfo.difficultyPercent}%`))
      : '—';
    const theoryOrder = rankInfo ? rankInfo.order : '—';
    lines.push(`| ${i + 1} | ${mdCell(subject)} | ${mdCell(t)} | ${diffText} | ${theoryOrder} | ${teacherCourseCount[t]} | ${mdCell(firstLabel)} |`);
  });
  lines.push('');
  lines.push('---');
  lines.push('');

  // ---------- 七、各子表排第一节课时的师资-班级空闲时间表（v5.57） ----------
  // 每子表第一门实际排课（非对齐）课程排课瞬间的「师资-班级空闲时间表」快照，
  // 以及该时刻已从空闲表中扣除的来源子表课程（子表整块顺序排课时第一课尚无本子表课程占用，
  // 故所扣时段全部来自此前已排课的子表）
  const firstLessons = result.scheduleTrace?.firstLessons || [];
  if (firstLessons.length > 0) {
    const anyCutAfter = firstLessons.some(fl => !!fl.cutAfter);
    lines.push(`## ${CN[7]}、各子表排第一节课时的师资-班级空闲时间表`);
    lines.push('');
    lines.push(`> 每子表展示**第一门实际排课（非对齐）课程**在排课瞬间的「师资-班级空闲时间表」快照（v5.57）。` +
      `该表 = 该师资当月空闲时间 − **班级已占时段**（该课涉及班级的已排课程，左右各加 ${CLASS_MIN_GAP} 分钟缓冲）− ` +
      `**该师资自身已排时段**（同一时刻师资只能上一门课）。因子表内严格按行序整表顺序排课，排第一课时本子表尚无课程被占用，` +
      `故该表中所减时段全部来自**此前已排课的子表**，具体来源见各子表「已减去来源子表课程」。` +
      (anyCutAfter ? ` **若子表含有「排课前已确定日期」的合班课（日期由先前子表确定），另按「合班课之后截断」（v5.59/v5.68）删除第一个合班课开始时间 − ${CLASS_MIN_GAP} 分钟缓冲之后的所有空闲时间；本子表首次确定合班课日期的子表，排课瞬间合班课尚未确定，快照不截断。**` : ''));
    lines.push('');
    for (const fl of firstLessons) {
      const slotText = fl.slot
        ? `**${fl.slot.date} ${fl.slot.startTime}-${fl.slot.endTime}**`
        : '排课失败（因无师资-课程空闲时间）';
      lines.push(`#### ${mdCell(fl.sheetName)}`);
      lines.push('');
      lines.push(`**第一门实际排课**：「**${mdCell(fl.courseName)}**」（行序 ${fl.orderInSheet}，师资 ${mdCell(fl.teacher)}，班级 ${mdCell(fl.classType)}）→ ${slotText}`);
      lines.push('');
      if (fl.tailReserve) {
        lines.push(`> ⚠ 该子表为含合班课子表（v5.49 尾段预留）：构建本空闲表时将该月后 ${fl.tailReserve.tailCount} 天（${fl.tailReserve.tailFrom.slice(5)} ~ ${fl.tailReserve.tailTo.slice(5)}）中「合班课其他班级」${mdCell((fl.tailReserve.otherClasses || []).join('、'))} 已排课程时间一并扣除，为本次首次安插的合班课腾出尾段位置。`);
        lines.push('');
      }
      if (fl.cutAfter) {
        lines.push(`> ✂ 该子表含有**已排日期合班课**：合班课「${mdCell(fl.cutAfter.courseName)}」（${mdCell(fl.cutAfter.classType)}，${fl.cutAfter.mergeDate} ${fl.cutAfter.mergeStart}）日期已确定（v5.59）。` +
          `构建本空闲表时按「合班课之后截断」删除 **${fl.cutAfter.date} ${fl.cutAfter.startTime}**（该合班课开始时间 − ${CLASS_MIN_GAP} 分钟缓冲）之后的所有空闲时间。`);
        lines.push('');
      }
      // v5.59/v5.68：展示时对快照应用 cutAfter 截断（仅在排课前已确定合班课日期的子表——
      // 日期由先前子表确定——快照才含 cutAfter 并在此截断；本子表首次确定合班课日期的子表
      // 排课瞬间合班课尚未确定，快照无 cutAfter、如实展示未截断的空闲表，与排课瞬间一致）
      const rawAvail = Array.isArray(fl.availability) ? fl.availability : [];
      const displayAvail = rawAvail.length > 0 && fl.cutAfter ? applyCutAfter(rawAvail, fl.cutAfter) : rawAvail;
      const hasAvail = displayAvail.length > 0;
      if (hasAvail) {
        lines.push('**师资-班级空闲时间表快照（已减去上述占用时段，不含本课自身）：**');
        lines.push('');
        lines.push('| # | 日期 | 开始 | 结束 |');
        lines.push('|--:|:--|:--|:--|');
        displayAvail.forEach((a, i) => {
          lines.push(`| ${i + 1} | ${String(a.date).slice(5)} | ${a.startTime} | ${a.endTime} |`);
        });
      } else {
        lines.push('**师资-班级空闲时间表快照：**（空 — 该课排课瞬间无可用空闲时间）');
      }
      lines.push('');
      const excl = fl.excluded || [];
      const exclTotal = excl.reduce((s, e) => s + ((e.courses || []).length), 0);
      if (exclTotal > 0) {
        lines.push(`**已减去来源子表课程（共 ${exclTotal} 门，来自 ${excl.length} 个子表）：**`);
        lines.push('');
        lines.push('| 来源子表 | 扣除课程数 | 明细（行序 · 课程名 · 班级 · 师资 · 日期 时段） |');
        lines.push('|---|--:|---|');
        for (const e of excl) {
          const detail = (e.courses || []).map(c => `${c.orderInSheet} · ${c.courseName} · ${c.classType} · ${c.teacher} · ${String(c.date).slice(5)} ${c.startTime}-${c.endTime}`).join('；');
          lines.push(`| ${mdCell(e.sheetName)} | ${(e.courses || []).length} | ${mdCell(detail)} |`);
        }
      } else {
        // v5.60：excluded 已过滤为「实际参与扣除的来源课程」；为空时可能是本子表
        // 是第一个排课的子表，也可能是此前子表无与该子表同师资/同班级的课程
        const isFirstSheet = fl === firstLessons[0];
        lines.push(isFirstSheet
          ? '**已减去来源子表课程：**（无 — 本子表是第一个排课的子表，空闲表仅含该师资原始空闲时间）'
          : '**已减去来源子表课程：**（无 — 此前已排子表中没有与本子表第一课同师资/同班级的课程，且无尾段预留扣除）');
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/** 评分格式化（v5.52）：null/±Infinity/NaN（空方案取 -Infinity，JSON 后又变 null）→ '—'，否则保留 2 位小数 */
function fmtScore(v) {
  if (v === null || v === undefined || v === Infinity || v === -Infinity || Number.isNaN(v)) return '—';
  return Number(v).toFixed(2);
}

/** 天数字段格式化：null → '—' */
function fmtGapDays(v) {
  if (v === null || v === undefined) return '—';
  return String(v);
}

/** 模拟槽位序列格式化：优先 slots（含时段），slots 缺失时退回 dates；'MM-DD HH:MM-HH:MM' 或仅 'MM-DD' */
function formatSlots(slots, dates) {
  const arr = (slots && slots.length > 0)
    ? slots
    : ((dates || []).map(d => ({ date: d })));
  if (arr.length === 0) return '—';
  return arr.map(s => {
    if (!s || !s.date) return '—';
    const mmdd = String(s.date).slice(5);
    return s.startTime ? `${mmdd} ${s.startTime}-${s.endTime || ''}` : mmdd;
  }).join('、');
}

/**
 * 生成模拟日历周行（周一开头，v5.52）
 * @param {number} year 年
 * @param {number} month 月（1-12）
 * @param {Object} slotMap { 'MM-DD': 'HH:MM-HH:MM' | '' } 有排课日的时段文本（空串 = 纯日期锚点）
 * @returns {Array<Array<{day:number, slot:string}|null>>} 周行；null = 月外空档
 */
function buildCalendarRows(year, month, slotMap) {
  const firstDow = new Date(year, month - 1, 1).getDay(); // 0=周日
  const lead = (firstDow + 6) % 7; // 月首前空档（周一=0）
  const daysInMonth = new Date(year, month, 0).getDate();
  const rows = [];
  let week = [];
  for (let i = 0; i < lead; i++) week.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    week.push({ day: d, slot: Object.prototype.hasOwnProperty.call(slotMap, key) ? (slotMap[key] || '') : '' });
    if (week.length === 7) { rows.push(week); week = []; }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    rows.push(week);
  }
  return rows;
}

/** 生成报告序号与文件名（本地时间） */
export function scheduleReportFileName(reportAt, year, month) {
  const y = reportAt.getFullYear();
  const m = String(reportAt.getMonth() + 1).padStart(2, '0');
  const d = String(reportAt.getDate()).padStart(2, '0');
  const hh = String(reportAt.getHours()).padStart(2, '0');
  const mm = String(reportAt.getMinutes()).padStart(2, '0');
  const ss = String(reportAt.getSeconds()).padStart(2, '0');
  return `排课报告_${year}年${month}月_${y}${m}${d}_${hh}${mm}${ss}.md`;
}