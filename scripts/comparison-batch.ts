/**
 * 真实对比测试跑批脚本（docs/COMPARISON_TEST.md 数据产出方）。
 *
 * 用法：
 *   npx tsx scripts/comparison-batch.ts [地址 ...]
 *   不带参数时跑内置样例组（A 在建校区 / B 老城核心 / C 高校本部）。
 *
 * 服务端通道口径：企业配额 AK（.env 的 BAIDU_MAP_AK_SERVER），
 * 每点位跑「一般成人 + 老年人」两档，结果 JSON 落到 docs/data/batches/。
 * 受上游 QPS 限制，单点位约 3~6 分钟，全程约 10~15 分钟。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { analyzeWithServerProvider } from '../server/src/provider.js';
import type { AnalysisReport } from '../shared/analyze.js';

function loadEnv() {
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 无 .env */ }
}
loadEnv();

const AK = process.env.BAIDU_MAP_AK_SERVER ?? '';
if (!AK) { console.error('缺少 BAIDU_MAP_AK_SERVER'); process.exit(1); }

/** center 直接给坐标：地理编码对无「市」前缀的校名会漂移到外地，锁定实测点位保证批次可比 */
const SAMPLES = [
  { id: 'A', address: '江西师范大学数字产业学院', label: '在建新校区（高铁试验区）', center: { lat: 28.50509, lng: 118.02389 } },
  { id: 'B', address: '上饶市信州区中心广场', label: '老城核心', center: { lat: 28.43763, lng: 117.97341 } },
  { id: 'C', address: '上饶师范学院', label: '高校本部（成熟学生社区）', center: { lat: 28.42315, lng: 117.97654 } },
];

function brief(r: AnalysisReport) {
  const s = r.score as { total?: number; grade?: string; completeness?: number; proximity?: number; coverage?: number | null };
  const pop = r.popCoverage ? `${(r.popCoverage.share * 100).toFixed(0)}%(WorldPop)` : null;
  return {
    总分: s.total, 等级: s.grade,
    完整度: s.completeness != null ? Math.round(s.completeness * 100) : null,
    临近度: s.proximity != null ? Math.round(s.proximity * 100) : null,
    人口覆盖: pop ?? (s.coverage != null ? `${Math.round(s.coverage * 100)}%` : '无法评估'),
    机会: `${r.cumulative?.total ?? '?'}处/${r.cumulative?.categoriesCovered ?? '?'}类`,
    MAE: r.accuracy?.maeMinutes != null ? +r.accuracy.maeMinutes.toFixed(2) : null,
    灰斑: r.gap?.patches?.length ?? 0,
    补点: r.planSites?.length ?? 0,
    警告: r.warnings?.length ?? 0,
  };
}

type Target = { id: string; address: string; label: string; center?: { lat: number; lng: number } };
const addrs = process.argv.slice(2);
const targets: Target[] = addrs.length
  ? (SAMPLES as Target[]).filter((s) => addrs.includes(s.id))
      .concat(addrs.filter((a) => a.length > 2).map((a, i) => ({ id: `X${i}`, address: a, label: a })))
  : SAMPLES;
mkdirSync('docs/data/batches', { recursive: true });
const file = path.join('docs/data/batches', `${new Date().toISOString().slice(0, 10)}.json`);
// 同日批次合并：补跑/重跑单个点位时保留已有结果，避免整批重跑
let prev: Record<string, unknown> = { runs: {} };
try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 首批 */ }
const out: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), runs: { ...(prev.runs as object ?? {}) } };
let calls = 0;

for (const t of targets) {
  for (const persona of ['adult', 'elderly'] as const) {
    const key = `${t.id}-${persona}`;
    console.log(`\n=== ${key} ${t.address}（${t.label}）===`);
    try {
      const r = await analyzeWithServerProvider(
        'center' in t && t.center
          ? { center: t.center, persona, minutes: 15 }
          : { address: t.address, persona, minutes: 15 }, AK, () => { calls++; }
      );
      (out.runs as Record<string, unknown>)[key] = { label: t.label, center: r.center, ...brief(r), report: r };
      console.log(JSON.stringify(brief(r)));
    } catch (e) {
      (out.runs as Record<string, unknown>)[key] = { label: t.label, error: String(e) };
      console.error('FAILED:', String(e).slice(0, 200));
    }
  }
}
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\nupstream calls: ${calls}\nwritten: ${file}`);
