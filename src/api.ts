import { mockDetourFactor, generateMockPois } from '../shared/mock.js';
import { THRESHOLDS, DEFAULT_CENTER } from '../shared/config.js';
import { destination } from '../shared/geo.js';
import { sampleBearings } from '../shared/isochrone.js';
import { poiCacheKey, getCachedPois, setCachedPois } from './poiCache.js';
import { getCachedSearch, setCachedSearch, detailedSearchKey } from './poiCache.js';
import { searchPoiPages, legacyPoiSearchResult, unqueriedPoiSearch, isPoiQuotaError } from '../shared/poiSearch.js';
import type { PoiSearchPage } from '../shared/poiSearch.js';
import type { CategoryId, ChannelName, LatLng, Poi, PoiSource, RouteProbe, PoiSearchResult } from '../shared/types.js';

/**
 * 数据通道设计（对应评分细则「容错与降级机制」）：
 *
 *   ① server  —— 服务端代理（AK 不出后端，带缓存/限流/重试），首选；
 *   ② client  —— 浏览器直连（JSONP 调 Web API / GL SDK 算路），服务端不可用或熔断时接管；
 *   ③ mock    —— 确定性合成数据，前两级全部失败或配额熔断时兜底，保证演示永不中断。
 *
 * 每个通道独立熔断：连续 3 次失败 → 打开 60s；配额类错误（status 302/303/304/401/429）→ 打开 30min。
 */

export interface GeocodeResult {
  lat: number;
  lng: number;
  level?: string;
}

export interface PoiSearchParams {
  query: string;
  location: LatLng;
  radiusM: number;
  page?: number;
}

/** Prefijo de las llamadas /api: respeta el base path del build (deploy bajo subruta, p.ej. Pages estáticas). */
export const API_BASE: string = import.meta.env.BASE_URL;

export interface Gateway {
  readonly name: ChannelName;
  geocode(address: string): Promise<GeocodeResult>;
  /** 逆地理编码：坐标 → 地名描述 */
  reverseGeocode(p: LatLng): Promise<string>;
  searchPoi(params: PoiSearchParams): Promise<Poi[]>;
  searchPoiDetailed?(params: PoiSearchParams, category: CategoryId): Promise<PoiSearchResult>;
  routeMatrix(origin: LatLng, dests: LatLng[]): Promise<(RouteProbe | null)[]>;
  walkingRoute(origin: LatLng, dest: LatLng): Promise<RouteProbe | null>;
  /** 返回一条步行路线的分段描述文本（用于过街设施文本扫描） */
  walkingSteps(origin: LatLng, dest: LatLng): Promise<string[]>;
  /** 步行路线分段文本 + 几何路径（有则用于把过街扫描回标到地图） */
  walkingGeo?(origin: LatLng, dest: LatLng): Promise<WalkingStepGeo[]>;
}

/** 步行路线的一段：描述文本 + 该段几何（可为空 = 无几何数据） */
export interface WalkingStepGeo {
  text: string;
  path: LatLng[];
}

/** 百度 direction 返回的 "lng,lat;lng,lat" 折线串 → LatLng[] */
function parsePathString(s: unknown): LatLng[] {
  if (typeof s !== 'string' || !s) return [];
  const out: LatLng[] = [];
  for (const pair of s.split(';')) {
    const [lng, lat] = pair.split(',').map(Number);
    if (isFinite(lng) && isFinite(lat)) out.push({ lng, lat });
  }
  return out;
}

/** GL 步行 step 的几何提取：兼容 getPath() / _path / path 三种形态 */
function stepPathToLatLng(s: any): LatLng[] {
  const raw = typeof s?.getPath === 'function' ? s.getPath() : (s?._path ?? s?.path);
  if (typeof raw === 'string') return parsePathString(raw);
  if (!Array.isArray(raw)) return [];
  const out: LatLng[] = [];
  for (const p of raw) {
    const lng = Number(p?.lng ?? p?.x), lat = Number(p?.lat ?? p?.y);
    if (isFinite(lng) && isFinite(lat)) out.push({ lng, lat });
  }
  return out;
}

// ---------- 熔断器 ----------

const QUOTA_STATUS = new Set([302, 303, 304, 401, 429]);

export class Circuit {
  fails = 0;
  openUntil = 0;

