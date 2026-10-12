import { describe, expect, it } from 'vitest';
import { assessmentUnavailableCategories, searchPoiPages } from '../shared/poiSearch.js';
import type { Poi } from '../shared/types.js';

function rows(start: number, count: number): Poi[] {
  return Array.from({ length: count }, (_, offset) => ({
    uid: `p${start + offset}`, name: `设施${start + offset}`, lat: 30 + (start + offset) * 0.0001,
    lng: 120, category: 'pharmacy', source: 'server'
  }));
}

describe('设施检索的有限分页与完整性', () => {
  it('逐页串行取尽已知总数，同时去重重复设施并保留最早采集时间', async () => {
    let active = 0;
    let maxActive = 0;
    const requested: number[] = [];
    const r = await searchPoiPages({ keyword: '药店', category: 'pharmacy', source: 'server',
      fetchPage: async (page) => {
        requested.push(page);
        maxActive = Math.max(maxActive, ++active);
        await Promise.resolve();
        active--;
        return { pois: page ? [rows(19, 1)[0], rows(20, 1)[0]] : rows(0, 20),
          reportedTotal: 22, rawCount: page ? 2 : 20, cacheHit: true,
          collectedAt: page ? '2026-10-10T01:00:00Z' : '2026-10-09T01:00:00Z' };
      }
    });
    expect(requested).toEqual([0, 1]);
    expect(maxActive).toBe(1);
    expect(r.pois).toHaveLength(21);
    expect(r.completeness).toMatchObject({ status: 'complete', rawCount: 22, fetchedCount: 21,
      reportedTotal: 22, cacheHit: true, collectedAt: '2026-10-09T01:00:00.000Z' });
  });

  it('总数大于五页预算时标为截断，不以100条冒充完整数据', async () => {
    const pages: number[] = [];
    const r = await searchPoiPages({ keyword: '药店', category: 'pharmacy', source: 'server', pageLimit: 999,
      fetchPage: async (page) => { pages.push(page); return { pois: rows(page * 20, 20), reportedTotal: 108 }; }
    });
    expect(pages).toEqual([0, 1, 2, 3, 4]);
    expect(r.completeness).toMatchObject({ status: 'truncated', reportedTotal: 108, fetchedCount: 100, pageLimit: 5 });
    expect(assessmentUnavailableCategories([], [r.completeness])).toEqual(['pharmacy']);
  });

  it('已知总数恰好60时三页即可证实取尽，不额外请求第四页', async () => {
    const pages: number[] = [];
    const result = await searchPoiPages({ keyword: '药店', category: 'pharmacy', source: 'server',
      fetchPage: async (page) => { pages.push(page); return { pois: rows(page * 20, 20), reportedTotal: 60 }; } });
    expect(pages).toEqual([0, 1, 2]);
    expect(result.completeness).toMatchObject({ status: 'complete', fetchedCount: 60, reportedTotal: 60 });
  });

  it('末页失败保留成功页，失败请求不算缓存命中', async () => {
    const pages: number[] = [];
    const r = await searchPoiPages({ keyword: '药店', category: 'pharmacy', source: 'server',
      fetchPage: async (page) => {
        pages.push(page);
        if (page) throw new Error('network failure');
        return { pois: rows(0, 20), reportedTotal: 35, cacheHit: true };
      }
    });
    expect(pages).toEqual([0, 1]);
    expect(r.pois).toHaveLength(20);
    expect(r.completeness).toMatchObject({ status: 'partial', pagesFetched: 1, cacheHit: false, quotaExhausted: false });
  });

  it('分页中途配额耗尽不再请求第三页，已有设施仍可展示', async () => {
    const pages: number[] = [];
    const r = await searchPoiPages({ keyword: '药店', category: 'pharmacy', source: 'server',
      fetchPage: async (page) => {
        pages.push(page);
        if (page) throw Object.assign(new Error('daily quota'), { status: 302 });
        return { pois: rows(0, 20), reportedTotal: 50 };
      }
    });
    expect(pages).toEqual([0, 1]);
    expect(r.completeness).toMatchObject({ status: 'partial', fetchedCount: 20, quotaExhausted: true });
  });

  it('首次失败与可信零结果分开表示', async () => {
    const failed = await searchPoiPages({ keyword: '药店', category: 'pharmacy', source: 'server',
      fetchPage: async () => { throw new Error('upstream unavailable'); } });
    const empty = await searchPoiPages({ keyword: '药店', category: 'pharmacy', source: 'server',
      fetchPage: async () => ({ pois: [], reportedTotal: 0 }) });
    expect(failed.completeness).toMatchObject({ status: 'failed', reportedTotal: null, pagesFetched: 0 });
    expect(empty.completeness).toMatchObject({ status: 'complete', reportedTotal: 0, pagesFetched: 1 });
  });

  it('没有上游总数，即使不足一页也只标未知，不能当全量', async () => {
    const r = await searchPoiPages({ keyword: '药店', category: 'pharmacy', source: 'client',
      fetchPage: async () => ({ pois: rows(0, 3), source: 'client' }) });
    expect(r.completeness).toMatchObject({ status: 'unknown', reportedTotal: null, fetchedCount: 3, source: 'client' });
  });

  it('返回短页但总数未达到时，明确标为部分结果', async () => {
    const r = await searchPoiPages({ keyword: '药店', category: 'pharmacy', source: 'server',
      fetchPage: async () => ({ pois: rows(0, 4), reportedTotal: 21 }) });
    expect(r.completeness.status).toBe('partial');
    expect(r.completeness.reason).toContain('尚未达到');
  });

  it('重复返回同一整页时及时停止，不能用累计原始条数掩盖重复', async () => {
    const pages: number[] = [];
    const r = await searchPoiPages({ keyword: '药店', category: 'pharmacy', source: 'server',
      fetchPage: async (page) => { pages.push(page); return { pois: rows(0, 20), reportedTotal: 40 }; } });
    expect(pages).toEqual([0, 1]);
    expect(r.completeness).toMatchObject({ status: 'partial', fetchedCount: 20 });
    expect(r.completeness.reason).toContain('新的有效设施');
  });

  it('无效坐标与分页总数变化均不能产生完整结论', async () => {
    const invalid = await searchPoiPages({ keyword: '药店', category: 'pharmacy', source: 'server',
      fetchPage: async () => ({ pois: [{ ...rows(0, 1)[0], lat: NaN }], reportedTotal: 1 }) });
    const changed = await searchPoiPages({ keyword: '药店', category: 'pharmacy', source: 'server',
      fetchPage: async (page) => ({ pois: page ? rows(20, 1) : rows(0, 20), reportedTotal: page ? 21 : 22 }) });
    expect(invalid.completeness).toMatchObject({ status: 'partial', fetchedCount: 0 });
    expect(changed.completeness.status).toBe('partial');
  });

  it('分页时通道从真实转为合成，不混入合成设施伪造真实全量', async () => {
    const r = await searchPoiPages({ keyword: '药店', category: 'pharmacy', source: 'server',
      fetchPage: async (page) => ({ pois: rows(page * 20, page ? 2 : 20), reportedTotal: 22,
        source: page ? 'mock' : 'server' }) });
    expect(r.pois).toHaveLength(20);
    expect(r.completeness).toMatchObject({ status: 'partial', source: 'server', pagesFetched: 1 });
  });
});
