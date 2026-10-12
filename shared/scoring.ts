import { CATEGORIES, CATEGORY_MAP, GRADE_THRESHOLDS } from './config.js';
import { nearestPoiM } from './poi.js';
import type { GapAnalysis, ScoreDimDetail, ScoreResult, LatLng, Poi } from './types.js';

/** 临近度阶梯衰减：直线距离 → 0-1 得分 */
function proximityFromDistance(d: number | null): number {
  if (d == null) return 0;
  if (d <= 200) return 1;
  if (d <= 500) return 0.85;
  if (d <= 800) return 0.7;
  if (d <= 1200) return 0.5;
  if (d <= 2000) return 0.3;
  if (d <= 3000) return 0.15;
  return 0;
}

export interface ScoreOptions {
  /**
   * 检索失败的类别：这些类别数量为 0 属「数据缺失」而非「真实没有」，
   * 不参与加权评分（权重重新归一），但在明细中标注 missingData。
   */
  failedCategories?: string[];
}

export function computeScore(
  center: LatLng,
  pois: Poi[],
  gap: GapAnalysis,
  opts: ScoreOptions = {}
): ScoreResult {
  const failed = new Set<string>(opts.failedCategories ?? []);
  const byCat: Record<string, Poi[]> = {};
  for (const p of pois) (byCat[p.category] ??= []).push(p);

  const scored = CATEGORIES.filter((c) => c.scored);
  const details: ScoreDimDetail[] = scored.map((c) => {
    const missingData = failed.has(c.id);
    const list = missingData ? [] : (byCat[c.id] ?? []);
    const nearest = list.length ? nearestPoiM(center, list) : null;
    return {
      category: c.id,
      name: c.name,
      count: list.length,
      ideal: c.ideal,
      completeness: c.ideal > 0 ? Math.min(1, list.length / c.ideal) : 1,
      nearestM: nearest ? Math.round(nearest.distM) : null,
      proximity: proximityFromDistance(nearest ? nearest.distM : null),
      missingData
    };
  });

  // 数据缺失的类别不参与加权（区分「数据缺失」与「真实为 0」），权重重新归一
  const counted = details.filter((d) => !d.missingData);
  const wSum = counted.reduce((a, d) => a + CATEGORY_MAP[d.category].weight, 0) || 1;
  const completeness =
    counted.reduce((a, d) => a + d.completeness * CATEGORY_MAP[d.category].weight, 0) / wSum;
  const proximity =
    counted.reduce((a, d) => a + d.proximity * CATEGORY_MAP[d.category].weight, 0) / wSum;

  // 人口覆盖：无居住采样或核心类别全未知时无法评估（置空，并从总分加权中剔除该维度）
  const coverageAvailable = gap.totalWeight > 0 && gap.coverageShare != null;
  const coverage = coverageAvailable ? gap.coverageShare : null;

  const counts = counted.map((d) => d.count);
  const countTotal = counts.reduce((a, b) => a + b, 0);
  let diversity = 0;
  // 可用类别数 ≤ 1 时香农熵无意义（log(1)=0 会除零），记 0
  if (countTotal > 0 && counts.length > 1) {
    let h = 0;
    for (const c of counts) {
      if (c <= 0) continue;
      const p = c / countTotal;
      h -= p * Math.log(p);
    }
    diversity = h / Math.log(counts.length);
  }

  // 总分：可用维度加权后归一（缺失维度不拉低总分）
  const parts: [number, number][] = [
    [completeness, 0.3],
    [proximity, 0.35],
    [diversity, 0.15]
  ];
  let weightSum = 0.8;
  if (coverage != null) {
    parts.push([coverage, 0.2]);
    weightSum = 1;
  }
  const totalScore = parts.reduce((a, [v, w]) => a + v * w, 0) / weightSum;
  const total = Math.round(totalScore * 100);
  const grade =
    total >= GRADE_THRESHOLDS.A
      ? 'A'
      : total >= GRADE_THRESHOLDS.B
        ? 'B'
        : total >= GRADE_THRESHOLDS.C
          ? 'C'
          : total >= GRADE_THRESHOLDS.D
            ? 'D'
            : 'E';

  const missingDataNames = details.filter((d) => d.missingData).map((d) => d.name);
  const zeroCats = details.filter((d) => !d.missingData && d.count === 0).map((d) => d.name);
  const weak = [...counted].sort(
    (a, b) => a.completeness * CATEGORY_MAP[a.category].weight - b.completeness * CATEGORY_MAP[b.category].weight
  )[0];
  const summaryParts: string[] = [];
  if (missingDataNames.length) summaryParts.push(`检索失败或不完整（数据缺失，无法判断）：${missingDataNames.join('、')}`);
  if (gap.unknownCategories?.length) {
    const names = gap.unknownCategories.map((c) => CATEGORY_MAP[c as keyof typeof CATEGORY_MAP]?.name ?? c);
    summaryParts.push(
      gap.coverageShare == null
        ? `「${names.join('、')}」检索失败或不完整，三件套完整覆盖率无法评估`
        : `「${names.join('、')}」检索失败或不完整，覆盖率仅按已判定 ${3 - gap.unknownCategories.length} 类计算（未知 ≠ 覆盖成功）`
    );
  }
  if (zeroCats.length) summaryParts.push(`检索范围内未查得：${zeroCats.join('、')}`);
  if (gap.patches.length) {
    const top = gap.patches[0];
    summaryParts.push(
      `最大灰色区域位于${bearingName(center, top.centroid)}方向，覆盖约 ${(top.weightShare * 100).toFixed(0)}% 居住权重，主要缺${CATEGORY_MAP[top.dominant].name}`
    );
  }
  if (coverageAvailable && gap.severeShare != null && gap.severeShare > 0.05)
    summaryParts.push(`重度缺失（三类全无）居住权重占 ${(gap.severeShare * 100).toFixed(0)}%`);
  if (gap.totalWeight === 0) {
    const resCount = pois.filter((p) => p.category === 'residential').length;
    summaryParts.push(resCount
      ? `住宅小区已取得 ${resCount} 处但检索不完整（达到分页上限），人口覆盖率无法评估`
      : '片区内未检索到住宅小区，人口覆盖率无法评估');
  }
  if (!summaryParts.length) summaryParts.push('各类设施齐备，暂无明显服务盲区');
  summaryParts.unshift(
    `最薄弱维度：${weak ? CATEGORY_MAP[weak.category].name + '（完整度 ' + Math.round(weak.completeness * 100) + '%）' : '—'}`
  );

  return {
    total,
    grade,
    dims: { completeness, proximity, coverage, diversity },
    coverageUnavailable: !coverageAvailable,
    missingDataCategories: missingDataNames,
    details,
    summary: summaryParts.join('；') + '。'
  };
}

function bearingName(from: LatLng, to: LatLng): string {
  const dLat = to.lat - from.lat;
  const dLng = to.lng - from.lng;
  const angle = (Math.atan2(dLng, dLat) * 180) / Math.PI;
  const a = (angle + 360) % 360;
  if (a < 22.5 || a >= 337.5) return '正北';
  if (a < 67.5) return '东北';
  if (a < 112.5) return '正东';
  if (a < 157.5) return '东南';
  if (a < 202.5) return '正南';
  if (a < 247.5) return '西南';
  if (a < 292.5) return '西北';
  return '西北';
}
