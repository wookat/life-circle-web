import { Button, Input, Table, Tag } from 'antd';
import { useState } from 'react';
import {
  budgetExceeded, currentSites, planActions, sameRules, siteId, getPanelView,
} from '../../panels.js';
import { CATEGORY_MAP, THRESHOLDS } from '../../../shared/config.js';
import type { AnalysisResult } from '../../../shared/types.js';

const CORE = ['market', 'pharmacy', 'primarySchool'] as const;
const catName = (c: string) => CATEGORY_MAP[c as keyof typeof CATEGORY_MAP]?.name ?? c;

function FlyBtn({ lat, lng }: { lat: number; lng: number }) {
  return <Button size="small" data-fly={`${lat},${lng}`}>定位</Button>;
}

export function PlanPanel({ r }: { r: AnalysisResult | null }) {
  const wb = getPanelView().workbench;
  const [cat, setCat] = useState<string>(CORE[0]);
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [zone, setZone] = useState('');
  const budget = wb.budget;
  const [bMax, setBMax] = useState(() => (budget.maxSites === undefined ? '' : String(budget.maxSites)));
  const [bCost, setBCost] = useState(() => (budget.costPerSiteWan === undefined ? '' : String(budget.costPerSiteWan)));
  const [bTotal, setBTotal] = useState(() => (budget.totalBudgetWan === undefined ? '' : String(budget.totalBudgetWan)));

  if (!r) return <div className="empty-tip">先完成一次体检</div>;
  if (!sameRules(r)) {
    return <div className="rpt-summary">此项目的算法或规则与当前版本不同。历史结果仍可查看和导出；请重新体检后继续规划。</div>;
  }
  const { acceptedSites, rejectedSites, customCandidates, noGoZones } = wb;
  const sites = currentSites(r);

  return (
    <>
      <div className="rpt-summary">
        <span className="sum-label">工作台</span>规划引擎基于贪心最大覆盖给出补点建议。<b>采纳</b>一条建议后，
        其服务盘即刻写入覆盖状态并重新求解剩余建议；<b>跳过</b>则不再在该位置 400m 内重复推荐。
      </div>
      {budgetExceeded() && (
        <div className="rpt-summary" style={{ color: 'var(--warn)' }}>
          <span className="sum-label">预算超限</span>已采纳 {acceptedSites.length} 处，超出当前预算/数量上限（
          {budget.maxSites ?? '-'} 处上限{budget.totalBudgetWan !== undefined ? `，预算 ${budget.totalBudgetWan} 万` : ''}）。
          请撤销已采纳点或调整约束。
        </div>
      )}
      <div className="rpt-summary">
        <span className="sum-label">规划编辑</span>
        自定义候选与网格候选同场竞价；落入禁建区的候选被排除。成本为规划讨论假设，非工程概算；
        标注为<b>规划候选点</b>，不代表已具备建设条件的地块。
      </div>
      <Table
        className="tbl" size="small" pagination={false} rowKey={(_, i) => `c${i}`}
        columns={[
          { title: '类别', dataIndex: 'category', render: catName },
          { title: '纬度, 经度', className: 'num', render: (_: unknown, c: (typeof customCandidates)[number]) => `${c.latLng.lat.toFixed(5)}, ${c.latLng.lng.toFixed(5)}` },
          {
            title: '操作', render: (_: unknown, __: unknown, i: number) => (
              <>
                <Button size="small" data-planact="adopt-custom" data-idx={i} onClick={() => planActions.adoptCustom(i)}>采纳</Button>{' '}
                <Button size="small" data-planact="remove-custom" data-idx={i} onClick={() => planActions.removeCustom(i)}>移除</Button>
              </>
            ),
          },
        ]}
        dataSource={customCandidates}
        locale={{ emptyText: '暂无自定义候选' }}
      />
      <div className="plan-edit-row" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
        <select id="pe-cat" className="input" value={cat} onChange={(e) => setCat(e.target.value)}>
          {CORE.map((c) => <option key={c} value={c}>{catName(c)}</option>)}
        </select>
        <Input id="pe-lat" placeholder="纬度" style={{ width: 110 }} value={lat} onChange={(e) => setLat(e.target.value)} />
        <Input id="pe-lng" placeholder="经度" style={{ width: 110 }} value={lng} onChange={(e) => setLng(e.target.value)} />
        <Button id="pe-add" onClick={() => planActions.addCandidate(Number(lat), Number(lng), cat as (typeof CORE)[number])}>添加候选点</Button>
        <Input id="pe-zone" placeholder="禁建区半径 m" style={{ width: 110 }} value={zone} onChange={(e) => setZone(e.target.value)} />
        <Button id="pe-zone-add" onClick={() => planActions.addZone(Number(zone) > 0 ? Number(zone) : undefined)}>以分析中心添加禁建区</Button>
      </div>
      <Table
        className="tbl" size="small" pagination={false} rowKey={(_, i) => `z${i}`}
        columns={[
          { title: '禁建区', render: (_: unknown, z: (typeof noGoZones)[number]) => `半径 ${z.radiusM}m` },
          { title: '圆心', className: 'num', render: (_: unknown, z: (typeof noGoZones)[number]) => `${z.center.lat.toFixed(5)}, ${z.center.lng.toFixed(5)}` },
          { title: '操作', render: (_: unknown, __: unknown, i: number) => <Button size="small" data-planact="remove-zone" data-idx={i} onClick={() => planActions.removeZone(i)}>移除</Button> },
        ]}
        dataSource={noGoZones}
        locale={{ emptyText: '暂无禁建区' }}
      />
      <div className="plan-edit-row" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
        <Input id="pe-max" placeholder="最大补点数" style={{ width: 110 }} value={bMax} onChange={(e) => setBMax(e.target.value)} />
        <Input id="pe-cost" placeholder="单点成本(万)" style={{ width: 110 }} value={bCost} onChange={(e) => setBCost(e.target.value)} />
        <Input id="pe-total" placeholder="总预算(万)" style={{ width: 110 }} value={bTotal} onChange={(e) => setBTotal(e.target.value)} />
        <Button id="pe-budget-apply" onClick={() => planActions.applyBudget(bMax ?? '', bCost ?? '', bTotal ?? '')}>应用预算约束</Button>
      </div>

      {!r.planSites.length && !acceptedSites.length ? (
        <div className="empty-tip">{r.incomplete ? '检索数据不完整，当前没有可可靠推荐的补点；请核验数据后再规划。' : '当前暂无补点建议，请结合覆盖率与住宅样本判断。'}</div>
      ) : (
        <>
          {acceptedSites.length > 0 && (
            <>
              <div className="sec-title">已采纳方案</div>
              {acceptedSites.map((s) => (
                <div className="plan-card accepted" key={siteId(s)}>
                  <h4><span className="rank">✓</span> 补建「{catName(s.category)}」<Tag className="gain-chip">已纳入覆盖模拟</Tag></h4>
                  <div className="plan-meta"><span>坐标 {s.latLng.lat.toFixed(5)}, {s.latLng.lng.toFixed(5)}</span></div>
                  <div className="plan-loc">
                    <FlyBtn lat={s.latLng.lat} lng={s.latLng.lng} />
                    <Button size="small" data-act="undo-accept" data-id={siteId(s)} onClick={() => planActions.undoAccept(siteId(s))}>撤销</Button>
                  </div>
                </div>
              ))}
            </>
          )}
          {rejectedSites.length > 0 && (
            <>
              <div className="sec-title">已跳过</div>
              {rejectedSites.map((s) => (
                <div className="plan-card skipped" key={siteId(s)}>
                  <h4><span className="rank" style={{ background: '#8a93a6' }}>–</span> {catName(s.category)}（{s.latLng.lat.toFixed(4)}, {s.latLng.lng.toFixed(4)}）</h4>
                  <div className="plan-loc"><Button size="small" data-act="undo-reject" data-id={siteId(s)} onClick={() => planActions.undoReject(siteId(s))}>恢复推荐</Button></div>
                </div>
              ))}
            </>
          )}
          <div className="sec-title">当前建议（{sites.length}）</div>
          {!sites.length && <div className="empty-tip">已无进一步补点建议：或覆盖率良好，或剩余缺口不在可推荐范围。</div>}
          {sites.map((s) => (
            <div className="plan-card" key={siteId(s)}>
              <h4><span className="rank">{s.rank}</span> 建议补建「{catName(s.category)}」<Tag className="gain-chip">+{Math.round((s.afterPct - s.beforePct) * 10) / 10}pp</Tag></h4>
              <div>{s.rationale}</div>
              <div className="plan-meta">
                <span>坐标 {s.latLng.lat.toFixed(5)}, {s.latLng.lng.toFixed(5)}</span>
                <span>服务盘折算 ≈ {s.estWalkMin} 分钟步行</span>
              </div>
              <div className="plan-loc">
                <FlyBtn lat={s.latLng.lat} lng={s.latLng.lng} />
                <Button size="small" data-act="accept" data-id={siteId(s)} onClick={() => planActions.accept(siteId(s))}>采纳</Button>
                <Button size="small" data-act="reject" data-id={siteId(s)} onClick={() => planActions.reject(siteId(s))}>跳过</Button>
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}
