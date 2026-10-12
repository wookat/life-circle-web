import { dedupePois } from '../../shared/poi.js';
import { localDistM } from '../../shared/geo.js';
import { CATEGORY_MAP } from '../../shared/config.js';
import type { LatLng, Poi } from '../../shared/types.js';
import { analyzeWithServerProvider } from './provider.js';
import { buckets, callBaidu } from './baidu.js';
import { TtlCache } from './cache.js';
import { overBudget } from './usage.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// №12 任务持久化：跨重启可找回/续跑；运行中任务在重启后标记为 interrupted
const PERSIST_PATH = path.resolve(process.env.BATCH_PERSIST_FILE ?? '.batch-jobs.json');
function persistJob(job: BatchJob) {
  try {
    const all = existsSync(PERSIST_PATH) ? JSON.parse(readFileSync(PERSIST_PATH, 'utf8')) : {};
    all[job.id] = {
      id: job.id, status: job.status, createdAt: job.createdAt, centerName: job.centerName,
      center: job.center, radiusM: job.radiusM, maxCommunities: job.total,
      scope: (job as BatchJob & { scope?: string }).scope, persona: (job as BatchJob & { persona?: string }).persona,
      done: job.done, total: job.total, communities: job.communities, summary: job.summary, error: job.error,
      samples: (job as BatchJob & { samples?: Poi[] }).samples
    };
    writeFileSync(PERSIST_PATH, JSON.stringify(all));
  } catch { /* 持久化失败不影响任务本身 */ }
}
function loadPersisted(jobId: string): (BatchJob & { scope?: string; persona?: string; samples?: Poi[] }) | null {
  try {
    if (!existsSync(PERSIST_PATH)) return null;
    const all = JSON.parse(readFileSync(PERSIST_PATH, 'utf8'));
    return all[jobId] ?? null;
  } catch { return null }
}
/**
 * 街道级批量体检：以街道中心为圆心检索住宅小区作为采样点，
 * 逐个执行完整体检（服务端引擎），聚合成街道排名。
 * 任务后台串行执行（受上游 2 QPS 限制），前端轮询进度。
 */

export interface BatchCommunityResult {
  name: string;
  street: string;
  center: LatLng;
  score: number;
  grade: string;
  coverageShare: number | null;
  coverageUnavailable?: boolean;
  blindPoints: number;
  patches: number;
  dominantMissing: string | null;
  planTop: string | null;
  degraded: boolean;
  error?: string;
}

export interface StreetGroup {
  street: string;
  count: number;
  avgScore: number;
  weakCount: number;
  bestName: string | null;
  bestScore: number;
  worstName: string | null;
  worstScore: number;
}

export interface BatchJob {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled' | 'queued' | 'interrupted';
  createdAt: number;
  centerName: string;
  center: LatLng;
  radiusM: number;
  total: number;
  done: number;
  current: string;
  /** 上游请求预算（含重试的粗上界）：社区数 × 40 */
  requestBudget: number;
  requestCount: number;
  consecutiveFailures: number;
  communities: BatchCommunityResult[];
  summary: {
    avgScore: number;
    gradeDist: Record<string, number>;
    best: BatchCommunityResult | null;
    worst: BatchCommunityResult | null;
    /** 公平性视角：最优与最差的小区评分极差（分） */
    scoreGap: number;
    /** 薄弱清单：评分 < 75 或覆盖率 < 80% 的小区 */
    weakList: { name: string; score: number; coverageShare: number | null; dominantMissing: string | null }[];
    /** 城区级试点：按街道分组的聚合排名 */
    streetGroups: StreetGroup[];
  } | null;
  cancelled?: boolean;
  error?: string;
  /** №12 采样点（续跑依据），持久化时一并保存 */
  samples?: Poi[];
  maxCommunities?: number;
  scope?: 'street' | 'district';
  /** F7：本任务的人群口径（随结果持久化，脱离页面可还原） */
  persona?: 'adult' | 'elderly' | 'child';
}

const jobs = new Map<string, BatchJob>();