  constructor(
    public readonly threshold = 3,
    public readonly coolMs = 60_000,
    public readonly quotaCoolMs = 30 * 60_000
  ) {}

  recordFailure(quotaLike = false) {
    this.fails++;
    if (quotaLike) this.openUntil = Date.now() + this.quotaCoolMs;
    else if (this.fails >= this.threshold) this.openUntil = Date.now() + this.coolMs;
  }

  recordSuccess() {
    this.fails = 0;
    this.openUntil = 0;
  }

  isOpen(): boolean {
    return Date.now() < this.openUntil;
  }
}

// ---------- 通道 ①：服务端代理 ----------

export class ServerGateway implements Gateway {
  readonly name: ChannelName = 'server';

  async geocode(address: string): Promise<GeocodeResult> {
    const r = await this.get('/api/baidu/geocoding/v3', { address });
    if (r.status !== 0) throw new Error(r.message ?? `geocode status ${r.status}`);
    return { lat: r.result.location.lat, lng: r.result.location.lng, level: r.result.level };
  }

  async reverseGeocode(p: LatLng): Promise<string> {
    const r = await this.get('/api/baidu/reverse_geocoding/v3', {
      location: `${p.lat},${p.lng}`
    });
    if (r.status !== 0) throw new Error(r.message ?? `reverse status ${r.status}`);
    const rg = r.result ?? {};
    const name = rg.formatted_address ?? rg.sematic_description ?? '';
    if (!name) throw new Error('reverse empty');
    return String(name);
  }

  async searchPoi(params: PoiSearchParams): Promise<Poi[]> {
    const r = await this.get('/api/baidu/place/v2/search', {
      query: params.query,
      location: `${params.location.lat},${params.location.lng}`,
      radius: String(params.radiusM),
      page_num: String(params.page ?? 0)
    });
    if (r.status !== 0) throw new Error(r.message ?? `place status ${r.status}`);
    return (r.results ?? []).map((it: any) => this.mapPoi(it, params.query));
  }

