// ============================================================
// 排课报告（Markdown）生成器
// ------------------------------------------------------------
// 每次排课成功后生成一份 markdown 文档，包含：
//   一、排课逻辑说明
//   二、科目师资表（v5.94 起独立成章，含 408计算机 / 日语 科目说明）
//   三、师资难易程度评估与排课顺序
//   四、排课结果摘要
//   五、各子表分散排课策略详情与评分（v5.62 起独立成章；此前为「三之（下）」）
//   六、各子表选中方案模拟日历表（v5.62 起独立成章，便于按子表快速定位）
//   七、排课师资次序
//   八、各子表排第一节课时的师资-班级空闲时间表（v5.57）
//   首部另含目录（TOC，v5.62），可快速跳转各章节
// 输入：generateSchedule() 的返回值 result（含 diagnostics.teacherOrder / scheduleTrace.steps / scheduleTrace.firstLessons）
// ============================================================
import { AVAIL_REMOVE_PAD, AVAIL_REMOVE_PAD_TEACHER, CLASS_MIN_GAP } from './constants.js';
import { SUBJECT_TEACHERS, SUBJECT_PRIORITY, inferPresetSubject } from '../config/constants.js';
import { applyCutAfter, applyCutBefore } from './scheduleContext.js';
import { abbreviateClassType } from '../utils/classRegistry.js';

