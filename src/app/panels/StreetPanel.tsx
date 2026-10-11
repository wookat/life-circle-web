import { Button, Input, Select, Statistic, Table, Tag } from 'antd';
import { useEffect, useState } from 'react';
import { banner } from '../../hud.js';
import { CATEGORY_MAP, PERSONA_MAP } from '../../../shared/config.js';
import { getStreetView, streetActions, streetMounts, streetStart, type StreetCommunity, type StreetView } from '../../panels.js';

const shortName = (n: string) => n.replace(/^江西省上饶市信州区/, '').replace(/^上饶市信州区/, '');
const catName = (c: string | null) => (c ? (CATEGORY_MAP[c as keyof typeof CATEGORY_MAP]?.name ?? c) : '—');
const covText = (c: { coverageShare: number | null; coverageUnavailable?: boolean }) =>
  c.coverageUnavailable || c.coverageShare == null ? '无法评估' : `${Math.round(c.coverageShare * 100)}%`;

function CommunityTable({ communities }: { communities: StreetCommunity[] }) {
  const rows = [...communities].sort((a, b) => b.score - a.score);
  return (
    <Table<StreetCommunity>
      className="tbl" size="small" pagination={false} rowKey={(c) => `${c.name}-${c.score}`}
      dataSource={rows}
      columns={[
        { title: '小区', render: (_, c) => shortName(c.name) },
        { title: '评分', className: 'num', render: (_, c) => (c.score >= 0 ? c.score : '—') },
        { title: '等级', render: (_, c) => (c.grade === '-' ? '—' : <Tag className={`pill ${c.grade === 'A' || c.grade === 'B' ? 'ok' : c.grade === 'C' ? 'mid' : 'bad'}`}>{c.grade}</Tag>) },
        { title: '覆盖率', className: 'num', render: (_, c) => covText(c) },
        { title: '主要缺失', render: (_, c) => catName(c.dominantMissing) },
        { title: '', render: (_, c) => <Button size="small" data-fly={`${c.center.lat},${c.center.lng}`}>定位</Button> },
      ]}
    />
  );
}