  searchPoiDetailed(params: PoiSearchParams, category: CategoryId): Promise<PoiSearchResult> {
    return searchPoiPages({ keyword: params.query, category, source: this.name, fetchPage: async (page) => {
      if (page > 0) await new Promise((resolve) => setTimeout(resolve, 450));
      const query = new URLSearchParams({ query: params.query,
        location: `${params.location.lat},${params.location.lng}`,
        radius: String(params.radiusM), page_num: String(page) });
      const response = await fetch(`${API_BASE}api/baidu/place/v2/search?${query}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.status !== 0) throw new Error(`place status ${data.status}`);
      if (!Array.isArray(data.results)) throw new Error('设施检索响应缺少结果列表');
      const rows = data.results;
      return { pois: rows.map((it: any) => ({ ...this.mapPoi(it, params.query), category })),
        rawCount: rows.length, reportedTotal: data.total,
        collectedAt: response.headers.get('X-Data-Collected-At') ?? undefined,
        cacheHit: response.headers.get('X-Proxy-Cache') === 'HIT', source: this.name };
    } });
  }

  async routeMatrix(origin: LatLng, dests: LatLng[]): Promise<(RouteProbe | null)[]> {
    // 全链路统一 BD-09：state.center 来自百度地图/地理编码，本身就是 BD-09
    const o = origin;
    const out: (RouteProbe | null)[] = new Array(dests.length).fill(null);
    // 服务端按 20 对分片，这里整体一次性发出
    const destStr = dests.map((d) => `${d.lat},${d.lng}`).join('|');
    const r = await this.get('/api/baidu/routematrix/v2/walking', {
      origins: `${o.lat},${o.lng}`,
      destinations: destStr
    });
    if (r.status !== 0) throw new Error(r.message ?? `routematrix status ${r.status}`);
    const rows: any[] = r.result ?? [];
    rows.forEach((row, i) => {
      const d = row?.distance?.value;
      if (typeof d === 'number' && d > 0) out[i] = { ok: true, distM: d };
    });
    return out;
  }

  async walkingRoute(origin: LatLng, dest: LatLng): Promise<RouteProbe | null> {
    const r = await this.get('/api/baidu/direction/v2/walking', {
      origin: `${origin.lat},${origin.lng}`,
      destination: `${dest.lat},${dest.lng}`
    });
    if (r.status !== 0) throw new Error(r.message ?? `direction status ${r.status}`);
    const route = r.result?.routes?.[0];
    if (!route) return null;
    return { ok: true, distM: route.distance ?? 0 };
  }

  async walkingSteps(origin: LatLng, dest: LatLng): Promise<string[]> {
    return (await this.walkingGeo(origin, dest)).map((s) => s.text).filter(Boolean);
  }

  async walkingGeo(origin: LatLng, dest: LatLng): Promise<WalkingStepGeo[]> {
    const r = await this.get('/api/baidu/direction/v2/walking', {
      origin: `${origin.lat},${origin.lng}`,
      destination: `${dest.lat},${dest.lng}`
    });
    if (r.status !== 0) throw new Error(r.message ?? `direction status ${r.status}`);
    const steps: any[] = r.result?.routes?.[0]?.steps ?? [];
    return steps.map((s) => ({ text: String(s.instructions ?? ''), path: parsePathString(s.path) }));
  }

  private async get(path: string, params: Record<string, string>): Promise<any> {
    const qs = new URLSearchParams(params);
    const res = await fetch(`${API_BASE}${path.replace(/^\//, '')}?${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  private mapPoi(it: any, query: string): Poi {
    return {
      uid: String(it.uid ?? `${it.name}-${it.address ?? ''}`),
      name: String(it.name ?? '未命名'),
      lat: it.location?.lat ?? 0,
      lng: it.location?.lng ?? 0,
      category: guessCategory(query),
      address: it.address,
      source: 'server'
    };
  }
}

// ---------- 通道 ②：浏览器直连 ----------

export class ClientGateway implements Gateway {
  readonly name: ChannelName = 'client';
  private cbSeq = 0;

  async geocode(address: string): Promise<GeocodeResult> {
    // 优先 GL SDK Geocoder（走 JS API 鉴权），SDK 未就绪时退回 JSONP REST
    if (window.BMapGL) {
      try {
        return await this.glGeocode(address);
      } catch {
        /* 继续走 JSONP */
      }
    }
    const r = await this.jsonp('https://api.map.baidu.com/geocoding/v3/', { address });
    if (r.status !== 0) throw new Error(`geocode status ${r.status}`);
    return { lat: r.result.location.lat, lng: r.result.location.lng, level: r.result.level };
  }

  async reverseGeocode(p: LatLng): Promise<string> {
    if (window.BMapGL) {
      return await this.glReverseGeocode(p);
    }
    const r = await this.jsonp('https://api.map.baidu.com/reverse_geocoding/v3/', {
      location: `${p.lat},${p.lng}`
    });
    if (r.status !== 0) throw new Error(`reverse status ${r.status}`);
    const name = r.result?.formatted_address;
    if (!name) throw new Error('reverse empty');
    return String(name);
  }

  private glReverseGeocode(p: LatLng): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gl reverse timeout')), 8000);
      try {
        new window.BMapGL.Geocoder().getLocation(
          new window.BMapGL.Point(p.lng, p.lat),
          (r: any) => {
            clearTimeout(timer);
            const name = r?.address ?? r?.content?.address;
            if (name) resolve(String(name));
            else reject(new Error('gl reverse empty'));
          }
        );
      } catch (e) {
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  async searchPoi(params: PoiSearchParams): Promise<Poi[]> {
    // 优先 GL SDK LocalSearch（走 JS API 鉴权，REST 服务未开通时依然可用）
    if (window.BMapGL && window.__LC_MAP__) {
      return await this.glSearchPoi(params);
    }
    return await this.jsonpSearchPoi(params);
  }

  searchPoiDetailed(params: PoiSearchParams, category: CategoryId): Promise<PoiSearchResult> {
    const sdkPage = window.BMapGL && window.__LC_MAP__ ? this.glPageFetcher(params, category) : null;
    return searchPoiPages({ keyword: params.query, category, source: this.name, fetchPage: async (page) => {
      if (page > 0) await new Promise((resolve) => setTimeout(resolve, 450));
      if (sdkPage) return sdkPage(page);
      const data = await this.jsonp('https://api.map.baidu.com/place/v2/search', {
        query: params.query, location: `${params.location.lat},${params.location.lng}`,
        radius: String(params.radiusM), radius_limit: 'true', scope: '2', page_size: '20', page_num: String(page)
      });
      if (data.status !== 0) throw new Error(`place status ${data.status}`);
      if (!Array.isArray(data.results)) throw new Error('设施检索响应缺少结果列表');
      const rows = data.results;
      return { pois: rows.map((it: any) => ({ uid: String(it.uid ?? `${it.name}-${it.address ?? ''}`),
        name: String(it.name ?? ''), lat: it.location?.lat ?? NaN, lng: it.location?.lng ?? NaN,
        category, address: it.address, source: this.name })),
        rawCount: rows.length, reportedTotal: data.total, source: this.name };
    } });
  }

  /** Reuse a single search instance so later pages do not re-request page zero. */
  private glPageFetcher(params: PoiSearchParams, category: CategoryId): (page: number) => Promise<PoiSearchPage> {
    let search: any;
    let complete: ((result: any) => void) | null = null;
    return (page) => new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { settled = true; complete = null; reject(new Error('gl search timeout')); }, 8000);
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true; complete = null; clearTimeout(timer); reject(error);
      };
      complete = (result: any) => {
        if (settled) return;
        try {
          const status = search.getStatus();
          if (status !== 0) throw new Error(`gl search status ${status}`);
          if (!result || typeof result.getCurrentNumPois !== 'function') throw new Error('gl search invalid result');
          if (typeof result.getPageIndex === 'function' && result.getPageIndex() !== page) return;
          const count = result.getCurrentNumPois();
          if (!Number.isInteger(count) || count < 0 || count > 20) throw new Error('gl search invalid count');
          const pois: Poi[] = [];
          for (let i = 0; i < count; i++) {
            const p = result.getPoi(i);
            if (!p?.point) continue;
            pois.push({ uid: String(p.uid ?? `${p.title}-${p.address ?? ''}`), name: String(p.title ?? ''),
              lat: p.point.lat, lng: p.point.lng, category, address: p.address, source: 'client' });
          }
          settled = true; complete = null; clearTimeout(timer);
          resolve({ pois, rawCount: count, reportedTotal: result.getNumPois?.(), source: 'client' });
        } catch (error) { fail(error); }
      };
      try {
        if (!search) {
          search = new window.BMapGL.LocalSearch(window.__LC_MAP__, {
            pageCapacity: 20, onSearchComplete: (result: any) => complete?.(result)
          });
          search.searchNearby(params.query, new window.BMapGL.Point(params.location.lng, params.location.lat), params.radiusM);
        } else search.gotoPage(page);
      } catch (error) { fail(error); }
    });
  }

  /** 浏览器通道没有批量算路接口：降级为 GL SDK 逐向算路（调用方限制方向数） */
  async routeMatrix(origin: LatLng, dests: LatLng[]): Promise<(RouteProbe | null)[]> {
    const out: (RouteProbe | null)[] = [];
    for (const d of dests) {
      out.push(await this.walkingRoute(origin, d));
    }
    return out;
  }

  walkingRoute(origin: LatLng, dest: LatLng): Promise<RouteProbe | null> {
    return new Promise((resolve) => {
      if (!window.BMapGL) {
        resolve(null);
        return;
      }
      try {
        routeSearch(origin, dest, resolve);
      } catch {
        resolve(null);
      }
    });
  }

  async walkingSteps(origin: LatLng, dest: LatLng): Promise<string[]> {
    return (await this.walkingGeo(origin, dest)).map((s) => s.text).filter(Boolean);
  }

  async walkingGeo(origin: LatLng, dest: LatLng): Promise<WalkingStepGeo[]> {
    if (window.BMapGL) {
      return await this.glWalkingGeo(origin, dest);
    }
    const r = await this.jsonp('https://api.map.baidu.com/direction/v2/walking', {
      origin: `${origin.lat},${origin.lng}`,
      destination: `${dest.lat},${dest.lng}`
    });
    if (r.status !== 0) throw new Error(`direction status ${r.status}`);
    const steps: any[] = r.result?.routes?.[0]?.steps ?? [];
    return steps.map((s) => ({ text: String(s.instructions ?? ''), path: parsePathString(s.path) }));
  }

  private glGeocode(address: string): Promise<GeocodeResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gl geocode timeout')), 8000);
      try {
        new window.BMapGL.Geocoder().getPoint(
          address,
          (pt: any) => {
            clearTimeout(timer);
            if (pt) resolve({ lat: pt.lat, lng: pt.lng, level: 'gl' });
            else reject(new Error('gl geocode empty'));
          },
          '全国'
        );
      } catch (e) {
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  /** GL SDK LocalSearch 周边检索：坐标为 BD-09，与引擎口径一致 */
  private glSearchPoi(params: PoiSearchParams): Promise<Poi[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gl search timeout')), 8000);
      try {
        const search = new window.BMapGL.LocalSearch(window.__LC_MAP__, {
          onSearchComplete: (res: any) => {
            clearTimeout(timer);
            try {
              const n = (res && res.getCurrentNumPois && res.getCurrentNumPois()) || 0;
              const out: Poi[] = [];
              for (let i = 0; i < n; i++) {
                const p = res.getPoi(i);
                if (!p?.point) continue;
                out.push({
                  uid: String(p.uid ?? `${p.title}-${p.address ?? ''}`),
                  name: String(p.title ?? ''),
                  lat: p.point.lat,
                  lng: p.point.lng,
                  category: guessCategory(params.query),
                  address: p.address,
                  source: 'client' as PoiSource
                });
              }
              resolve(out);
            } catch (e) {
              reject(e as Error);
            }
          }
        });
        search.searchNearby(
          params.query,
          new window.BMapGL.Point(params.location.lng, params.location.lat),
          params.radiusM
        );
      } catch (e) {
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  private async jsonpSearchPoi(params: PoiSearchParams): Promise<Poi[]> {
    const r = await this.jsonp('https://api.map.baidu.com/place/v2/search', {
      query: params.query,
      location: `${params.location.lat},${params.location.lng}`,
      radius: String(params.radiusM),
      radius_limit: 'true',
      scope: '2',
      page_size: '20',
      page_num: String(params.page ?? 0)
    });
    if (r.status !== 0) throw new Error(`place status ${r.status}`);
    return (r.results ?? []).map((it: any) => ({
      uid: String(it.uid ?? it.name),
      name: String(it.name ?? ''),
      lat: it.location?.lat ?? 0,
      lng: it.location?.lng ?? 0,
      category: guessCategory(params.query),
      address: it.address,
      source: 'client' as PoiSource
    }));
  }

  /** GL SDK 步行路线分段描述 + 几何（过街设施文本扫描与地图回标用） */
  private glWalkingGeo(origin: LatLng, dest: LatLng): Promise<WalkingStepGeo[]> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: WalkingStepGeo[]) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const timer = setTimeout(() => done([]), 10000);
      try {
        const route = new window.BMapGL.WalkingRoute(window.__LC_MAP__ ?? '全国', {
          onSearchComplete: (res: any) => {
            clearTimeout(timer);
            try {
              const plans = res?._plans ?? [];
              if (!plans.length) {
                done([]);
                return;
              }
              const routes = plans[0]._routes ?? [];
              const steps: WalkingStepGeo[] = [];
              for (const r of routes) {
                for (const s of r?._steps ?? []) {
                  const desc =
                    (typeof s?.getDescription === 'function' ? s.getDescription(false) : '') ||
                    s?._instructions ||
                    s?._description ||
                    '';
                  const path = stepPathToLatLng(s);
                  if (desc || path.length) steps.push({ text: String(desc), path });
                }
              }
              done(steps);
            } catch {
              done([]);
            }
          }
        });
        route.search(new window.BMapGL.Point(origin.lng, origin.lat), new window.BMapGL.Point(dest.lng, dest.lat));
      } catch {
        clearTimeout(timer);
        done([]);
      }
    });
  }

  private jsonp(host: string, params: Record<string, string>): Promise<any> {
    return new Promise((resolve, reject) => {
      const cb = `__lc_jsonp_${this.cbSeq++}`;
      const ak = window.__LC_BROWSER_AK__;
      if (!ak) {
        reject(new Error('browser AK missing'));
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('jsonp timeout'));
      }, 8000);
      const script = document.createElement('script');
      window[cb] = (data: any) => {
        clearTimeout(timer);
        cleanup();
        resolve(data);
      };
      const qs = new URLSearchParams({ ...params, output: 'json', ak, callback: cb });
      script.src = `${host}?${qs}`;
      script.onerror = () => {
        clearTimeout(timer);
        cleanup();
        reject(new Error('jsonp error'));
      };
      document.head.appendChild(script);

      function cleanup() {
        delete window[cb];
        script.remove();
      }
    });
  }
}