/** 将「当日分钟数」格式化为 HH:MM，用于报告中切割时刻示例随 X（AVAIL_REMOVE_PAD）动态取值 */
function hm(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 章节中文序号（报告目录/章节自动编号） */
const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

/** 扣除维度标签（v5.73：index.js isRelevantExcludedCourse 返回的维度标识 → 中文） */
const EXCL_DIM_LABEL = { teacher: '师资占用', class: '班级占用', tailReserve: '尾段预留', headReserve: '头段预留' };
/** 已排课表（preset）扣除维度标签（v5.99） */
const PRESET_DIM_LABEL = { presetTeacher: '师资占用', presetClass: '班级占用' };

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
  ['师资排课顺序', '先按科目确立大体师资顺序（英语 > 政治 > 数学 > 408计算机 > 日语 > 未收录科目，v5.25 科目师资表，v5.95 新增日语，见第二章）；科目内再按师资难易程度降序确定最终师资排课顺序，难排的师资优先排课（v5.36/v5.37，见第三章）。'],
  ['科目互斥', '同一班级同一时间段默认全科目互斥（v5.95 起支持部分互斥）：日语仅与「日语 / 政治 / 数学」互斥，与英语、408计算机可在同班同一时间段并存；日语课之间（同班）仍互斥。已排课表（v5.99）按**授课师资名称**归类科目后参与同一互斥矩阵（与课程体系表使用同一份师资名单，如英语师资的已排课不阻挡日语）；师资不在名单中时保守按全互斥处理。互斥判定同时作用于班级冲突检测与师资-班级空闲时间表扣除；其中空闲表扣除口径更窄（v5.96）：日语师资仅扣除同班「政治 / 数学」课节及自身课节，同班英语、408计算机、日语（其他师资）均不扣除；已排课表（v5.99）按硬互斥口径扣除，归类为英语/408计算机时不扣除。'],
  ['师资难易程度', '难易程度 = 该师资课程时间总需求 ÷ 空闲时间总量（v5.11）。比值越大排课越困难越优先；无空闲时间的师资（∞）在该科目内最优先排课。'],
  ['子表间排序', '按师资排课顺序排对应子表（v5.37）：先遍历师资（科目 → 科目内难易程度），同一师资的多个子表按「时间密度 L = M / N」升序优先排课（v5.88，替换 v5.37「课程数量降序」）——N = 子表全部课程数，M = 子表中「起始日期」「终止日期」均非空行的「最晚终止日期 − 最早起始日期 + 1 天」（含首尾，如 10-01~10-10 = 10 天），缺任一日期的行跳过、全缺则该子表 L = ∞ 排最后；L 越小（单位课程可用天数越少）越紧张越先排。L 相同按课程数量降序，再相同按子表出现顺序。子表归属师资取该子表内课时数最多的师资。示例：师资A 的课程在子表 1/2/3/4，L 分别为 6.0/3.0/4.5/∞ → 按 L 升序排子表 2,3,1,4；师资B 的课程在子表 5/7 → 子表 5,7，整体排课次序为 子表 2,3,1,4,5,7,6。'],
  ['子表内行序', '严格按行顺序（orderInSheet）排课；同一班级的课程日期严格递增（v5.32 班级维度递增，不同班级互不阻塞）。'],
  ['合班课识别', 'v6.1：**只有分处不同子表的某个课节的全部信息一致，才算合班课**——比较 6 个字段：班型 classType / 课程名称 courseName / 师资名称 teacher / 时长 duration / 起始日期 startDate / 终止日期 endDate；6 字段去空白后全部相等（空值与空值亦视为一致）且分处 **≥2 个不同子表** → 该课节为合班课（同一子表内重复出现不计）。识别在**排课之前**由课程体系表一次性完成（buildMergeIndex）：命中课程行打上 mergeCourseKey 标记，含合班课的子表在第四章摘要表「合班」列标注、并在第十二章逐组列出。合班课按一节课处理，同时满足所有组成班级空闲。v6.1 起废弃旧的单行判定（班型列含中英文逗号 / 「合班备注」列含"合班"字样）。'],
  ['合班课与子表顺序', '合班课与所在子表课程体系顺序一起排课（v5.34）：递增约束取「子表内同班上一门课程日期」与「该班级最近一门合班课日期」——v5.74 曾按「班级」维度跨子表推进（无公共班级的子表互不推进；有公共班级的子表仍以班级最近合班课日期为下界；当月余量不足致严格下界不可行时由 v5.72 mergeRelax 前移下界到最早可行窗口）。v5.82「选中策略即最终排课」：移除跨子表合班课推进——跨表推进会把后子表合班课硬锁到前子表（同班）月末，而模拟分散方案（选中策略）无此约束，造成选中策略不可落（如 Sheet1 选中 10-04/09/14/19/23/28、实际排成 10-25~31）。现主排与模拟分散方案约束一致，锚点槽位（日期+起止时段全等 slotMatchBonus=10000 直接锁定）即落为最终排课结果；子表内同班课程日期仍严格递增、不产生倒挂，合班课不脱离所在子表行序。v5.83「形态分流」：子表按行序判定排课形态——含合班课子表首尾合班课行之前全是普通课为先分后合（pre-merge），之后全是普通课为先合后分（post-merge），两侧均有普通课为混合形态（mixed，见第九章报错跳过排课）。'],
  ['合班课对齐', 'v6.1：对齐键统一为**6 字段全等**（班型 + 课程名称 + 师资名称 + 时长 + 起始日期 + 终止日期，与合班课识别共用同一 mergeKeyOf），先排的子表确定日期，后处理的子表自动对齐该日期，不重复占用新日期。v5.42 起对齐课不再写入排课结果列表，界面中同一门合班课只出现一次；课程体系表中对应行仍标记为已排课（日期与先排子表一致）。先分后合侧：后子表中位于该合班课之前的普通课限定在合班课日期前一天（dayBefore）之前排课；先合后分侧：位于已定日期合班课之后的普通课限定在该合班课日期后一天（dayAfter）之后排课（v5.83 严格对称）。'],
  ['尾段预留', 'v5.49 首次排含合班课子表时，按「合班课数量 ÷ 子表总课数量 × 130%」计算尾段比例 N（如 3/8 → 48.75%），尾段天数 = 当月天数 × N 取整（如 30 × 48.75% = 14.625 → 15 天）。生成师资-班级空闲时间表时，将该月尾段日期中「合班课其他班级」已排课程时间一并扣除，使子表内普通课避开尾段，为合班课（需多个班级同时空闲）腾出位置。该约束仅在**先分后合**形态子表生效（v5.83 形态分流接管触发）。'],
  ['头段预留', 'v5.83 先合后分（post-merge）形态子表的新约束，严格镜像尾段预留：按「合班课数量 ÷ 子表总课数量 × 130%」计算头段比例，头段天数 = 当月天数 × N 取整，取该月**前 N% 日期**；生成师资-班级空闲时间表时，将头段日期中「合班课其他班级」已排课程时间一并扣除，使子表内普通课避开头段，为合班课（需多个班级同时空闲）腾出位置。当前课程班级自身不在其中（避免重复扣除）。'],
  ['合班课之后截断', () => `v5.59 若子表中含有「已排日期」的合班课（日期已由先前排课的子表确定，或本子表排课过程中首次确定），在生成该子表师资-班级空闲时间表时，删除第一个合班课时间段之后的所有空闲时间：切割时刻 = 合班课开始时间 − ${AVAIL_REMOVE_PAD} 分钟缓冲（如合班课 8/22 17:00-19:00，X=${AVAIL_REMOVE_PAD} 时 → 切割时刻 8/22 ${hm(17 * 60 - AVAIL_REMOVE_PAD)}；删除该切割时刻起的全部碎片，含 8/25 07:00 之后的所有时段），使本子表普通课的候选时间域收缩到第一个合班课开始时间之前，避免普通课占用合班课及其后的日期域。该约束仅在**先分后合（pre-merge）**形态子表生效，v5.84 补形态 gating（form === 'pre-merge' 才计算，与合班课之前截断的 post-merge gating 严格对称）：此前 v5.59 无条件触发，先合后分（post-merge）子表会被误截断——后表普通课本应排在合班课之后，cutAfter 恰好把该候选域删空导致全部排课失败（如后端 Sheet5(2) 的 27全程2期 高数课）。`],
  ['合班课之前截断', () => `v5.83 先合后分（post-merge）形态子表的新约束，严格镜像「合班课之后截断」：若子表中含有「已排日期」的合班课，在生成该子表师资-班级空闲时间表时，删除最后一个合班课时间段之前的所有空闲时间：切割时刻 = 合班课结束时间 + ${AVAIL_REMOVE_PAD} 分钟缓冲（如合班课 8/22 17:00-19:00，X=${AVAIL_REMOVE_PAD} 时 → 切割时刻 8/22 ${hm(19 * 60 + AVAIL_REMOVE_PAD)}；删除该切割时刻前的全部碎片），使本子表普通课的候选时间域收缩到最后一个合班课结束之后，避免普通课占用合班课及其前的日期域。`],
  ['日期下界', 'v5.83 先合后分（post-merge）形态子表的新约束，严格镜像日期上界（v5.34 latestDate = dayBefore）：正序逐行扫描子表，普通课的日期下界 = 其行序之前最近一个已定日期合班课日期的后一天（dayAfter），限定该普通课只能排在下界（含）之后。合班课自身与对齐课豁免（与上界对合班课/对齐课豁免严格对称）。'],
  ['混合形态报错', 'v5.83 混合形态子表（行序上既有合班课之前又有合班课之后的普通课，即先分后合与先合后分并存）暂不做排课处理：该子表整表跳过排课，报告新增「九、未处理子表（混合形态）」错误章节逐表列出原因，课程体系表上传页同步标红警告（不影响导入）。'],
  ['已排课表约束', 'v5.90 已排课表为**跨科目班级占用约束**表：含班级、课节名称、授课日期、授课时间，与师资空闲时间表、课程体系表**科目隔离**（已排课表不涉及本排课师资与课程，如已排课表=英语既定课表，本排课=数学/政治）。排课前将表内全部条目**预注册到占用域**：①班级维度（始终）→ 同一班级同一时间段只能上一门课，建师资-班级空闲时间表时从班级空闲域扣除该时段；②师资维度（v5.91，师资列非空）→ 该师资自身档期按前后各 Y 分钟缓冲扣除；两维度均不写「每天至多一节」计数，不触发师资每日节数硬约束。v5.99 起条目科目**按授课师资名称归类**（与课程体系表同一份师资名单），参与科目部分互斥与空闲表扣除（如英语师资的已排课不阻挡日语）；师资不在名单中时按全互斥保守处理。**空/无已排课表时本约束零影响**。'],
  ['日期预算', 'v5.34.1 合班课优先尽早排入；v5.34.2 按「本课及后续同师资课程所需日期数」做日期预算硬约束，避免分散度偏好拖占后续课程的可用日期。'],
  ['分散方案锚定', 'v5.51 起「模拟排课生成」：以师资-班级空闲时间表为候选时段池，按师资×班级逐门模拟排课（时段可放性 + 师资并发互斥/班级冲突硬约束，已排槽位逐步注册累积为后续课程的占用约束），多种策略各产出一种完整可行的「日期+时段」槽位序列方案，按「分散度评分（v5.64 起 Z 规则：均匀度 + 覆盖范围 + 中段覆盖奖励 + 起始留白 + 终止留白 + 间隔匹配）+ 槽位时间优先级均值（v5.67）」选分数最高者为最终方案。v5.53 起策略扩为 10 个（原 5 个：晚间优先分散、晚间优先分散倒序、分散优先、晚间+时间分、时间分优先；新增 5 个：晚间+周末、日间优先、月初前载、月末后载、晚间/日间交替），v5.54 增 1 个贪心策略（greedy-earliest：日期层从最早可行日期逐日排课 + 槽位层取当日最早空闲时段），v5.55 再增 1 个月中向两边最大分散策略（mid-spread：以每月中间 15/16 日为轴心、在可行跨度上向月初/月末两侧全额铺开，覆盖范围最大化），v5.56 再增 1 个贪心+启发式策略（greedy-heuristic：每步选一天，启发式估计函数按子表数据预估剩余课程的潜在分散评分，权重随跨度疏密/受限课程占比自适应并迭代精炼至该子表最优），共 13 个，由 STRATEGY_META 按 dayWeight（日期层位置分布）+ dayPref（日期偏好）+ slotMode（选槽偏好）三特征组合出差异化方案。排课时将方案中按行序对应的锚点槽位（日期+时段）作为计划槽传入：槽位完整可行时直接锁定（最高优先级，10000 分阈值），槽位被占用/不可行时自动近邻回退评分（锚点日奖励权重×10，±1天→70/±3天→50/±7天→30），避免月底课程被局部递增奖励持续挤压成连排。少课（<4门）沿用 v5.47 区间等分锚点并升级为就近选取「覆盖晚间」的可行时段槽；v5.41 子表整体分散语义保留（合班课与所在子表前面普通课共享同一套锚点序列）。v5.52 起排课报告新增「各子表分散排课策略详情与评分 + 模拟日历表」章节：逐策略展示评分明细（均匀度/覆盖范围/中段覆盖/起始留白/终止留白/间隔匹配）与模拟槽位序列，并对选中方案生成模拟日历表。v5.64 起分散基础分改为「Z 规则」三项核心评分：以排课前最终版师资-课程空闲时间表区间 [X1, X2] 与未定时间课程数 Y 计算理想节奏 Z = round((X2-X1-1-Y)/Y)；三项偏差（起始留白 (W1-X1-1)-Z/2、终止留白 (X2-W2-1)-Z/2、相邻间隔 W3-Z）各按线性衰减 100×max(0, 1−0.1·|D|) 评分（v5.66；v5.64 曾为高斯 100×e^(-0.1·D²)，对远偏差惩罚过陡），偏差 0 分最高、偏差越大分越低；同名替换旧「最小间隔/平衡性/大小间隔惩罚/端距留白」维度（平衡性并入间隔项），保留均匀度/覆盖范围/中段覆盖。**v6.0「模拟即结果」**：选中策略的槽位序列不再仅作为锚点偏好，而是先整表重放校验（区间/班级递增/合班上界/师资空闲/冲突），通过后逐课直接落账为最终排课结果；上述锚点近邻回退（±1/±3/±7 天）仅在校验失败降级兜底时生效。'],
  ['兜底补排', () => '每门课先按师资-班级空闲时间表 + Z 规则分散方案锚点/时段偏好正常排课（同一师资间隔全局统一 Y=' + AVAIL_REMOVE_PAD_TEACHER + ' 分钟，晚间偏好由时间分数权重承载；v5.10 六级「仅晚上/所有空闲 × 10/5/0 分钟间隔」回退仅第一级实际触发，2-6 级从未生效已移除；v5.65 移除 v5.10 槽位级间隔天数分散度奖励 calculateDispersionBonus——实测选中槽位 100% 为锚点全等锁定且去掉该奖励后胜者 0 次变化，分散语义由 v5.64 Z 规则方案评分唯一承载）；失败后直接进入兜底放宽（v6.0.5 起移除原第二阶段「补排」中间层——不再用原始空闲时间做中间层兜底，第一阶段失败后直接进入第三阶段；冲突仍由 hasConflict 兜底检测）。**v6.0**：兜底仅在「13 策略模拟全部无解」或「模拟方案整表重放校验不通过」时启用，逐课改用 scheduleCourse 求解；校验通过时模拟槽位即为最终排课结果，不再二次求解。**v6.0.6 师资间隔全局统一**：原独立常量 MIN_GAP=10 已删除，阶段一正常排课、模拟枚举/整表校验、第三阶段兜底放宽均以同一师资间隔 Y=' + AVAIL_REMOVE_PAD_TEACHER + ' 分钟为准。**v6.0.4 同天兜底（第三阶段）**：v6.0.5 起第一阶段失败后直接执行（原第二阶段补排已移除），放宽「同一师资 + 同一班级每天至多一节」整日硬约束再试一次（allowSameDay=true），使同一天的不同时段可再排一节；该阶段师资同天间隔提高到 Y=' + AVAIL_REMOVE_PAD_TEACHER + ' 分钟、班级间隔仍为 ' + CLASS_MIN_GAP + ' 分钟。该阶段在常规约束（不同天）下确实排不下时才落到与当日已有课程**不同时段**的同一天，不会抢走本可排在不同天的日期。'],
];

