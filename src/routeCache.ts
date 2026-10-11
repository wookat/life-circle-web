import type { LatLng } from '../shared/types.js';

/**
 * 浏览器端路线核验缓存（localStorage，TTL 6 小时）：
 * 同一起终点重复核验零消耗。仅缓存成功结果，失败不缓存、不伪装。
 */
const TTL = 6 * 3600 * 1000;
const MAX_ENTRIES = 40;
const PREFIX = 'lc-route-v1:';

export interface CachedRoute {
  distM: number;
  channel: string;
  at: number;
  /** 真实步行路径折线点列（可选：旧缓存项没有，命中后回源取一次） */
  path?: LatLng[];
}

export function routeCacheKey(origin: LatLng, dest: LatLng): string {
  return `${PREFIX}${JSON.stringify([
    origin.lat.toFixed(5), origin.lng.toFixed(5),
    dest.lat.toFixed(5), dest.lng.toFixed(5)
  ])}`;
}

export function getCachedRoute(key: string, storage: StorageLike = localStorage): CachedRoute | null {
  try {
    const entry = JSON.parse(storage.getItem(key) ?? 'null');
    if (!entry || typeof entry !== 'object') return null;
    if (!Number.isFinite(entry.at) || Date.now() - entry.at > TTL || entry.at > Date.now()) return null;
    if (!Number.isFinite(entry.distM) || entry.distM < 0 || typeof entry.channel !== 'string') return null;
    const path = Array.isArray(entry.path) && entry.path.every((p: LatLng) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng))
      ? entry.path as LatLng[] : undefined;
    return { distM: entry.distM, channel: entry.channel, at: entry.at, path };
  } catch {
    return null;
  }
}

export function setCachedRoute(key: string, distM: number, channel: string, path?: LatLng[], storage: StorageLike = localStorage): void {
  try {
    storage.setItem(key, JSON.stringify({ distM, channel, at: Date.now(), path }));
    const entries: { key: string; at: number }[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      try { entries.push({ key: k, at: JSON.parse(storage.getItem(k)!).at ?? 0 }); } catch { /* 忽略损坏项 */ }
    }
    entries.sort((a, b) => a.at - b.at);
    for (const item of entries.slice(0, Math.max(0, entries.length - MAX_ENTRIES))) storage.removeItem(item.key);
  } catch { /* 缓存是 best-effort，配额满不影响核验本身 */ }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
