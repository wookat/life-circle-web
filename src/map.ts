import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { CATEGORY_MAP } from '../shared/config.js';
import { simplifyLine } from '../shared/timefield.js';
import type { CrossingSegment, GapPatch, LatLng, PlanSite, Poi } from '../shared/types.js';
import { PoiPop } from './app/PoiPop.js';

/**
 * 地图视图封装：所有图层 no-op 安全（演示模式下底图不可用时静默跳过）。
 * 热力面用 GroundOverlay 贴 canvas 渲染的时间场图片（平滑、GPU 友好），
 * 等时环/盲区轮廓为矢量折线，POI/规划点为标注。
 */

export type LayerKey = 'heat' | 'rings' | 'poi' | 'gap' | 'plan' | 'cross' | 'route' | 'batch' | 'boundary';
export interface BatchMapCommunity {
  name: string;
  center: LatLng;
  score: number;
  grade: string;
  coverageShare: number | null;
  coverageUnavailable?: boolean;
  dominantMissing: string | null;
}

export class MapView {
  map: any = null;
  ready = false;

  private overlays: Record<string, any[]> = { heat: [], rings: [], poi: [], gap: [], plan: [], cross: [], route: [], batch: [], boundary: [] };
  private visible: Record<LayerKey, boolean> = { heat: true, rings: true, poi: true, gap: true, plan: true, cross: true, route: true, batch: true, boundary: true };
  private data: Record<string, any> = {};
  private centerMarker: any = null;
  private popRoot: Root | null = null;

