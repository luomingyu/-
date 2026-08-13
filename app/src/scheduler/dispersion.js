// 课程分散策略：生成方案 + 评分 + 选择最优方案
// 优先使用有晚上时间的日期，不足时回退到所有空闲时间
import { calculateDatePriorityScore } from './timePriority.js';

/** 从 'YYYY-MM-DD' 提取当月第几天 */
function getDayOfMonth(dateStr) {
  return parseInt(dateStr.slice(-2), 10);
}

/**
 * 在可用日期中找到「不早于」targetDay 的第一个日期
 * 若所有日期都早于 targetDay，则返回最后一个日期
 * 这种「向前取」策略避免聚类在密集区域的低端
 */
function findDateOnOrAfter(targetDay, sortedDates) {
  for (const d of sortedDates) {
    if (getDayOfMonth(d) >= targetDay) return d;
  }
  return sortedDates[sortedDates.length - 1];
}

/**
 * 将可用日期按天数范围均匀分布，使用「向前取」策略
 * 对每个理想天数位置，取不早于该位置的第一个未使用可用日期
 * 这样中间的间隙日期（如11号、21号）会自然被纳入
 */
function segmentSpread(sortedDates, totalCourses) {
  if (sortedDates.length < totalCourses) return sortedDates.slice(0, totalCourses);

  const firstDay = getDayOfMonth(sortedDates[0]);
  const lastDay = getDayOfMonth(sortedDates[sortedDates.length - 1]);
  const daySpan = lastDay - firstDay;

  if (daySpan === 0) return [sortedDates[0]];

  // 计算每个课程的理想天数位置（均匀分布在 [firstDay, lastDay] 范围内）
  const idealDays = [];
  for (let i = 0; i < totalCourses; i++) {
    const pos = i / (totalCourses - 1);
    idealDays.push(firstDay + pos * daySpan);
  }

  // 使用「向前取」策略映射到实际可用日期
  // 第一个课程固定在第一个可用日期，确保起始点
  const result = [sortedDates[0]];
  const used = new Set([sortedDates[0]]);

  for (let i = 1; i < totalCourses; i++) {
    const idealDay = idealDays[i];
    let chosen = null;

    // 从 idealDay 开始向后找第一个未使用的日期
    for (const d of sortedDates) {
      if (!used.has(d) && getDayOfMonth(d) >= idealDay) {
        chosen = d;
        break;
      }
    }

    // 若没找到向后的日期，向前找最近的未使用日期
    if (!chosen) {
      let bestBefore = null;
      let bestDiff = Infinity;
      for (const d of sortedDates) {
        if (!used.has(d)) {
          const day = getDayOfMonth(d);
          if (day <= idealDay) {
            const diff = idealDay - day;
            if (diff < bestDiff) {
              bestDiff = diff;
              bestBefore = d;
            }
          }
        }
      }
      if (bestBefore) {
        chosen = bestBefore;
      } else {
        // 最后兜底：取第一个未使用的日期
        for (const d of sortedDates) {
          if (!used.has(d)) { chosen = d; break; }
        }
      }
    }

    if (chosen) {
      used.add(chosen);
      result.push(chosen);
    }
  }

  return result;
}

/**
 * 评价分散方案的分数：覆盖范围 + 均匀度 + 最小间隔 + 平衡性 + 中间覆盖
 * 注意：allDates 应为「整月所有日期」（1 日~月末），分散度按整月时间轴衡量，
 *       而非按空闲日期子集——这样即使空闲日期集中在局部，也能识别出
 *       课程是否真正覆盖整个月，避免课程扎堆在空闲日期子集内得高分。
 */