function StreetStatus({ view }: { view: StreetView }) {
  const s = view.snap;
  if (!view.hasJob || !s) return <div id="street-status"><div className="empty-tip">发起任务后，这里显示进度与街道排名</div></div>;
  if (s.status === 'running') {
    return (
      <div id="street-status">
        <div className="rpt-summary"><span className="sum-label">进行中</span>{s.done}/{s.total} 完成 · 当前：{s.current}
          <Button id="btn-street-cancel" size="small" style={{ marginLeft: 8 }} onClick={() => void streetActions.cancel()}>取消任务</Button>
        </div>
        {s.communities.length > 0 && <CommunityTable communities={s.communities} />}
      </div>
    );
  }
  if (s.status === 'cancelled') {
    return (
      <div id="street-status">
        <div className="rpt-summary"><span className="sum-label" style={{ color: 'var(--warn)' }}>已取消</span>任务已停止，已完成的 {s.done} 个小区结果保留。</div>
        <CommunityTable communities={s.communities} />
      </div>
    );
  }
  if (s.status === 'error') {
    return (
      <div id="street-status">
        <div className="rpt-summary"><span className="sum-label" style={{ color: 'var(--bad)' }}>失败</span>{s.error ?? '未知错误'}</div>
        {s.communities?.length > 0 && <CommunityTable communities={s.communities} />}
      </div>
    );
  }
  const sum = s.summary ?? {};
  const dist = Object.entries(sum.gradeDist ?? {}).map(([g, n]) => `${g} 级 ×${n}`).join(' · ');
  const weak = (sum.weakList ?? []) as { name: string; score: number; coverageShare: number | null; dominantMissing: string | null }[];
  const groups = (s.summary?.streetGroups ?? []) as { street: string; count: number; avgScore: number; weakCount?: number; bestScore: number; worstScore: number }[];
  return (
    <div id="street-status">
      <div className="kpi-row">
        <div className="kpi"><Statistic value={sum.avgScore ?? '—'} /><span>街道均分{s.persona && s.persona !== 'adult' ? `（${PERSONA_MAP[s.persona as keyof typeof PERSONA_MAP]?.name ?? s.persona}口径）` : ''}</span></div>
        <div className="kpi"><Statistic value={s.total} /><span>采样小区</span></div>
        <div className="kpi"><Statistic value={sum.scoreGap ?? 0} /><span>最优最差极差</span></div>
      </div>
      <div className="rpt-summary"><span className="sum-label">汇总</span>等级分布：{dist || '—'}；
        {sum.best && <>最优 <b>{shortName(sum.best.name)}（{sum.best.score}）</b></>}
        {sum.worst && <>、最差 <b>{shortName(sum.worst.name)}（{sum.worst.score}）</b></>}。
        地图上已按等级着色标注各小区。
      </div>
      {(() => {
        const scored = s.communities.filter((c) => c.score >= 0);
        if (scored.length < 2) return null;
        const miss = new Map<string, number>();
        scored.forEach((c) => { if (c.dominantMissing) miss.set(c.dominantMissing, (miss.get(c.dominantMissing) ?? 0) + 1); });
        const maxScore = Math.max(...scored.map((c) => c.score), 1);
        return (
          <>
            {miss.size > 0 && (
              <div className="rpt-summary">
                <span className="sum-label">短板类别分布</span>
                {[...miss.entries()].sort((a, b) => b[1] - a[1]).map(([cat, n]) => (
                  <Tag key={cat} className="pill mid" style={{ marginRight: 6 }}>{catName(cat)} ×{n}</Tag>
                ))}
                ——这些是本片区最普遍的缺口，区级统筹补建收益最大。
              </div>
            )}
            <div className="sec-title">小区评分排行</div>
            <div className="rank-bars">
              {[...scored].sort((a, b) => b.score - a.score).map((c) => (
                <div className="rank-bar-row" key={c.name}>
                  <span className="rank-bar-name">{shortName(c.name)}</span>
                  <span className="rank-bar-track"><span className="rank-bar-fill" style={{ width: `${Math.round((c.score / maxScore) * 100)}%`, background: c.score >= 75 ? 'var(--ok)' : c.score >= 60 ? 'var(--warn)' : 'var(--bad)' }} /></span>
                  <span className="rank-bar-score">{c.score}</span>
                </div>
              ))}
            </div>
          </>
        );
      })()}
      {weak.length > 0 && (
        <>
          <div className="sec-title">公平性视角 · 薄弱小区清单</div>
          <Table className="tbl" size="small" pagination={false} rowKey={(w) => w.name} dataSource={weak}
            columns={[
              { title: '小区', render: (_, w) => shortName(w.name) },
              { title: '评分', className: 'num', dataIndex: 'score' },
              { title: '覆盖率', className: 'num', render: (_, w) => (w.coverageShare == null ? '无法评估' : `${Math.round(w.coverageShare * 100)}%`) },
              { title: '主要缺失', render: (_, w) => catName(w.dominantMissing) },
            ]} />
          <div className="rpt-sub">公平性口径：评分 &lt; 75 或人口覆盖率 &lt; 80% 判定为薄弱小区——资源应优先向这些片区倾斜。</div>
        </>
      )}
      {groups.length > 0 && (
        <>
          <div className="sec-title">城区试点 · 街道分组排名</div>
          <Table className="tbl" size="small" pagination={false} rowKey={(g) => g.street} dataSource={groups}
            columns={[
              { title: '街道', dataIndex: 'street' },
              { title: '小区数', className: 'num', dataIndex: 'count' },
              { title: '均分', className: 'num', render: (_, g) => <b>{g.avgScore}</b> },
              { title: '薄弱', className: 'num', render: (_, g) => g.weakCount || '—' },
              { title: '最优', className: 'num', dataIndex: 'bestScore' },
              { title: '最差', className: 'num', dataIndex: 'worstScore' },
            ]} />
        </>
      )}
      <CommunityTable communities={s.communities.filter((c) => c.score >= 0)} />
      <Button id="btn-weak-csv" onClick={() => streetActions.exportWeakCsv()}>导出薄弱社区 CSV</Button>
      <div className="rpt-sub">说明：排名为<b>片区抽样口径</b>（采样半径内住宅小区），非行政街道全域普查；小区评分未覆盖时显示「-」；重复发起任务会命中服务端缓存，速度快得多。</div>
    </div>
  );
}