  async init(
    browserAk: string,
    center: LatLng,
    onPick?: (p: LatLng) => void,
    onContext?: (p: LatLng, px: { x: number; y: number }) => void
  ): Promise<boolean> {
    try {
      await this.loadSdk(browserAk);
      // 百度 GL JS API 的经纬度即为 BD-09 坐标，引擎统一以 BD-09 运算
      const pt = new BMapGL.Point(center.lng, center.lat);
      this.map = new BMapGL.Map('map', { enableMapClick: false });
      this.map.centerAndZoom(pt, 15);
      this.map.enableScrollWheelZoom(true);
      this.map.addControl(new BMapGL.ScaleControl());
      this.map.addControl(new BMapGL.NavigationControl3D());
      this.ready = true;
      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__lcDebugPoiPop = (p: Poi, cat: string) => this.openPoiPop(p, cat);
      }
      if (onPick) {
        this.map.addEventListener('click', (e: any) => {
          if (e.latlng) onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
        });
      }
      if (onContext) {
        // 用 DOM contextmenu 而非地图 rightclick：POI/热力面等覆盖物会吞掉地图层事件
        const el = document.getElementById('map')!;
        el.addEventListener('contextmenu', (e: MouseEvent) => {
          e.preventDefault();
          const rect = el.getBoundingClientRect();
          const px = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          const ll = this.map.pixelToPoint(new BMapGL.Pixel(px.x, px.y));
          if (ll) onContext({ lat: ll.lat, lng: ll.lng }, px);
        });
      }
      return true;
    } catch (err) {
      console.warn('[map] init failed:', err);
      this.ready = false;
      return false;
    }
  }

  /** 切换底图形态：平面 / 卫星 / 3D（3D = 地球视图 + 倾斜角） */
  setMapType(mode: '2d' | 'satellite' | '3d') {
    if (!this.ready) return;
    const B = window.BMapGL;
    if (mode === '2d') {
      this.map.setTilt?.(0);
      this.map.setMapType?.(B.BMAP_NORMAL_MAP);
    } else if (mode === 'satellite') {
      this.map.setTilt?.(0);
      this.map.setMapType?.(B.BMAP_SATELLITE_MAP ?? B.BMAP_EARTH_MAP);
    } else {
      // 3D：地球视图 + 倾斜
      this.map.setMapType?.(B.BMAP_EARTH_MAP);
      this.map.setTilt?.(50);
    }
  }

  private loadSdk(ak: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (window.BMapGL) {
        resolve();
        return;
      }
      window.__initBMap = () => resolve();
      const s = document.createElement('script');
      s.src = `https://api.map.baidu.com/api?v=1.0&type=webgl&ak=${encodeURIComponent(ak)}&callback=__initBMap`;
      s.onerror = () => reject(new Error('百度地图 SDK 加载失败'));
      document.head.appendChild(s);
      setTimeout(() => reject(new Error('百度地图 SDK 加载超时')), 10000);
    });
  }

  setCenter(p: LatLng, label?: string) {
    if (!this.ready) return;
    const pt = new BMapGL.Point(p.lng, p.lat);
    this.map.centerAndZoom(pt, 15);
    if (this.centerMarker) this.map.removeOverlay(this.centerMarker);
    if ((this as any)._centerLabel) {
      this.map.removeOverlay((this as any)._centerLabel);
      (this as any)._centerLabel = null;
    }
    this.centerMarker = new BMapGL.Marker(pt, { icon: iconCenter() });
    this.map.addOverlay(this.centerMarker);
    if (label) {
      const lbl = new BMapGL.Label(escapeHtml(label), {
        position: pt,
        offset: new BMapGL.Size(14, -14)
      });
      lbl.setStyle({
        background: '#2f6fed', color: '#fff', border: 'none', borderRadius: '6px',
        padding: '2px 8px', fontSize: '12px'
      });
      this.map.addOverlay(lbl);
      (this as any)._centerLabel = lbl;
    }
  }

  flyTo(p: LatLng, zoom = 16) {
    if (!this.ready) return;
    this.map.centerAndZoom(new BMapGL.Point(p.lng, p.lat), zoom);
  }

  // ---- 图层数据 ----

  setHeat(dataUrl: string, sw: LatLng, ne: LatLng) {
    this.data.heat = { dataUrl, sw, ne };
    this.renderLayer('heat');
  }

  setRings(rings: { level: number; lines: LatLng[][] }[]) {
    this.data.rings = rings;
    this.renderLayer('rings');
  }

  setPois(pois: Poi[]) {
    this.data.pois = pois;
    this.renderLayer('poi');
  }

  setGaps(patches: GapPatch[]) {
    this.data.gaps = patches;
    this.renderLayer('gap');
  }

  setPlanSites(sites: PlanSite[]) {
    this.data.plan = sites;
    this.renderLayer('plan');
  }

  /** 街道级批量结果：按等级着色的小区标注（点击弹出摘要） */
  /** №11 行政边界轮廓（青色虚线） */
  setBoundary(polygons: [number, number][][] | null) {
    this.data.boundary = polygons;
    this.renderLayer('boundary');
  }

  setBatchResults(communities: BatchMapCommunity[]) {
    this.data.batch = communities;
    this.renderLayer('batch');
  }

  /** 过街扫描的几何路段回标 */
  setCrossings(segments: CrossingSegment[]) {
    this.data.cross = segments;
    this.renderLayer('cross');
  }

  /** 路线核验连线：真实步行路径折线（walkingGeo 逐段几何拼接）；null 清除 */
  setRoute(path: LatLng[] | null) {
    this.data.route = path;
    this.renderLayer('route');
  }

  /** POI 详情弹窗：React+antd 渲染进 InfoWindow 宿主节点，与全局组件体系统一 */
  private openPoiPop(p: Poi, categoryName: string) {
    this.popRoot?.unmount();
    this.popRoot = null;
    const host = document.createElement('div');
    const root = createRoot(host);
    this.popRoot = root;
    // 同步提交后再开弹窗：异步 render 时 BMapGL 量到的高度太小，按钮区会被裁
    flushSync(() => {
      root.render(createElement(PoiPop, {
        name: p.name,
        category: categoryName,
        address: p.address ?? '',
        uid: p.uid,
        act: (ds) => (window as unknown as { __lcPoiAct?: (d: Record<string, string>) => void }).__lcPoiAct?.(ds)
      }));
    });
    const info = new BMapGL.InfoWindow(host, { width: 320 });
    // close 只卸载自己那个 root：openInfoWindow 会先关掉旧弹窗触发其 close，
    // 若按 this.popRoot 卸载会把刚挂上的新 root 一并卸掉（第二个弹窗空白）
    info.addEventListener?.('close', () => {
      if (this.popRoot === root) { this.popRoot = null; }
      root.unmount();
    });
    this.map.openInfoWindow(info, new BMapGL.Point(p.lng, p.lat));
    // 兜底：样式/字体异步加载导致二次排版时强制重测高度
    requestAnimationFrame(() => info.redraw?.());
  }

  toggleLayer(key: LayerKey, on: boolean) {
    this.visible[key] = on;
    this.renderLayer(key);
  }

  clearAnalysis() {
    for (const k of Object.keys(this.overlays)) {
      for (const o of this.overlays[k]) this.map?.removeOverlay(o);
      this.overlays[k as LayerKey] = [];
    }
  }

  private renderLayer(key: LayerKey) {
    if (!this.ready) return;
    for (const o of this.overlays[key]) this.map.removeOverlay(o);
    this.overlays[key] = [];
    if (!this.visible[key]) return;

    const map = this.map;
    if (key === 'heat' && this.data.heat) {
      const { dataUrl, sw, ne } = this.data.heat;
      const b = new BMapGL.Bounds(new BMapGL.Point(sw.lng, sw.lat), new BMapGL.Point(ne.lng, ne.lat));
      const overlay = new BMapGL.GroundOverlay(b, { url: dataUrl, opacity: 1 });
      map.addOverlay(overlay);
      this.overlays.heat = [overlay];
    }

    if (key === 'rings' && this.data.rings) {
      const styles: Record<number, { color: string; width: number; dash: boolean }> = {
        5: { color: '#7cb342', width: 2, dash: true },
        10: { color: '#fb8c00', width: 2, dash: true },
        15: { color: '#e53935', width: 3, dash: false }
      };
      for (const ring of this.data.rings) {
        const st = styles[ring.level] ?? { color: '#666', width: 2, dash: true };
        let north: LatLng | null = null;
        for (const line of ring.lines) {
          const simp = simplifyLine(line, 15);
          const pts = simp.map((p) => new BMapGL.Point(p.lng, p.lat));
          if (pts.length < 2) continue;
          for (const p of simp) if (!north || p.lat > north.lat) north = p;
          const pl = new BMapGL.Polyline(pts, {
            strokeColor: st.color,
            strokeWeight: st.width,
            strokeOpacity: 0.9,
            strokeStyle: st.dash ? 'dashed' : 'solid'
          });
          map.addOverlay(pl);
          this.overlays.rings.push(pl);
        }
        // 环顶标注：说明这条等时线是什么
        if (north) {
          const lbl = new BMapGL.Label(`步行 ${ring.level} 分钟可达边界`, {
            position: new BMapGL.Point(north.lng, north.lat),
            offset: new BMapGL.Size(-38, -16)
          });
          lbl.setStyle({
            background: 'rgba(255,255,255,0.92)', color: st.color, border: `1px solid ${st.color}`,
            borderRadius: '6px', padding: '1px 7px', fontSize: '11px', fontWeight: '600', whiteSpace: 'nowrap'
          });
          map.addOverlay(lbl);
          this.overlays.rings.push(lbl);
        }
      }
    }

    if (key === 'route') {
      const path = this.data.route as LatLng[] | null;
      if (path && path.length >= 2) {
        const pts = path.map((p) => new BMapGL.Point(p.lng, p.lat));
        const pl = new BMapGL.Polyline(pts, { strokeColor: '#2f6fed', strokeWeight: 4, strokeOpacity: 0.9, strokeStyle: 'solid' });
        map.addOverlay(pl);
        this.overlays.route.push(pl);
      }
    }

    if (key === 'boundary' && this.data.boundary) {
      for (const ring of this.data.boundary as [number, number][][]) {
        const path = ring.map(([lng, lat]) => new BMapGL.Point(lng, lat));
        const pl = new BMapGL.Polyline(path, { strokeColor: '#0ca678', strokeWeight: 2.5, strokeOpacity: 0.8, strokeStyle: 'dashed' });
        map.addOverlay(pl);
        this.overlays.boundary.push(pl);
      }
    }

    if (key === 'poi' && this.data.pois) {
      const poiList = this.data.pois as Poi[];
      for (const p of poiList) {
        if (p.category === 'residential') continue;
        const def = CATEGORY_MAP[p.category];
        const marker = new BMapGL.Marker(new BMapGL.Point(p.lng, p.lat), {
          icon: iconFor(def.color, def.name.slice(0, 1))
        });
        marker.addEventListener('click', () => {
          this.openPoiPop(p, def.name);
        });
        map.addOverlay(marker);
        this.overlays.poi.push(marker);
      }
      // 住宅小区用小圆点展示（人口代理）
      for (const p of poiList.filter((x: Poi) => x.category === 'residential')) {
        const marker = new BMapGL.Marker(new BMapGL.Point(p.lng, p.lat), {
          icon: iconFor('#5c6bc0', '家', 18)
        });
        map.addOverlay(marker);
        this.overlays.poi.push(marker);
      }
    }

    if (key === 'gap' && this.data.gaps) {
      for (const patch of this.data.gaps as GapPatch[]) {
        const color = patch.severity === 'severe' ? '#c62828' : '#ef6c00';
        for (const line of patch.outline) {
          if (line.length < 3) continue;
          const pts = line.map((p) => new BMapGL.Point(p.lng, p.lat));
          const poly = new BMapGL.Polygon(pts, {
            strokeColor: color,
            strokeWeight: 1.5,
            strokeOpacity: 0.8,
            fillColor: color,
            fillOpacity: 0.22
          });
          map.addOverlay(poly);
          this.overlays.gap.push(poly);
        }
        const label = new BMapGL.Label(
          `#${patch.id} ${patch.severity === 'severe' ? '重度' : '中度'}缺${catName(patch.dominant)} · ${(patch.weightShare * 100).toFixed(0)}%居住`,
          { position: new BMapGL.Point(patch.centroid.lng, patch.centroid.lat), offset: new BMapGL.Size(-60, -10) }
        );
        label.setStyle({
          background: color, color: '#fff', border: 'none', borderRadius: '6px',
          padding: '2px 8px', fontSize: '11px', whiteSpace: 'nowrap'
        });
        map.addOverlay(label);
        this.overlays.gap.push(label);
      }
    }

    if (key === 'plan' && this.data.plan) {
      for (const site of this.data.plan) {
        const pt = new BMapGL.Point(site.latLng.lng, site.latLng.lat);
        const marker = new BMapGL.Marker(pt, { icon: iconFor('#00bcd4', `补${site.rank}`) });
        marker.addEventListener('click', () => {
          const info = new BMapGL.InfoWindow(
            `<div class="poi-pop"><div class="poi-pop-title">规划建议 #${site.rank}：补建${catName(site.category)}</div><div class="poi-pop-sub">${escapeHtml(site.rationale)}</div></div>`,
            { width: 250 }
          );
          map.openInfoWindow(info, pt);
        });
        map.addOverlay(marker);
        this.overlays.plan.push(marker);
        const circle = new BMapGL.Circle(pt, 1000, {
          strokeColor: '#00bcd4',
          strokeWeight: 1.5,
          strokeStyle: 'dashed',
          fillColor: '#00bcd4',
          fillOpacity: 0.06
        });
        map.addOverlay(circle);
        this.overlays.plan.push(circle);
        // 圈顶标注：解释虚线圈 = 补点服务半径
        const lbl = new BMapGL.Label(`#${site.rank} 补点服务半径 1km`, {
          position: new BMapGL.Point(site.latLng.lng, site.latLng.lat + 0.0093),
          offset: new BMapGL.Size(-52, -6)
        });
        lbl.setStyle({
          background: 'rgba(255,255,255,0.92)', color: '#0097a7', border: '1px solid #00bcd4',
          borderRadius: '6px', padding: '1px 7px', fontSize: '11px', whiteSpace: 'nowrap'
        });
        map.addOverlay(lbl);
        this.overlays.plan.push(lbl);
      }
    }

    if (key === 'cross' && this.data.cross) {
      const segStyles: Record<string, { color: string; width: number; opacity: number; dash: boolean }> = {
        walk: { color: '#78909c', width: 1.5, opacity: 0.55, dash: true },
        overpass: { color: '#8e24aa', width: 4, opacity: 0.95, dash: false },
        underpass: { color: '#3949ab', width: 4, opacity: 0.95, dash: false },
        crosswalk: { color: '#ef6c00', width: 4, opacity: 0.95, dash: false }
      };
      for (const seg of this.data.cross as CrossingSegment[]) {
        if (seg.path.length < 2) continue;
        const st = segStyles[seg.kind] ?? segStyles.walk;
        const pts = seg.path.map((p) => new BMapGL.Point(p.lng, p.lat));
        const pl = new BMapGL.Polyline(pts, {
          strokeColor: st.color,
          strokeWeight: st.width,
          strokeOpacity: st.opacity,
          strokeStyle: st.dash ? 'dashed' : 'solid'
        });
        map.addOverlay(pl);
        this.overlays.cross.push(pl);
      }
    }

    if (key === 'batch' && this.data.batch) {
      const gradeColor: Record<string, string> = {
        A: '#2f9e44', B: '#74b816', C: '#f08c00', D: '#e8590c', E: '#e03131', '-': '#8a93a6'
      };
      for (const c of this.data.batch as BatchMapCommunity[]) {
        const pt = new BMapGL.Point(c.center.lng, c.center.lat);
        const color = gradeColor[c.grade] ?? '#8a93a6';
        const marker = new BMapGL.Marker(pt, { icon: iconFor(color, c.grade === '-' ? '?' : String(c.grade)) });
        const coverage = c.coverageUnavailable || c.coverageShare == null ? '无法评估' : `${Math.round(c.coverageShare * 100)}%`;
        const summary = c.score >= 0
          ? `<b>${escapeHtml(c.name)}</b><br/>评分 ${c.score}（${escapeHtml(c.grade)} 级）· 人口覆盖率 ${coverage}${c.dominantMissing ? `<br/>主要缺失：${escapeHtml(catName(c.dominantMissing))}` : ''}`
          : `<b>${escapeHtml(c.name)}</b><br/>分析失败`;
        marker.addEventListener('click', () => {
          const info = new BMapGL.InfoWindow(`<div class="poi-pop">${summary}</div>`, { width: 240 });
          map.openInfoWindow(info, pt);
        });
        map.addOverlay(marker);
        this.overlays.batch.push(marker);
      }
    }
  }
}

