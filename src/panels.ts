import { CATEGORY_MAP, PERSONA_MAP, THRESHOLDS } from '../shared/config.js';
import { applySiteCoverage, planFacilitiesFromCoverage } from '../shared/planner.js';
import { localDistM } from '../shared/geo.js';
import type { AnalysisResult, GapPatch, LatLng, PlanSite } from '../shared/types.js';
import { banner, CHANNEL_LABEL } from './hud.js';
import { API_BASE } from './api.js';
import { map } from './appRuntime.js';
import { readAllProjects, type WorkbenchSnapshot } from './projects.js';
import { APPLICATION_VERSION, ALGORITHM_VERSION, RULE_VERSION, ruleFingerprint } from '../shared/provenance.js';
import { captureScenario, comparisonBaseline, type PlanScenarios } from '../shared/comparison.js';
import { explainResult } from './explain.js';
import { comparisonTable, downloadText, weakCommunityCsv } from './exports.js';
import { listCorrections } from './corrections.js';
import { addSupplement, getSupplements, removeSupplement } from './supplements.js';
import { clearBoundary, getBoundary, parseBoundaryGeoJson, saveBoundary } from './boundary.js';

/** 右侧报告面板：体检报告 / 国标清单 / 灰色区域 / 规划建议 / 街道体检 / 运行日志 */

let currentResult: AnalysisResult | null = null;
let currentTab = 'report';

// ---- 交互式规划工作台状态（新分析时重置）----
let acceptedSites: PlanSite[] = [];
let rejectedSites: PlanSite[] = [];
let scenarios: PlanScenarios = {};
// №7/8 规划编辑状态：自定义候选、禁建区与预算约束（随项目快照保存）
let customCandidates: { latLng: LatLng; category: PlanSite['category'] }[] = [];
let noGoZones: { center: LatLng; radiusM: number }[] = [];
let budget: { maxSites?: number; costPerSiteWan?: number; totalBudgetWan?: number } = {};
let workbenchListener: (() => void) | null = null;

export function onWorkbenchChange(listener: () => void) { workbenchListener = listener; }
export function getWorkbenchSnapshot(): WorkbenchSnapshot {
  return structuredClone({
    acceptedSites, rejectedSites,
    ...(Object.keys(scenarios).length ? { scenarios } : {}),
    ...(customCandidates.length ? { customCandidates } : {}),
    ...(noGoZones.length ? { noGoZones } : {}),
    ...(Object.keys(budget).length ? { budget } : {})
  });
}
export function setWorkbenchState(snapshot: WorkbenchSnapshot) {
  acceptedSites = structuredClone(snapshot.acceptedSites);
  rejectedSites = structuredClone(snapshot.rejectedSites);
  scenarios = structuredClone(snapshot.scenarios ?? {});
  customCandidates = structuredClone(snapshot.customCandidates ?? []);
  noGoZones = structuredClone(snapshot.noGoZones ?? []);
  budget = structuredClone(snapshot.budget ?? {});
}
export function displayedPlanSites(): PlanSite[] {
  return currentResult ? [...acceptedSites, ...currentSites(currentResult)] : [];
}

// ---- 街道批量体检状态 ----
export interface StreetCommunity {
  name: string;
  center: LatLng;
  score: number;
  grade: string;
  coverageShare: number | null;
  coverageUnavailable?: boolean;
  dominantMissing: string | null;
  error?: string;
}
let streetJobId: string | null = null;
let streetPollTimer: ReturnType<typeof setInterval> | null = null;
export interface StreetSnapshot {
  status: string; done: number; total: number; current: string;
  communities: StreetCommunity[]; summary: any; error?: string; persona?: string;
}
let streetLastSnapshot: StreetSnapshot | null = null;

export function setResult(r: AnalysisResult | null) {
  if (r !== currentResult) {
    acceptedSites = [];
    rejectedSites = [];
    scenarios = {};
    customCandidates = [];
    noGoZones = [];
    budget = {};
  }
  currentResult = r;
}