/**
 * 生成排课报告 markdown
 * @param {Object} meta { year, month, reportAt, appVersion }
 * @param {Object} result generateSchedule() 返回值（含 diagnostics / scheduleTrace）
 * @param {Object} [options] { abbreviateClass = true } 是否将班级缩写为批量简称（v6.0.8）
 * @returns {string} markdown 文本
 */
export function buildScheduleReportMarkdown(meta, result, { abbreviateClass = true } = {}) {
  const steps = result.scheduleTrace?.steps || [];
  const diag = result.diagnostics || {};
  // 师资理论排课次序（科目 → 科目内难易程度），供「科目师资表」「师资难易程度」等章节复用
  const teacherOrder = diag.teacherOrder || [];
  const title = `${meta.year}年${meta.month}月排课报告`;

  // v6.0.8 班级反向缩写：仅展示层面，开关关闭或未命中分组时原样输出（不影响排课口径）
  const abbrCls = (v) => (abbreviateClass ? abbreviateClassType(String(v ?? '')) : String(v ?? ''));
  const clsCell = (v) => mdCell(abbrCls(v));

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
  lines.push(`> 生成时间：${meta.reportAt}　应用版本：${meta.appVersion}`);
  lines.push('');
  // v6.0：排课模式（simulation-first = 13 策略模拟选优后直接落账 / legacy = 模拟仅作锚点偏好）
  lines.push(`排课模式：**${diag.scheduleMode === 'legacy'
    ? 'legacy（模拟方案仅作锚点偏好，逐课排课）'
    : 'simulation-first（13 策略模拟选优，校验通过后直接落账）'}**`);
  lines.push('');
  lines.push(`课程总数：**${result.successCount + result.failedCount}**　成功：**${result.successCount}**　失败：**${result.failedCount}**`);
  lines.push('');
  lines.push(`子表排课顺序：${(diag.schedulingOrder || []).join(' → ') || '—'}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ---------- 目录（v5.62） ----------
  const tocChapters = [
    `${CN[1]}、排课逻辑说明`,
    `${CN[2]}、科目师资表`,
    `${CN[3]}、师资难易程度评估与排课顺序`,
    `${CN[4]}、排课结果摘要`,
    `${CN[5]}、各子表分散排课策略详情与评分`,
    `${CN[6]}、各子表选中方案模拟日历表`,
    `${CN[7]}、排课师资次序`,
    `${CN[8]}、各子表排第一节课时的师资-班级空闲时间表`
  ];
  // v5.83：存在混合形态子表（排课时整表跳过）时追加第九章「未处理子表」
  if ((diag.mixedSheets || []).length > 0) {
    tocChapters.push(`${CN[9]}、未处理子表（混合形态）`);
  }
  // v5.90：存在已排课表（跨科目班级占用约束）时追加第十章「已排课表」
  const presetStats = diag.presetStats || [];
  if (presetStats.length > 0) {
    tocChapters.push(`${CN[10]}、已排课表（班级占用约束）`);
  }
  // v6.0.15：发生过同师资子表重排重试时追加第十一章「同师资子表重排重试」
  if (((diag.sheetReorder || {}).attempts || []).length > 0) {
    tocChapters.push(`${CN[11]}、同师资子表重排重试`);
  }
  // v6.1：存在跨子表合班课时追加第十二章「合班组与含合班课子表」
  if ((diag.mergeGroups || []).length > 0) {
    tocChapters.push(`${CN[12]}、合班组与含合班课子表`);
  }
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
    lines.push(`| **${name}** | ${mdCell(typeof desc === 'function' ? desc() : desc)} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ---------- 二、科目师资表（v5.94 独立成章） ----------
  // 列出各科目优先级顺序、科目内全部师资名单，以及本报告实际涉及师资/课程需求/排课门数。
  // 「408计算机」为 v5.92 新增科目（师资：乔石磊、白玉杰、宋萍萍），优先级排在「数学」之后、
  // 「未收录科目」之前；未在科目师资表中的师资按「未收录科目」处理，排在所有已收录科目之后。
  lines.push(`## ${CN[2]}、科目师资表`);
  lines.push('');
  lines.push('> **科目优先级**（v5.25 科目师资表，v5.92 新增「408计算机」，v5.95 新增「日语」）：' +
    `**${SUBJECT_PRIORITY.join(' > ')} > 未收录科目**。排课时先按科目确立大体师资顺序（整科目排完再进下一科目），` +
    '科目内再按师资难易程度降序排课（见下一章）。未在科目师资表中的师资按「未收录科目」处理，排在所有已收录科目之后。');
  lines.push('');
  lines.push('| 优先级 | 科目 | 师资总数 | 师资名单 | 本报告涉及师资 | 本报告课程需求(分钟) | 本报告排课门数 |');
  lines.push('|--:|:--|--:|:--|:--|--:|--:|');
  const subjectRows = [];
  for (let i = 0; i < SUBJECT_PRIORITY.length; i++) {
    const subject = SUBJECT_PRIORITY[i];
    const roster = SUBJECT_TEACHERS[subject] || [];
    const rows = teacherOrder.filter(r => (r.subject || null) === subject);
    subjectRows.push({
      order: i + 1,
      subject,
      roster,
      involved: rows.map(r => r.teacher),
      courseMinutes: rows.reduce((s, r) => s + (r.courseMinutes || 0), 0),
      courseCount: rows.reduce((s, r) => s + (teacherCourseCount[r.teacher] || 0), 0)
    });
  }
  const unlistedRows = teacherOrder.filter(r => !r.subject);
  if (unlistedRows.length > 0) {
    subjectRows.push({
      order: SUBJECT_PRIORITY.length + 1,
      subject: '未收录科目',
      roster: null,
      involved: unlistedRows.map(r => r.teacher),
      courseMinutes: unlistedRows.reduce((s, r) => s + (r.courseMinutes || 0), 0),
      courseCount: unlistedRows.reduce((s, r) => s + (teacherCourseCount[r.teacher] || 0), 0)
    });
  }
  for (const sr of subjectRows) {
    lines.push(`| ${sr.order} | ${mdCell(sr.subject)} | ${sr.roster ? sr.roster.length : '—'} | ` +
      `${sr.roster ? sr.roster.map(mdCell).join('、') : '—'} | ` +
      `${sr.involved.length > 0 ? sr.involved.map(mdCell).join('、') : '—'} | ` +
      `${sr.involved.length > 0 ? sr.courseMinutes : '—'} | ` +
      `${sr.involved.length > 0 ? sr.courseCount : '—'} |`);
  }
  lines.push('');
  // 408计算机 科目专项说明（v5.92 新增）
  const cs408Roster = SUBJECT_TEACHERS['408计算机'] || [];
  const cs408Involved = teacherOrder.filter(r => r.subject === '408计算机');
  lines.push('**「408计算机」科目说明（v5.92 新增）：**');
  lines.push('');
  lines.push(`- **科目定位**：计算机统考 408（数据结构、计算机组成原理、操作系统、计算机网络）相关课程的专属科目，` +
    `在科目优先级中固定排在 **数学之后、未收录科目之前**（第 ${SUBJECT_PRIORITY.indexOf('408计算机') + 1} 优先级）。`);
  lines.push(`- **师资名单**（共 ${cs408Roster.length} 位）：${cs408Roster.map(mdCell).join('、')}。`);
  if (cs408Involved.length > 0) {
    lines.push(`- **本报告涉及**：${cs408Involved.length} 位 408计算机 师资参与排课 —— ` +
      cs408Involved.map(r => `${mdCell(r.teacher)}（理论第 ${r.order} 位，需求 ${r.courseMinutes} 分钟，排课 ${teacherCourseCount[r.teacher] || 0} 门）`).join('；') + '。');
  } else {
    lines.push('- **本报告涉及**：本报告未涉及 408计算机 科目课程（该科目师资不参与本次排课）。');
  }
  lines.push('- **排课顺序语义**：408计算机 课程整体排在英语、政治、数学之后统一排课，科目内按师资难易程度降序排课；' +
    '其班级/师资占用与其它科目共享同一套「师资-班级空闲时间表」约束。');
  lines.push('');

  // 日语 科目专项说明（v5.95 新增）
  const japaneseRoster = SUBJECT_TEACHERS['日语'] || [];
  const japaneseInvolved = teacherOrder.filter(r => r.subject === '日语');
  lines.push('**「日语」科目说明（v5.95 新增）：**');
  lines.push('');
  lines.push(`- **科目定位**：日语相关课程的专属科目，在科目优先级中固定排在 **408计算机之后、未收录科目之前**（第 ${SUBJECT_PRIORITY.indexOf('日语') + 1} 优先级）。`);
  lines.push(`- **师资名单**（共 ${japaneseRoster.length} 位）：${japaneseRoster.map(mdCell).join('、')}。`);
  if (japaneseInvolved.length > 0) {
    lines.push(`- **本报告涉及**：${japaneseInvolved.length} 位 日语 师资参与排课 —— ` +
      japaneseInvolved.map(r => `${mdCell(r.teacher)}（理论第 ${r.order} 位，需求 ${r.courseMinutes} 分钟，排课 ${teacherCourseCount[r.teacher] || 0} 门）`).join('；') + '。');
  } else {
    lines.push('- **本报告涉及**：本报告未涉及 日语 科目课程（该科目师资不参与本次排课）。');
  }
  lines.push('- **互斥规则（部分互斥）**：同一班级中，日语仅与 **日语 / 政治 / 数学** 时间互斥，' +
    '与 **英语、408计算机** 可在同一时间段并存；日语课之间（同班）仍互斥。已排课表（v5.99）按**授课师资名称**归类科目后参与同一互斥矩阵（与课程体系表同一份师资名单），归类为英语/408计算机的已排课不阻挡日语；师资不在名单中时保守按全互斥处理。');
  lines.push('- **空闲时间表扣除口径（v5.96 / v5.99）**：生成日语师资的「师资-班级空闲时间表」时，仅扣除同班 **政治 / 数学** 课节时间，' +
    '以及该师资自身的已排课节时间；同班 **英语、408计算机、日语（其他师资）** 课节不扣除。' +
    '已排课表（v5.99）归类为政治/数学/日语时扣除，归类为英语/408计算机时不扣除，师资不在名单中时保守扣除。');
  lines.push('');
  lines.push('---');
  lines.push('');

  // ---------- 三、师资难易程度评估与排课顺序（v5.36） ----------
  lines.push(`## ${CN[3]}、师资难易程度评估与排课顺序`);
  lines.push('');
  lines.push('> **难易程度** = 该师资课程时间总需求（分钟）÷ 空闲时间总量（分钟）。比值越大 = 排课越困难 = 越优先排课；' +
    '无空闲时间的师资显示为 **∞**（该科目内最优先）。**师资排课顺序**：先按科目确立大体师资顺序，科目内再按难易程度确定最终师资排课顺序。');
  lines.push('');
  lines.push('| 理论次序 | 科目 | 师资 | 课程需求(分钟) | 空闲时间(分钟) | 难易程度 | 实际排课次序 | 排课门数 |');
  lines.push('|--:|:--|:--|--:|--:|:--|:--|--:|');
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

  // ---------- 四、排课结果摘要 ----------
  lines.push(`## ${CN[4]}、排课结果摘要`);
  lines.push('');
  lines.push('> 子表按「师资排课顺序 → 同师资时间密度 L = M/N 升序」排序（v5.88）：N = 子表课程数，M = 子表内「起始日期」「终止日期」均非空行的最晚终止日期 − 最早起始日期 + 1 天（含首尾），L 越小越先排；无齐备日期行则 L = ∞ 排最后。');
  lines.push('');
  lines.push('| 子表 | 课程数N | 天数M | 时间密度L | 成功 | 对齐 | 失败 | 模拟方案校验 | 合班 | 涉及师资 |');
  lines.push('|---|--:|--:|--:|--:|--:|--:|---|---|---|');
  for (const s of diag.sheetStats || []) {
    const mergeCell = s.hasMerge
      ? `是（对 ${(s.mergePeers || []).length > 0 ? (s.mergePeers || []).map(mdCell).join('、') : '—'}）`
      : '—';
    lines.push(`| ${mdCell(s.sheetName)} | ${s.totalCourses} | ${s.m ?? '—'} | ${fmtL(s.l)} | ${s.scheduled} | ${s.aligned} | ${s.failed} | ${formatPlanValidation(s.planValidation)} | ${mergeCell} | ${s.teachers.map(mdCell).join('、')} |`);
  }
  lines.push('');

  // v6.0.4：忽略整日封锁（同天）落账标注 —— v6.0.7 起 simulation-first 由宏观第③步整表处理：
  // 第①②步（严格 13 策略模拟 + 校验）未通过的子表，忽略「同一师资+同一班级每天至多一节」
  // 整日硬约束重新执行 13 策略模拟并选优直接落账（phase = 'simulation-relaxed'）；
  // legacy 模式下同一语义的逐课兜底为 'fallback-same-day'（放宽整日约束后落在与当日已有课程
  // 不同时段的同一天：师资同天间隔仍满足 Y=${AVAIL_REMOVE_PAD_TEACHER} 分钟、班级间隔仍满足 ${CLASS_MIN_GAP} 分钟）。
  const sameDaySteps = steps.filter(s => (s.phase === 'simulation-relaxed' || s.phase === 'fallback-same-day') && s.slot);
  if (sameDaySteps.length > 0) {
    const relaxedSteps = sameDaySteps.filter(s => s.phase === 'simulation-relaxed');
    const title = relaxedSteps.length > 0 ? '忽略整日封锁（v6.0.7 宏观第③步）' : '同天兜底（v6.0.4）';
    lines.push(`> ⚠ **${title}**：以下 **${sameDaySteps.length}** 门课程在常规约束（同一师资 + 同一班级每天至多一节，须排在不同天）下无可行的「不同天」日期，经忽略该整日约束后落在与当日已有课程**不同时段**的同一天（师资同天间隔仍满足 Y=${AVAIL_REMOVE_PAD_TEACHER} 分钟、班级间隔仍满足 ${CLASS_MIN_GAP} 分钟）：`);
    lines.push('');
    lines.push('| 子表 | 行序 | 课程 | 班级 | 师资 | 落账日期 时段 |');
    lines.push('|---|--:|---|---|---|---|');
    for (const s of sameDaySteps) {
      lines.push(`| ${mdCell(s.sheetName)} | ${s.orderInSheet} | ${mdCell(s.courseName)} | ${clsCell(s.classType)} | ${mdCell(s.teacher)} | ${s.slot.date} ${s.slot.startTime}-${s.slot.endTime} |`);
    }
    lines.push('');
  } else {
    lines.push('> **忽略整日封锁（v6.0.7 宏观第③步）**：本次排课未触发忽略整日封锁（全部课程均在满足「同一师资 + 同一班级每天至多一节」的基础上排入不同日期）。');
    lines.push('');
  }

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

  // ---------- 五、各子表分散排课策略详情与评分（v5.62 独立成章；此前为「三之（下）」前半） ----------
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
    lines.push(`## ${CN[5]}、各子表分散排课策略详情与评分`);
    lines.push('');
    lines.push('> 每行说明：总分 = 分散基础分（均匀度 + 覆盖范围 + 中段覆盖 + 起始留白 + 终止留白 + 间隔匹配）**+ 时间优先级（槽位时间优先级分均值，v5.67）**；v5.64 起按理想节奏 Z = round((X2-X1-1-Y)/Y) 评分（X1/X2 = 排课前最终版师资-课程空闲时间表区间、Y = 未定时间课程数），起始/终止留白理想值各 = Z/2、相邻间隔理想值 = Z，偏差 0 分最高、偏差越大分越低（v5.66 起线性衰减）；**★** 为该子表选中策略。v6.0 起选中策略即最终排课结果：整表重放校验通过后逐课直接落账，「落账来源」列给出模拟直接落账 / 逐课兜底的课程门数。各子表选中方案对应的**模拟日历表**见下一章（六）。');
    lines.push('');

    // v6.0：各子表逐课落账来源统计（simulation = 第①②步模拟直接落账 / simulation-relaxed =
    // 第③步忽略整日封锁模拟直接落账 / fallback = 逐课兜底（legacy）/ aligned = 合班对齐）
    const slotSourceBySheet = new Map();
    for (const st of steps) {
      if (!slotSourceBySheet.has(st.sheetName)) {
        slotSourceBySheet.set(st.sheetName, { simulation: 0, relaxed: 0, fallback: 0, aligned: 0 });
      }
      const rec = slotSourceBySheet.get(st.sheetName);
      if (st.slotSource === 'simulation') rec.simulation++;
      else if (st.slotSource === 'simulation-relaxed') rec.relaxed++;
      else if (st.slotSource === 'fallback') rec.fallback++;
      else if (st.slotSource === 'aligned') rec.aligned++;
    }
    const slotSourceLabel = (sheetName) => {
      const rec = slotSourceBySheet.get(sheetName);
      if (!rec) return '—';
      const parts = [];
      if (rec.simulation > 0) parts.push(`模拟 ${rec.simulation}`);
      if (rec.relaxed > 0) parts.push(`忽略封锁 ${rec.relaxed}`);
      if (rec.fallback > 0) parts.push(`兜底 ${rec.fallback}`);
      if (rec.aligned > 0) parts.push(`对齐 ${rec.aligned}`);
      return parts.join(' / ') || '—';
    };

    // （1）选中策略概览
    lines.push('**（1）各子表选中策略概览：**');
    lines.push('');
    lines.push('| 子表 | 课程数 | 选中策略 | 总分 | 分散基础分 | 时间优先级 | 方案校验 | 落账来源 | 模拟槽位序列 |');
    lines.push('|---|---|:--|--:|--:|--:|---|---|---|');
    for (const s of sheetsWithPlan) {
      const p = s.dispersionPlan;
      const selected = p.candidates.find(c => c.strategy === p.selectedStrategy) || p.candidates[0];
      if (!selected) continue;
      lines.push(`| ${mdCell(s.sheetName)} | ${courseCountLabel(p, s)} | **${mdCell(selected.strategy || '—')}** | ${fmtScore(selected.score)} | ${fmtScore(selected.baseScore)} | ${fmtScore(selected.timeScoreAvg)} | ${formatPlanValidation(s.planValidation)} | ${slotSourceLabel(s.sheetName)} | ${formatSlots(selected.slots)} |`);
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
      // v5.87：不再输出 v5.72「阶段三/阶段四」详情块（`**策略**：总分/分支/相对原方案提升`
      // 与各课原槽 → 更优槽变体明细列表）——逐子表大段陈列各策略逐课挪动明细使报告体量
      // 激增（单个子表动辄数十行，全报告数百行），业务无需该粒度展示，仅保留上方策略评分明细表格。
      lines.push('');
    }
    lines.push('---');
    lines.push('');

    // ---------- 六、各子表选中方案模拟日历表（v5.62 独立成章；此前为「三之（下）」后半） ----------
    lines.push(`## ${CN[6]}、各子表选中方案模拟日历表`);
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

  // ---------- 七、排课师资次序 ----------
  // 实际排课师资次序：按排课调度步骤中师资首次出现的顺序排列
  lines.push(`## ${CN[7]}、排课师资次序`);
  lines.push('');
  lines.push('（按实际排课调度中师资首次出现的先后顺序排列；理论次序见第三章师资难易程度评估）');
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

  // ---------- 八、各子表排第一节课时的师资-班级空闲时间表（v5.57） ----------
  // 每子表第一门实际排课（非对齐）课程排课瞬间的「师资-班级空闲时间表」快照，
  // 以及该时刻已从空闲表中扣除的来源子表课程（子表整块顺序排课时第一课尚无本子表课程占用，
  // 故所扣时段全部来自此前已排课的子表）
  const firstLessons = result.scheduleTrace?.firstLessons || [];
  if (firstLessons.length > 0) {
    const anyCutAfter = firstLessons.some(fl => !!fl.cutAfter);
    const anyCutBefore = firstLessons.some(fl => !!fl.cutBefore);
    lines.push(`## ${CN[8]}、各子表排第一节课时的师资-班级空闲时间表`);
    lines.push('');
    lines.push(`> 每子表展示**第一门实际排课（非对齐）课程**在排课瞬间的「师资-班级空闲时间表」快照（v5.57）。` +
      `该表 = 该师资当月空闲时间 − **班级已占时段**（该课涉及班级的已排课程，左右各加 X=${AVAIL_REMOVE_PAD} 分钟缓冲）− ` +
      `**该师资自身已排时段**（同一时刻师资只能上一门课，左右各加独立的 Y=${AVAIL_REMOVE_PAD_TEACHER} 分钟缓冲；同一课程若同时命中班级与师资两类，取 max(X, Y)）− ` +
      `**已排课表（preset）占用**（v5.99：已排课表按**授课师资名称**归类科目后参与扣除——班级有交集且与本科目互斥时按 X 缓冲扣除，师资相同按 Y 缓冲扣除；师资不在名单中时保守全扣）− ` +
      `**整日封锁日期**（v6.1：第①步严格模拟口径下，「同一师资 + 同一班级当日已有课」的整天从空闲表中**整体移除**，被移除的日期在下方以 🔒 标注；宏观第③步忽略整日封锁时不体现）。因子表内严格按行序整表顺序排课，排第一课时本子表尚无课程被占用，` +
      `故该表中所减时段来自**此前已排课的子表**与**已排课表**，具体来源见各子表「已减去来源子表课程」「已减去已排课表占用」。` +
      (anyCutAfter ? ` **若子表含有「排课前已确定日期」的合班课（日期由先前子表确定），先分后合侧按「合班课之后截断」（v5.59/v5.68）删除第一个合班课开始时间 − ${AVAIL_REMOVE_PAD} 分钟缓冲之后的所有空闲时间；**` : '') +
      (anyCutBefore ? ` **先合后分侧按「合班课之前截断」（v5.83）删除行序最后一个已定日期合班课结束时间 + ${AVAIL_REMOVE_PAD} 分钟缓冲之前的所有空闲时间，使普通课收缩到最后合班课之后排课。本子表首次确定合班课日期的子表，排课瞬间合班课尚未确定，快照不截断。**` : ''));
    lines.push('');
    for (const fl of firstLessons) {
      const slotText = fl.slot
        ? `**${fl.slot.date} ${fl.slot.startTime}-${fl.slot.endTime}**`
        : '排课失败（因无师资-课程空闲时间）';
      lines.push(`#### ${mdCell(fl.sheetName)}`);
      lines.push('');
      lines.push(`**第一门实际排课**：「**${mdCell(fl.courseName)}**」（行序 ${fl.orderInSheet}，师资 ${mdCell(fl.teacher)}，班级 ${clsCell(fl.classType)}）→ ${slotText}`);
      lines.push('');
      if (fl.tailReserve) {
        lines.push(`> ⚠ 该子表为含合班课子表（v5.49 尾段预留）：构建本空闲表时将该月后 ${fl.tailReserve.tailCount} 天（${fl.tailReserve.tailFrom.slice(5)} ~ ${fl.tailReserve.tailTo.slice(5)}）中「合班课其他班级」${mdCell((fl.tailReserve.otherClasses || []).join('、'))} 已排课程时间一并扣除，为本次首次安插的合班课腾出尾段位置。`);
        lines.push('');
      }
      if (fl.cutAfter) {
        lines.push(`> ✂ 该子表含有**已排日期合班课**：合班课「${mdCell(fl.cutAfter.courseName)}」（${clsCell(fl.cutAfter.classType)}，${fl.cutAfter.mergeDate} ${fl.cutAfter.mergeStart}）日期已确定（v5.59）。` +
          `构建本空闲表时按「合班课之后截断」删除 **${fl.cutAfter.date} ${fl.cutAfter.startTime}**（该合班课开始时间 − ${AVAIL_REMOVE_PAD} 分钟缓冲）之后的所有空闲时间。`);
        lines.push('');
      }
      if (fl.cutBefore) {
        lines.push(`> ✂ 该子表含有**已排日期合班课**：合班课「${mdCell(fl.cutBefore.courseName)}」（${clsCell(fl.cutBefore.classType)}，${fl.cutBefore.mergeDate} ${fl.cutBefore.mergeEnd}）日期已确定（v5.83，日期由「${mdCell(fl.cutBefore.fromSheet || fl.sheetName)}」确定）。` +
          `构建本空闲表时按「合班课之前截断」删除 **${fl.cutBefore.date} ${fl.cutBefore.endTime}**（该合班课结束时间 + ${AVAIL_REMOVE_PAD} 分钟缓冲）之前的所有空闲时间。`);
        lines.push('');
      }
      // v5.59/v5.68 + v5.83：展示时对快照应用 cutAfter / cutBefore 截断（仅在排课前已确定合班课日期的子表——
      // 日期由先前子表确定——快照才含截断并在此生效；本子表首次确定合班课日期的子表
      // 排课瞬间合班课尚未确定，快照无截断、如实展示未截断的空闲表，与排课瞬间一致）
      const rawAvail = Array.isArray(fl.availability) ? fl.availability : [];
      let displayAvail = rawAvail;
      if (displayAvail.length > 0 && fl.cutAfter) displayAvail = applyCutAfter(displayAvail, fl.cutAfter);
      if (displayAvail.length > 0 && fl.cutBefore) displayAvail = applyCutBefore(displayAvail, fl.cutBefore);
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
      const lockedDates = Array.isArray(fl.dayLockedDates) ? fl.dayLockedDates : [];
      if (lockedDates.length > 0) {
        lines.push('');
        lines.push(`> 🔒 **整日封锁（v6.1）**：该师资「${mdCell(fl.teacher)}」+ 班级 ${clsCell(fl.classType)} 在下列日期**当日已有课**，` +
          `按「同一师资 + 同一班级每天至多一节」硬约束，这些整天已从上方空闲表中**整体移除**（第①步严格模拟口径）：` +
          `${lockedDates.map(d => String(d).slice(5)).join('、')}。`);
      }
      lines.push('');
      const excl = fl.excluded || [];
      const exclTotal = excl.reduce((s, e) => s + ((e.courses || []).length), 0);
      if (exclTotal > 0) {
        lines.push(`**已减去来源子表课程（共 ${exclTotal} 门，来自 ${excl.length} 个子表，每门标注扣除维度）：**`);
        lines.push('');
        lines.push('| 来源子表 | 扣除课程数 | 明细（行序 · 课程名 · 班级 · 师资 · 日期 时段 · 维度） |');
        lines.push('|---|--:|---|');
        for (const e of excl) {
          const detail = (e.courses || []).map(c => {
            const dimNames = (c.dims || []).map(d => EXCL_DIM_LABEL[d]).filter(Boolean).join('/');
            return `${c.orderInSheet} · ${c.courseName} · ${abbrCls(c.classType)} · ${c.teacher} · ${String(c.date).slice(5)} ${c.startTime}-${c.endTime}${dimNames ? `【${dimNames}】` : ''}`;
          }).join('；');
          lines.push(`| ${mdCell(e.sheetName)} | ${(e.courses || []).length} | ${mdCell(detail)} |`);
        }
        // v5.73：区分「师资占用 / 班级占用 / 尾段预留」，重点澄清共享师资场景——
        // 两子表即使没有公共班级，只要共用同一位师资，其已排时段同样会被扣减
        lines.push('');
        lines.push('> 说明（v5.73）：扣除维度 = **师资占用**（该师资本人此前已排课程，不限班级 —— ' +
          '两子表即使**没有公共班级**、只要**共用同一位师资**，其已排时段同样被扣减，防止同一老师同一时段上两门课；' +
          `该维度左右各加独立的 Y=${AVAIL_REMOVE_PAD_TEACHER} 分钟缓冲）` +
          `＋ **班级占用**（组成班级有交集，左右各加 X=${AVAIL_REMOVE_PAD} 分钟缓冲）＋ **尾段预留**（v5.49 为合班课腾尾段：合班课其他班级在尾段日期内的已排时间）。` +
          '同一课程若同时命中师资占用与班级占用，两段区间合并取并集，等效于取 max(X, Y)。' +
          '（v5.97）班级占用 / 尾段预留 / 头段预留三个维度均按师资-班级空闲表的科目扣除口径过滤：' +
          '日语师资仅计入同班 **政治 / 数学** 课节，同班英语、408计算机、日语（其他师资）不计入扣除来源。');
      } else {
        // v5.60：excluded 已过滤为「实际参与扣除的来源课程」；为空时可能是本子表
        // 是第一个排课的子表，也可能是此前子表无与该子表同师资/同班级的课程
        const isFirstSheet = fl === firstLessons[0];
        const hasPreset = (fl.presetExcluded || []).length > 0;
        lines.push(isFirstSheet
          ? `**已减去来源子表课程：**（无 — 本子表是第一个排课的子表，空闲表仅含该师资原始空闲时间${hasPreset ? '；已排课表占用另见下方「已减去已排课表占用」' : ''}）`
          : '**已减去来源子表课程：**（无 — 此前已排子表中没有与本子表第一课同师资/同班级的课程，且无尾段预留扣除）');
      }
      // v5.99：已排课表（preset）占用扣除明细——preset 识别科目后按硬互斥口径参与扣除
      const presetExcl = fl.presetExcluded || [];
      if (presetExcl.length > 0) {
        lines.push('');
        lines.push(`**已减去已排课表占用（共 ${presetExcl.length} 条，v5.99）：**`);
        lines.push('');
        lines.push('| # | 班级 | 课节名称 | 师资 | 识别科目 | 日期 时段 | 维度 |');
        lines.push('|--:|---|---|---|---|---|---|');
        presetExcl.forEach((p, i) => {
          const dimNames = (p.dims || []).map(d => PRESET_DIM_LABEL[d]).filter(Boolean).join('/');
          lines.push(`| ${i + 1} | ${clsCell(p.classType)} | ${mdCell(p.courseName)} | ${mdCell(p.teacher)} | ${mdCell(p.subject || '未识别')} | ${String(p.date).slice(5)} ${p.startTime}-${p.endTime} | ${dimNames} |`);
        });
        lines.push('');
        lines.push(`> 已排课表条目无科目列（v5.99）：按**授课师资名称**归类科目（与课程体系表同一份师资名单，如唐静 → 英语），` +
          `并按**硬互斥口径**（isSubjectConflict）从空闲表扣除——**班级占用**（组成班级有交集且与本科目互斥，左右各加 X=${AVAIL_REMOVE_PAD} 分钟缓冲）、` +
          `**师资占用**（与第一课师资相同，左右各加 Y=${AVAIL_REMOVE_PAD_TEACHER} 分钟缓冲）。` +
          `归类为英语/408计算机的已排课不阻挡日语，不会出现在日语师资的扣除来源中；师资不在名单中的条目仍按全互斥保守扣除。`);
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  // ---------- 九、未处理子表（混合形态）（v5.83） ----------
  // 混合形态子表（行序上既有合班课之前又有合班课之后的普通课，即先分后合与先合后分并存）
  // 暂不做排课处理：子表循环中已整表跳过（详见 diagnostics.mixedSheets），此处逐表列出原因。
  // 混合形态跳过意味着该子表内所有课程均未排课（含合班课），需人工拆分为先分后合/先合后分
  // 两种形态（分别放入不同子表）后重新排课。
  const mixedSheets = diag.mixedSheets || [];
  if (mixedSheets.length > 0) {
    lines.push(`## ${CN[9]}、未处理子表（混合形态）`);
    lines.push('');
    lines.push(`> ⚠ **以下 ${mixedSheets.length} 张子表为混合形态（先分后合与先合后分并存），v5.83 暂不做排课处理，整表跳过，子表内全部课程均未排课。**` +
      `请将子表拆分为「先分后合」（先普通课、后合班课）与「先合后分」（先合班课、后普通课）两种形态分别放入不同子表后重新排课。`);
    lines.push('');
    lines.push('| 子表 | 子表内课程数 | 合班课数 | 首合班课前普通课数 | 末合班课后普通课数 | 跳过原因 |');
    lines.push('|---|--:|--:|--:|--:|---|');
    for (const m of mixedSheets) {
      lines.push(`| ${mdCell(m.sheetName)} | ${m.totalCourses} | ${m.mergeCount} | ${m.preCount} | ${m.postCount} | ${mdCell(m.reason || '既有合班课之前的普通课（先分后合），又有合班课之后的普通课（先合后分）')} |`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // ---------- 十、已排课表（班级/师资占用约束）（v5.90 / v5.91） ----------
  // 已排课表为跨科目占用约束：条目 {班级, 课节名称, 师资, 授课日期, 开始/结束时间} 与
  // 课程体系科目隔离，声明「某班级/某师资某日期某时间段已有课程」。排课前全部预注册：
  //   班级维度（始终）→ classScheduleByDate，班级空闲域扣除 + 班级冲突检测兜底；
  //   师资维度（师资列非空）→ teacherScheduleByDate，按前后各 Y 分钟缓冲扣除，
  //   实现同一班级 / 同一师资对应时间段互斥。
  if (presetStats.length > 0) {
    lines.push(`## ${CN[10]}、已排课表（班级/师资占用约束）`);
    lines.push('');
    lines.push(`> 已排课表为**跨科目占用约束**（v5.90 起支持）：共解析 **${presetStats.length}** 条，` +
      `与课程体系表科目隔离。排课前全部条目**预注册**——` +
      `**班级维度**（始终）：下列班级在对应日期、时段内已排课程，本排课自动避让（同一班级同一时间段只能上一门课）；` +
      `**师资维度**（v5.91，师资列非空）：该师资已于对应时段排课，本排课按前后各 **Y=${AVAIL_REMOVE_PAD_TEACHER}** 分钟缓冲避让` +
      `（同一师资同一时间段不能上两门课）。` +
      `v5.99 起条目科目按**授课师资名称**归类（与课程体系表同一份师资名单，如唐静 → 英语），班级维度改按**硬互斥口径**参与扣除：` +
      `归类为英语/408计算机的条目不阻挡日语；师资不在名单中的条目仍按全互斥保守扣除。`);
    lines.push('');
    lines.push('| # | 班级 | 课节名称 | 师资 | 识别科目 | 授课日期 | 授课时间 |');
    lines.push('|---:|---|---|---|---|---|---|');
    for (const p of presetStats) {
      const subject = inferPresetSubject(p);
      lines.push(`| ${p.order} | ${clsCell(p.classType)} | ${mdCell(p.courseName)} | ${mdCell(p.teacher)} | ${mdCell(subject || '未识别')} | ${mdCell(p.date)} | ${mdCell(p.startTime)}-${mdCell(p.endTime)} |`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // ---------- 十一、同师资子表重排重试（v6.0.15；v6.1 起偏序约束） ----------
  // 对「忽略整日封锁的 13 策略模拟仍无解」的子表，按其主师资把同师资子表重新排列后整表重跑：
  // v6.1 起为「带合班偏序约束的线性扩展」——含同一跨子表合班课的子表保持默认顺序中的相对先后
  // （中间可插任意其它子表）、无合班约束子表自由换位；某排列使该师资名下全部（参与排课的）
  // 子表成功则采用。此处展示尝试排列数与最终采用顺序，全失败时标注「仍失败」。
  const reorderAttempts = (diag.sheetReorder || {}).attempts || [];
  const reorderMaxOrders = (diag.sheetReorder || {}).maxOrders;
  if (reorderAttempts.length > 0) {
    // 按师资分组（保持首次出现顺序）
    const reorderOwners = [];
    const reorderMap = new Map();
    for (const a of reorderAttempts) {
      if (!reorderMap.has(a.owner)) { reorderMap.set(a.owner, []); reorderOwners.push(a.owner); }
      reorderMap.get(a.owner).push(a);
    }
    lines.push(`## ${CN[11]}、同师资子表重排重试`);
    lines.push('');
    lines.push(`> v6.0.15（v6.1 起偏序约束）：对「忽略整日封锁的 13 策略模拟仍无解」的子表，按其**主师资**将同师资子表重新排列后**整表重跑**——` +
      `v6.1 起改为**带合班偏序约束的线性扩展**：凡含同一跨子表合班课（第十二章）的子表，保持其在默认排课顺序中的**相对先后**不变（如 27英语1 在 27英语2 之前，重排后仍在其前，中间可插入任意其它子表）；` +
      `无合班约束的子表之间仍可自由换位（单师资枚举上限 ${reorderMaxOrders ?? '—'} 种，默认顺序优先）；` +
      `若某排列使该师资名下**全部（参与排课的）子表**均排课成功，则采用该结果。`);
    lines.push('');
    lines.push('| 师资 | 尝试排列数 | 结果 | 采用顺序 | 备注 |');
    lines.push('|---|--:|---|---|---|');
    for (const owner of reorderOwners) {
      const list = reorderMap.get(owner);
      const accepted = list.find(a => a.allOk);
      const truncated = list.some(a => a.truncated);
      const note = truncated ? `已达上限（仅枚举前 ${reorderMaxOrders} 种）` : '—';
      lines.push(`| ${mdCell(owner)} | ${list.length} | ${accepted ? '✅ 重排成功，已采用' : '❌ 全部顺序仍失败'} | ${accepted ? mdCell(accepted.order.join(' → ')) : '—（保留默认顺序结果）'} | ${note} |`);
    }
    lines.push('');
    // 全部顺序穷尽仍失败的师资：标注「已尝试同师资子表重排仍失败」并列仍失败子表
    const failedOwners = reorderOwners.filter(o => !reorderMap.get(o).some(a => a.allOk));
    if (failedOwners.length > 0) {
      lines.push(`> ⚠ **以下师资已尝试同师资子表重排仍失败**（排列穷尽或达枚举上限），保留默认顺序的排课结果：`);
      lines.push('');
      lines.push('| 师资 | 尝试排列数 | 仍失败子表 |');
      lines.push('|---|--:|---|');
      for (const owner of failedOwners) {
        const list = reorderMap.get(owner);
        const base = list.find(a => a.isDefault) || list[list.length - 1];
        const fs = (base.failedSheets || []).map(s => `${s.sheetName}（${s.failed} 门）`).join('、') || '—';
        lines.push(`| ${mdCell(owner)} | ${list.length} | ${mdCell(fs)} |`);
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  // ---------- 十二、合班组与含合班课子表（v6.1） ----------
  // 排课之前由 buildMergeIndex 跨子表配对得到：合班组（6 字段全等）+ 含合班课子表清单。
  // 识别规则见第一章「合班课识别」；本表为识别结果的可视化核对。
  const mergeGroups = diag.mergeGroups || [];
  const mergeSheets = diag.mergeSheets || [];
  if (mergeGroups.length > 0) {
    lines.push(`## ${CN[12]}、合班组与含合班课子表`);
    lines.push('');
    lines.push(`> v6.1：合班课在**排课之前**由课程体系表一次性识别——**只有分处不同子表的某个课节的全部信息（班型 / 课程名称 / 师资名称 / 时长 / 起始日期 / 终止日期）一致，才算合班课**。` +
      `本次共识别 **${mergeGroups.length}** 个跨子表合班组、**${mergeSheets.length}** 张含合班课的子表。`);
    lines.push('');
    lines.push('| # | 班型 | 课程名称 | 师资 | 时长 | 起始日期 | 终止日期 | 涉及子表（默认排课顺序） |');
    lines.push('|---:|---|---|---|---|---|---|---|');
    mergeGroups.forEach((g, i) => {
      lines.push(`| ${i + 1} | ${clsCell(g.classType)} | ${mdCell(g.courseName)} | ${mdCell(g.teacher)} | ${mdCell(g.duration)} | ${mdCell(g.startDate)} | ${mdCell(g.endDate)} | ${(g.sheetKeys || []).map(mdCell).join(' → ')} |`);
    });
    lines.push('');
    lines.push('**含合班课子表（标注）：**');
    lines.push('');
    lines.push('| 子表 | 涉及合班组数 | 合班对子表 |');
    lines.push('|---|--:|---|');
    for (const s of mergeSheets) {
      lines.push(`| ${mdCell(s.sheetName)} | ${s.mergeGroupCount} | ${(s.mergePeers || []).map(mdCell).join('、') || '—'} |`);
    }
    lines.push('');
    lines.push('> 同师资子表重排（第十一章）中，凡含对应合班课的子表保持其在默认排课顺序中的**相对先后**不变（中间可插入任意其它子表）。');
    lines.push('');
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

/** v5.88：时间密度 L 格式化（∞ / null(JSON 序列化后) → '∞'，否则保留 2 位小数） */
function fmtL(v) {
  if (v === null || v === undefined || v === Infinity || v === -Infinity) return '∞';
  if (Number.isNaN(v)) return '—';
  return String(Math.round(Number(v) * 100) / 100);
}

/** v6.0：模拟方案校验结果格式化（verified → 直接落账；否则列出降级/失败原因）
 *  v6.0.7：宏观第③步（忽略整日封锁的 13 策略模拟）直接落账时标注「忽略整日封锁」。 */
function formatPlanValidation(pv) {
  if (!pv) return '—';
  if (pv.verified) return pv.relaxed ? '通过·忽略整日封锁（第③步直接落账）' : '通过（第①②步直接落账）';
  if (pv.reason && String(pv.reason).startsWith('legacy')) return '—（legacy 模式）';
  const reason = pv.reason ? mdCell(pv.reason) : '未知原因';
  return pv.relaxed ? `失败·忽略整日封锁仍无解（${reason}）` : `失败（${reason}）`;
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