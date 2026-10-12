import { CATEGORIES, CORE_CATEGORIES, PERSONA_MAP, THRESHOLDS } from './config.js';
import { buildChecklist } from './checklist.js';
import { buildIsochroneModel, sampleBearings } from './isochrone.js';
import { buildTimeField, contourPolylines, simplifyLine, sampleTimeNearest } from './timefield.js';
import { analyzeGaps } from './gap.js';
import { computeScore } from './scoring.js';
import { dedupePois } from './poi.js';
import { assessmentUnavailableCategories, isPoiQuotaError, legacyPoiSearchResult, poiSearchWarnings, unqueriedPoiSearch } from './poiSearch.js';
import { createProvenance } from './provenance.js';
import { planFacilitiesFromCoverage } from './planner.js';
import { cumulativeOpportunities, interpolationAccuracy } from './cumulative.js';
import { buildAnalysisWarnings } from './warnings.js';
import { destination, interpAngle } from './geo.js';
import type {
  CategoryId,
  LatLng,
  PersonaId,
  Poi,
  PoiSearchCompleteness,
  PoiSearchResult,
  RouteProbe
} from './types.js';

/**
 * 可共享的分析编排引擎：给定一个数据提供者（浏览器通道 / 服务端通道 / 测试桩），
 * 执行一次完整体检并输出可序列化的报告。Web 端与 API 端共用同一套流程语义。
 */

export interface AnalysisProvider {
  geocode(address: string): Promise<LatLng>;
  reverseGeocode(p: LatLng): Promise<string>;
  searchPoi(keyword: string, category: CategoryId, center: LatLng, radiusM: number): Promise<Poi[]>;
  searchPoiDetailed?(keyword: string, category: CategoryId, center: LatLng, radiusM: number): Promise<PoiSearchResult>;
  routeMatrix(origin: LatLng, dests: LatLng[]): Promise<(RouteProbe | null)[]>;
}

export interface AnalyzeParams {
  /** 二选一：直接给中心点，或给地址由地理编码解析 */
  center?: LatLng;
  address?: string;
  persona?: PersonaId;
  minutes?: number;
  /** 检索半径（米），默认 2000 */
  searchRadiusM?: number;
}

export interface AnalysisStep {
  name: string;
  ms: number;
  note?: string;
  ok: boolean;
}

export interface RingLine {
  level: number;
  lines: LatLng[][];
}

export interface PatchSummary {
  id: number;
  centroid: LatLng;
  weightShare: number;
  missingCats: string[];
  dominant: string;
  maxNearestM: number;
  severity: 'severe' | 'moderate';
  outline: LatLng[][];
}

export interface AnalysisReport {
  center: LatLng;
  centerName: string;
  persona: PersonaId;
  minutes: number;
  generatedAt: string;
  provenance?: import('./provenance.js').AnalysisProvenance;
  degraded: boolean;
  model: {
    dirs: number;
    probeM: number;
    factors: number[];
    radiusM: number[];
    degradedDirs: number;
  };
  rings: RingLine[];
  pois: Poi[];
  counts: Record<string, number>;
  score: ReturnType<typeof computeScore>;
  checklist: ReturnType<typeof buildChecklist>;
  gap: {
    blindPoints: number;
    coverageShare: number | null;
    severeShare: number | null;
    coverageUnavailable: boolean;
    patches: PatchSummary[];
  };
  planSites: ReturnType<typeof planFacilitiesFromCoverage>;
  /** 累积机会指标（学界标准口径）：圈内可步行抵达的设施总数与类别数 */
  cumulative: ReturnType<typeof cumulativeOpportunities>;
  /** 插值精度自证：抽样真实算路 vs 模型估计的平均绝对误差 */
  accuracy: ReturnType<typeof interpolationAccuracy>;
  /** 数据口径警告：区分「数据缺失」「模型合成」「真实结论」 */
  warnings: string[];
  /** 检索失败的类别（数量 0 属数据缺失而非真实结论） */
  failedCategories: CategoryId[];
  poiSearch: PoiSearchCompleteness[];
  incompleteCategories: CategoryId[];
  assessmentUnavailableCategories: CategoryId[];
  /** true = 真实设施检索未完成或失败，报告不可冒充完整结果 */
  incomplete: boolean;
  /** true = 检索因上游配额耗尽被截断（incomplete 必为 true） */
  quotaExhausted: boolean;
  steps: AnalysisStep[];
}

