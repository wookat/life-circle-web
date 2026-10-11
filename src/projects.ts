import type { AnalysisResult, CategoryId, LatLng, PlanSite } from '../shared/types.js';
import { PERSONA_MAP } from '../shared/config.js';
import { APPLICATION_VERSION, ALGORITHM_VERSION, RULE_VERSION, ruleFingerprint } from '../shared/provenance.js';
import { comparisonBaseline, type PlanScenarios, type PlanScenario } from '../shared/comparison.js';

export interface WorkbenchSnapshot {
  acceptedSites: PlanSite[]; rejectedSites: PlanSite[]; scenarios?: PlanScenarios;
  /** №7 自定义候选落点（含手动添加的补点候选） */
  customCandidates?: { latLng: LatLng; category: PlanSite['category'] }[];
  /** №7 禁建区（圆心 + 半径米） */
  noGoZones?: { center: LatLng; radiusM: number }[];
  /** №8 预算约束（成本为规划假设，非工程概算） */
  budget?: { maxSites?: number; costPerSiteWan?: number; totalBudgetWan?: number };
}
export interface ProjectSnapshot {
  format: 'life-circle-project'; schemaVersion: 1;
  id: string; name: string; createdAt: string; updatedAt: string;
  result: AnalysisResult; workbench: WorkbenchSnapshot;
}
export interface ProjectSummary {
  id: string; name: string; createdAt: string; updatedAt: string;
  centerName: string; persona: AnalysisResult['persona']; minutes: number;
}
export type ProjectErrorCode = 'invalid' | 'incompatible' | 'too_large' | 'corrupt' | 'storage_unavailable' | 'storage_full' | 'not_found';
export class ProjectError extends Error {
  constructor(public readonly code: ProjectErrorCode, message: string) { super(message); this.name = 'ProjectError'; }
}
export const PROJECT_STORAGE_KEY = 'life-circle:projects:v1';
export const MAX_PROJECT_BYTES = 8 * 1024 * 1024;
const MAX_STORAGE_BYTES = 4 * 1024 * 1024;
const MAX_PROJECTS = 20;
const CATS: CategoryId[] = ['hospital', 'clinic', 'pharmacy', 'market', 'supermarket', 'primarySchool', 'kindergarten', 'elderly', 'busStop', 'park', 'residential'];
const CORE = ['market', 'pharmacy', 'primarySchool'];
type Obj = Record<string, unknown>;
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function bad(path: string): never { throw new ProjectError('invalid', `项目文件内容不完整或无效（${path}），未载入。`); }
function obj(v: unknown, p: string): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) bad(p);
  return v as Obj;
}
function str(v: unknown, p: string, max = 2000): string {
  if (typeof v !== 'string' || v.length > max) bad(p);
  return v;
}
function num(v: unknown, p: string, min = 0, max = 1e12): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad(p);
  return v;
}
function integer(v: unknown, p: string, min = 0, max = 1e7): number {
  const n = num(v, p, min, max); if (!Number.isInteger(n)) bad(p); return n;
}
function bool(v: unknown, p: string): boolean { if (typeof v !== 'boolean') bad(p); return v; }
function nullable(v: unknown, p: string, max = 1e12): number | null { return v === null ? null : num(v, p, 0, max); }
function en<T extends string>(v: unknown, allowed: readonly T[], p: string): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) bad(p); return v as T;
}
function arr<T>(v: unknown, p: string, read: (v: unknown, p: string) => T, max = 10000): T[] {
  if (!Array.isArray(v) || v.length > max) bad(p);
  return v.map((x, i) => read(x, `${p}[${i}]`));
}
const cat = (v: unknown, p: string) => en(v, CATS, p);
const texts = (v: unknown, p: string) => arr(v, p, (x, q) => str(x, q), 100);
const cats = (v: unknown, p: string) => arr(v, p, cat, CATS.length);
function point(v: unknown, p: string): LatLng {
  const o = obj(v, p); return { lat: num(o.lat, `${p}.lat`, -85, 85), lng: num(o.lng, `${p}.lng`, -180, 180) };
}
function timestamp(v: unknown, p: string): string {
  const s = str(v, p, 40); if (!/^\d{4}-\d\d-\d\dT/.test(s) || !Number.isFinite(Date.parse(s))) bad(p); return s;
}
function lines(v: unknown, p: string): LatLng[][] {
  const result = arr(v, p, (x, q) => arr(x, q, point, 65536), 2000);
  if (result.reduce((n, line) => n + line.length, 0) > 100000) bad(p); return result;
}
function vector(v: unknown, p: string, size: number, kind: 'time' | 'weight' | 'mask' | 'missing') {
  if (!(Array.isArray(v) || v instanceof Float64Array || v instanceof Uint8Array) || v.length !== size) bad(p);
  const values = Array.from(v as ArrayLike<unknown>, (x, i) => {
    if (kind === 'time' && (x === null || (typeof x === 'number' && Number.isNaN(x)))) return NaN;
    if (kind === 'time' && (x === Infinity || x === 'Infinity')) return Infinity;
    return kind === 'mask' || kind === 'missing' ? integer(x, `${p}[${i}]`, 0, kind === 'mask' ? 1 : 3) : num(x, `${p}[${i}]`);
  });
  return kind === 'mask' || kind === 'missing' ? new Uint8Array(values) : new Float64Array(values);
}
function site(v: unknown, p: string): PlanSite {
  const o = obj(v, p);
  return { rank: integer(o.rank, `${p}.rank`, 1, 1000), latLng: point(o.latLng, p), category: cat(o.category, p),
    coveredCells: integer(o.coveredCells, p), coveredWeight: num(o.coveredWeight, p), beforePct: num(o.beforePct, p, 0, 100),
    afterPct: num(o.afterPct, p, 0, 100), estWalkMin: num(o.estWalkMin, p), rationale: str(o.rationale, p) };
}
function result(v: unknown): AnalysisResult {
  const r = obj(v, 'result'), m = obj(r.model, 'model'), f = obj(r.field, 'field'), g = obj(r.gap, 'gap');
  const s = obj(r.score, 'score'), dims = obj(s.dims, 'score.dims');
  const n = integer(f.n, 'field.n', 2, 256), size = n * n, dirs = integer(m.dirs, 'model.dirs', 1, 360);
  if (integer(g.n, 'gap.n') !== n) bad('gap.n 与 field.n');
  const factors = arr(m.factors, 'model.factors', (x, p) => num(x, p), 360);
  const radiusM = arr(m.radiusM, 'model.radiusM', (x, p) => num(x, p), 360);
  if (factors.length !== dirs || radiusM.length !== dirs) bad('model 方向数量');
  const masks = obj(g.coveredMasks, 'gap.coveredMasks');
  const coveredMasks = Object.fromEntries(CORE.map(c => [c, vector(masks[c], `gap.coveredMasks.${c}`, size, 'mask') as Uint8Array]));
  const out: AnalysisResult = {
    center: point(r.center, 'center'), centerName: str(r.centerName, 'centerName'), persona: en(r.persona, ['adult', 'elderly', 'child'], 'persona'),
    minutes: num(r.minutes, 'minutes', 1, 120), generatedAt: timestamp(r.generatedAt, 'generatedAt'),
    model: { center: point(m.center, 'model.center'), dirs, factors, radiusM, probeM: num(m.probeM, 'model.probeM'), minutes: num(m.minutes, 'model.minutes', 1, 120), speed: num(m.speed, 'model.speed', 1, 1000), degradedDirs: integer(m.degradedDirs, 'model.degradedDirs', 0, dirs) },
    field: { n, cellM: num(f.cellM, 'field.cellM', 0.01), center: point(f.center, 'field.center'), latMax: num(f.latMax, 'field.latMax', -90, 90), lngMin: num(f.lngMin, 'field.lngMin', -180, 180), t: vector(f.t, 'field.t', size, 'time') as Float64Array, maxMinutes: num(f.maxMinutes, 'field.maxMinutes'), minutes: num(f.minutes, 'field.minutes', 1, 120), speed: num(f.speed, 'field.speed', 1, 1000) },
    rings: arr(r.rings, 'rings', (x, p) => { const o = obj(x, p); return { level: num(o.level, p, 0, 120), lines: lines(o.lines, p) }; }, 10),
    pois: arr(r.pois, 'pois', (x, p) => { const o = obj(x, p); return { uid: str(o.uid, p, 300), name: str(o.name, p), ...point(o, p), category: cat(o.category, p), source: en(o.source, ['server', 'client', 'mock'], p), ...(o.address !== undefined ? { address: str(o.address, p) } : {}) }; }),
    gap: { n, cellM: num(g.cellM, 'gap.cellM', 0.01), weightGrid: vector(g.weightGrid, 'gap.weightGrid', size, 'weight') as Float64Array,
      totalWeight: num(g.totalWeight, 'gap.totalWeight'), missingGrid: vector(g.missingGrid, 'gap.missingGrid', size, 'missing') as Uint8Array, coveredMasks,
      patches: arr(g.patches, 'gap.patches', (x, p) => { const o = obj(x, p); return { id: integer(o.id, p), cells: arr(o.cells, p, (c, q) => integer(c, q, 0, size - 1), size), weight: num(o.weight, p), weightShare: num(o.weightShare, p, 0, 1), centroid: point(o.centroid, p), missingCats: cats(o.missingCats, p), dominant: cat(o.dominant, p), maxNearestM: num(o.maxNearestM, p), outline: lines(o.outline, p), severity: en(o.severity, ['severe', 'moderate'], p) }; }, 2000),
      unknownCategories: cats(g.unknownCategories, 'gap.unknownCategories'), coverageShare: nullable(g.coverageShare, 'gap.coverageShare', 1), severeShare: nullable(g.severeShare, 'gap.severeShare', 1), coverageUnavailable: bool(g.coverageUnavailable, 'gap.coverageUnavailable'), blindPoints: integer(g.blindPoints, 'gap.blindPoints', 0, size) },
    score: { total: num(s.total, 'score.total', 0, 100), grade: en(s.grade, ['A', 'B', 'C', 'D', 'E'], 'score.grade'), dims: { completeness: num(dims.completeness, 'score.dims.completeness', 0, 1), proximity: num(dims.proximity, 'score.dims.proximity', 0, 1), coverage: nullable(dims.coverage, 'score.dims.coverage', 1), diversity: num(dims.diversity, 'score.dims.diversity', 0, 1.0000001) },
      details: arr(s.details, 'score.details', (x, p) => { const o = obj(x, p); return { category: cat(o.category, p), name: str(o.name, p), count: integer(o.count, p), ideal: num(o.ideal, p), completeness: num(o.completeness, p, 0, 1), nearestM: nullable(o.nearestM, p), proximity: num(o.proximity, p, 0, 1), ...(o.missingData === undefined ? {} : { missingData: bool(o.missingData, p) }) }; }, 50), summary: str(s.summary, 'score.summary', 10000),
      ...(s.coverageUnavailable === undefined ? {} : { coverageUnavailable: bool(s.coverageUnavailable, 'score.coverageUnavailable') }), ...(s.missingDataCategories === undefined ? {} : { missingDataCategories: texts(s.missingDataCategories, 'score.missingDataCategories') }) },
    checklist: arr(r.checklist, 'checklist', (x, p) => { const o = obj(x, p); return { id: str(o.id, p, 100), name: str(o.name, p), basis: str(o.basis, p), thresholdM: num(o.thresholdM, p), met: o.met === null ? null : bool(o.met, p), nearestM: nullable(o.nearestM, p), count: integer(o.count, p), ...(o.unavailable === undefined ? {} : { unavailable: bool(o.unavailable, p) }) }; }, 100),
    planSites: arr(r.planSites, 'planSites', site, 100), crossings: r.crossings === null ? null : (() => { const o = obj(r.crossings, 'crossings'); return { scanned: integer(o.scanned, 'crossings.scanned'), overpass: integer(o.overpass, 'crossings.overpass'), underpass: integer(o.underpass, 'crossings.underpass'), crosswalkHint: integer(o.crosswalkHint, 'crossings.crosswalkHint') }; })(),
    steps: arr(r.steps, 'steps', (x, p) => { const o = obj(x, p), u = obj(o.usage, p); return { name: str(o.name, p), usage: { channel: en(u.channel, ['server', 'client', 'mock'], p), ms: num(u.ms, p), ...(u.cacheHit === undefined ? {} : { cacheHit: bool(u.cacheHit, p) }), ...(u.note === undefined ? {} : { note: str(u.note, p) }) } }; }, 100), mock: bool(r.mock, 'mock')
  };
  // Restored map and planning use these copies together; mixed parameters are not a valid snapshot.
  for (const [label, center] of [['model.center', out.model.center], ['field.center', out.field.center]] as const) {
    if (center.lat !== out.center.lat || center.lng !== out.center.lng) bad(`${label} 与 center 不一致`);
  }
  if (out.model.minutes !== out.minutes || out.field.minutes !== out.minutes) bad('模型、网格与报告的时长不一致');
  if (out.model.speed !== out.field.speed) bad('模型与网格的步行速度不一致');
  if (out.field.cellM !== out.gap.cellM) bad('field.cellM 与 gap.cellM 不一致');
  if (r.warnings !== undefined) out.warnings = texts(r.warnings, 'warnings');
  if (r.failedCategories !== undefined) out.failedCategories = cats(r.failedCategories, 'failedCategories');
  if (r.incomplete !== undefined) out.incomplete = bool(r.incomplete, 'incomplete');
  if (r.quotaExhausted !== undefined) out.quotaExhausted = bool(r.quotaExhausted, 'quotaExhausted');
  if (r.cumulative !== undefined) {
    const c = obj(r.cumulative, 'cumulative'), counts = obj(c.byCategory, 'cumulative.byCategory');
    out.cumulative = { total: integer(c.total, 'cumulative.total'), byCategory: Object.fromEntries(CATS.filter(k => counts[k] !== undefined).map(k => [k, integer(counts[k], `cumulative.${k}`)])), categoriesCovered: integer(c.categoriesCovered, 'cumulative.categoriesCovered', 0, CATS.length), missingCategories: cats(c.missingCategories, 'cumulative.missingCategories') };
  }
  if (r.accuracy !== undefined) {
    const a = obj(r.accuracy, 'accuracy'); out.accuracy = { samples: integer(a.samples, 'accuracy.samples'), maeMinutes: num(a.maeMinutes, 'accuracy.maeMinutes'), maePercent: num(a.maePercent, 'accuracy.maePercent'), worstPercent: num(a.worstPercent, 'accuracy.worstPercent') };
  }
  if (r.popCoverage !== undefined) {
    if (r.popCoverage === null) { out.popCoverage = null; }
    else {
      const c = obj(r.popCoverage, 'popCoverage');
      if (c.source !== 'worldpop-2020') bad('popCoverage.source 不识别');
      out.popCoverage = { share: num(c.share, 'popCoverage.share', 0, 1), popIn: num(c.popIn, 'popCoverage.popIn'), popEval: num(c.popEval, 'popCoverage.popEval'), radiusM: num(c.radiusM, 'popCoverage.radiusM'), source: 'worldpop-2020' };
    }
  }
  if (r.incompleteCategories !== undefined) out.incompleteCategories = cats(r.incompleteCategories, 'incompleteCategories');
  if (r.assessmentUnavailableCategories !== undefined) out.assessmentUnavailableCategories = cats(r.assessmentUnavailableCategories, 'assessmentUnavailableCategories');
  if (r.poiSearch !== undefined) out.poiSearch = arr(r.poiSearch, 'poiSearch', (x, p) => {
    const o = obj(x, p);
    return { keyword: str(o.keyword, p, 200), category: cat(o.category, p), status: en(o.status, ['complete', 'truncated', 'partial', 'unknown', 'failed', 'skipped'], p),
      reportedTotal: nullable(o.reportedTotal, p), rawCount: integer(o.rawCount, p), fetchedCount: integer(o.fetchedCount, p), pagesFetched: integer(o.pagesFetched, p), pageSize: integer(o.pageSize, p), pageLimit: integer(o.pageLimit, p), quotaExhausted: bool(o.quotaExhausted, p), collectedAt: timestamp(o.collectedAt, p), cacheHit: bool(o.cacheHit, p), source: en(o.source, ['server', 'client', 'mock'], p),
      ...(o.reason === undefined ? {} : { reason: str(o.reason, p) }), ...(o.legacy === undefined ? {} : { legacy: bool(o.legacy, p) }) };
  }, 200);
  if (r.provenance !== undefined) {
    const p = obj(r.provenance, 'provenance'); if (p.schemaVersion !== 1) bad('provenance.schemaVersion');
    out.provenance = { schemaVersion: 1, reportId: str(p.reportId, 'provenance.reportId', 100), generatedAt: timestamp(p.generatedAt, 'provenance.generatedAt'), applicationVersion: str(p.applicationVersion, 'provenance.applicationVersion', 100), algorithmVersion: str(p.algorithmVersion, 'provenance.algorithmVersion', 100), ruleVersion: str(p.ruleVersion, 'provenance.ruleVersion', 100), ruleFingerprint: str(p.ruleFingerprint, 'provenance.ruleFingerprint', 100), coordinateSystem: en(p.coordinateSystem, ['BD-09'], 'provenance.coordinateSystem'), populationBasis: en(p.populationBasis, ['residential-poi-proxy'], 'provenance.populationBasis'), channels: arr(p.channels, 'provenance.channels', (x, q) => en(x, ['server', 'client', 'mock'], q), 3), mock: bool(p.mock, 'provenance.mock'), poiCollectedAt: p.poiCollectedAt === null ? null : timestamp(p.poiCollectedAt, 'provenance.poiCollectedAt'), poiCacheHits: integer(p.poiCacheHits, 'provenance.poiCacheHits'), poiQueries: integer(p.poiQueries, 'provenance.poiQueries') };
    // Historical snapshots keep their original speed. Only a snapshot claiming the exact
    // current rules must agree with current persona settings; the UI locks old planning.
    const provenance = out.provenance;
    const currentRules = provenance.applicationVersion === APPLICATION_VERSION && provenance.algorithmVersion === ALGORITHM_VERSION &&
      provenance.ruleVersion === RULE_VERSION && provenance.ruleFingerprint === ruleFingerprint();
    if (currentRules && out.model.speed !== PERSONA_MAP[out.persona].speed) bad('当前规则的人群与步行速度不一致');
  }
  return out;
}
function snapshot(v: unknown): ProjectSnapshot {
  const o = obj(v, '项目');
  if (o.format !== 'life-circle-project') throw new ProjectError('incompatible', '这不是完整项目文件。旧版报告摘要 JSON 无法恢复地图与规划，请导入“项目快照”。');
  if (o.schemaVersion !== 1) throw new ProjectError('incompatible', '项目格式版本不兼容，请使用对应版本的圈点打开。');
  const id = str(o.id, 'id', 100); if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) bad('id');
  const name = str(o.name, 'name', 100).trim(); if (!name) bad('name');
  const w = obj(o.workbench, 'workbench');
  const analysis = result(o.result);
  const workbench: WorkbenchSnapshot = { acceptedSites: arr(w.acceptedSites, 'workbench.acceptedSites', site, 100), rejectedSites: arr(w.rejectedSites, 'workbench.rejectedSites', site, 100) };
    if (w.customCandidates !== undefined) {
      workbench.customCandidates = arr(w.customCandidates, 'workbench.customCandidates', (x, p) => {
        const o = obj(x, p);
        return { latLng: point(o.latLng, `${p}.latLng`), category: cat(o.category, `${p}.category`) };
      }, 100);
    }
    if (w.noGoZones !== undefined) {
      workbench.noGoZones = arr(w.noGoZones, 'workbench.noGoZones', (x, p) => {
        const o = obj(x, p);
        return { center: point(o.center, `${p}.center`), radiusM: num(o.radiusM, `${p}.radiusM`, 0, 10000) };
      }, 50);
    }
    if (w.budget !== undefined) {
      const bo = obj(w.budget, 'workbench.budget');
      const b: WorkbenchSnapshot['budget'] = {};
      if (bo.maxSites !== undefined) b.maxSites = integer(bo.maxSites, 'workbench.budget.maxSites', 0, 100);
      if (bo.costPerSiteWan !== undefined) b.costPerSiteWan = num(bo.costPerSiteWan, 'workbench.budget.costPerSiteWan', 0, 1e6);
      if (bo.totalBudgetWan !== undefined) b.totalBudgetWan = num(bo.totalBudgetWan, 'workbench.budget.totalBudgetWan', 0, 1e7);
      workbench.budget = b;
    }
  if (w.scenarios !== undefined) {
    const saved = obj(w.scenarios, 'workbench.scenarios');
    if (Object.keys(saved).some(k => k !== 'A' && k !== 'B')) bad('方案只支持 A / B');
    workbench.scenarios = {};
    const baseline = comparisonBaseline(analysis);
    for (const key of ['A', 'B'] as const) {
      if (saved[key] === undefined) continue;
      const s = obj(saved[key], `scenarios.${key}`);
      const scenario: PlanScenario = { baselineKey: str(s.baselineKey, 'scenario.baselineKey', 100), savedAt: timestamp(s.savedAt, 'scenario.savedAt'),
        acceptedSites: arr(s.acceptedSites, 'scenario.acceptedSites', site, 100), rejectedSites: arr(s.rejectedSites, 'scenario.rejectedSites', site, 100) };
      if (scenario.baselineKey !== baseline) bad(`方案 ${key} 的社区、数据或规则与项目基线不一致`);
      workbench.scenarios[key] = scenario;
    }
  }
  return { format: 'life-circle-project', schemaVersion: 1, id, name, createdAt: timestamp(o.createdAt, 'createdAt'), updatedAt: timestamp(o.updatedAt, 'updatedAt'), result: analysis, workbench };
}
function json(text: string, max = MAX_PROJECT_BYTES): unknown {
  if (typeof text !== 'string' || text.length > max || new TextEncoder().encode(text).byteLength > max) throw new ProjectError('too_large', '项目文件过大，请导入不超过 8 MB 的完整项目。');
  try {
    return JSON.parse(text, (key, value) => {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') bad('不安全的对象字段');
      return value;
    });
  } catch (e) { if (e instanceof ProjectError) throw e; throw new ProjectError('invalid', '项目文件不是有效的 JSON，未载入。'); }
}
const encode = (v: unknown) => JSON.stringify(v, (_key, value) => value instanceof Float64Array || value instanceof Uint8Array ? Array.from(value, x => Number.isNaN(x) ? null : x === Infinity ? 'Infinity' : x) : value);

