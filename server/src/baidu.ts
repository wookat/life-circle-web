import { TokenBucket } from './ratelimit.js';
import { countUpstream, overBudget } from './usage.js';

const BASE = 'https://api.map.baidu.com';

/** 上游服务维度的限流桶（个人 AK 并发/QPS 上限约 2-3，取保守值） */
// 企业配额 QPS 上限 30；5 QPS 为保守值（原 2 是个人 AK 时代的遗留）
export const buckets = {
  place: new TokenBucket(5, 5),
  route: new TokenBucket(5, 5),
  geo: new TokenBucket(5, 5)
};

export interface BaiduCallResult {
  ok: boolean;
  httpStatus: number;
  body: any;
  tookMs: number;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用百度 Web API（GET）。
 * - 网络异常 / HTTP 5xx 自动重试 2 次（指数退避）；
 * - 百度业务错误（body.status != 0）原样透传给前端做熔断降级决策。
 */
export async function callBaidu(
  path: string,
  params: Record<string, string>,
  bucket: TokenBucket,
  ak: string,
  maxRetry = 2
): Promise<BaiduCallResult> {
  const t0 = Date.now();
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('ak', ak);
  url.searchParams.set('output', 'json');

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    if (!(await bucket.take())) {
      return { ok: false, httpStatus: 429, body: { status: -1, message: '服务端限流，请稍后重试' }, tookMs: Date.now() - t0 };
    }
    // F2：预算闸门放在限流之后、真实出网之前——重试各计一次，全部入口（代理/前置采样/批量）共用
    if (overBudget()) {
      return { ok: false, httpStatus: 429, body: { status: -1, message: '本地每日预算触顶，已停止上游调用（可调高 BAIDU_LOCAL_DAILY_BUDGET）' }, tookMs: Date.now() - t0 };
    }
    countUpstream(path);
    try {
      const res = await fetchWithTimeout(url.toString(), 8000);
      if (res.status >= 500) throw new Error(`upstream ${res.status}`);
      const body = await res.json().catch(() => ({ status: -1, message: '响应解析失败' }));
      return { ok: res.ok, httpStatus: res.status, body, tookMs: Date.now() - t0 };
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetry) await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
  }
  return {
    ok: false,
    httpStatus: 502,
    body: { status: -1, message: `上游请求失败: ${(lastErr as Error)?.message ?? 'unknown'}` },
    tookMs: Date.now() - t0
  };
}
