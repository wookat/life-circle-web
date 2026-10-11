import { Router, json as expressJson, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import type { ServerConfig } from './config.js';
import { TtlCache } from './cache.js';
import { countCacheHit, usageSnapshot } from './usage.js';
import { buckets, callBaidu } from './baidu.js';
import { analyzeWithServerProvider } from './provider.js';
import { startStreetBatch, getJob, cancelJob, sweepJobs, listJobs, resumeStreetBatch } from './batch.js';
import { escapeHtml as esc, getShare, saveShare } from './share.js';
import { worldPopCoverage } from './worldpop.js';
import { PERSONAS } from '../../shared/config.js';
import type { AnalysisReport } from '../../shared/analyze.js';
import type { LatLng } from '../../shared/types.js';
import { slimShareReport } from '../../shared/sharePayload.js';

/**
 * 百度 Web API 代理：
 * - AK 只存在于服务端；前端仅访问 /api/baidu/*；
 * - 全量 TTL 缓存（算路 24h / POI 6h / 地理编码 24h）；
 * - 上游失败统一返回 HTTP 200 + {status:-1}，前端据此做通道降级；
 * - 批量算路按 20 对一份内部分片串行调用并按序合并，规避上游单次上限。
 */

const HOUR = 3600_000;

export function createApiRouter(cfg: ServerConfig): Router {
  const router = Router();
  const caches = {
    route: new TtlCache<any>(24 * HOUR, 5000),
    place: new TtlCache<any>(6 * HOUR, 8000),
    geo: new TtlCache<any>(24 * HOUR, 4000)
  };

  const hasServerAk = () => cfg.akServer.length >= 16;

  router.use((req, res, next) => {
    if (cfg.allowOrigins.length && req.headers.origin) {
      if (!cfg.allowOrigins.includes(req.headers.origin)) {
        res.status(403).json({ status: -1, message: 'Origin 不在允许列表' });
        return;
      }
    }
    if (!hasServerAk()) {
      res.status(200).json({ status: -1, message: '服务端未配置 BAIDU_MAP_AK_SERVER，代理不可用，请使用浏览器通道或演示模式' });
      return;
    }
    next();
  });

  function sendCached(res: Response, cache: TtlCache<any>, key: string, producer: () => Promise<any>) {
    const hit = cache.get(key);
    if (hit) {
      countCacheHit();
      res.set('X-Proxy-Cache', 'HIT');
      res.set('X-Data-Collected-At', hit.collectedAt);
      res.json(hit.body);
      return;
    }
    producer().then((result) => {
      const body = result.body;
      const collectedAt = new Date().toISOString();
      if (result.ok && body && body.status === 0) cache.set(key, { body, collectedAt });
      res.set('X-Proxy-Cache', 'MISS');
      res.set('X-Data-Collected-At', collectedAt);
      res.status(200).json(body);
    });
  }

  // ---- 地理编码 ----
  router.get('/geocoding/v3', (req, res) => {
    const address = String(req.query.address ?? '');
    if (!address) {
      res.json({ status: -1, message: '缺少 address' });
      return;
    }
    sendCached(res, caches.geo, `geo:${address}`, () =>
      callBaidu('/geocoding/v3/', { address }, buckets.geo, cfg.akServer)
    );
  });

  router.get('/reverse_geocoding/v3', (req, res) => {
    const location = String(req.query.location ?? '');
    if (!location) {
      res.json({ status: -1, message: '缺少 location' });
      return;
    }
    sendCached(res, caches.geo, `rev:${location}`, () =>
      callBaidu('/reverse_geocoding/v3/', { location }, buckets.geo, cfg.akServer)
    );
  });

  // ---- POI 检索（圆形区域）----
  router.get('/place/v2/search', (req, res) => {
    const query = String(req.query.query ?? '');
    const location = String(req.query.location ?? '');
    let radius = Number(req.query.radius ?? 2000);
    const page = Number(req.query.page_num ?? 0);
    if (!query || !location) {
      res.json({ status: -1, message: '缺少 query/location' });
      return;
    }
    radius = Math.min(3000, Math.max(100, radius));
    const params: Record<string, string> = {
      query,
      location,
      radius: String(radius),
      radius_limit: 'true',
      scope: '2',
      page_size: '20',
      page_num: String(Math.min(4, Math.max(0, page)))
    };
    const key = `place:${createHash('sha1').update(JSON.stringify(params)).digest('hex')}`;
    sendCached(res, caches.place, key, () => callBaidu('/place/v2/search', params, buckets.place, cfg.akServer));
  });

  // №16 营业时段核验：POI 详情（open_time 为商户申报，未知不默认全天营业）
  router.get('/place/v2/detail', (req, res) => {
    const uid = String(req.query.uid ?? '');
    if (!uid) {
      res.json({ status: -1, message: '缺少 uid' });
      return;
    }
    const key = `detail:${uid}`;
    sendCached(res, caches.place, key, () => callBaidu('/place/v2/detail', { uid, scope: '2' }, buckets.place, cfg.akServer));
  });

  // ---- 批量步行算路：GET origins=lat,lng & destinations=lat,lng|lat,lng|... ----
  router.get('/routematrix/v2/walking', async (req, res) => {
    const origins = String(req.query.origins ?? '');
    const destinations = String(req.query.destinations ?? '');
    if (!origins || !destinations) {
      res.json({ status: -1, message: '缺少 origins/destinations' });
      return;
    }
    const destList = destinations.split('|').filter(Boolean);
    const chunkSize = 20;
    const chunks: string[][] = [];
    for (let i = 0; i < destList.length; i += chunkSize) chunks.push(destList.slice(i, i + chunkSize));

    const cacheKeys = chunks.map((c) => `rt:${origins}:${c.join(';')}`);
    const cached = cacheKeys.map((k) => caches.route.get(k));
    if (cached.every((c) => c !== undefined)) {
      res.set('X-Proxy-Cache', 'HIT');
      res.json({ status: 0, result: cached.flatMap((c) => (c as any).result ?? []) });
      return;
    }

    const results: any[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const producer = () =>
        callBaidu(
          '/routematrix/v2/walking',
          { origins, destinations: chunks[i].join('|') },
          buckets.route,
          cfg.akServer
        );
      const key = cacheKeys[i];
      const hit = cached[i];
      let body: any;
      if (hit) {
        body = hit;
      } else {
        const result = await producer();
        body = result.body;
        if (result.ok && body && body.status === 0) caches.route.set(key, body);
      }
      if (!body || body.status !== 0) {
        res.set('X-Proxy-Cache', 'MISS');
        res.status(200).json({ status: body?.status ?? -1, message: body?.message ?? '批量算路失败' });
        return;
      }
      results.push(...(body.result ?? []));
    }
    res.set('X-Proxy-Cache', 'MISS');
    res.json({ status: 0, result: results });
  });

  // ---- 单路径步行规划（用于过街设施扫描等）----
  router.get('/direction/v2/walking', (req, res) => {
    const origin = String(req.query.origin ?? '');
    const destination = String(req.query.destination ?? '');
    if (!origin || !destination) {
      res.json({ status: -1, message: '缺少 origin/destination' });
      return;
    }
    const key = `dir:${origin}:${destination}`;
    sendCached(res, caches.route, key, () =>
      callBaidu('/direction/v2/walking', { origin, destination }, buckets.route, cfg.akServer)
    );
  });

  // №13 调用预算面板：本地进程计数（非平台账户余额），每日预算触顶自动暂停上游调用
  router.get('/usage', (_req, res) => {
    res.json({ status: 0, usage: usageSnapshot() });
  });

  // №18 只读分享：固定版本报告快照（无交互、无 AK；存储上限 100 份 FIFO）
  router.post('/share', expressJson({ limit: '8mb' }), (req, res) => {
    // 只存只读页渲染所需的字段子集——完整报告数 MB，瘦身快照恒在 KB 级
    const text = JSON.stringify(slimShareReport(req.body ?? {}));
    const out = saveShare(text);
    if ('error' in out) {
      res.status(400).json({ status: -1, message: out.error });
      return;
    }
    res.json({ status: 0, id: out.id, url: `/s/${out.id}` });
  });

  router.get('/share/:id', (req, res) => {
    const entry = getShare(String(req.params.id));
    if (!entry) {
      res.status(404).send('<html><body style="font-family:sans-serif"><h3>分享不存在或已被清理</h3></body></html>');
      return;
    }
    const r = (entry.report ?? {}) as any;
    const dims = r.score?.dims ?? {};
    const warnings: string[] = r.warnings ?? [];
    const pct = (v: unknown) => typeof v === 'number' ? `${Math.round(v * 100)} 分` : '—';
    res.send(`<html><head><meta charset="utf-8"><title>圈点 · 只读报告</title>
      <style>body{font-family:system-ui,'Microsoft YaHei',sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#1c2333}
      .card{background:#f4f6f9;border-radius:10px;padding:14px 18px;margin:12px 0}
      .kpi{display:inline-block;margin-right:18px;text-align:center}.kpi b{display:block;font-size:22px}
      .muted{color:#65758d;font-size:12px}.grade{font-size:34px;font-weight:700;color:${r.score?.grade === 'C' || r.score?.grade === 'D' ? '#f08c00' : '#e03131'}}</style></head><body>
      <h2>圈点 · 15 分钟生活圈 只读报告</h2>
      <p><b>${esc(String(r.centerName ?? '未命名中心'))}</b> · ${esc(String(r.persona ?? ''))} · ${esc(String(r.minutes ?? ''))} 分钟 · 生成于 ${esc(String(r.generatedAt ?? ''))}</p>
      <div class="card"><span class="grade">${esc(String(r.score?.grade ?? ''))} ${esc(String(r.score?.total ?? ''))}</span> 分
        <div class="kpi"><b>${pct(dims.completeness)}</b>完整度</div>
        <div class="kpi"><b>${pct(dims.proximity)}</b>临近度</div>
        <div class="kpi"><b>${dims.coverage == null ? '—' : pct(dims.coverage)}</b>人口覆盖率</div>
        <div class="kpi"><b>${pct(dims.diversity)}</b>多样性</div>
      </div>
      <div class="card"><b>诊断</b><br/>${esc(String(r.score?.summary ?? '—'))}</div>
      ${warnings.length ? `<div class="card"><b>口径与警告</b><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      <div class="card"><b>数据与规则</b><br/><span class="muted">应用 ${esc(String(r.provenance?.applicationVersion ?? '—'))} · 规则 ${esc(String(r.provenance?.ruleVersion ?? '—'))} · 指纹 ${esc(String(r.provenance?.ruleFingerprint ?? '—'))} · 坐标系 ${esc(String(r.provenance?.coordinateSystem ?? 'BD-09'))}<br/>
      本页为固定版本只读快照：不含交互与实时数据；人工纠错标注未计入评分；覆盖率基于住宅 POI 代理而非真实人口。</span></div>
      </body></html>`);
  });

  router.get('/stats', (_req, res) => {
    res.json({
      status: 0,
      caches: {
        route: caches.route.stats(),
        place: caches.place.stats(),
        geo: caches.geo.stats()
      }
    });
  });

  return router;
}

/**
 * 分析 API 路由（挂载于 /api）：
 * 单点体检 / 街道批量 / OpenAPI 文档。此路由不做「必须有 AK」的硬拦截——
 * 未配置 AK 时各接口返回优雅降级错误，便于评审零配置体验。
 */
export function createAnalysisRouter(cfg: ServerConfig): Router {
  const router = Router();

  /**
   * 住宅 POI 口径判「无法评估」时回退 WorldPop 栅格口径：
   * 取最外层等时圈（level=minutes）最长闭合线为覆盖多边形，
   * 分母为理想步行半径 speed×minutes 的圆。估算失败保持 popCoverage 为空。
   */
  async function attachPopCoverage(report: AnalysisReport, personaId: string, minutes: number): Promise<void> {
    if (!report?.gap?.coverageUnavailable) return;
    const outer = report.rings?.[report.rings.length - 1]?.lines ?? [];
    const ring: LatLng[] | undefined = outer.reduce<LatLng[] | undefined>(
      (best, line) => (line.length > (best?.length ?? 0) ? line : best),
      undefined
    );
    if (!ring || ring.length < 3) return;
    const speed = PERSONAS.find((p) => p.id === personaId)?.speed ?? 80;
    const est = await worldPopCoverage(report.center, ring, speed * minutes);
    if (!est) return;
    report.popCoverage = est;
    report.warnings = [
      ...(report.warnings ?? []),
      `人口覆盖率改用 WorldPop 2020 年 100m 人口栅格口径估算：等时圈内常住人口约 ${Math.round(est.popIn).toLocaleString()} / 理想步行圈 ${est.radiusM}m 内约 ${Math.round(est.popEval).toLocaleString()}（住宅 POI 口径不可用，两口径不混用，四维评分仍按住宅口径剔除覆盖维度）`
    ];
  }

  // ================= 分析 API（面向多端 / 批量任务的地基） =================

  // POST /api/analyze  {lat?, lng?, address?, persona?, minutes?} → 完整体检报告 JSON
  router.post('/analyze', (req, res) => {
    const { lat, lng, address, persona, minutes } = req.body ?? {};
    if (!address && (typeof lat !== 'number' || typeof lng !== 'number')) {
      res.status(400).json({ status: -1, message: '需要提供 address 或 lat/lng' });
      return;
    }
    const personaId = persona ?? 'adult';
    const minutesN = Number(minutes) || 15;
    analyzeWithServerProvider(
      {
        center: typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : undefined,
        address: typeof address === 'string' && address ? address : undefined,
        persona: personaId,
        minutes: minutesN
      },
      cfg.akServer
    )
      .then(async (report) => {
        await attachPopCoverage(report, personaId, minutesN);
        res.json({ status: 0, report });
      })
      .catch((err) => res.json({ status: -1, message: String(err?.message ?? err) }));
  });

  // POST /api/popcoverage  {center:{lat,lng}, ring:LatLng[], radiusM}
  // 住宅 POI 口径无法评估时的 WorldPop 栅格兜底：等时圈常住人口 / 理想步行圈常住人口
  router.post('/popcoverage', expressJson({ limit: '200kb' }), (req, res) => {
    const { center, ring, radiusM } = req.body ?? {};
    // ring 两种入参都收：{lat,lng} 对象数组（主路径）或 [lng,lat] 坐标对数组
    const norm: LatLng[] = Array.isArray(ring)
      ? ring.map((p: any) => Array.isArray(p) ? { lat: Number(p[1]), lng: Number(p[0]) } : { lat: Number(p?.lat), lng: Number(p?.lng) })
          .filter((p: LatLng) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
      : [];
    if (!center || typeof center.lat !== 'number' || typeof center.lng !== 'number' || norm.length < 3) {
      res.status(400).json({ status: -1, message: '需要 center 与至少 3 个顶点的等时圈 ring' });
      return;
    }
    worldPopCoverage(center, norm, Math.max(200, Math.min(4000, Number(radiusM) || 1200)))
      .then((r) => res.json({ status: 0, popCoverage: r }))
      .catch(() => res.json({ status: 0, popCoverage: null }));
  });

  // POST /api/batch/street  {address|lat/lng, scope?, radiusM?, maxCommunities?} → {jobId}
  // scope=street（默认，≤3km/16 点）｜scope=district（城区试点，≤8km/30 点，结果按街道分组）
  router.post('/batch/street', (req, res) => {
    const { lat, lng, address, radiusM, maxCommunities, scope, persona } = req.body ?? {};
    const personaId = ['adult', 'elderly', 'child'].includes(persona) ? persona : 'adult';
    const isDistrict = scope === 'district';
    if (!address && (typeof lat !== 'number' || typeof lng !== 'number')) {
      res.status(400).json({ status: -1, message: '需要提供 address 或 lat/lng' });
      return;
    }
    sweepJobs();
    const maxRadius = isDistrict ? 8000 : 3000;
    const maxN = isDistrict ? 30 : 16;
    const doStart = (center: { lat: number; lng: number }, name: string) => {
      const job = startStreetBatch(
        cfg.akServer,
        center,
        name,
        Math.min(maxRadius, Math.max(800, Number(radiusM) || (isDistrict ? 5000 : 2500))),
        Math.min(maxN, Math.max(3, Number(maxCommunities) || (isDistrict ? 16 : 10))),
        isDistrict ? 'district' : 'street',
        personaId
      );
      res.json({ status: 0, jobId: job.id, total: job.total, scope: isDistrict ? 'district' : 'street' });
    };
    if (typeof lat === 'number' && typeof lng === 'number') {
      doStart({ lat, lng }, String(address ?? (isDistrict ? '指定城区' : '指定街道')));
      return;
    }
    // 地理编码对街道级地址偶发「无相关结果」：提取城市前缀作为 city 提示 + 失败重试一次
    const rawAddress = String(address);
    const cityHint = (rawAddress.match(/^(.*?市)/)?.[1] ?? '').trim();
    const geocodeOnce = () =>
      callBaidu(
        '/geocoding/v3/',
        cityHint ? { address: rawAddress, city: cityHint } : { address: rawAddress },
        buckets.geo,
        cfg.akServer
      );
    geocodeOnce()
      .catch(() => geocodeOnce())
      .then((first) => (first.ok && first.body?.status === 0 ? first : geocodeOnce()))
      .then((r) => {
        if (!r.ok || r.body?.status !== 0) {
          console.log(`[batch] geocode fail: http=${r.httpStatus} body=`, JSON.stringify(r.body)?.slice(0, 200));
          res.json({ status: -1, message: r.body?.message ?? r.body?.msg ?? '地址解析失败' });
          return;
        }
      doStart(
        { lat: r.body.result.location.lat, lng: r.body.result.location.lng },
        String(address)
      );
    });
  });

  // GET /api/batch/status/:jobId → 任务进度与结果
  // №12 任务找回/续跑/失败重试
  router.get('/batch/jobs', (_req, res) => {
    res.json({ status: 0, jobs: listJobs().map((j) => ({ id: j.id, status: j.status, centerName: j.centerName, createdAt: j.createdAt, done: j.done, total: j.total })) });
  });
  router.post('/batch/resume', (req, res) => {
    const { jobId, mode } = req.body ?? {};
    const job = resumeStreetBatch(cfg.akServer, String(jobId ?? ''), mode === 'failed' ? 'failed' : 'remaining');
    if (!job) {
      res.status(404).json({ status: -1, message: '任务不存在、无未完成样本，或已在运行' });
      return;
    }
    res.json({ status: 0, jobId: job.id, total: job.total, resumed: true });
  });

  router.get('/batch/status/:jobId', (req, res) => {
    const job = getJob(String(req.params.jobId));
    if (!job) {
      res.status(404).json({ status: -1, message: '任务不存在' });
      return;
    }
    const { communities, summary, ...rest } = job;
    res.json({ status: 0, job: { ...rest, communities, summary } });
  });

  // POST /api/batch/cancel/:jobId → 取消运行中的任务（保护上游配额）
  router.post('/batch/cancel/:jobId', (req, res) => {
    const ok = cancelJob(String(req.params.jobId));
    res.json({ status: ok ? 0 : -1, message: ok ? '取消信号已发送' : '任务不存在' });
  });

  // OpenAPI 描述（供 /docs 与多端接入）
  router.get('/openapi.json', (_req, res) => {
    res.json({
      openapi: '3.0.0',
      info: {
        title: '15 分钟生活圈 · 智能体检与规划助手 API',
        version: '0.1.0',
        description: '服务端分析引擎：单点完整体检 + 街道级批量体检。所有接口经服务端 AK 调用百度 Web API，带缓存与限流。'
      },
      paths: {
        '/api/analyze': {
          post: {
            summary: '单点完整体检',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      lat: { type: 'number' },
                      lng: { type: 'number' },
                      address: { type: 'string' },
                      persona: { type: 'string', enum: ['adult', 'elderly', 'child'] },
                      minutes: { type: 'number', enum: [5, 10, 15] }
                    }
                  }
                }
              }
            },
            responses: { '200': { description: '体检报告 JSON（degraded=true 表示上游降级）' } }
          }
        },
        '/api/batch/street': {
          post: {
            summary: '发起街道级批量体检任务',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      address: { type: 'string' },
                      lat: { type: 'number' },
                      lng: { type: 'number' },
                      radiusM: { type: 'number' },
                      maxCommunities: { type: 'number' }
                    }
                  }
                }
              }
            },
            responses: { '200': { description: '返回 jobId' } }
          }
        },
        '/api/batch/status/{jobId}': {
          get: {
            summary: '查询批量任务进度与结果',
            parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: '任务状态、逐小区结果与街道汇总' } }
          }
        },
        '/api/baidu/geocoding/v3': { get: { summary: '地理编码代理' } },
        '/api/baidu/reverse_geocoding/v3': { get: { summary: '逆地理编码代理' } },
        '/api/baidu/place/v2/search': { get: { summary: 'POI 圆形区域检索代理' } },
        '/api/baidu/routematrix/v2/walking': { get: { summary: '批量步行算路代理（自动分片合并）' } },
        '/api/baidu/direction/v2/walking': { get: { summary: '单路径步行规划代理' } },
        '/api/health': { get: { summary: '健康检查' } }
      }
    });
  });

  // 极简 API 文档页
  router.get('/docs', (_req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>API 文档 · 15分钟生活圈</title>
<style>body{font-family:system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;line-height:1.7;color:#1c2333}
code,pre{background:#f4f6fa;border-radius:6px;padding:2px 6px}pre{padding:12px;overflow:auto}
h1{font-size:22px}h2{font-size:17px;border-bottom:1px solid #e4e8f0;padding-bottom:6px;margin-top:28px}
</style></head><body>
<h1>15 分钟生活圈 · 分析 API</h1>
<p>机器可读描述：<a href="/api/openapi.json">/api/openapi.json</a>（可导入 Swagger UI / Apifox）</p>
<h2>POST /api/analyze — 单点完整体检</h2>
<pre>curl -X POST http://localhost:8787/api/analyze \\
  -H "Content-Type: application/json" \\
  -d '{"address":"江西省上饶市江西师范大学数字产业学院","persona":"adult","minutes":15}'</pre>
<p>返回：<code>status</code>、<code>report.score</code>（总分/等级/四维）、<code>report.gap</code>（盲区与斑块）、
<code>report.planSites</code>（补点建议）、<code>report.checklist</code>（国标清单）、<code>report.rings</code>（等时环坐标）。
<code>report.degraded=true</code> 表示上游降级（结果为兜底口径）。</p>
<h2>POST /api/batch/street — 街道级批量体检</h2>
<pre>curl -X POST http://localhost:8787/api/batch/street \\
  -H "Content-Type: application/json" \\
  -d '{"address":"上饶市信州区东市街道","radiusM":2500,"maxCommunities":10}'</pre>
<p>返回 <code>jobId</code>。任务后台串行执行（受上游限流，首次约 1-3 分钟）。</p>
<h2>GET /api/batch/status/:jobId — 查询进度</h2>
<pre>curl http://localhost:8787/api/batch/status/&lt;jobId&gt;</pre>
<p>返回 <code>job.done/total/current</code> 进度，完成后附 <code>job.summary</code>（平均分/等级分布/最优最差）
与 <code>job.communities[]</code>（逐小区评分排名）。</p>
<h2>百度 Web API 代理</h2>
<p>/api/baidu/geocoding/v3 · /api/baidu/reverse_geocoding/v3 · /api/baidu/place/v2/search ·
/api/baidu/routematrix/v2/walking · /api/baidu/direction/v2/walking —— 参数与百度官方一致，
AK 由服务端注入，带缓存与限流。</p>
</body></html>`);
  });

  return router;
}