export function calculateDispersionScore(dates, allDates) {
  if (dates.length === 0) return -Infinity;

  const dateIndices = dates.map(d => allDates.indexOf(d)).filter(i => i >= 0);
  if (dateIndices.length < 2) return -Infinity;

  const firstIdx = dateIndices[0];
  const lastIdx = dateIndices[dateIndices.length - 1];
  const totalRange = allDates.length - 1;
  const coverage = (lastIdx - firstIdx) / totalRange;

  const gaps = [];
  for (let i = 1; i < dateIndices.length; i++) {
    gaps.push(dateIndices[i] - dateIndices[i - 1]);
  }

  const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((sum, g) => sum + Math.pow(g - meanGap, 2), 0) / gaps.length;
  const stdDev = Math.sqrt(variance);

  const minGap = Math.min(...gaps);
  const maxGap = Math.max(...gaps);
  const gapRange = maxGap - minGap;

  // 大间隔惩罚：超过7天的间隔额外扣分，强制方案不能有一周以上的空白期
  let largeGapPenalty = 0;
  for (const g of gaps) {
    if (g > 7) {
      largeGapPenalty -= (g - 7) * 10;
    }
  }

  // 小间隔惩罚：相邻天(gap=1)或同天(gap=0)给较强惩罚，鼓励至少间隔2天
  // 仅当可用日期充裕时优化器才会避开；课程多于"隔天可排"容量时仍允许（数据强制）
  let smallGapPenalty = 0;
  for (const g of gaps) {
    if (g < 2) {
      smallGapPenalty -= (2 - g) * 20; // gap=1: -20, gap=0: -40
    }
  }

  // 中间覆盖奖励：方案中的日期落在月中间区域的比例越高，分数越高
  // 中间区域定义为 allDates 的 15%~85% 区间，避免课程集中在首尾
  const midStartIdx = Math.floor(totalRange * 0.15);
  const midEndIdx = Math.ceil(totalRange * 0.85);
  let midCount = 0;
  for (const idx of dateIndices) {
    if (idx >= midStartIdx && idx <= midEndIdx) midCount++;
  }
  const midRatio = midCount / dateIndices.length;
  const midCoverageBonus = midRatio * 30;

  const uniformityScore = 1 / (1 + stdDev);
  const minGapScore = minGap;
  const balanceScore = 1 / (1 + gapRange);
  const coverageScore = coverage * 100;

  return uniformityScore * 50 + minGapScore * 10 + balanceScore * 20
       + coverageScore + largeGapPenalty + smallGapPenalty + midCoverageBonus;
}

/**
 * 生成多种分散方案
 * @param {string[]} availableDates 可用日期（已排序）
 * @param {number} totalCourses 课程数
 * @param {Object} datePriorityMap { date: 'evening'|'afternoon'|'morning' }
 */