// ---------- 通道 ③：演示/兜底合成 ----------

export class MockGateway implements Gateway {
  readonly name: ChannelName = 'mock';

  async geocode(_address: string): Promise<GeocodeResult> {
    // 演示模式固定落在默认样例社区
    void _address;
    return { lat: DEFAULT_CENTER.lat, lng: DEFAULT_CENTER.lng, level: '演示' };
  }

  async reverseGeocode(p: LatLng): Promise<string> {
    void p;
    return `演示位置（${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}）`;
  }

  async searchPoi(params: PoiSearchParams): Promise<Poi[]> {
    const all = generateMockPois(await this.center(), window.__LC_MOCK_SEED__ ?? 42);
    const kw = params.query;
    return all.filter(
      (p) => kw.includes(p.name.slice(0, 2)) || p.name.includes(kw) || kwMatch(kw, p)
    );
  }

  async searchPoiDetailed(params: PoiSearchParams, category: CategoryId): Promise<PoiSearchResult> {
    const pois = (await this.searchPoi(params)).map((p) => ({ ...p, category }));
    const result = legacyPoiSearchResult(params.query, category, pois);
    result.completeness = { ...result.completeness, status: 'complete', reportedTotal: pois.length,
      source: 'mock', legacy: false, reason: '合成演示数据，完整性仅指本次合成样本' };
    return result;
  }