export function StreetPanel() {
  const [addr, setAddr] = useState('');
  const [scope, setScope] = useState('street');
  const [radius, setRadius] = useState('2500');
  const [max, setMax] = useState('10');
  const [persona, setPersona] = useState('adult');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<StreetView>(getStreetView());

  useEffect(() => {
    const on = () => setView(getStreetView());
    window.addEventListener('lc:street', on);
    streetMounts();
    return () => window.removeEventListener('lc:street', on);
  }, []);

  const district = scope === 'district';
  const note = district
    ? '城区试点：半径可至 8km、最多 30 个采样点，结果将按街道分组排名（约 3-6 分钟，企业配额）。'
    : '街道体检：半径 ≤3km、≤16 个采样点。切到「城区试点」可扩大到 8km / 30 点，结果将按街道分组排名。';

  return (
    <>
      <div className="rpt-summary"><span className="sum-label">街道体检</span>
        输入街道 / 片区地址，系统检索片区内住宅小区作为采样点，逐个完整体检后给出街道排名。
        任务在服务端串行执行，首次约 1-3 分钟（受上游限流），结果服务端缓存。
      </div>
      <div className="plan-card">
        <label className="lbl" htmlFor="street-addr">街道 / 片区 / 城区地址</label>
        <Input
          id="street-addr"
          style={{ width: '100%', margin: '6px 0' }}
          placeholder="如：上饶市信州区东市街道 / 上饶市信州区"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
          <label className="lbl">范围</label>
          <Select
            id="street-scope" value={scope} style={{ width: 108 }}
            options={[{ value: 'street', label: '街道体检' }, { value: 'district', label: '城区试点' }]}
            onChange={(v) => {
              setScope(v);
              setRadius(v === 'district' ? '5000' : '2500');
              setMax(v === 'district' ? '16' : '10');
            }}
          />
          <label className="lbl">人群</label>
          <Select
            id="street-persona" value={persona} title="批量体检人群" style={{ width: 108 }}
            options={[{ value: 'adult', label: '一般成人' }, { value: 'elderly', label: '老年人' }, { value: 'child', label: '儿童(陪同)' }]}
            onChange={setPersona}
          />
          <label className="lbl">采样半径</label>
          <Select
            id="street-radius" value={radius} style={{ width: 88 }}
            options={[{ value: '1500', label: '1.5 km' }, { value: '2500', label: '2.5 km' }, { value: '3000', label: '3 km' }, { value: '5000', label: '5 km' }, { value: '6500', label: '6.5 km' }]}
            onChange={setRadius}
          />
          <label className="lbl">采样点上限</label>
          <Select
            id="street-max" value={max} style={{ width: 64 }}
            options={[{ value: '6', label: '6' }, { value: '10', label: '10' }, { value: '16', label: '16' }, { value: '24', label: '24' }]}
            onChange={setMax}
          />
          <Button
            id="btn-street-start" type="primary" style={{ marginLeft: 'auto' }} loading={busy}
            onClick={async () => {
              const address = addr.trim();
              if (!address) { banner('请先输入街道 / 片区地址', 'warn'); return; }
              setBusy(true);
              try {
                await streetStart({ address, scope, radiusM: Number(radius), maxCommunities: Number(max), persona });
              } finally {
                setBusy(false);
              }
            }}
          >
            开始
          </Button>
        </div>
        <div className="rpt-sub" id="street-scope-note" style={{ marginTop: 6 }}>{note}</div>
      </div>
      <StreetStatus view={view} />
      <div id="street-usage" className="rpt-sub" style={{ marginTop: 8 }}>{view.usageText}</div>
      <div id="street-jobs" className="rpt-sub" style={{ marginTop: 8 }}>
        {view.jobs.length > 0 && <>最近任务：
          {view.jobs.map((j, i) => (
            <span key={j.id}>{i > 0 && ' · '}{j.label}
              {j.canFind && <Button size="small" data-jobfind={j.id} style={{ fontSize: 12, padding: '0 6px', height: 22, marginLeft: 4 }} onClick={() => streetActions.findJob(j.id)}>找回</Button>}
              {j.canResume && <Button size="small" data-jobresume={j.id} style={{ fontSize: 12, padding: '0 6px', height: 22, marginLeft: 4 }} onClick={() => void streetActions.resumeJob(j.id)}>续跑剩余</Button>}
            </span>
          ))}
        </>}
      </div>
    </>
  );
}
