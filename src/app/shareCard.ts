/**
 * 分享图卡：把一次体检的结论渲染成一张 PNG（canvas 手绘，免依赖截图库）。
 * 评委/使用者可直接保存引用——诊断结论、等级、决策建议一屏讲完。
 * 口径诚实：演示数据在卡片顶部明示，WorldPop 栅格口径单独标注，不与住宅 POI 口径混用。
 */
import type { AnalysisResult } from '../../shared/types.js';
import { CATEGORY_MAP, PERSONA_MAP } from '../../shared/config.js';

const GRADE_COLOR: Record<string, string> = { A: '#2f9e44', B: '#74b816', C: '#f08c00', D: '#e8590c', E: '#e03131' };
const INK = '#1d2733';
const INK2 = '#5a6b80';
const LINE = '#e4e9f2';
const ACCENT = '#2563eb';

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (ctx.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ch; }
    else cur += ch;
  }
  if (cur) lines.push(cur);
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function buildShareCard(r: AnalysisResult): HTMLCanvasElement {
  const W = 900;
  const PAD = 48;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const persona = PERSONA_MAP[r.persona]?.name ?? r.persona;
  const dims = r.score.dims;

  // 先排内容高度，再定画布高（一次 dry-run 量高度）
  const measure = document.createElement('canvas').getContext('2d')!;
  const sumFont = '400 26px "PingFang SC", "Microsoft YaHei", sans-serif';
  measure.font = sumFont;
  const sumX = PAD + 160; // 等级圆占位：摘要从圆右侧起排
  const summaryLines = wrapText(measure, r.score.summary, W - sumX - PAD);
  const site0 = r.planSites?.[0];
  const decision = site0
    ? `优先补建「${CATEGORY_MAP[site0.category]?.name ?? site0.category}」于候选 #${site0.rank}：新覆盖 ${site0.coveredCells} 个居住网格，该类覆盖率 ${site0.beforePct}%→${site0.afterPct}%`
    : '选址引擎未产出无依据推荐（居住人口权重无法评估时如实不推，详见报告口径说明）';
  const decisionLines = wrapText(measure, decision, W - PAD * 2 - 32);
  // 高度=内容流末y + 24余量 + 底栏64：起始232 + 等级块(176+多行摘要) + 维度188 + 机会44 + 处方(56+行*40) + 自证52
  const H = 232 + 176 + Math.max(0, summaryLines.length - 2) * 40 + 188
    + (r.cumulative ? 44 : 0) + 56 + decisionLines.length * 40
    + (r.accuracy ? 52 : 0) + 88;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = `${W}px`;
  ctx.scale(dpr, dpr);

  // 背景
  ctx.fillStyle = '#f4f6fa';
  ctx.fillRect(0, 0, W, H);

  // 顶部深色带
  ctx.fillStyle = '#16213a';
  roundRect(ctx, 0, 0, W, 108, 0);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = '700 34px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText('圈点 · 15分钟生活圈体检', PAD, 66);
  ctx.font = '400 22px "PingFang SC", "Microsoft YaHei", sans-serif';
  const badge = r.mock ? '演示数据（合成通道）' : '真实路网数据';
  ctx.fillStyle = r.mock ? '#ffd8a8' : '#9fe8b1';
  ctx.textAlign = 'right';
  ctx.fillText(badge, W - PAD, 66);
  ctx.textAlign = 'left';

  // 中心点信息
  ctx.fillStyle = INK;
  ctx.font = '700 30px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(r.centerName, PAD, 168);
  ctx.fillStyle = INK2;
  ctx.font = '400 22px "PingFang SC", "Microsoft YaHei", sans-serif';
  const meta = `${r.center.lat.toFixed(5)}, ${r.center.lng.toFixed(5)} · ${persona} · 步行${r.minutes}分钟 · ${r.generatedAt.slice(0, 16).replace('T', ' ')}`;
  ctx.fillText(meta, PAD, 208);

  let y = 232;

  // 等级圆 + 总分 + 诊断摘要
  const grade = r.score.grade;
  ctx.fillStyle = GRADE_COLOR[grade] ?? '#666';
  ctx.beginPath();
  ctx.arc(PAD + 64, y + 84, 62, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = '700 56px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(grade, PAD + 64, y + 92);
  ctx.font = '700 26px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(`${r.score.total}`, PAD + 64, y + 126);
  ctx.textAlign = 'left';

  const tx = PAD + 160;
  ctx.fillStyle = INK;
  ctx.font = sumFont;
  summaryLines.forEach((l, i) => ctx.fillText(l, tx, y + 56 + i * 40));
  y += 176 + Math.max(0, summaryLines.length - 2) * 40;

  // 维度条
  const cov = dims.coverage;
  const covLabel = r.score.coverageUnavailable
    ? (r.popCoverage ? `栅格 ${(r.popCoverage.share * 100).toFixed(0)}%` : '无法评估')
    : `${Math.round((cov ?? 0) * 100)}%`;
  const bars: [string, number | null, string][] = [
    ['完整度', dims.completeness, `${Math.round(dims.completeness * 100)}%`],
    ['临近度', dims.proximity, `${Math.round(dims.proximity * 100)}%`],
    ['人口覆盖', r.score.coverageUnavailable ? (r.popCoverage ? r.popCoverage.share : null) : cov, covLabel],
    ['多样性', dims.diversity, `${Math.round(dims.diversity * 100)}%`],
  ];
  for (const [name, v, label] of bars) {
    ctx.fillStyle = INK2;
    ctx.font = '500 22px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(name, PAD, y + 22);
    ctx.fillStyle = LINE;
    roundRect(ctx, PAD + 118, y + 4, W - PAD * 2 - 118 - 96, 20, 10);
    ctx.fill();
    if (v != null) {
      ctx.fillStyle = ACCENT;
      roundRect(ctx, PAD + 118, y + 4, Math.max(12, (W - PAD * 2 - 118 - 96) * Math.min(1, v)), 20, 10);
      ctx.fill();
    }
    ctx.fillStyle = v == null ? '#c08a00' : INK;
    ctx.textAlign = 'right';
    ctx.fillText(label, W - PAD, y + 22);
    ctx.textAlign = 'left';
    y += 44;
  }
  y += 12;

  // 累积机会
  if (r.cumulative) {
    ctx.fillStyle = INK;
    ctx.font = '600 24px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(`累积机会：圈内可达设施 ${r.cumulative.total} 处 / ${r.cumulative.categoriesCovered} 类`, PAD, y + 26);
    y += 44;
  }

  // 决策条
  ctx.fillStyle = '#eaf1ff';
  roundRect(ctx, PAD, y, W - PAD * 2, 40 + decisionLines.length * 40, 14);
  ctx.fill();
  ctx.fillStyle = ACCENT;
  ctx.font = '700 22px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText('处方', PAD + 16, y + 34);
  ctx.fillStyle = INK;
  ctx.font = '400 23px "PingFang SC", "Microsoft YaHei", sans-serif';
  decisionLines.forEach((l, i) => ctx.fillText(l, PAD + 16, y + 70 + i * 40));
  y += 56 + decisionLines.length * 40;

  // 插值自证
  if (r.accuracy) {
    ctx.fillStyle = INK2;
    ctx.font = '400 22px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(`插值精度自证：抽样 ${r.accuracy.samples} 点真算路，模型平均绝对误差 ${r.accuracy.maeMinutes} 分钟（${r.accuracy.maePercent}%）`, PAD, y + 26);
    y += 52;
  }

  // 底栏
  ctx.fillStyle = '#16213a';
  ctx.fillRect(0, H - 64, W, 64);
  ctx.fillStyle = '#9fb2d0';
  ctx.font = '400 20px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText('github.com/wookat/life-circle-web · 开源（MIT）· 基于百度地图开放能力', PAD, H - 26);
  return canvas;
}

export function downloadShareCard(r: AnalysisResult) {
  const canvas = buildShareCard(r);
  canvas.toBlob((blob) => {
    if (!blob) throw new Error('图卡生成失败');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `圈点-体检图卡-${r.centerName}-${r.score.grade}${r.score.total}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, 'image/png');
}