  async routeMatrix(origin: LatLng, dests: LatLng[]): Promise<(RouteProbe | null)[]> {
    const { minutes, speed } = window.__LC_MOCK_CTX__ ?? { minutes: 15, speed: 80 };
    const probeM = minutes * speed;
    return dests.map((d) => {
      const theta = bearingOf(origin, d);
      const f = mockDetourFactor(theta);
      const straight = distM(origin, d);
      // 探针本身按 probeM 直线距离布点：返回真实「路网」距离 = probeM × f
      void straight;
      return { ok: true, distM: Math.round(probeM * f) };
    });
  }

  async walkingSteps(origin: LatLng, dest: LatLng): Promise<string[]> {
    // 演示模式返回空文本，过街统计记零
    void origin;
    void dest;
    return [];
  }

  /** 演示通道：无真实路线，返回起终点直线走廊供地图示意回标 */
  async walkingGeo(origin: LatLng, dest: LatLng): Promise<WalkingStepGeo[]> {
    return [{ text: '', path: [origin, dest] }];
  }

  async walkingRoute(origin: LatLng, dest: LatLng): Promise<RouteProbe | null> {
    const f = mockDetourFactor(bearingOf(origin, dest));
    return { ok: true, distM: Math.round(distM(origin, dest) * f) };
  }