function catName(id: string): string {
  return CATEGORY_MAP[id as keyof typeof CATEGORY_MAP]?.name ?? id;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** 中心点图标：同心圆（生活圈母题），虚线外环 + 实心核；2x 位图保证 HiDPI 清晰 */
function iconCenter(): any {
  const size = 30;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 2}" height="${size * 2}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="13" fill="rgba(47,111,237,0.18)" stroke="#2f6fed" stroke-width="1.6" stroke-dasharray="3.5 2.6"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="4.6" fill="#2f6fed" stroke="#ffffff" stroke-width="2"/>
  </svg>`;
  return new BMapGL.Icon(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, new BMapGL.Size(size, size), {
    anchor: new BMapGL.Size(size / 2, size / 2),
    imageSize: new BMapGL.Size(size, size)
  });
}

function iconFor(color: string, glyph: string, size = 26): any {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 2}" height="${size * 2}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="${color}" stroke="#fff" stroke-width="2"/>
    <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-size="${Math.round(size * 0.42)}" fill="#fff" font-family="PingFang SC, Microsoft YaHei, sans-serif">${escapeHtml(glyph)}</text>
  </svg>`;
  const icon = new BMapGL.Icon(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, new BMapGL.Size(size, size), {
    anchor: new BMapGL.Size(size / 2, size / 2),
    imageSize: new BMapGL.Size(size, size)
  });
  return icon;
}