export function generateDispersionPlans(availableDates, totalCourses, datePriorityMap) {
  const plans = [];

  const eveningDates = availableDates.filter(d => datePriorityMap?.[d] === 'evening');
  const afternoonDates = availableDates.filter(d => datePriorityMap?.[d] === 'afternoon');
  const morningDates = availableDates.filter(d => datePriorityMap?.[d] === 'morning');

  if (availableDates.length <= totalCourses) {
    const sortedDates = [...eveningDates, ...afternoonDates, ...morningDates];
    plans.push({
      dates: sortedDates.slice(0, availableDates.length),
      description: 'priority-limited-days'
    });
    return plans;
  }

  if (totalCourses === 1) {
    const sortedDates = [...eveningDates, ...afternoonDates, ...morningDates];
    plans.push({ dates: [sortedDates[Math.floor(sortedDates.length / 2)]], description: 'single' });
    return plans;
  }

  const priorityDates = [...eveningDates, ...afternoonDates, ...morningDates];

  // —— 方案1: 晚上时间专用（仅当晚上 >= 课程数时）——
  if (eveningDates.length >= totalCourses) {
    const eveningPlan = [];
    const eveningInterval = Math.ceil(eveningDates.length / totalCourses);
    for (let i = 0; i < totalCourses; i++) {
      const idx = Math.min(i * eveningInterval, eveningDates.length - 1);
      eveningPlan.push(eveningDates[idx]);
    }
    plans.push({ dates: eveningPlan, description: 'evening-priority' });
  }

  // —— 方案2: 按优先级数组索引线性分布 ——
  const linearDates = [];
  for (let i = 0; i < totalCourses; i++) {
    const pos = i / (totalCourses - 1);
    const idx = Math.round(pos * (priorityDates.length - 1));
    linearDates.push(priorityDates[idx]);
  }
  plans.push({ dates: linearDates, description: 'priority-linear-spread' });

  // —— 方案3: 按优先级数组均匀分段中点分布 ——
  const linearEvenDates = [];
  for (let i = 0; i < totalCourses; i++) {
    const pos = (i + 0.5) / totalCourses;
    const idx = Math.floor(pos * priorityDates.length);
    linearEvenDates.push(priorityDates[Math.min(idx, priorityDates.length - 1)]);
  }
  plans.push({ dates: linearEvenDates, description: 'priority-linear-even' });

  // —— 方案4: 偏移方案 ——
  const baseInterval = Math.ceil(priorityDates.length / totalCourses);
  for (let offset = 0; offset < Math.min(baseInterval, 3); offset++) {
    const dates = [];
    let idx = offset;
    for (let i = 0; i < totalCourses && idx < priorityDates.length; i++) {
      dates.push(priorityDates[idx]);
      idx += baseInterval;
    }
    if (dates.length === totalCourses) {
      plans.push({ dates, description: `priority-offset-${offset}` });
    }
  }

  // —— 方案5: 间隔方案 ——
  for (let interval = Math.max(2, baseInterval - 2); interval <= baseInterval + 2; interval++) {
    const dates = [];
    for (let i = 0; i < totalCourses && i * interval < priorityDates.length; i++) {
      dates.push(priorityDates[i * interval]);
    }
    if (dates.length === totalCourses) {
      plans.push({ dates, description: `priority-interval-${interval}` });
    }
  }

  // —— 方案6（核心修复）: 基于实际日期值的分段全范围分布 ——
  // 将日期范围分成 totalCourses 段，每段取中间位置的可用日期
  // 强制包含首尾可用日期以保证覆盖范围，中间用分段策略填充
  const sortedByDate = [...availableDates].sort();
  const firstDay = getDayOfMonth(sortedByDate[0]);
  const lastDay = getDayOfMonth(sortedByDate[sortedByDate.length - 1]);
  const daySpan = lastDay - firstDay;

  if (daySpan > 0 && totalCourses >= 2) {
    const firstAvailable = sortedByDate[0];
    const lastAvailable = sortedByDate[sortedByDate.length - 1];
    const middlePool = sortedByDate.slice(1, -1);
    const middleCourses = totalCourses - 2;

    if (middleCourses > 0 && middlePool.length >= middleCourses) {
      const middlePlan = segmentSpread(middlePool, middleCourses);
      const combinedPlan = [firstAvailable, ...middlePlan, lastAvailable];

      // 去重
      const used = new Set();
      const deduplicated = [];
      for (const d of combinedPlan) {
        if (!used.has(d)) {
          used.add(d);
          deduplicated.push(d);
        }
      }

      if (deduplicated.length === totalCourses) {
        plans.push({ dates: deduplicated, description: 'segment-full-range' });
      }
    } else {
      // 回退：直接用 segmentSpread
      const segmentedPlan = segmentSpread(sortedByDate, totalCourses);
      const used = new Set();
      const deduplicated = [];
      for (const d of segmentedPlan) {
        if (!used.has(d)) {
          used.add(d);
          deduplicated.push(d);
        }
      }
      if (deduplicated.length === totalCourses) {
        plans.push({ dates: deduplicated, description: 'segment-full-range' });
      }
    }
  }

  // —— 方案7（核心修复）: 贪心最大分散 ——
  // 从首尾两端开始，迭代选择使最小间隔最大化的日期
  // 选择后对日期排序，确保时间顺序正确
  if (sortedByDate.length >= totalCourses && totalCourses >= 2) {
    const greedySet = new Set();
    greedySet.add(sortedByDate[0]);
    greedySet.add(sortedByDate[sortedByDate.length - 1]);
    const remainingPool = sortedByDate.slice(1, -1);

    while (greedySet.size < totalCourses && remainingPool.length > 0) {
      let bestDate = null;
      let bestMinGap = -1;

      for (const candidate of remainingPool) {
        const candidateDay = getDayOfMonth(candidate);
        let minGap = Infinity;
        for (const selected of greedySet) {
          const gap = Math.abs(candidateDay - getDayOfMonth(selected));
          if (gap < minGap) minGap = gap;
        }
        if (minGap > bestMinGap) {
          bestMinGap = minGap;
          bestDate = candidate;
        }
      }

      if (bestDate) {
        greedySet.add(bestDate);
        const idx = remainingPool.indexOf(bestDate);
        remainingPool.splice(idx, 1);
      } else {
        break;
      }
    }

    if (greedySet.size === totalCourses) {
      const greedyPlan = Array.from(greedySet).sort();
      plans.push({ dates: greedyPlan, description: 'max-dispersion-greedy' });
    }
  }

  // —— 方案8: 前后半月均衡分布 ——
  // 确保课程分散在前半月和后半月
  if (daySpan > 0 && totalCourses >= 2) {
    const midDay = firstDay + daySpan / 2;
    const firstHalf = sortedByDate.filter(d => getDayOfMonth(d) <= midDay);
    const secondHalf = sortedByDate.filter(d => getDayOfMonth(d) > midDay);

    if (firstHalf.length > 0 && secondHalf.length > 0) {
      const halfCount = Math.ceil(totalCourses / 2);
      const firstHalfPlan = [];
      const secondHalfPlan = [];

      for (let i = 0; i < halfCount && i < firstHalf.length; i++) {
        const pos = firstHalf.length === 1 ? 0 : i / (firstHalf.length - 1);
        const idx = Math.round(pos * (firstHalf.length - 1));
        firstHalfPlan.push(firstHalf[idx]);
      }

      const secondCount = totalCourses - firstHalfPlan.length;
      for (let i = 0; i < secondCount && i < secondHalf.length; i++) {
        const pos = secondHalf.length === 1 ? 0 : i / (secondHalf.length - 1);
        const idx = Math.round(pos * (secondHalf.length - 1));
        secondHalfPlan.push(secondHalf[idx]);
      }

      const balancedPlan = [...firstHalfPlan, ...secondHalfPlan];
      if (balancedPlan.length === totalCourses) {
        plans.push({ dates: balancedPlan, description: 'bi-weekly-balance' });
      }
    }
  }

  return plans;
}