(function restoreOnBoot() {
  try {
    if (!existsSync(PERSIST_PATH)) return;
    const all = JSON.parse(readFileSync(PERSIST_PATH, 'utf8'));
    for (const j of Object.values<any>(all)) {
      if (j.status === 'running' || j.status === 'queued') {
        j.status = 'interrupted';
        j.error = '服务重启导致任务中断，可续跑（已完成结果保留）';
        persistJob(j as BatchJob);
      }
      jobs.set(j.id, j as BatchJob);
    }
  } catch { /* 损坏的持久化文件直接忽略 */ }
})();

function jobId(): string {
  return `bj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function searchResidentials(
  ak: string,
  center: LatLng,
  radiusM: number,
  job: BatchJob
): Promise<{ pois: Poi[]; quotaExhausted: boolean }> {
  const cache = new TtlCache<Poi[]>(6 * 3600_000, 500);
  const key = `res:${center.lat.toFixed(4)},${center.lng.toFixed(4)}:${radiusM}`;
  const hit = cache.get(key);
  if (hit) return { pois: hit, quotaExhausted: false };
  const pois: Poi[] = [];
  let quotaExhausted = false;
  for (let page = 0; page < 4; page++) {
    if (job.cancelled) return { pois: [], quotaExhausted: false };
    let rows: Poi[] | null = null;
    // 上游偶发 Internal Service Error：每页最多重试 3 次
    for (let attempt = 0; attempt < 3 && !rows; attempt++) {
      if (attempt > 0) await new Promise((res) => setTimeout(res, 400 * attempt));
      job.requestCount++;
      const r = await callBaidu(
        '/place/v2/search',
        {
          query: '小区',
          location: `${center.lat},${center.lng}`,
          radius: String(radiusM),
          radius_limit: 'true',
          scope: '2',
          page_size: '20',
          page_num: String(page)
        },
        buckets.place,
        ak
      );
      if (r.ok && r.body?.status === 0) {
        rows = (r.body.results ?? [])
          .filter((it: any) => it.location)
          .map((it: any) => ({
            uid: String(it.uid ?? it.name),
            name: String(it.name ?? ''),
            lat: it.location.lat,
            lng: it.location.lng,
            category: 'residential' as const,
            address: it.address,
            source: 'server' as const
          }));
      } else if (r.body?.status === 302) {
        quotaExhausted = true;
        break; // 天配额超限：非瞬态，提示用户明日重试
      } else if (r.body?.status !== 1 && r.httpStatus < 500) {
        break; // 其他非瞬态错误不再重试
      }
    }
    if (!rows || rows.length === 0) break;
    pois.push(...rows);
    if (rows.length < 20) break;
  }
  if (!pois.length && quotaExhausted) {
    return { pois: [], quotaExhausted: true };
  }
  const cleaned = dedupePois(pois);
  cache.set(key, cleaned);
  return { pois: cleaned, quotaExhausted: !cleaned.length && quotaExhausted };
}

/** 空间抽稀：保证采样点在片区内分布均匀（按 300m 网格去重），再截断至上限 */
function thinCommunities(pois: Poi[], maxN: number): Poi[] {
  const seen = new Set<string>();
  const thinned: Poi[] = [];
  for (const p of pois) {
    const cell = `${Math.round(p.lat / 0.0027)}:${Math.round(p.lng / 0.0033)}`;
    if (seen.has(cell)) continue;
    seen.add(cell);
    thinned.push(p);
  }
  if (thinned.length <= maxN) return thinned;
  // 按相对中心方位角排序后均匀抽取，保证覆盖各方向
  const center = pois.length ? centroid(thinned) : { lat: 0, lng: 0 };
  const withAngle = thinned
    .map((p) => ({ p, angle: Math.atan2(p.lng - center.lng, p.lat - center.lat) }))
    .sort((a, b) => a.angle - b.angle);
  const step = withAngle.length / maxN;
  const out: Poi[] = [];
  for (let i = 0; i < maxN; i++) out.push(withAngle[Math.floor(i * step)].p);
  return out;
}

function centroid(pois: Poi[]): LatLng {
  const lat = pois.reduce((a, p) => a + p.lat, 0) / pois.length;
  const lng = pois.reduce((a, p) => a + p.lng, 0) / pois.length;
  return { lat, lng };
}

/** 从逆地理编码地址中提取街道名（如「东市街道」） */
export function extractStreet(name: string): string {
  const m = name.match(/([\u4e00-\u9fa5]{2,6}街道)/);
  return m ? m[1] : '其他片区';
}

export function startStreetBatch(
  ak: string,
  center: LatLng,
  centerName: string,
  radiusM: number,
  maxCommunities: number,
  scope: 'street' | 'district' = 'street',
  persona: 'adult' | 'elderly' | 'child' = 'adult'
): BatchJob {
  const job: BatchJob = {
    id: jobId(),
    status: 'running',
    createdAt: Date.now(),
    centerName,
    center,
    radiusM,
    total: 0,
    done: 0,
    current: '检索片区内住宅小区…',
    requestBudget: maxCommunities * 80, // 分页预算 5 页后单社区最坏 ~64 次检索，放宽到 ×80
    requestCount: 0,
    consecutiveFailures: 0,
    communities: [],
    summary: null
  };
  job.maxCommunities = maxCommunities;
  (job as BatchJob & { scope?: 'street' | 'district' }).scope = scope;
  (job as BatchJob & { persona?: 'adult' | 'elderly' | 'child' }).persona = persona;
  jobAk.set(job, ak);
  jobs.set(job.id, job);
  persistJob(job);
  // №12 全局低并发排队：同一时刻仅一个批量任务执行，其余排队自动接续
  if (activeJob && activeJob.status === 'running') {
    job.status = 'queued';
    pendingQueue.push(job);
    persistJob(job);
    return job;
  }
  activeJob = job;
  void runJob(job);
  return job;
}

let activeJob: BatchJob | null = null;
const pendingQueue: BatchJob[] = [];

const runJob = async (job: BatchJob, samplesOverride?: Poi[]): Promise<void> => {
  let filtered: Poi[] = [];
  try {
    if (samplesOverride) {
      // №12 续跑：只处理未完成样本，已完成结果直接沿用，不重复计费
      job.samples = samplesOverride;
      filtered = samplesOverride;
      job.total = samplesOverride.length;
      job.done = 0;
      if (!job.total) {
        job.status = 'done';
        persistJob(job);
        return;
      }
    } else {
      const { pois: residentials, quotaExhausted } = await searchResidentials(akOf(job), job.center, job.radiusM, job);
      if (quotaExhausted) {
        job.status = 'error';
        job.error = '百度检索当日配额已耗尽（status 302），请明日重试或更换配额更高的 AK';
        return;
      }
      const samples = thinCommunities(residentials, job.maxCommunities ?? 10);
      // 限制相邻采样点过近（<300m）重复
      filtered = [];
      for (const p of samples) {
        if (filtered.every((q) => localDistM(p.lat, p.lng, q.lat, q.lng) >= 300)) filtered.push(p);
      }
      job.samples = filtered;
      job.total = filtered.length;
      if (!job.total) {
        job.status = 'error';
        job.error = '片区内未检索到住宅小区，请扩大半径或更换地点';
        return;
      }
      persistJob(job);
    }
      for (const p of filtered) {
        if (job.cancelled) {
          job.status = 'cancelled';
          job.error = '任务已取消';
          return;
        }
        if (job.requestCount > job.requestBudget) {
          job.status = 'error';
          job.error = `已超出请求预算（${job.requestBudget} 次上游调用），任务中止以保护配额`;
          return;
        }
        if (overBudget()) {
          // 本地每日预算触顶：暂停任务，已完成小区结果全部保留（非上游配额错误）
          job.status = 'error';
          job.error = `本地每日预算触顶，任务暂停于第 ${job.done + 1}/${job.total} 个小区（已完成结果保留）`;
          return;
        }
        if (job.consecutiveFailures >= 5) {
          job.status = 'error';
          job.error = '连续 5 个小区分析失败，上游可能不可用，任务中止';
          return;
        }
        job.current = p.name;
        try {
          const report = await analyzeWithServerProvider(
            { center: { lat: p.lat, lng: p.lng }, persona: (job as BatchJob & { persona?: 'adult' | 'elderly' | 'child' }).persona ?? 'adult', minutes: 15 },
            akOf(job),
            () => {
              job.requestCount++;
            }
          );
          // 额度耗尽的报告：立即终止整个任务（后续小区必然同样失败）
          if (report.quotaExhausted) {
            job.status = 'error';
            job.error = `上游配额耗尽，任务中止于第 ${job.done + 1}/${job.total} 个小区（${p.name}）`;
            return;
          }
          // 部分截断不等于社区分析失败；住宅采样成功也不能代替民生设施检索成功。
          const hasUsableFacilities = report.poiSearch.some((s) =>
            CATEGORY_MAP[s.category].scored && (s.status === 'complete' || s.legacy)
          );
          if (!hasUsableFacilities) throw new Error('数据不完整：该小区设施检索未取得可用类别');
          job.consecutiveFailures = 0;
          job.communities.push({
            name: report.centerName.includes(',') ? p.name : report.centerName,
            street: extractStreet(report.centerName),
            center: report.center,
            score: report.score.total,
            grade: report.score.grade,
            coverageShare: report.gap.coverageShare,
            coverageUnavailable: report.gap.coverageUnavailable,
            blindPoints: report.gap.blindPoints,
            patches: report.gap.patches.length,
            dominantMissing: report.gap.patches[0]
              ? String(report.gap.patches[0].dominant)
              : null,
            planTop: report.planSites[0] ? String(report.planSites[0].category) : null,
            degraded: report.degraded
          });
        } catch (err) {
          const msg = String((err as Error).message ?? err);
          // 额度耗尽：立即中止整个任务（后续小区必然同样失败），不再消耗请求
          if (msg.includes('302') || msg.includes('配额') || msg.includes('限流') || msg.includes('搜索量超限')) {
            job.status = 'error';
            job.error = `上游配额耗尽，任务中止于第 ${job.done + 1}/${job.total} 个小区（${p.name}）：${msg}`;
            return;
          }
          job.consecutiveFailures++;
          job.communities.push({
            name: p.name,
            street: extractStreet(p.name),
            center: { lat: p.lat, lng: p.lng },
            score: -1,
            grade: '-',
            coverageShare: null,
            coverageUnavailable: true,
            blindPoints: 0,
            patches: 0,
            dominantMissing: null,
            planTop: null,
            degraded: true,
            error: String((err as Error).message ?? err)
          });
        }
        job.done++;
      }
      const valid = job.communities.filter((c) => c.score >= 0);
      const sorted = [...valid].sort((a, b) => b.score - a.score);
      const gradeDist: Record<string, number> = {};
      for (const c of valid) gradeDist[c.grade] = (gradeDist[c.grade] ?? 0) + 1;
      // 城区级试点：按街道分组聚合（每街道小区数/均分/薄弱数/最优最差）
      const groupMap = new Map<string, BatchCommunityResult[]>();
      for (const c of valid) {
        const list = groupMap.get(c.street) ?? [];
        list.push(c);
        groupMap.set(c.street, list);
      }
      const streetGroups: StreetGroup[] = [...groupMap.entries()]
        .map(([street, list]) => {
          const ss = [...list].sort((a, b) => b.score - a.score);
          const avg = Math.round((list.reduce((a, c) => a + c.score, 0) / list.length) * 10) / 10;
          const weak = list.filter(
            (c) => c.score < 75 || (c.coverageShare != null && c.coverageShare < 0.8)
          ).length;
          return {
            street,
            count: list.length,
            avgScore: avg,
            weakCount: weak,
            bestName: ss[0]?.name ?? null,
            bestScore: ss[0]?.score ?? 0,
            worstName: ss[ss.length - 1]?.name ?? null,
            worstScore: ss[ss.length - 1]?.score ?? 0
          };
        })
        .sort((a, b) => b.avgScore - a.avgScore);
      job.summary = {
        avgScore: valid.length ? Math.round((valid.reduce((a, c) => a + c.score, 0) / valid.length) * 10) / 10 : 0,
        gradeDist,
        best: sorted[0] ?? null,
        worst: sorted[sorted.length - 1] ?? null,
        scoreGap: sorted.length > 1 ? sorted[0].score - sorted[sorted.length - 1].score : 0,
        weakList: valid
          .filter((c) => c.score < 75 || (c.coverageShare != null && c.coverageShare < 0.8))
          .sort((a, b) => a.score - b.score)
          .map((c) => ({
            name: c.name,
            score: c.score,
            coverageShare: c.coverageShare ?? null,
            dominantMissing: c.dominantMissing
          })),
        streetGroups
      };
      job.status = 'done';
    } catch (err) {
      job.status = 'error';
      job.error = String((err as Error).message ?? err);
    }
    // №12 任务结算：释放全局执行位、持久化并接续排队任务
    if (activeJob === job) activeJob = null;
    persistJob(job);
    const next = pendingQueue.shift();
    if (next && next.status === 'queued') {
      next.status = 'running';
      activeJob = next;
      persistJob(next);
      void runJob(next);
    }
  };

/** ak 不进持久化文件：进程内 WeakMap 保存，续跑由路由层重新注入 */
const jobAk = new WeakMap<BatchJob, string>();
function akOf(job: BatchJob): string {
  return jobAk.get(job) ?? '';
}

/** №12 续跑：只处理未完成样本（已完成结果沿用，不重复计费） */
export function resumeStreetBatch(ak: string, prevId: string, mode: 'remaining' | 'failed' = 'remaining'): BatchJob | null {
  const prev = jobs.get(prevId) ?? loadPersisted(prevId);
  if (!prev || !prev.samples?.length) return null;
  if (prev.status === 'running' || prev.status === 'queued') return jobs.get(prevId) ?? null;
  const okCenters = prev.communities.filter((c) => c.score >= 0).map((c) => c.center);
  const failedCenters = prev.communities.filter((c) => c.score < 0).map((c) => c.center);
  const isDone = (s: Poi) => okCenters.some((c) => localDistM(c.lat, c.lng, s.lat, s.lng) <= 50);
  const remaining = mode === 'failed'
    ? prev.samples.filter((s) => !isDone(s) && (failedCenters.some((c) => localDistM(c.lat, c.lng, s.lat, s.lng) <= 50) || okCenters.length === 0))
    : prev.samples.filter((s) => !isDone(s));
  if (!remaining.length) return null;
  // 手工构造续跑任务：不走 startStreetBatch（避免其自动搜索空跑与续跑并发竞争）
  const carried = prev.communities.filter((c) => c.score >= 0);
  const job: BatchJob = {
    id: jobId(), status: 'running', createdAt: Date.now(),
    centerName: prev.centerName, center: prev.center, radiusM: prev.radiusM,
    total: remaining.length, done: carried.length, current: '',
    requestBudget: remaining.length * 40, requestCount: 0, consecutiveFailures: 0,
    communities: carried, summary: null,
    samples: remaining, maxCommunities: prev.maxCommunities ?? 10,
    scope: (prev as BatchJob & { scope?: 'street' | 'district' }).scope ?? 'street',
    persona: (prev as BatchJob & { persona?: 'adult' | 'elderly' | 'child' }).persona ?? 'adult'
  };
  jobAk.set(job, ak);
  jobs.set(job.id, job);
  persistJob(job);
  if (activeJob && activeJob.status === 'running') {
    job.status = 'queued';
    pendingQueue.push(job);
    persistJob(job);
    return job;
  }
  activeJob = job;
  void runJob(job, remaining);
  return job;
}

/** 列出任务（内存 + 持久化文件），供「任务找回」 */
export function listJobs(): BatchJob[] {
  const all = new Map<string, BatchJob>();
  try {
    if (existsSync(PERSIST_PATH)) {
      const stored = JSON.parse(readFileSync(PERSIST_PATH, 'utf8')) as Record<string, BatchJob>;
      for (const j of Object.values(stored)) all.set(j.id, j);
    }
  } catch { /* 忽略损坏文件 */ }
  for (const j of jobs.values()) all.set(j.id, j);
  return [...all.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
}

export function getJob(id: string): BatchJob | undefined {
  return jobs.get(id);
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelled = true;
  return true;
}

/** 清理超过 2 小时的旧任务 */
export function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 2 * 3600_000) jobs.delete(id);
  }
}