/** 工作台决策快照（导出 JSON 时随报告持久化） */
export function getWorkbenchState() {
  return {
    acceptedSites: acceptedSites.map((s) => ({
      category: s.category,
      latLng: s.latLng,
      coveredCells: s.coveredCells,
      beforePct: s.beforePct,
      afterPct: s.afterPct
    })),
    rejectedSites: rejectedSites.map((s) => ({ category: s.category, latLng: s.latLng })),
    currentSuggestions: currentResult ? currentSites(currentResult).length : 0,
    ...(Object.keys(scenarios).length ? { scenarios: structuredClone(scenarios) } : {})
  };
}

// ---- React 接管桥 ----
// 全部页签由 React 渲染；PanelBody 读 getPanelView() 直挂在 #panel-body。
export function getPanelView() {
  return {
    tab: currentTab,
    result: currentResult,
    correctionsCount: listCorrections().length,
    workbench: {
      acceptedSites, rejectedSites, scenarios, customCandidates, noGoZones, budget
    }
  };
}

export function switchTab(tab: string) {
  currentTab = tab;
  window.dispatchEvent(new CustomEvent('lc:tab', { detail: tab }));
  render();
}

export function render() {
  // 全部页签由 React 渲染；本函数只保留壳层职责：
  // 控制导出按钮组可见性、保留 [data-fly] 飞行定位委托、广播刷新事件
  const body = document.getElementById('panel-body')!;
  const footer = document.getElementById('panel-footer');
  if (footer) footer.classList.toggle('hidden', !['report', 'compare'].includes(currentTab) || !currentResult);
  body.onclick = (event) => {
    const el = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-fly]') : null;
    if (!el || !body.contains(el)) return;
    const [lat, lng] = (el.dataset.fly ?? '').split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) map.flyTo({ lat, lng });
  };
  window.dispatchEvent(new CustomEvent('lc:panel'));
}

export function sameRules(r: AnalysisResult): boolean {
  return !!r.provenance && (r.provenance.applicationVersion === APPLICATION_VERSION && r.provenance.ruleVersion === RULE_VERSION &&
    r.provenance.algorithmVersion === ALGORITHM_VERSION && r.provenance.ruleFingerprint === ruleFingerprint());
}

// ---------- 街道级批量体检 ----------

interface StreetJobItem { id: string; label: string; canFind: boolean; canResume: boolean; }
let streetJobs: StreetJobItem[] = [];
let streetUsageText = '';

function emitStreet() {
  window.dispatchEvent(new CustomEvent('lc:street'));
}

export interface StreetView {
  jobs: StreetJobItem[];
  usageText: string;
  snap: StreetSnapshot | null;
  hasJob: boolean;
}

export function getStreetView(): StreetView {
  return { jobs: streetJobs, usageText: streetUsageText, snap: streetLastSnapshot, hasJob: !!streetJobId };
}

async function refreshJobList() {
  try {
    const res = await fetch(`${API_BASE}api/batch/jobs`);
    const data = await res.json();
    const jobs: any[] = data.jobs ?? [];
    streetJobs = jobs.slice(0, 3).map((j) => ({
      id: j.id,
      label: `${j.centerName}（${j.done}/${j.total} · ${j.status === 'running' ? '运行中' : j.status === 'queued' ? '排队中' : j.status === 'interrupted' ? '已中断' : j.status === 'error' ? '失败' : j.status === 'cancelled' ? '已取消' : '完成'}）`,
      canFind: j.status === 'running' || j.status === 'queued',
      canResume: ['interrupted', 'error', 'cancelled'].includes(j.status),
    }));
  } catch { /* 演示模式无此端点 */ }
  emitStreet();
}
/** №13 调用预算面板：本地进程计数（非平台账户余额），预算与命中一目了然 */
async function refreshUsageLine() {
  try {
    const res = await fetch(`${API_BASE}api/baidu/usage`);
    const data = await res.json();
    const u = data.usage;
    if (!u) return;
    const budget = u.dailyBudget > 0 ? `${u.requests.total}/${u.dailyBudget}` : `${u.requests.total}（未设上限）`;
    streetUsageText = `今日上游请求 ${budget}（检索 ${u.requests.place} · 算路 ${u.requests.route} · 编码 ${u.requests.geo}）· 缓存命中 ${u.cacheHits} · 本地进程计数，非平台账户余额${u.overBudget ? ' · 已触顶暂停' : ''}`;
    emitStreet();
  } catch { /* 演示模式/离线环境无此端点 */ }
}