/**
 * 贪心优化：从空闲日期中选择使分散度评分最大的子集
 * 策略：先选首尾两端，再逐步选择使评分增量最大的中间日期
 * @param {string[]} candidateDates 候选日期（已排序）
 * @param {number} totalCourses 需要选择的课程数
 * @param {string[]} allMonthDates 整月所有日期
 * @returns {{ dates: string[], score: number }}
 */
function greedyOptimize(candidateDates, totalCourses, allMonthDates) {
  if (candidateDates.length <= totalCourses) {
    return { dates: [...candidateDates], score: calculateDispersionScore(candidateDates, allMonthDates) };
  }

  const sorted = [...candidateDates].sort();
  const selected = [];
  const remaining = [...sorted];

  // 第一步：选取第一天
  selected.push(remaining.shift());

  if (totalCourses >= 2) {
    // 第二步：选取最后一天
    selected.push(remaining.pop());
  }

  // 贪心迭代：每次选使分散度评分最大增量的日期
  while (selected.length < totalCourses && remaining.length > 0) {
    let bestCandidate = null;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const trialDates = [...selected, remaining[i]].sort();
      const score = calculateDispersionScore(trialDates, allMonthDates);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = i;
      }
    }

    if (bestCandidate !== null) {
      selected.push(remaining.splice(bestCandidate, 1)[0]);
    } else {
      break;
    }
  }

  const finalDates = selected.sort();
  const finalScore = calculateDispersionScore(finalDates, allMonthDates);

  return { dates: finalDates, score: finalScore };
}

/**
 * 局部搜索精炼：对已选日期做 1-for-1 替换爬山，跳出贪心局部最优
 * 对每个已选日期，尝试用每个未选候选替换，若评分提升则接受，循环直至稳定
 * @param {string[]} selectedDates 已选日期
 * @param {string[]} candidateDates 全部候选日期
 * @param {string[]} allMonthDates 整月所有日期
 * @returns {{ dates: string[], score: number }}
 */
function localSearchRefine(selectedDates, candidateDates, allMonthDates) {
  let selected = [...selectedDates].sort();
  let currentScore = calculateDispersionScore(selected, allMonthDates);
  const selectedSet = new Set(selected);
  const unselected = [...candidateDates].sort().filter(d => !selectedSet.has(d));

  let improved = true;
  let iterations = 0;
  const MAX_ITER = 100;

  while (improved && iterations < MAX_ITER) {
    improved = false;
    iterations++;
    for (let i = 0; i < selected.length; i++) {
      for (const cand of unselected) {
        if (cand === selected[i]) continue;
        const trial = [...selected];
        trial[i] = cand;
        trial.sort();
        const trialScore = calculateDispersionScore(trial, allMonthDates);
        if (trialScore > currentScore + 0.001) {
          // 同步更新 unselected：移除 cand，加回被替换的旧值
          const old = selected[i];
          selected = trial;
          currentScore = trialScore;
          const ci = unselected.indexOf(cand);
          if (ci >= 0) unselected.splice(ci, 1);
          unselected.push(old);
          unselected.sort();
          improved = true;
        }
      }
    }
  }

  return { dates: selected, score: currentScore };
}

