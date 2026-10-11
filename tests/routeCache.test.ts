import { describe, expect, it } from 'vitest';
import { getCachedRoute, setCachedRoute, routeCacheKey } from '../src/routeCache.js';
import type { LatLng } from '../shared/types.js';

/** localStorage 的内存替身（routeCache 通过注入的 StorageLike 读写）。 */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; }
  };
}

const a: LatLng = { lat: 28.46, lng: 117.97 };
const b: LatLng = { lat: 28.47, lng: 117.98 };

describe('路线核验缓存', () => {
  it('写入后可读回距离与通道', () => {
    const s = memoryStorage();
    const key = routeCacheKey(a, b);
    setCachedRoute(key, 823, 'server', undefined, s);
    expect(getCachedRoute(key, s)).toMatchObject({ distM: 823, channel: 'server' });
  });

  it('过期与未来时间戳都不返回', () => {
    const s = memoryStorage();
    const key = routeCacheKey(a, b);
    setCachedRoute(key, 100, 'server', undefined, s);
    s.setItem(key, JSON.stringify({ distM: 100, channel: 'server', at: Date.now() - 7 * 3600 * 1000 }));
    expect(getCachedRoute(key, s)).toBeNull();
    s.setItem(key, JSON.stringify({ distM: 100, channel: 'server', at: Date.now() + 60_000 }));
    expect(getCachedRoute(key, s)).toBeNull();
  });

  it('损坏 JSON 与非法距离都返回 null，不抛异常', () => {
    const s = memoryStorage();
    const key = routeCacheKey(a, b);
    s.setItem(key, '{not json');
    expect(getCachedRoute(key, s)).toBeNull();
    s.setItem(key, JSON.stringify({ distM: -5, channel: 'server', at: Date.now() }));
    expect(getCachedRoute(key, s)).toBeNull();
    s.setItem(key, JSON.stringify({ distM: Number.NaN, channel: 'server', at: Date.now() }));
    expect(getCachedRoute(key, s)).toBeNull();
  });

  it('超过上限时淘汰最旧条目，保留最新', () => {
    const s = memoryStorage();
    const keys = Array.from({ length: 42 }, (_, i) => {
      const k = routeCacheKey(a, { lat: 28 + i * 0.001, lng: 117 });
      setCachedRoute(k, i, 'server', undefined, s);
      return k;
    });
    expect(getCachedRoute(keys[0], s)).toBeNull();
    expect(getCachedRoute(keys[1], s)).toBeNull();
    expect(getCachedRoute(keys[41], s)).toMatchObject({ distM: 41 });
  });
});
