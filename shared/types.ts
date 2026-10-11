/** 共享领域类型：前端 / 服务端 / 引擎三方共用 */

export interface LatLng {
  lat: number;
  lng: number;
}

export type CategoryId =
  | 'hospital'
  | 'clinic'
  | 'pharmacy'
  | 'market'
  | 'supermarket'
  | 'primarySchool'
  | 'kindergarten'
  | 'elderly'
  | 'busStop'
  | 'park'
  | 'residential';

export interface CategoryDef {
  id: CategoryId;
  name: string;
  color: string;
  keywords: string[];
  /** 体检理想数量阈值（完整度打分用） */
  ideal: number;
  /** 完整度权重 */
  weight: number;
  /** 赛题核心三件套（评分细则：1公里内无菜市场/药店/小学即盲区） */
  core?: boolean;
  /** 参与评分（住宅小区只做人口代理，不计分） */
  scored?: boolean;
}

export type PoiSource = 'server' | 'client' | 'mock';

export interface Poi {
  uid: string;
  name: string;
  lat: number;
  lng: number;
  category: CategoryId;
  address?: string;
  source: PoiSource;
}

export interface RouteProbe {
  ok: boolean;
  /** 实际路网步行距离（米） */
  distM: number;
}

export type PersonaId = 'adult' | 'elderly' | 'child';

export interface PersonaDef {
  id: PersonaId;
  name: string;
  /** 步行速度 m/min */
  speed: number;
  note: string;
}

export type ChannelName = 'server' | 'client' | 'mock';

/** complete 仅表示该关键词的上游返回已取尽，不代表现实设施普查。 */
export type PoiSearchStatus = 'complete' | 'truncated' | 'partial' | 'unknown' | 'failed' | 'skipped';

export interface PoiSearchCompleteness {
  keyword: string;
  category: CategoryId;
  status: PoiSearchStatus;
  /** 上游声明的总条目数；未提供或无效时为 null，不能推定为全量。 */
  reportedTotal: number | null;
  /** 已收到的原始条目数（去重前）。 */
  rawCount: number;
  /** 有效、去重后的 POI 数量。 */
  fetchedCount: number;
  pagesFetched: number;
  pageSize: number;
  pageLimit: number;
  quotaExhausted: boolean;
  collectedAt: string;
  /** 只有全部成功页均来自缓存时才为 true。 */
  cacheHit: boolean;
  source: ChannelName;
  reason?: string;
  /** 兼容未实现详细检索契约的旧 provider：仅供估算，不声称完整。 */
  legacy?: boolean;
}

export interface PoiSearchResult {
  pois: Poi[];
  completeness: PoiSearchCompleteness;
}

/** 单向探测结果汇总后的等时圈解析模型 */
export interface IsochroneModel {
  center: LatLng;
  /** 方向数（均匀扇形采样） */
  dirs: number;
  /** 各方向的绕行系数 f(θ) = 实际路网距离 / 直线距离 */
  factors: number[];
  /** 探测半径（米，直线） */
  probeM: number;
  minutes: number;
  speed: number;
  /** 各方向 15 分钟可达直线半径（米） */
  radiusM: number[];
  /** 使用合成兜底的方向数 */
  degradedDirs: number;
}

export interface TimeField {
  /** 网格边长（格） */
  n: number;
  /** 网格步长（米） */
  cellM: number;
  center: LatLng;
  /** 网格北边界纬度 / 西边界经度 */
  latMax: number;
  lngMin: number;
  /** 行 i 自北向南，列 j 自西向东；单位：分钟；NaN = 超出分析范围 */
  t: Float64Array;
  maxMinutes: number;
  /** 等时圈目标时长（分钟），圈内/圈外判定基准 */
  minutes: number;
  speed: number;
}

export interface GapPatch {
  id: number;
  cells: number[];
  weight: number;
  /** 占总人口代理权重比例 0-1 */
  weightShare: number;
  centroid: LatLng;
  /** 斑块内缺失的核心类别 */
  missingCats: CategoryId[];
  dominant: CategoryId;
  /** 主缺失类别下，斑块内最远居住网格距最近设施的直线距离 */
  maxNearestM: number;
  outline: LatLng[][];
  severity: 'severe' | 'moderate';
}

export interface GapAnalysis {
  n: number;
  cellM: number;
  weightGrid: Float64Array;
  totalWeight: number;
  /** 每格缺失核心设施数 0-3（检索失败类别不计入缺失） */
  missingGrid: Uint8Array;
  /** 每个核心类别的覆盖掩码（0/1），供选址引擎精确归因；检索失败类别恒为 1（未知≠覆盖） */
  coveredMasks: Record<string, Uint8Array>;
  patches: GapPatch[];
  /** 检索失败的核心类别（无法判断，未计入缺失与覆盖率） */
  unknownCategories: string[];
  /** 人口加权覆盖率：三件套齐全的居住权重占比；无居住采样时为 null（无法评估） */
  coverageShare: number | null;
  /** 人口加权重度缺失占比；无居住采样时为 null */
  severeShare: number | null;
  /** 无居住采样（覆盖率无法评估） */
  coverageUnavailable: boolean;
  /** 盲区点位数（缺任意一项核心设施） */
  blindPoints: number;
}