/** Explicit field allowlist: runtime objects, configuration and credentials never enter the snapshot. */
export function createProject(r: AnalysisResult, workbench: WorkbenchSnapshot, name: string, previous?: ProjectSnapshot): ProjectSnapshot {
  const now = new Date().toISOString();
  const id = previous?.id ?? `project_${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
  return snapshot({ format: 'life-circle-project', schemaVersion: 1, id, name, createdAt: previous?.createdAt ?? now, updatedAt: now, result: r, workbench });
}
export function serializeProject(project: ProjectSnapshot): string {
  const text = encode(snapshot(project));
  if (new TextEncoder().encode(text).byteLength > MAX_PROJECT_BYTES) throw new ProjectError('too_large', '项目快照超过 8 MB，未导出或保存。');
  return text;
}
export function parseProject(text: string): ProjectSnapshot { return snapshot(json(text)); }

/** №19 历史趋势：只读列出本地保存的全部项目（损坏条目跳过，不抛错） */
export function readAllProjects(storage: StorageLike = localStorage): ProjectSnapshot[] {
  try {
    const raw = storage.getItem(PROJECT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { projects?: unknown[] };
    const out: ProjectSnapshot[] = [];
    for (const item of parsed.projects ?? []) {
      try { out.push(snapshot(item)); } catch { /* 单条损坏跳过 */ }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch { return [] }
}

interface StoreData { format: 'life-circle-project-store'; schemaVersion: 1; recentId: string | null; projects: ProjectSnapshot[] }
/** One atomic localStorage write prevents a full disk from damaging the existing project/index. */
export class ProjectStore {
  constructor(private readonly suppliedStorage?: StorageLike) {}
  private storage(): StorageLike {
    try { return this.suppliedStorage ?? globalThis.localStorage; }
    catch { throw new ProjectError('storage_unavailable', '浏览器未允许本地存储，项目未保存；请下载项目快照备份。'); }
  }
  private read(): StoreData {
    let raw: string | null;
    try { raw = this.storage().getItem(PROJECT_STORAGE_KEY); }
    catch { throw new ProjectError('storage_unavailable', '无法读取浏览器中的项目；请检查本地存储权限。'); }
    if (raw === null) return { format: 'life-circle-project-store', schemaVersion: 1, recentId: null, projects: [] };
    try {
      // localStorage quotas count UTF-16 code units. A Chinese string can occupy more
      // UTF-8 bytes, so use the same UTF-16 limit as write() and a larger JSON parser cap.
      if (raw.length * 2 > MAX_STORAGE_BYTES) bad('项目库容量');
      const data = obj(json(raw, MAX_PROJECT_BYTES), '项目列表');
      if (data.format !== 'life-circle-project-store' || data.schemaVersion !== 1) throw new ProjectError('incompatible', '本地项目库版本不兼容，原数据已保留。');
      const projects = arr(data.projects, 'projects', x => snapshot(x), MAX_PROJECTS);
      if (new Set(projects.map(p => p.id)).size !== projects.length) bad('重复项目编号');
      const recentId = data.recentId === null ? null : str(data.recentId, 'recentId', 100);
      if (recentId !== null && !projects.some(p => p.id === recentId)) bad('recentId');
      return { format: 'life-circle-project-store', schemaVersion: 1, recentId, projects };
    } catch (e) {
      if (e instanceof ProjectError && e.code === 'incompatible') throw e;
      throw new ProjectError('corrupt', '本地项目数据损坏，已停止保存以保护原数据；请在另一个浏览器导入已下载的项目备份。');
    }
  }
  private write(data: StoreData): void {
    const text = encode(data);
    if (text.length * 2 > MAX_STORAGE_BYTES) throw new ProjectError('storage_full', '本地项目空间不足，未保存，原项目不变；请先下载备份并删除不需要的项目。');
    try { this.storage().setItem(PROJECT_STORAGE_KEY, text); }
    catch (e) {
      const quota = e instanceof Error && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');
      throw new ProjectError(quota ? 'storage_full' : 'storage_unavailable', quota ? '浏览器本地空间不足，未保存，原项目不变；请下载项目快照备份。' : '浏览器拒绝保存项目，原项目不变；请下载项目快照备份。');
    }
  }
  list(): ProjectSummary[] {
    return this.read().projects.map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, centerName: p.result.centerName, persona: p.result.persona, minutes: p.result.minutes })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  load(id: string): ProjectSnapshot {
    const project = this.read().projects.find(p => p.id === id);
    if (!project) throw new ProjectError('not_found', '找不到该项目，可能已在另一个页面删除。');
    return project;
  }
  save(project: ProjectSnapshot): void {
    const clean = parseProject(serializeProject(project)), data = this.read();
    const i = data.projects.findIndex(p => p.id === clean.id);
    if (i >= 0) data.projects[i] = clean;
    else {
      if (data.projects.length >= MAX_PROJECTS) throw new ProjectError('storage_full', '最多保存 20 个项目；请先下载备份并删除不需要的项目。');
      data.projects.push(clean);
    }
    data.recentId = clean.id; this.write(data);
  }
  rename(id: string, name: string): ProjectSnapshot {
    const p = this.load(id); p.name = name; p.updatedAt = new Date().toISOString();
    const clean = snapshot(p); this.save(clean); return clean;
  }
  remove(id: string): void {
    const data = this.read(); data.projects = data.projects.filter(p => p.id !== id);
    if (data.recentId === id) data.recentId = null;
    this.write(data);
  }
  recent(): ProjectSnapshot | null {
    const data = this.read(); return data.projects.find(p => p.id === data.recentId) ?? null;
  }
  setRecent(id: string): void {
    const data = this.read(); if (!data.projects.some(p => p.id === id)) throw new ProjectError('not_found', '找不到该项目，无法恢复。');
    data.recentId = id; this.write(data);
  }
}
