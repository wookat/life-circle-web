import { Button, Table } from 'antd';
import { compareActions, getPanelView, sameRules, switchTab } from '../../panels.js';
import { measurePlan } from '../../../shared/comparison.js';
import { PERSONA_MAP, THRESHOLDS } from '../../../shared/config.js';
import { readAllProjects } from '../../projects.js';
import type { AnalysisResult } from '../../../shared/types.js';

const percent = (x: number | null) => (x === null ? '无法评估' : `${(x * 100).toFixed(1)}%`);

function ComparisonTable({ r }: { r: AnalysisResult }) {
  const { scenarios } = getPanelView().workbench;
  const columns = [
    measurePlan(r, []),
    ...(['A', 'B'] as const).map((k) => (scenarios[k] ? measurePlan(r, scenarios[k]!.acceptedSites, scenarios[k]!.baselineKey) : null)),
  ];
  type M = NonNullable<(typeof columns)[number]>;
  const rows: { key: string; name: string; render: (m: M) => string }[] = [
    { key: 'sites', name: '补点数', render: (m) => String(m.siteCount) },
    { key: 'cov', name: '三件套全覆盖', render: (m) => percent(m.coverage) },
    { key: 'gain', name: '新增覆盖（百分点）', render: (m) => (m.gainPoints === null ? '无法评估' : `+${m.gainPoints.toFixed(1)}`) },
    { key: 'cells', name: '剩余薄弱住宅格', render: (m) => (m.remainingCells === null ? '无法评估' : String(m.remainingCells)) },
    { key: 'share', name: '剩余缺口权重', render: (m) => percent(m.remainingShare) },
  ];
  const reasons = [...new Set(columns.flatMap((m) => (m?.reason ? [m.reason] : [])))];
  // 保留 th 行头 + td 值列的原生表结构（.comparison-table tbody tr 的 th/td 布局是测试契约）
  return (
    <>
      <table className="tbl comparison-table">
        <thead><tr><th>指标</th><th>现状</th><th>方案 A</th><th>方案 B</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th>{row.name}</th>
              {columns.map((m, i) => <td key={i}>{m ? row.render(m) : '未记录'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {reasons.map((s) => <p className="rpt-sub" key={s}>{s}</p>)}
    </>
  );
}

function TrendTable({ r }: { r: AnalysisResult }) {
  const sameCenter = (p: { result: AnalysisResult }) =>
    Math.abs(p.result.center.lat - r.center.lat) * 111320 <= 60 &&
    Math.abs(p.result.center.lng - r.center.lng) * 111320 * Math.cos((r.center.lat * Math.PI) / 180) <= 60;
  const mine = readAllProjects().filter(sameCenter);
  if (mine.length < 2) {
    return <div className="rpt-summary"><span className="sum-label">历史趋势</span>同一社区保存多期项目后，这里按时间对照总分、覆盖率与补点采纳（当前不足两期）。</div>;
  }
  const fp = r.provenance?.ruleFingerprint ?? '';
  const rows = mine.map((p, i) => {
    const same = (p.result.provenance?.ruleFingerprint ?? '') === fp && fp !== '';
    const cov = p.result.gap.coverageUnavailable || p.result.gap.coverageShare == null
      ? '无法评估'
      : `${Math.round(p.result.gap.coverageShare * 100)}%`;
    return {
      key: i,
      time: new Date(p.createdAt).toLocaleString('zh-CN'),
      persona: PERSONA_MAP[p.result.persona]?.name ?? p.result.persona,
      score: `${p.result.score.total}（${p.result.score.grade}）`,
      cov,
      accepted: p.workbench.acceptedSites.length,
      same,
      fp: (p.result.provenance?.ruleFingerprint ?? '未知').slice(0, 8),
    };
  });
  return (
    <>
      <div className="sec-title">历史趋势（同一社区 · 按时间）</div>
      <div id="trend-table">
        <Table
          className="tbl" size="small" pagination={false} rowKey="key"
          columns={[
            { title: '体检时间', dataIndex: 'time' },
            { title: '人群', dataIndex: 'persona' },
            { title: '总分', className: 'num', render: (_: unknown, row: (typeof rows)[number]) => <b>{row.score}</b> },
            { title: '居住覆盖率', dataIndex: 'cov', className: 'num' },
            { title: '已采纳补点', dataIndex: 'accepted', className: 'num' },
            {
              title: '口径',
              render: (_: unknown, row: (typeof rows)[number]) =>
                row.same ? '同口径 ✓' : <span style={{ color: 'var(--warn)' }}>规则 {row.fp}</span>,
            },
          ]}
          dataSource={rows}
        />
      </div>
      <div className="rpt-sub">口径列标注「同口径 ✓」才可直接纵向比大小；规则或数据批次不同的期间只能并列查看。分数变化可能来自百度 POI 数据漂移与规则调整——<b>不能仅凭分数上升认定某项改造产生了效果</b>，需结合设施明细与实地核验。</div>
    </>
  );
}

export function ComparePanel({ r }: { r: AnalysisResult | null }) {
  const { scenarios, acceptedSites, rejectedSites } = getPanelView().workbench;
  if (!r) return <div className="empty-tip">先完成一次体检</div>;
  const editable = sameRules(r);
  return (
    <>
      <div className="rpt-summary"><span className="sum-label">方案对比</span>先在「规划建议」采纳补点，再把当前选择记录为 A 或 B。两套方案共用本次体检基线，记录后可继续调整；跳过的点不计入收益。</div>
      <p className="rpt-sub">{r.centerName} · {PERSONA_MAP[r.persona].name} · {r.minutes} 分钟<br />当前已采纳 {acceptedSites.length} 处，已跳过 {rejectedSites.length} 处。</p>
      {!editable && <p className="rpt-summary">此项目使用历史规则，方案只可查看。请重新体检后继续规划。</p>}
      <div className="comparison-actions">
        {(['A', 'B'] as const).map((k) => (
          <div className="plan-card" key={k}>
            <b>方案 {k}</b>
            <p className="rpt-sub">{scenarios[k] ? <>已记录 {scenarios[k]!.acceptedSites.length} 处补点<br />{new Date(scenarios[k]!.savedAt).toLocaleString('zh-CN')}</> : '尚未记录'}</p>
            <Button size="small" data-scenario-save={k} disabled={!editable} onClick={() => compareActions.save(k)}>{scenarios[k] ? '更新' : '记录'}为 {k}</Button>{' '}
            <Button size="small" data-scenario-load={k} disabled={!editable || !scenarios[k]} onClick={() => compareActions.load(k)}>载入 {k}</Button>
          </div>
        ))}
      </div>
      <div className="comparison-tools">
        <Button size="small" id="compare-plan" onClick={() => switchTab('plan')}>去调整补点</Button>
        <Button size="small" id="compare-reset" disabled={!editable} onClick={() => compareActions.reset()}>清空当前选择</Button>
      </div>
      <p className="rpt-sub">清空或载入只改变当前工作台，已记录的 A / B 保留；覆盖记录前会提醒确认。</p>
      <ComparisonTable r={r} />
      <TrendTable r={r} />
      <div className="rpt-sub">全覆盖：菜市场、药店、小学三类服务齐全的住宅代理权重占比。新增覆盖相对现状计算，重叠服务范围去重。剩余薄弱住宅格只统计有住宅权重的格点。{THRESHOLDS.coreRadiusM} 米直线半径模拟，非真实人口数；现状总分不随补点重算。数据不完整时不提供改善结论。</div>
    </>
  );
}