/**
 * 从多个候选方案中选择评分最高的，并做局部搜索精炼
 * @param {Array<{dates: string[], description: string}>} plans 候选方案
 * @param {string[]} candidateDates 全部候选日期
 * @param {string[]} allMonthDates 整月所有日期
 * @returns {{ dates: string[], score: number, description: string }}
 */
function pickBestPlan(plans, candidateDates, allMonthDates) {
  let best = null;
  for (const p of plans) {
    if (!p.dates || p.dates.length === 0) continue;
    const score = calculateDispersionScore(p.dates, allMonthDates);
    if (!best || score > best.score) {
      best = { dates: [...p.dates].sort(), score, description: p.description };
    }
  }
  if (!best) return null;
  // 局部搜索精炼，跳出贪心局部最优（如避免可避开的相邻天 gap-1）
  const refined = localSearchRefine(best.dates, candidateDates, allMonthDates);
  if (refined.score > best.score + 0.001) {
    return { dates: refined.dates, score: refined.score, description: best.description + '+refine' };
  }
  return best;
}

/**
 * 选择最优分散方案（两级：优先晚上，回退全部）
 * 综合多种策略方案 + 贪心优化 + 局部搜索，选评分最高者
 * @returns {{ primary: Plan, secondary: Plan, hasEveningPriority: boolean }}
 */
export function findBestDispersionPlan(availableDates, totalCourses, teacher, monthAvailability, allMonthDates) {
  const datePriorityMap = {};
  for (const date of availableDates) {
    const dateAvailabilities = monthAvailability.filter(a => a.date === date && a.teacher === teacher);
    const maxScore = calculateDatePriorityScore(dateAvailabilities, 0);
    if (maxScore >= 140) {
      datePriorityMap[date] = 'evening';
    } else if (maxScore >= 90) {
      datePriorityMap[date] = 'afternoon';
    } else {
      datePriorityMap[date] = 'morning';
    }
  }

  const eveningDates = availableDates.filter(d => datePriorityMap[d] === 'evening');

  let primaryPlan = null;

  // 第一级：晚上时间足够时，仅在晚上时间中选最优方案
  if (eveningDates.length >= totalCourses) {
    // 收集多策略方案 + 贪心方案
    const plans = generateDispersionPlans(eveningDates, totalCourses, datePriorityMap);
    const greedy = greedyOptimize(eveningDates, totalCourses, allMonthDates);
    plans.push({ dates: greedy.dates, description: 'greedy-evening' });
    const best = pickBestPlan(plans, eveningDates, allMonthDates);
    primaryPlan = { dates: best.dates, score: best.score, description: best.description };
    console.log('分散方案选择:', best.description, '评分:', best.score.toFixed(2), '日期:', best.dates.map(d => parseInt(d.slice(-2))), '(优先使用晚上时间)');
  }

  // 第二级：所有空闲时间选最优方案（回退）
  const allDates = [...availableDates].sort();
  const allPlans = generateDispersionPlans(allDates, totalCourses, datePriorityMap);
  const allGreedy = greedyOptimize(allDates, totalCourses, allMonthDates);
  allPlans.push({ dates: allGreedy.dates, description: 'greedy-all' });
  const allBest = pickBestPlan(allPlans, allDates, allMonthDates);
  const secondaryPlan = { dates: allBest.dates, score: allBest.score, description: allBest.description };

  if (!primaryPlan) {
    console.log('分散方案选择:', allBest.description, '评分:', allBest.score.toFixed(2), '日期:', allBest.dates.map(d => parseInt(d.slice(-2))), '(晚上时间不足，使用所有空闲时间)');
  }

  return {
    primary: primaryPlan || secondaryPlan,
    secondary: secondaryPlan,
    hasEveningPriority: !!primaryPlan
  };
}