  private async center(): Promise<LatLng> {
    return window.__LC_CENTER__ ?? DEFAULT_CENTER;
  }
}

/** GL SDK 单路径步行检索（浏览器降级通道用；地图实例由 main.ts 注入）。
 * GL 的结果结构与旧版 BMap 不同：res._plans[0].getDistance(false) 为真实路网距离（米）。 */
function routeSearch(o: LatLng, d: LatLng, resolve: (r: RouteProbe | null) => void) {
  const loc = window.__LC_MAP__ ?? '全国';
  let settled = false;
  const done = (v: RouteProbe | null) => {
    if (settled) return;
    settled = true;
    resolve(v);
  };
  const timer = setTimeout(() => done(null), 10000);
  try {
    const route = new window.BMapGL.WalkingRoute(loc, {
      onSearchComplete: (res: any) => {
        clearTimeout(timer);
        try {
          const plans = res?._plans ?? [];
          if (!plans.length) {
            done(null);
            return;
          }
          const plan = plans[0];
          const dist = typeof plan.getDistance === 'function' ? Number(plan.getDistance(false)) : Number(plan._distance ?? 0);
          done({ ok: dist > 0, distM: dist });
        } catch {
          done(null);
        }
      }
    });
    route.search(new window.BMapGL.Point(o.lng, o.lat), new window.BMapGL.Point(d.lng, d.lat));
  } catch {
    clearTimeout(timer);
    done(null);
  }
}