export async function runAnalysis(
  params: AnalyzeParams,
  provider: AnalysisProvider,
  onStep?: (s: AnalysisStep) => void
): Promise<AnalysisReport> {
  const steps: AnalysisStep[] = [];
  const step = (name: string, ms: number, ok: boolean, note?: string) => {
    const s = { name, ms, ok, note };
    steps.push(s);
    onStep?.(s);
    return s;
  };

  const personaId = params.persona ?? 'adult';
  const persona = PERSONA_MAP[personaId];
  const minutes = params.minutes ?? 15;
  const searchRadiusM = params.searchRadiusM ?? THRESHOLDS.searchRadiusM;

  // 1) 中心定位
  let t0 = Date.now();
  let center = params.center;
  let centerName = '';
  if (!center) {
    if (!params.address) throw new Error('需要提供 center 或 address');
    const loc = await provider.geocode(params.address);
    center = loc;
    centerName = params.address;
  }
  if (!centerName) {
    try {
      centerName = await provider.reverseGeocode(center);
    } catch {
      centerName = `中心点 ${center.lat.toFixed(5)},${center.lng.toFixed(5)}`;
    }
  }
  step('中心定位', Date.now() - t0, true, centerName);

  // 2) 扇形采样（2 探针预检决定方向数：服务端健康→48 向，否则 16 向）
  //    上游失败不中断：异常方向记为 null，由等时圈模型的谐波系数兜底
  t0 = Date.now();
  const probeM = minutes * persona.speed;
  let pre: (RouteProbe | null)[] = [null, null];
  try {
    pre = await provider.routeMatrix(center, [
      destination(center, 0, probeM),
      destination(center, 180, probeM)
    ]);
  } catch {
    pre = [null, null];
  }
  const serverHealthy = pre.filter(Boolean).length === 2;
  const dirs = serverHealthy ? THRESHOLDS.sampleDirs : 16;
  const dests = sampleBearings(dirs).map((b) => destination(center, b, probeM));
  const probes: (RouteProbe | null)[] = new Array(dirs).fill(null);
  probes[0] = pre[0];
  probes[serverHealthy ? 24 : 8] = pre[1];
  const restIdx = probes.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
  let rest: (RouteProbe | null)[] = restIdx.map(() => null);
  try {
    rest = await provider.routeMatrix(
      center,
      restIdx.map((i) => dests[i])
    );
  } catch {
    rest = restIdx.map(() => null);
  }
  restIdx.forEach((idx, k) => {
    probes[idx] = rest[k] ?? null;
  });
  const okProbes = probes.filter((p) => p && p.ok).length;
  step('路网采样算路', Date.now() - t0, okProbes > 0, `${okProbes}/${dirs} 向成功`);

  // 3) 时间场与等时环
  t0 = Date.now();
  const model = buildIsochroneModel(center, probes, { dirs, minutes, speed: persona.speed, probeM });
  const field = buildTimeField(model);
  const levels = [...new Set([5, 10, minutes])].sort((a, b) => a - b);
  const rings = levels.map((level) => ({
    level,
    lines: contourPolylines(field, level).map((line) => simplifyLine(line, 15))
  }));
  step('时间场与等时环', Date.now() - t0, true, `${rings.length} 层等时环`);

  // 3b) 插值精度自证：8 个抽样点全量算路 vs 模型估计 → MAE
  t0 = Date.now();
  const sampleB = [15, 60, 105, 150, 195, 240, 285, 330];
  let accuracy: AnalysisReport['accuracy'] = {
    samples: 0, maeMinutes: 0, maePercent: 0, worstPercent: 0, details: []
  };
  try {
    const real = await provider.routeMatrix(
      center,
      sampleB.map((b) => destination(center, b, probeM * 0.6))
    );
    const realProbes = real
      .map((p, i) => ({
        bearing: sampleB[i],
        straightM: probeM * 0.6,
        distM: p && p.ok ? p.distM : 0
      }))
      .filter((p) => p.distM > 0);
    accuracy = interpolationAccuracy(
      center,
      realProbes,
      (theta) => interpAngle(model.factors, dirs, theta),
      persona.speed
    );
  } catch {
    /* 精度自证失败不影响主流程 */
  }
  step('插值精度自证', Date.now() - t0, accuracy.samples > 0,
    accuracy.samples ? `抽样 ${accuracy.samples} 点 · MAE ${accuracy.maeMinutes} 分钟（${accuracy.maePercent}%）` : '未执行');

  // 4) POI 检索（串行，尊重上游并发限制）
  t0 = Date.now();
  const pois: Poi[] = [];
  const tasks = CATEGORIES.flatMap((c) => c.keywords.map((kw) => ({ cat: c, kw })));
  const poiSearch: PoiSearchCompleteness[] = [];
  const failedKw = new Set<string>();
  let quotaExhausted = false;
  for (const t of tasks) {
    if (quotaExhausted) {
      failedKw.add(t.kw);
      poiSearch.push(unqueriedPoiSearch(t.kw, t.cat.id, 'server', 'skipped', true));
      continue;
    }
    try {
      const found = provider.searchPoiDetailed
        ? await provider.searchPoiDetailed(t.kw, t.cat.id, center, searchRadiusM)
        : legacyPoiSearchResult(t.kw, t.cat.id, await provider.searchPoi(t.kw, t.cat.id, center, searchRadiusM));
      pois.push(...found.pois);
      poiSearch.push(found.completeness);
      if (found.completeness.status === 'failed' || found.completeness.status === 'skipped') failedKw.add(t.kw);
      quotaExhausted = found.completeness.quotaExhausted;
    } catch (err) {
      failedKw.add(t.kw);
      // 额度耗尽：后续检索必然失败，立即中止以保护配额
      quotaExhausted = isPoiQuotaError(err);
      poiSearch.push(unqueriedPoiSearch(t.kw, t.cat.id, 'server', 'failed', quotaExhausted));
    }
  }
  const cleaned = dedupePois(pois);
  // poiOk 只按【已评分设施】判定——住宅小区是人口代理，不能掩盖评分设施检索失败
  const scoredCats = CATEGORIES.filter((c) => c.scored);
  // 可信、完整的 0 条也是有效检索，不能将“确实没有”误报为调用失败。
  const poiOk = scoredCats.some((c) => poiSearch.some((s) => s.category === c.id && (s.status === 'complete' || s.legacy)));
  const incompleteCategories = [...new Set(poiSearch.filter((s) => s.status !== 'complete' && !s.legacy).map((s) => s.category))];
  const incomplete = !poiOk || quotaExhausted || incompleteCategories.length > 0;
  step(
    '设施 POI 检索',
    Date.now() - t0,
    poiOk,
    quotaExhausted
      ? '上游配额耗尽，检索中止'
      : incomplete
        ? `检索不完整，已保留 ${cleaned.length} 条有效设施`
        : `共 ${cleaned.length} 条`
  );

  // 4b) 累积机会指标（学界标准口径）
  const cumulative = cumulativeOpportunities(field, cleaned, minutes);
  // 检索失败（区别于真实为 0）的类别：全部关键词均失败的类别
  const failedCategories = CATEGORIES.filter((c) => c.keywords.every((kw) => failedKw.has(kw))).map(
    (c) => c.id
  );
  const unavailableCategories = assessmentUnavailableCategories(failedCategories, poiSearch);
  // 5) 盲区 + 评分 + 清单（失败类别按「无法判断」贯通）
  t0 = Date.now();
  // 人口代理若未取全，不能以部分住宅作为完整分母计算“人口覆盖率”。
  const gapPois = unavailableCategories.includes('residential') ? cleaned.filter((p) => p.category !== 'residential') : cleaned;
  const gap = analyzeGaps(field, gapPois, { failedCategories: unavailableCategories });
  // 三件套或人口分母任一数据未知时，不能把“可判定子集覆盖”呈现为三件套完整覆盖。
  if (unavailableCategories.some((cat) => cat === 'residential' || CORE_CATEGORIES.includes(cat))) {
    gap.coverageShare = null;
    gap.severeShare = null;
    gap.coverageUnavailable = true;
  }
  const score = computeScore(center, cleaned, gap, { failedCategories: unavailableCategories });
  const checklist = buildChecklist(center, cleaned, { failedCategories: unavailableCategories });
  step('盲区识别与评分', Date.now() - t0, true, `总分 ${score.total}（${score.grade}）`);

  // 6) 补点规划
  t0 = Date.now();
  const planSites = planFacilitiesFromCoverage(gap, gap.coveredMasks, field, persona.speed, {
    unknownCategories: unavailableCategories
  });
  step('补点规划', Date.now() - t0, true, `${planSites.length} 条建议`);

  const counts: Record<string, number> = {};
  for (const p of cleaned) counts[p.category] = (counts[p.category] ?? 0) + 1;

  // 降级与警告：区分「数据缺失」「模型合成」「真实结论」三种口径（与 Web 端共用生成器）
  const degraded = okProbes === 0;
  const warnings = buildAnalysisWarnings({
    okProbes,
    degradedDirs: model.degradedDirs,
    probes,
    probeStraightM: probeM,
    failedCategories,
    totalWeight: gap.totalWeight,
    poiOk,
    residentialCount: cleaned.filter((p) => p.category === 'residential').length
  });
  if (quotaExhausted) {
    warnings.unshift('上游配额耗尽，部分或全部检索中止：本报告为不完整结果');
  }
  warnings.push(...poiSearchWarnings(poiSearch));
  const generatedAt = new Date().toISOString();

  return {
    center,
    centerName,
    persona: personaId,
    minutes,
    generatedAt,
    provenance: createProvenance({ generatedAt, poiSearch,
      channels: [...new Set(poiSearch.map((s) => s.source))], mock: cleaned.some((p) => p.source === 'mock') }),
    degraded,
    warnings,
    failedCategories,
    poiSearch,
    incompleteCategories,
    assessmentUnavailableCategories: unavailableCategories,
    incomplete,
    quotaExhausted,
    model: {
      dirs,
      probeM,
      factors: model.factors,
      radiusM: model.radiusM,
      degradedDirs: model.degradedDirs
    },
    rings,
    pois: cleaned,
    counts,
    score,
    checklist,
    gap: {
      blindPoints: gap.blindPoints,
      coverageShare: gap.coverageShare,
      severeShare: gap.severeShare,
      coverageUnavailable: gap.coverageUnavailable,
      patches: gap.patches.map((p) => ({
        id: p.id,
        centroid: p.centroid,
        weightShare: p.weightShare,
        missingCats: p.missingCats,
        dominant: p.dominant,
        maxNearestM: p.maxNearestM,
        severity: p.severity,
        outline: p.outline
      }))
    },
    planSites,
    cumulative,
    accuracy,
    steps
  };
}
