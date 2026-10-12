import { CATEGORIES } from './config.js';
import type { CategoryId, RouteProbe } from './types.js';

/**
 * 分析口径警告生成器：区分「数据缺失」「模型合成」「真实结论」三种口径，
 * 供共享引擎（服务端）与 Web 端编排层共用，保证两端警告语义一致。
 */
export interface WarningInputs {
  okProbes: number;
  degradedDirs: number;
  /** 主采样探针（用于检出强阻隔方向） */
  probes: (RouteProbe | null)[];
  /** 强阻隔阈值：探针真实路网距离 / 直线探针距离 > 3 视为强阻隔 */
  probeStraightM: number;
  failedCategories: CategoryId[];
  /** 人口代理总权重（0 = 无居住采样，覆盖率无法评估） */
  totalWeight: number;
  /** 设施检索是否至少有一类成功 */
  poiOk: boolean;
  /** 已取到的住宅小区数（区分「真没有」与「取到了但检索截断被排除」） */
  residentialCount?: number;
}

export function buildAnalysisWarnings(opts: WarningInputs): string[] {
  const warnings: string[] = [];
  const { okProbes, degradedDirs, probes, probeStraightM } = opts;

  if (okProbes === 0) {
    warnings.push('全部方向算路失败：等时圈为模型合成估计，可达范围结论仅供参考');
  } else if (degradedDirs > 0) {
    warnings.push(`${degradedDirs} 个方向算路失败，已按道路网格模型合成该扇区`);
  }
  const strongBlocked = probes.filter((p) => p && p.ok && p.distM > probeStraightM * 3).length;
  if (strongBlocked > 0) {
    warnings.push(
      `${strongBlocked} 个方向为强阻隔（步行绕行系数>3）：这些扇区可达范围已按模型上限折算，实际可能更小`
    );
  }
  if (opts.failedCategories.length) {
    const names = opts.failedCategories.map(
      (c) => CATEGORIES.find((x) => x.id === c)?.name ?? c
    );
    warnings.push(`设施检索失败：${names.join('、')}——相关类别的数量与完整性结论缺失，未计入评分`);
  }
  if (opts.totalWeight === 0) {
    // 用户反馈：60 个小区已取到却提示「未检索到」——需区分两种情形
    warnings.push(opts.residentialCount
      ? `住宅小区已取得 ${opts.residentialCount} 处，但检索不完整（达到分页上限，未覆盖上游全部结果）：为避免以部分样本冒充完整人口分母，人口覆盖率与盲区权重按「无法评估」处理`
      : '片区内未检索到住宅小区：人口覆盖率与盲区权重结论无法评估');
  }
  if (!opts.poiOk) {
    warnings.push('设施检索全部失败：评分与盲区结论不可用');
  }
  return warnings;
}