function kwMatch(kw: string, p: Poi): boolean {
  const table: Record<string, string[]> = {
    医院: ['医院'],
    社区卫生服务中心: ['社区卫生'],
    诊所: ['诊所', '门诊'],
    药店: ['药店', '药房'],
    菜市场: ['菜市场', '菜场'],
    农贸市场: ['农贸市场'],
    生鲜超市: ['生鲜'],
    超市: ['超市'],
    购物中心: ['购物中心'],
    小学: ['小学'],
    幼儿园: ['幼儿园'],
    养老院: ['养老'],
    老年日间照料: ['照料', '养老'],
    公交站: ['公交'],
    公园: ['公园'],
    广场: ['广场'],
    住宅小区: ['小区', '住宅']
  };
  const kws = table[kw] ?? [kw];
  return kws.some((k) => p.name.includes(k) || p.category.includes(k));
}

function guessCategory(query: string): Poi['category'] {
  if (query.includes('医院')) return 'hospital';
  if (query.includes('卫生服务') || query.includes('诊所')) return 'clinic';
  if (query.includes('药店') || query.includes('药房')) return 'pharmacy';
  if (query.includes('菜') || query.includes('生鲜')) return 'market';
  if (query.includes('超市') || query.includes('购物')) return 'supermarket';
  if (query.includes('小学')) return 'primarySchool';
  if (query.includes('幼儿园')) return 'kindergarten';
  if (query.includes('养老') || query.includes('照料')) return 'elderly';
  if (query.includes('公交')) return 'busStop';
  if (query.includes('公园') || query.includes('广场')) return 'park';
  if (query.includes('小区') || query.includes('住宅')) return 'residential';
  return 'supermarket';
}

// ---------- 通道编排 ----------

export interface ChainResult<T> {
  value: T;
  channel: ChannelName;
  ms: number;
  degraded: boolean;
}

export class GatewayChain {
  private circuits = new Map<ChannelName, Circuit>();
  private active: ChannelName | null = null;

  constructor(
    private gateways: Gateway[],
    private onChannelChange?: (ch: ChannelName) => void
  ) {
    for (const g of gateways) this.circuits.set(g.name, new Circuit());
  }

  activeChannel(): ChannelName | null {
    return this.active;
  }

  /** 通道健康状态（供 UI 展示） */
  channels(): { name: ChannelName; open: boolean; fails: number }[] {
    return this.gateways.map((g) => {
      const c = this.circuits.get(g.name)!;
      return { name: g.name, open: c.isOpen(), fails: c.fails };
    });
  }

  circuitOf(name: ChannelName): Circuit {
    return this.circuits.get(name)!;
  }

  private async run<T>(fn: (g: Gateway) => Promise<T>, label: string): Promise<ChainResult<T>> {
    let lastErr: unknown = null;
    for (const g of this.gateways) {
      const circuit = this.circuits.get(g.name)!;
      if (circuit.isOpen()) continue;
      const t0 = performance.now();
      try {
        const value = await fn(g);
        circuit.recordSuccess();
        if (this.active !== g.name) {
          this.active = g.name;
          this.onChannelChange?.(g.name);
        }
        return { value, channel: g.name, ms: Math.round(performance.now() - t0), degraded: g.name !== this.gateways[0].name };
      } catch (err) {
        lastErr = err;
        const msg = String((err as Error)?.message ?? err);
        const quotaLike = QUOTA_STATUS.has(Number(msg.match(/status (\d+)/)?.[1] ?? -99)) || msg.includes('配额') || msg.includes('限流');
        circuit.recordFailure(quotaLike);
        console.warn(`[chain] ${label} via ${g.name} failed: ${msg}`);
      }
    }
    throw lastErr ?? new Error(`all channels failed for ${label}`);
  }

  geocode(address: string) {
    return this.run((g) => g.geocode(address), 'geocode');
  }

  reverseGeocode(p: LatLng) {
    return this.run((g) => g.reverseGeocode(p), 'reverse-geocode');
  }

  searchPoi(params: PoiSearchParams) {
    // 配额防线：先查浏览器端结果缓存（同位置重复分析零消耗）
    const key = poiCacheKey(params.query, params.location, params.radiusM);
    const hit = getCachedPois(key);
    if (hit) {
      return Promise.resolve({ value: hit.pois, channel: hit.channel, ms: 0, degraded: hit.channel !== this.gateways[0].name });
    }
    return this.run(async (g) => {
      const pois = await g.searchPoi(params);
      // 空结果不缓存：限流抖动的空返回若被固化，会污染后续 6 小时的分析
      if (g.name !== 'mock' && pois.length > 0) setCachedPois(key, { channel: g.name, at: Date.now(), pois });
      return pois;
    }, `poi:${params.query}`);
  }

