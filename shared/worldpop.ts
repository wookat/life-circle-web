import type { LatLng } from './types.js';
import { simplifyLine } from './timefield.js';

/**
 * WorldPop 开放人口栅格兜底口径。
 * 当住宅 POI 口径判「无法评估」时，改用 WorldPop 2020 年 100m 常住人口栅格估算：
 *   人口覆盖率 = 15 分钟步行等时圈内常住人口 / 理想步行圈（speed × minutes）内常住人口
 * 数据源：https://api.worldpop.org/v1（免费、无需密钥，异步任务式接口）
 * 结果只作覆盖参考，不与住宅 POI 口径混用；评分四维仍按住宅口径剔除该维度。
 */
export interface PopCoverageEstimate {
  share: number;
  popIn: number;
  popEval: number;
  radiusM: number;
  source: 'worldpop-2020';
}

const API = 'https://api.worldpop.org/v1';
const POLL_MS = 1500;
const TIMEOUT_MS = 25000;

function circlePolygon(center: LatLng, radiusM: number, n = 48): number[][] {
  const latRad = 111320;
  const lngRad = 111320 * Math.cos((center.lat * Math.PI) / 180);
  const pts: number[][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([center.lng + (radiusM * Math.cos(t)) / lngRad, center.lat + (radiusM * Math.sin(t)) / latRad]);
  }
  pts.push(pts[0]);
  return pts;
}

function ringPolygon(ring: LatLng[]): number[][] {
  const pts = ring.map((p) => [p.lng, p.lat]);
  if (pts.length && (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1])) pts.push(pts[0]);
  return pts;
}

async function statsForPolygon(coords: number[][]): Promise<number> {
  const geojson = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coords] } };
  const url = `${API}/services/stats?dataset=wpgppop&year=2020&geojson=${encodeURIComponent(JSON.stringify(geojson))}`;
  const created = await fetch(url).then((r) => r.json()) as { taskid?: string; error?: boolean; error_message?: string };
  if (!created.taskid) throw new Error(created.error_message ?? 'worldpop stats task 创建失败');
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error('worldpop stats 超时');
    await new Promise((r) => setTimeout(r, POLL_MS));
    const t = await fetch(`${API}/tasks/${created.taskid}`).then((r) => r.json()) as {
      status?: string; data?: { total_population?: number }; error_message?: string;
    };
    if (t.status === 'finished') {
      if (typeof t.data?.total_population !== 'number') {
        console.warn('[worldpop] task finished but shape unexpected:', JSON.stringify(t).slice(0, 500));
        throw new Error('worldpop 返回缺少人口总数');
      }
      return t.data.total_population;
    }
    if (t.status === 'failed') throw new Error(t.error_message ?? 'worldpop stats 失败');
  }
}

/**
 * 估算人口覆盖率。ring 为最外层等时圈多边形（经纬度折线），radiusM 为理想步行半径。
 * WorldPop 不可达或超时时返回 null（维持「无法评估」，不编造数字）。
 */
export async function worldPopCoverage(center: LatLng, ring: LatLng[], radiusM: number): Promise<PopCoverageEstimate | null> {
  try {
    // WorldPop stats 把 GeoJSON 放在 GET URL 上，必须控制顶点数：
    // Douglas-Peucker 抽稀后仍超 120 点则按步长再抽，避免 URL 过长被上游拒绝。
    let pts = simplifyLine(ring, 20);
    if (pts.length > 120) {
      const stride = Math.ceil(pts.length / 120);
      pts = pts.filter((_, i) => i % stride === 0);
    }
    const [popIn, popEval] = await Promise.all([
      statsForPolygon(ringPolygon(pts)),
      statsForPolygon(circlePolygon(center, radiusM))
    ]);
    if (!(popEval > 0)) return null;
    return { share: Math.min(1, popIn / popEval), popIn, popEval, radiusM, source: 'worldpop-2020' };
  } catch (e) {
    console.warn('[worldpop] coverage estimate failed:', e instanceof Error ? e.message : e);
    return null;
  }
}
