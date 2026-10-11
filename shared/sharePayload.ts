import type { AnalysisResult } from './types.js';

/**
 * 只读分享页只渲染这一小组字段（见 server/src/routes.ts 的 /share/:id 模板）。
 * 完整 AnalysisResult 含时间场矩阵、权重栅格与全部 POI，体积常达数 MB——
 * 分享与存盘只保留该子集，快照内容不变而体积恒小（KB 级）。
 * 函数幂等：对已经瘦身过的对象再调用结果不变，客户端与服务端共用。
 */
export interface ShareReport {
  centerName: string;
  persona: string;
  minutes: number;
  generatedAt: string;
  score?: {
    grade?: string;
    total?: number;
    dims?: { completeness?: number; proximity?: number; coverage?: number | null; diversity?: number };
    summary?: string;
  };
  warnings?: string[];
  provenance?: {
    applicationVersion?: string;
    ruleVersion?: string;
    ruleFingerprint?: string;
    coordinateSystem?: string;
  };
}

export function slimShareReport(r: AnalysisResult | ShareReport | Record<string, unknown>): ShareReport {
  const src = r as ShareReport & { score?: ShareReport['score']; provenance?: ShareReport['provenance'] };
  const s = src.score ?? {};
  const p = src.provenance ?? {};
  return {
    centerName: String(src.centerName ?? ''),
    persona: String(src.persona ?? ''),
    minutes: Number(src.minutes ?? 0),
    generatedAt: String(src.generatedAt ?? ''),
    score: {
      grade: s.grade,
      total: typeof s.total === 'number' ? s.total : undefined,
      dims: {
        completeness: s.dims?.completeness,
        proximity: s.dims?.proximity,
        coverage: s.dims?.coverage ?? null,
        diversity: s.dims?.diversity
      },
      summary: s.summary
    },
    warnings: Array.isArray(src.warnings) ? src.warnings.slice(0, 50) : [],
    provenance: {
      applicationVersion: p.applicationVersion,
      ruleVersion: p.ruleVersion,
      ruleFingerprint: p.ruleFingerprint,
      coordinateSystem: p.coordinateSystem
    }
  };
}
