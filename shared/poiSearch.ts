import { dedupePois } from './poi.js';
import type { CategoryId, ChannelName, Poi, PoiSearchCompleteness, PoiSearchResult, PoiSearchStatus } from './types.js';

export const POI_PAGE_SIZE = 20;
/** 单关键词分页预算：5 页 × 20 条 = 100 条。百度 place 单页上限 20 条，只能加页数；
 *  调大这里即可放宽（配额成本：单次分析最坏 12 关键词 × 5 页 = 60 次检索调用）。 */
export const POI_PAGE_LIMIT = 5;
/** 住宅小区是人口覆盖率与盲区权重的分母，预算加倍（10 页 = 200 条）。 */
export const POI_PAGE_LIMIT_RESIDENTIAL = POI_PAGE_LIMIT * 2;

/** 分页预算上限按类别：住宅（人口分母）加倍。 */
function pageCapFor(category: CategoryId): number {
  return category === 'residential' ? POI_PAGE_LIMIT_RESIDENTIAL : POI_PAGE_LIMIT;
}

/** 各通道只需将一页返回映射到此契约；页号从 0 开始。 */
export interface PoiSearchPage {
  pois: Poi[];
  reportedTotal?: number | null;
  rawCount?: number;
  collectedAt?: string;
  cacheHit?: boolean;
  source?: ChannelName;
}

export interface PoiSearchOptions {
  keyword: string;
  category: CategoryId;
  source: ChannelName;
  fetchPage: (page: number, pageSize: number) => Promise<PoiSearchPage>;
  /** 动态预算上限：住宅（人口分母）10 页 = 200 条，其余 5 页 = 100 条。 */
  pageLimit?: number;
  pageSize?: number;
  /** 页级进度回调：每取完一页调用（关键词/页码/已取条数/预算），供 UI 显示动态进度 */
  onPage?: (info: { keyword: string; page: number; fetched: number; budget: number }) => void;
}

export function isPoiQuotaError(error: unknown): boolean {
  const value = error as { status?: unknown; code?: unknown; httpStatus?: unknown; message?: unknown } | null;
  const codes = [value?.status, value?.code, value?.httpStatus].map(Number);
  if (codes.some((code) => [302, 303, 304, 401, 429].includes(code))) return true;
  const message = String(value?.message ?? error ?? '');
  return /(?:^|\D)(302|303|304|401|429)(?:\D|$)|配额|限流|quota|daily\s*limit/i.test(message);
}

function totalOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timestampOf(value?: string): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString();
}

function bounded(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(fallback, Math.floor(value!))) : fallback;
}

/**
 * 串行、小预算检索。达到预算或任一页失败立即停止，保留成功页。
 * 只有可信 total 且已遍历到末页才能声明 complete；未知总量绝不冒充全量。
 */