function startPolling() {
  if (streetPollTimer) clearInterval(streetPollTimer);
  streetPollTimer = setInterval(async () => {
    if (!streetJobId) return;
    try {
      const res = await fetch(`${API_BASE}api/batch/status/${streetJobId}`);
      const data = await res.json();
      if (data.status !== 0) return;
      void refreshUsageLine();
      streetLastSnapshot = {
        status: data.job.status,
        done: data.job.done,
        total: data.job.total,
        current: data.job.current,
        communities: data.job.communities ?? [],
        summary: data.job.summary,
        error: data.job.error,
        persona: data.job.persona
      };
      updateStreetStatus();
      if (data.job.status !== 'running' && streetPollTimer) {
        clearInterval(streetPollTimer);
        streetPollTimer = null;
        void refreshJobList();
        if (data.job.status === 'done' && map.ready && data.job.communities?.length) {
          map.setBatchResults(data.job.communities);
          const last = data.job.communities[data.job.communities.length - 1];
          map.flyTo({ lat: last.center.lat, lng: last.center.lng }, 13);
        }
      }
    } catch {
      /* 轮询失败下轮重试 */
    }
  }, 3000);
}

function updateStreetStatus() {
  emitStreet();
}

/** street 页签动作：找回 / 续跑 / 取消 / 导出薄弱社区 CSV（React 侧绑定） */
export const streetActions = {
  findJob(id: string) {
    streetJobId = id;
    startPolling();
    banner('已找回该任务，继续轮询进度。', 'info');
    emitStreet();
  },
  async resumeJob(id: string) {
    try {
      const res = await fetch(`${API_BASE}api/batch/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: id, mode: 'remaining' }) });
      const data = await res.json();
      if (data.status !== 0) { banner(data.message ?? '续跑失败'); return; }
      streetJobId = data.jobId;
      startPolling();
      banner(`续跑已启动：剩余 ${data.total} 个小区，已完成结果沿用。`, 'info');
    } catch { banner('续跑请求失败，请稍后重试。'); }
  },
  async cancel() {
    if (!streetJobId) return;
    try { await fetch(`${API_BASE}api/batch/cancel/${streetJobId}`, { method: 'POST' }); }
    catch { /* 轮询会反映最终状态 */ }
  },
  exportWeakCsv() {
    const s = streetLastSnapshot;
    try { if (streetJobId && s) downloadText(weakCommunityCsv(s.communities, streetJobId, new Date().toISOString(), { persona: s.persona, ruleVersion: RULE_VERSION }), '圈点-薄弱社区.csv', 'text/csv;charset=utf-8'); }
    catch { banner('薄弱社区表导出失败，任务结果已保留，请重试。', 'warn'); }
  },
};



export type { GapPatch, PlanSite };

export function siteId(s: PlanSite): string {
  return `${s.category}-${s.latLng.lat.toFixed(5)}-${s.latLng.lng.toFixed(5)}`;
}

/** 依据已采纳/已跳过状态重算当前建议 */
/** F3：预算按整个当前方案计——剩余数量/剩余预算 = 上限 − 已采纳占用 */
export function remainingBudget(): { maxSites?: number; costPerSiteWan?: number; totalBudgetWan?: number } {
  const out: { maxSites?: number; costPerSiteWan?: number; totalBudgetWan?: number } = {};
  if (budget.maxSites !== undefined) out.maxSites = Math.max(0, budget.maxSites - acceptedSites.length);
  if (budget.costPerSiteWan !== undefined) out.costPerSiteWan = budget.costPerSiteWan;
  if (budget.totalBudgetWan !== undefined && budget.costPerSiteWan !== undefined && budget.costPerSiteWan > 0) {
    out.totalBudgetWan = Math.max(0, budget.totalBudgetWan - acceptedSites.length * budget.costPerSiteWan);
  }
  return out;
}

/** F3：方案是否已超出预算（预算缩减到低于已采纳数量时提示，不自动撤销） */
export function budgetExceeded(): boolean {
  if (budget.maxSites !== undefined && acceptedSites.length > budget.maxSites) return true;
  if (budget.totalBudgetWan !== undefined && budget.costPerSiteWan !== undefined && budget.costPerSiteWan > 0
    && acceptedSites.length * budget.costPerSiteWan > budget.totalBudgetWan) return true;
  return false;
}

export function currentSites(r: AnalysisResult): PlanSite[] {
  if (!sameRules(r)) return [];
  const rem = remainingBudget();
  const countExhausted = rem.maxSites !== undefined && rem.maxSites <= 0;
  const costExhausted = rem.totalBudgetWan !== undefined && rem.costPerSiteWan !== undefined && rem.costPerSiteWan > 0 && rem.totalBudgetWan <= 0
    && (budget.totalBudgetWan !== undefined);
  if (countExhausted || (costExhausted && acceptedSites.length > 0)) return [];
  const cov: Record<string, Uint8Array> = {};
  for (const k of Object.keys(r.gap.coveredMasks)) cov[k] = Uint8Array.from(r.gap.coveredMasks[k]);
  for (const s of acceptedSites) applySiteCoverage(cov, s.category, s.latLng, r.field);
  const sites = planFacilitiesFromCoverage(
    r.gap,
    cov,
    r.field,
    PERSONA_MAP[r.persona].speed,
    {
      topK: THRESHOLDS.planTopK + rejectedSites.length,
      unknownCategories: r.assessmentUnavailableCategories ?? r.failedCategories ?? [],
      customCandidates,
      noGoZones,
      budget: remainingBudget()
    }
  );
  return sites.filter((s) =>
    rejectedSites.every((rj) => localDistM(s.latLng.lat, s.latLng.lng, rj.latLng.lat, rj.latLng.lng) > 400)
  );
}

/** №7/8 可编辑规划：自定义候选、禁建区与预算约束（成本为讨论假设，非工程概算） */
// ---------- React 页签动作层（plan / compare / street / log 迁移后共用） ----------

export function refreshWorkbench(): void {
  if (currentResult && map.ready) map.setPlanSites(displayedPlanSites());
  render();
  workbenchListener?.();
}

export const planActions = {
  accept(id: string) {
    if (!currentResult) return;
    const s = currentSites(currentResult).find((x) => siteId(x) === id);
    if (s) { acceptedSites.push(s); refreshWorkbench(); }
  },
  reject(id: string) {
    if (!currentResult) return;
    const s = currentSites(currentResult).find((x) => siteId(x) === id);
    if (s) { rejectedSites.push(s); refreshWorkbench(); }
  },
  undoAccept(id: string) { acceptedSites = acceptedSites.filter((s) => siteId(s) !== id); refreshWorkbench(); },
  undoReject(id: string) { rejectedSites = rejectedSites.filter((s) => siteId(s) !== id); refreshWorkbench(); },
  removeCustom(idx: number) { customCandidates.splice(idx, 1); refreshWorkbench(); },
  removeZone(idx: number) { noGoZones.splice(idx, 1); refreshWorkbench(); },
  addCandidate(lat: number, lng: number, cat: PlanSite['category']): boolean {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -85 || lat > 85 || lng < -180 || lng > 180) {
      banner('请输入有效的纬度（-85~85）与经度（-180~180）。');
      return false;
    }
    if (!currentResult || !sameRules(currentResult)) { banner('此项目使用历史规则，仅可查看。'); return false; }
    customCandidates.push({ latLng: { lat, lng }, category: cat });
    refreshWorkbench();
    return true;
  },
  addZone(radiusM: number | undefined): boolean {
    if (!currentResult || !sameRules(currentResult)) return false;
    if (!radiusM) { banner('请输入禁建区半径（米）。'); return false; }
    noGoZones.push({ center: currentResult.center, radiusM });
    const centerNow = currentResult.center;
    const conflicts = acceptedSites.filter((s) => localDistM(s.latLng.lat, s.latLng.lng, centerNow.lat, centerNow.lng) <= radiusM);
    if (conflicts.length) banner(`注意：新禁建区与 ${conflicts.length} 个已采纳点重叠——二者在方案讨论中属于冲突项，请人工裁决（系统不自动撤销）。`, 'warn', 10000);
    refreshWorkbench();
    return true;
  },
  applyBudget(rawMax: string, rawCost: string, rawTotal: string): boolean {
    if (!currentResult || !sameRules(currentResult)) return false;
    const readNum = (raw: string, max: number, integer: boolean): { ok: true; v?: number } | { ok: false } => {
      if (raw.trim() === '') return { ok: true };
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0 || v > max || (integer && !Number.isInteger(v))) return { ok: false };
      return { ok: true, v };
    };
    const maxR = readNum(rawMax, 100, true);
    const costR = readNum(rawCost, 1_000_000, false);
    const totalR = readNum(rawTotal, 10_000_000, false);
    if (!maxR.ok || !costR.ok || !totalR.ok) {
      banner('预算输入无效：最大补点数需为 0–100 整数，成本与预算需为非负数且不超上限。本次未修改约束。');
      return false;
    }
    budget = {};
    if (maxR.v !== undefined) budget.maxSites = maxR.v;
    if (costR.v !== undefined) budget.costPerSiteWan = costR.v;
    if (totalR.v !== undefined) budget.totalBudgetWan = totalR.v;
    if (!Object.keys(budget).length) banner('预算约束已清空。', 'info');
    refreshWorkbench();
    return true;
  },
  adoptCustom(idx: number): void {
    if (!currentResult || !sameRules(currentResult)) return;
    const cc = customCandidates[idx];
    if (!cc) return;
    const zone = noGoZones.find((z) => localDistM(cc.latLng.lat, cc.latLng.lng, z.center.lat, z.center.lng) <= z.radiusM);
    if (zone) {
      banner(`该候选位于禁建区内（圆心 ${zone.center.lat.toFixed(4)}, ${zone.center.lng.toFixed(4)} 半径 ${zone.radiusM}m），已拒绝采纳。`);
      return;
    }
    const unavailable = currentResult.assessmentUnavailableCategories ?? currentResult.failedCategories ?? [];
    if (unavailable.includes(cc.category)) {
      banner(`「${CATEGORY_MAP[cc.category as keyof typeof CATEGORY_MAP]?.name ?? cc.category}」检索不完整（未知），不能据此推断覆盖收益，已拒绝采纳。`);
      return;
    }
    const rem = remainingBudget();
    if (rem.maxSites !== undefined && rem.maxSites <= 0) {
      banner(`已达最大补点数上限（${budget.maxSites} 处）。要继续采纳请先撤销已采纳点或调高上限。`);
      return;
    }
    if (rem.totalBudgetWan !== undefined && rem.costPerSiteWan !== undefined && rem.costPerSiteWan > 0 && rem.totalBudgetWan < rem.costPerSiteWan) {
      banner(`已超出总预算（${budget.totalBudgetWan} 万 / 单点 ${budget.costPerSiteWan} 万）。要继续采纳请先撤销已采纳点或调整预算。`);
      return;
    }
    const cat = cc.category;
    const cov: Record<string, Uint8Array> = {};
    for (const k of Object.keys(currentResult.gap.coveredMasks)) cov[k] = Uint8Array.from(currentResult.gap.coveredMasks[k]);
    for (const s of acceptedSites) applySiteCoverage(cov, s.category, s.latLng, currentResult.field);
    const w = currentResult.gap.weightGrid;
    const beforeMask = Uint8Array.from(cov[cat]);
    let beforeW = 0;
    for (let k = 0; k < w.length; k++) if (w[k] > 0 && cov[cat][k] === 1) beforeW += w[k];
    applySiteCoverage(cov, cat, cc.latLng, currentResult.field);
    let afterW = 0, newlyCells = 0;
    for (let k = 0; k < w.length; k++) {
      if (w[k] <= 0 || cov[cat][k] !== 1) continue;
      afterW += w[k];
      if (beforeMask[k] !== 1) newlyCells++;
    }
    const total = currentResult.gap.totalWeight;
    const pct = (x: number) => (total > 0 ? x / total : 1) * 100;
    acceptedSites.push({
      rank: acceptedSites.length + 1, latLng: cc.latLng, category: cat,
      coveredCells: newlyCells, coveredWeight: afterW - beforeW,
      beforePct: Math.round(pct(beforeW) * 10) / 10, afterPct: Math.round(pct(afterW) * 10) / 10,
      estWalkMin: Math.round((THRESHOLDS.coreRadiusM * 1.25 / PERSONA_MAP[currentResult.persona].speed) * 10) / 10,
      rationale: `自定义候选落点：采纳后「${CATEGORY_MAP[cat as keyof typeof CATEGORY_MAP].name}」居住覆盖率 ${Math.round(pct(beforeW))}% → ${Math.round(pct(afterW))}%`
    });
    customCandidates.splice(idx, 1);
    refreshWorkbench();
  }
};

export const compareActions = {
  save(k: 'A' | 'B'): void {
    if (!currentResult || !sameRules(currentResult)) return;
    if (scenarios[k] && !window.confirm(`用当前选择覆盖已记录的方案 ${k}？`)) return;
    scenarios[k] = captureScenario(currentResult, { acceptedSites, rejectedSites });
    refreshWorkbench();
  },
  load(k: 'A' | 'B'): void {
    if (!currentResult || !sameRules(currentResult)) return;
    const saved = scenarios[k];
    if (!saved || saved.baselineKey !== comparisonBaseline(currentResult)) { banner('方案基线不同，无法载入。', 'warn'); return; }
    if ((acceptedSites.length || rejectedSites.length) && !window.confirm('载入此方案将替换当前工作台选择；尚未记录的调整将丢失。是否继续？')) return;
    acceptedSites = structuredClone(saved.acceptedSites);
    rejectedSites = structuredClone(saved.rejectedSites);
    refreshWorkbench();
  },
  reset(): void {
    if (!currentResult || !sameRules(currentResult)) return;
    if ((acceptedSites.length || rejectedSites.length) && !window.confirm('清空当前工作台的采纳和跳过选择？已记录的 A / B 会保留。')) return;
    acceptedSites = []; rejectedSites = [];
    refreshWorkbench();
  }
};

// ---------- street 页签 React 桥：表单由组件驱动，状态/任务容器仍走原 DOM 刷新 ----------

export function streetMounts(): void {
  void refreshJobList();
  void refreshUsageLine();
  updateStreetStatus();
  if (streetJobId && streetLastSnapshot?.status === 'running' && !streetPollTimer) startPolling();
}

export async function streetStart(opts: {
  address: string; scope: string; radiusM: number; maxCommunities: number; persona: string;
}): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}api/batch/street`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    const data = await res.json();
    if (data.status !== 0 || !data.jobId) {
      banner(`服务端不可用，已切换演示合成样本（${data.message ?? '无百度服务'}）。`, 'info');
      streetJobId = null;
      streetLastSnapshot = syntheticStreetSnapshot(opts);
      updateStreetStatus();
      return;
    }
    streetJobId = data.jobId;
    streetLastSnapshot = { status: 'running', done: 0, total: data.total ?? 0, current: '排队中…', communities: [], summary: null, persona: opts.persona };
    startPolling();
  } catch (e) {
    banner(`服务端不可用，已切换演示合成样本（${(e as Error).message}）。`, 'info');
    streetJobId = null;
    streetLastSnapshot = syntheticStreetSnapshot(opts);
    updateStreetStatus();
  }
}

// ---------- 街道批量演示兜底：无百度服务时确定性合成样本，演示不中断 ----------

function syntheticStreetSnapshot(opts: { address: string; radiusM: number; maxCommunities: number; persona: string }) {
  const seed = [...opts.address].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = (i: number, k: number) => {
    const x = Math.sin(seed * (i + 1) + k * 97) * 10000;
    return x - Math.floor(x);
  };
  const base = ((window as unknown as { __LC_CENTER__?: LatLng }).__LC_CENTER__ ?? currentResult?.center) as LatLng | undefined ?? { lat: 28.4619, lng: 117.9717 };
  const count = Math.max(4, Math.min(opts.maxCommunities, 10));
  const namePool = ['阳光花园', '书香雅苑', '滨江华庭', '锦绣东城', '信江丽景', '水岸华府', '鼓楼新村', '世纪名都', '康乐苑', '文峰逸景', '天福家园', '紫阳新居'];
  const cats = Object.keys(CATEGORY_MAP);
  const communities: StreetCommunity[] = Array.from({ length: count }, (_, i) => {
    const ang = rnd(i, 1) * Math.PI * 2;
    const d = 0.004 + (rnd(i, 2) * Math.min(opts.radiusM, 2800) * 0.009) / 1000;
    const score = Math.round((55 + rnd(i, 3) * 38) * 10) / 10;
    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'E';
    return {
      name: `${opts.address.replace(/[省市区县]/g, '').slice(0, 8) || '演示片区'}·${namePool[Math.floor(rnd(i, 5) * namePool.length)]}`,
      center: { lat: base.lat + Math.sin(ang) * d, lng: base.lng + Math.cos(ang) * d },
      score,
      grade,
      coverageShare: Math.round((0.55 + rnd(i, 4) * 0.43) * 100) / 100,
      dominantMissing: rnd(i, 6) > 0.45 ? cats[Math.floor(rnd(i, 7) * cats.length)] : null,
    };
  });
  const valid = communities.filter((c) => c.score >= 0);
  const gradeDist: Record<string, number> = {};
  for (const c of valid) gradeDist[c.grade] = (gradeDist[c.grade] ?? 0) + 1;
  const sorted = [...valid].sort((a, b) => b.score - a.score);
  const weakList = sorted
    .filter((c) => c.score < 75 || (c.coverageShare ?? 1) < 0.8)
    .map((c) => ({ name: c.name, score: c.score, coverageShare: c.coverageShare, dominantMissing: c.dominantMissing }));
  return {
    status: 'done', done: count, total: count, current: '演示合成数据（未配置 AK）',
    communities, persona: opts.persona, error: undefined,
    summary: {
      avgScore: valid.length ? Math.round((valid.reduce((a, c) => a + c.score, 0) / valid.length) * 10) / 10 : 0,
      gradeDist,
      scoreGap: sorted.length > 1 ? Math.round((sorted[0].score - sorted[sorted.length - 1].score) * 10) / 10 : 0,
      best: sorted[0] ? { name: sorted[0].name, score: sorted[0].score } : undefined,
      worst: sorted.length > 1 ? { name: sorted[sorted.length - 1].name, score: sorted[sorted.length - 1].score } : undefined,
      weakList,
      streetGroups: [],
    },
  };
}