  /** Keep one source per query; return quota status so the analysis stops the remaining batch. */
  async searchPoiDetailed(params: PoiSearchParams, category: CategoryId): Promise<ChainResult<PoiSearchResult>> {
    const key = detailedSearchKey(params.query, params.location, params.radiusM, category, this.gateways.map((g) => g.name));
    const cached = getCachedSearch(key);
    if (cached) return { value: cached, channel: cached.completeness.source, ms: 0,
      degraded: cached.completeness.source !== this.gateways[0].name };
    const start = performance.now();
    let last: PoiSearchResult | null = null;
    for (const gateway of this.gateways) {
      const circuit = this.circuits.get(gateway.name)!;
      if (circuit.isOpen()) continue;
      let result: PoiSearchResult;
      try {
        result = gateway.searchPoiDetailed
          ? await gateway.searchPoiDetailed(params, category)
          : legacyPoiSearchResult(params.query, category, await gateway.searchPoi(params));
      } catch (error) {
        result = { pois: [], completeness: unqueriedPoiSearch(params.query, category, gateway.name, 'failed', isPoiQuotaError(error)) };
      }
      last = result;
      const meta = result.completeness;
      if (meta.quotaExhausted || meta.status === 'failed') circuit.recordFailure(meta.quotaExhausted);
      else circuit.recordSuccess();
      if (meta.status === 'failed' && !meta.quotaExhausted) continue;
      this.active = gateway.name;
      this.onChannelChange?.(gateway.name);
      if (gateway.name !== 'mock' && meta.status === 'complete') setCachedSearch(key, result);
      return { value: result, channel: gateway.name, ms: Math.round(performance.now() - start), degraded: gateway.name !== this.gateways[0].name };
    }
    if (last) return { value: last, channel: last.completeness.source, ms: Math.round(performance.now() - start), degraded: true };
    throw new Error('所有数据通道暂不可用');
  }

  /** 批量算路：超过 batch 上限自动分片；单方向失败记为 null（由模型合成兜底） */
  async routeMatrix(origin: LatLng, dests: LatLng[]): Promise<ChainResult<(RouteProbe | null)[]>> {
    const batchSize = THRESHOLDS.routeBatchSize;
    const all: (RouteProbe | null)[] = new Array(dests.length).fill(null);
    let channel: ChannelName = 'mock';
    let ms = 0;
    let degraded = false;
    for (let i = 0; i < dests.length; i += batchSize) {
      const slice = dests.slice(i, i + batchSize);
      const r = await this.run((g) => g.routeMatrix(origin, slice), `routematrix[${i}]`);
      slice.forEach((_, k) => {
        all[i + k] = r.value[k];
      });
      channel = r.channel;
      ms += r.ms;
      degraded = degraded || r.degraded;
    }
    return { value: all, channel, ms, degraded };
  }

  walkingRoute(origin: LatLng, dest: LatLng) {
    return this.run((g) => g.walkingRoute(origin, dest), 'direction');
  }

  walkingSteps(origin: LatLng, dest: LatLng) {
    return this.run((g) => g.walkingSteps(origin, dest), 'walking-steps');
  }

  /** 分段文本 + 几何：通道无几何时以起终点直线兜底（图上标注为示意走廊） */
  walkingGeo(origin: LatLng, dest: LatLng) {
    return this.run(
      (g) =>
        g.walkingGeo
          ? g.walkingGeo(origin, dest)
          : g.walkingSteps(origin, dest).then((texts) => texts.map((t) => ({ text: t, path: [] }))),
      'walking-geo'
    );
  }
}

export function makeProbeDestinations(origin: LatLng, dirs: number, probeM: number): LatLng[] {
  return sampleBearings(dirs).map((b) => destination(origin, b, probeM));
}

// ---------- utils ----------

function distM(a: LatLng, b: LatLng): number {
  const R = 6371008.8;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function bearingOf(a: LatLng, b: LatLng): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const deg = (x: number) => (x * 180) / Math.PI;
  const φ1 = rad(a.lat);
  const φ2 = rad(b.lat);
  const Δλ = rad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