export async function searchPoiPages(options: PoiSearchOptions): Promise<PoiSearchResult> {
  const pageSize = bounded(options.pageSize, POI_PAGE_SIZE);
  const cap = bounded(options.pageLimit, pageCapFor(options.category));
  // 动态预算：初始用类别上限；首页拿到 reportedTotal 后精确收紧为 ceil(total/页大小)——需要几页取几页
  let pageLimit = cap;
  const pois: Poi[] = [];
  let rawCount = 0;
  let pagesFetched = 0;
  let reportedTotal: number | null = null;
  let source = options.source;
  let collectedAt = new Date().toISOString();
  let cacheHit = true;
  let quotaExhausted = false;
  let totalChanged = false;
  let invalidRows = false;
  let missingTotal = false;
  let previousTotal: number | null | undefined;
  const finish = (status: PoiSearchStatus, reason?: string): PoiSearchResult => {
    const clean = dedupePois(pois);
    return {
      pois: clean,
      completeness: {
        keyword: options.keyword, category: options.category, status, reportedTotal,
        rawCount, fetchedCount: clean.length, pagesFetched, pageSize, pageLimit,
        quotaExhausted, collectedAt, cacheHit: pagesFetched > 0 && cacheHit,
        source, ...(reason ? { reason } : {})
      }
    };
  };
  for (let page = 0; page < pageLimit; page++) {
    let batch: PoiSearchPage;
    try {
      batch = await options.fetchPage(page, pageSize);
    } catch (error) {
      quotaExhausted = isPoiQuotaError(error);
      cacheHit = false;
      return finish(pagesFetched ? 'partial' : 'failed', quotaExhausted
        ? '配额或限流导致检索停止，未继续调用后续页'
        : `第 ${page + 1} 页检索失败，已保留此前结果`);
    }
    // 不将一页真实数据与另一页合成数据拼成貌似完整的查询。
    if (pagesFetched && batch.source && batch.source !== source) {
      cacheHit = false;
      return finish('partial', '分页数据通道发生变化，已停止拼接不同来源的数据');
    }
    source = batch.source ?? source;
    const pageTime = timestampOf(batch.collectedAt);
    if (!pagesFetched || pageTime < collectedAt) collectedAt = pageTime;
    cacheHit = cacheHit && batch.cacheHit === true;
    pagesFetched++;
    const total = totalOf(batch.reportedTotal);
    if (total == null) missingTotal = true;
    if (previousTotal !== undefined && previousTotal !== total) totalChanged = true;
    previousTotal = total;
    if (total != null) {
      reportedTotal = Math.max(reportedTotal ?? 0, total);
      // 动态收紧：ceil(total/页大小) 与当前预算取小——绝不为已可判定取尽的检索多花钱
      pageLimit = Math.min(pageLimit, Math.max(1, Math.ceil(reportedTotal / pageSize)));
    }
    const rows = totalOf(batch.rawCount) ?? batch.pois.length;
    rawCount += rows;
    if (rows !== batch.pois.length) invalidRows = true;
    // dedupePois 过滤掉不合法坐标；同名多条设施去重不等于遗漏。
    const validRaw = batch.pois.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0));
    if (validRaw.length !== batch.pois.length) invalidRows = true;
    const before = dedupePois(pois).length;
    pois.push(...validRaw);
    const after = dedupePois(pois).length;
    if (page > 0 && rows > 0 && after === before) {
      return finish('partial', '后续页未返回新的有效设施，无法确认分页已取全');
    }
    const reachedTotal = reportedTotal != null && rawCount >= reportedTotal;
    const lastPage = rows < pageSize;
    if (reachedTotal || lastPage) {
      if (totalChanged) return finish('partial', '分页期间上游总数发生变化，建议稍后复核');
      if (invalidRows) return finish('partial', '部分上游条目缺少有效坐标，查得数量不代表完整设施清单');
      if (missingTotal) return finish('unknown', '上游未提供可信总数，无法确认检索完整性');
      if (reportedTotal != null && rawCount > reportedTotal) return finish('partial', '上游总数小于已返回条目数，完整性无法确认');
      if (reachedTotal) return finish('complete');
      return finish('partial', '末页条目少于页大小，但累计条目尚未达到上游总数');
    }
  }
  if (totalChanged || invalidRows) return finish('partial', totalChanged
    ? '分页期间上游总数发生变化，且已达到分页预算'
    : '部分条目无有效坐标，且已达到分页预算');
  return finish(missingTotal ? 'unknown' : 'truncated', missingTotal
    ? `已达到 ${pageLimit} 页预算，且上游总数未知`
    : `已达到 ${pageLimit} 页预算，尚未取完上游结果`);
}

/** 兼容仅返回 Poi[] 的旧扩展接口；保留估算能力，但不能称为完整检索。 */
export function legacyPoiSearchResult(keyword: string, category: CategoryId, pois: Poi[]): PoiSearchResult {
  const clean = dedupePois(pois);
  return {
    pois: clean,
    completeness: {
      keyword, category, status: 'unknown', reportedTotal: null, rawCount: pois.length,
      fetchedCount: clean.length, pagesFetched: 1, pageSize: POI_PAGE_SIZE, pageLimit: 1,
      quotaExhausted: false, collectedAt: new Date().toISOString(), cacheHit: false,
      source: pois[0]?.source ?? 'server', legacy: true,
      reason: '旧检索接口未提供总数与分页信息，结果仅供估算'
    }
  };
}

export function unqueriedPoiSearch(
  keyword: string, category: CategoryId, source: ChannelName,
  status: 'failed' | 'skipped', quotaExhausted = false
): PoiSearchCompleteness {
  return {
    keyword, category, status, reportedTotal: null, rawCount: 0, fetchedCount: 0,
    pagesFetched: 0, pageSize: POI_PAGE_SIZE, pageLimit: POI_PAGE_LIMIT, quotaExhausted,
    collectedAt: new Date().toISOString(), cacheHit: false, source,
    reason: status === 'skipped' ? '前序检索耗尽配额，后续检索未执行' : '首次检索失败，不能判定该类设施缺失'
  };
}

/** 真实详细检索只要不完整就不可据此推断不存在设施；legacy 保留兼容估算。 */
export function assessmentUnavailableCategories(
  failed: CategoryId[], searches: PoiSearchCompleteness[]
): CategoryId[] {
  return [...new Set([...failed, ...searches
    .filter((s) => s.status !== 'complete' && !s.legacy)
    .map((s) => s.category)])];
}

export function poiSearchWarnings(searches: PoiSearchCompleteness[]): string[] {
  const warnings: string[] = [];
  const incomplete = searches.filter((s) => s.status !== 'complete' && !s.legacy);
  if (incomplete.length) {
    warnings.push(`设施检索不完整：${incomplete.map((s) => `${s.keyword}（已取 ${s.fetchedCount}${s.reportedTotal == null ? ' 条，总量未知' : '/' + s.reportedTotal + ' 条'}）`).join('、')}。查得数量仅为下界；相关类别不据此判定缺失或推荐补建。`);
  }
  if (searches.some((s) => s.legacy)) warnings.push('部分检索接口未提供总量与分页信息，相关评分仅为估算，不能声称设施检索已取全。');
  return warnings;
}