export interface ScoreDimDetail {
  category: CategoryId;
  name: string;
  count: number;
  ideal: number;
  completeness: number;
  nearestM: number | null;
  proximity: number;
  /** true = 该类检索失败，数量为 0 属数据缺失而非真实结论 */
  missingData?: boolean;
}

export interface ScoreResult {
  total: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'E';
  dims: {
    completeness: number;
    proximity: number;
    /** 人口覆盖：无居住采样时为 null（无法评估） */
    coverage: number | null;
    diversity: number;
  };
  coverageUnavailable?: boolean;
  missingDataCategories?: string[];
  details: ScoreDimDetail[];
  summary: string;
}

export interface ChecklistItem {
  id: string;
  name: string;
  basis: string;
  thresholdM: number;
  /** true=达标 / false=缺失 / null=无法判断（该类检索失败） */
  met: boolean | null;
  /** 该类检索失败，无法判断 */
  unavailable?: boolean;
  nearestM: number | null;
  count: number;
}

export interface CustomCandidate { latLng: LatLng; category: PlanSite['category'] }
export interface NoGoZone { center: LatLng; radiusM: number }
/** №8 预算约束：最大补点数与成本假设（万元）。成本为规划讨论假设，非工程概算 */
export interface BudgetConstraint { maxSites?: number; costPerSiteWan?: number; totalBudgetWan?: number }

export interface PlanSite {
  rank: number;
  latLng: LatLng;
  category: CategoryId;
  /** 新覆盖居住网格数 */
  coveredCells: number;
  /** 新覆盖居住权重（贪心收益，逐位递减） */
  coveredWeight: number;
  /** 补建前该类别的居住覆盖率（%） */
  beforePct: number;
  /** 补建后该类别的居住覆盖率（%） */
  afterPct: number;
  /** 该点服务半径折算步行分钟（按人群速度与绕行系数估算） */
  estWalkMin: number;
  rationale: string;
}

export interface CrossingStats {
  scanned: number;
  overpass: number;
  underpass: number;
  crosswalkHint: number;
}

/** 过街扫描回标到地图的路段：kind 区分普通步行段与命中过街设施的段 */
export interface CrossingSegment {
  path: LatLng[];
  kind: 'walk' | 'overpass' | 'underpass' | 'crosswalk';
}

export interface ChannelUsage {
  channel: ChannelName;
  ms: number;
  cacheHit?: boolean;
  note?: string;
}

export interface AnalysisResult {
  center: LatLng;
  centerName: string;
  persona: PersonaId;
  minutes: number;
  generatedAt: string;
  provenance?: import('./provenance.js').AnalysisProvenance;
  model: IsochroneModel;
  field: TimeField;
  rings: { level: number; lines: LatLng[][] }[];
  pois: Poi[];
  gap: GapAnalysis;
  score: ScoreResult;
  checklist: ChecklistItem[];
  planSites: PlanSite[];
  /** 数据口径警告：区分「数据缺失」「模型合成」「真实结论」 */
  warnings?: string[];
  /** 检索失败的类别（数量 0 属数据缺失而非真实结论） */
  failedCategories?: CategoryId[];
  /** 每关键词的取样范围、分页与完整性状态。 */
  poiSearch?: PoiSearchCompleteness[];
  /** 无法确认完整的类别（含未执行/失败）；查得数量仅是下界。 */
  incompleteCategories?: CategoryId[];
  /** 当前数据不足以作缺失/覆盖结论的类别。 */
  assessmentUnavailableCategories?: CategoryId[];
  /** true = 设施检索全部失败，报告为不完整结果 */
  incomplete?: boolean;
  /** true = 检索因上游配额耗尽被截断（incomplete 必为 true） */
  quotaExhausted?: boolean;
  /** 累积机会指标（学界标准口径）：圈内可步行抵达的设施总数与类别数 */
  cumulative?: {
    total: number;
    byCategory: Record<string, number>;
    categoriesCovered: number;
    missingCategories: string[];
  };
  /** 插值精度自证：抽样真实算路 vs 模型估计的误差 */
  accuracy?: {
    samples: number;
    maeMinutes: number;
    maePercent: number;
    worstPercent: number;
  };
  crossings: CrossingStats | null;
  /** 过街扫描的几何路段（供地图回标；无几何数据时为空数组） */
  crossingSegments?: CrossingSegment[];
  /**
   * 人口覆盖率（WorldPop 栅格口径）：住宅 POI 口径判「无法评估」时，
   * 由服务端回源 WorldPop 2020 年 100m 常住人口栅格估算
   * （等时圈内常住人口 / 理想步行圈 speed×minutes 内常住人口）。
   * 只作覆盖参考展示，不与住宅 POI 口径混用；null/缺省 = 该口径亦不可用。
   */
  popCoverage?: {
    share: number;
    popIn: number;
    popEval: number;
    radiusM: number;
    source: 'worldpop-2020';
  } | null;
  steps: { name: string; usage: ChannelUsage }[];
  mock: boolean;
}
