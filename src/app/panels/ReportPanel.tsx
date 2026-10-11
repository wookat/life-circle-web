import { useEffect } from 'react';
import { Alert, Card, Statistic, Table, Tag } from 'antd';
import type { AnalysisResult, PoiSearchCompleteness } from '../../../shared/types.js';
import { CATEGORY_MAP, PERSONA_MAP } from '../../../shared/config.js';
import { CHANNEL_LABEL } from '../../hud.js';
import { renderCharts } from '../../charts.js';
import { explainResult } from '../../explain.js';
import { sameRules } from '../../panels.js';

const GRADE_COLOR: Record<string, string> = { A: '#2f9e44', B: '#74b816', C: '#f08c00', D: '#e8590c', E: '#e03131' };
const POI_STATUS: Record<PoiSearchCompleteness['status'], string> = {
  complete: '已取完', truncated: '达到上限', partial: '部分结果', unknown: '总量未知', failed: '检索失败', skipped: '未执行'
};

export function ReportPanel({ r, correctionsCount }: { r: AnalysisResult | null; correctionsCount: number }) {
  useEffect(() => { if (r) renderCharts(r); }, [r]);

  if (!r) {
    return (
      <div className="empty-tip">
        <div className="empty-title">三步完成一次生活圈体检</div>
        <ol>
          <li><b>定位中心点</b>：输入地址，或在地图上直接选点；</li>
          <li><b>选择人群</b>：老年人速度更慢，可达范围更小；</li>
          <li><b>点击「开始体检」</b>，查看右侧各页签的报告与规划建议。</li>
        </ol>
      </div>
    );
  }

  const dim = r.score.dims;
  const cumBy = r.cumulative?.byCategory ?? {};
  const searches = r.poiSearch ?? [];
  const p = r.provenance;

  return (
    <>
      <Card className="rpt-hero" size="small">
        <div className="rpt-grade">
          <div className="grade-circle" style={{ background: GRADE_COLOR[r.score.grade] ?? '#666' }}>
            <span>{r.score.grade}</span><b>{r.score.total}</b>
          </div>
          <div className="rpt-grade-text">
            <div className="rpt-title">{r.centerName || '所选中心点'}</div>
            <div className="rpt-sub">
              {PERSONA_MAP[r.persona].name} · 步行 {r.minutes} 分钟 · 速度 {r.field.speed}m/min<br />
              {new Date(r.generatedAt).toLocaleString('zh-CN')}
              {r.mock && <> · <span className="mock-flag">演示数据</span></>}
            </div>
          </div>
        </div>

        <div className="kpi-row">
          <div className="kpi"><Statistic value={Math.round(dim.completeness * 100)} /><span>完整度</span></div>
          <div className="kpi"><Statistic value={Math.round(dim.proximity * 100)} /><span>临近度</span></div>
          <div className="kpi">
            <Statistic value={r.score.coverageUnavailable ? '—' : Math.round((dim.coverage ?? 0) * 100)} />
            <span>人口覆盖率{r.score.coverageUnavailable ? '（无法评估）' : ''}</span>
          </div>
        </div>

        {r.cumulative && (
          <div className="rpt-sub rpt-meta">
            累积机会（已取样本口径）：{r.minutes} 分钟步行圈内查得设施 <b>{r.cumulative.total}</b> 处 · 覆盖 <b>{r.cumulative.categoriesCovered}</b>/10 类
            {r.cumulative.missingCategories.length > 0 && ` · 样本中未查得：${r.cumulative.missingCategories.map((c) => CATEGORY_MAP[c as keyof typeof CATEGORY_MAP]?.name ?? c).join('、')}`}
          </div>
        )}

        {r.accuracy && r.accuracy.samples > 0 && (
          <div className="rpt-sub rpt-meta">
            插值精度核验：抽样 {r.accuracy.samples} 个算路点{r.mock ? '（当前含演示数据，仅供流程验证）' : ''}，模型估计平均绝对误差 <b>{r.accuracy.maeMinutes} 分钟（{r.accuracy.maePercent}%）</b>，最大偏差 {r.accuracy.worstPercent}%
          </div>
        )}
      </Card>

      {(r.warnings?.length ?? 0) > 0 && (
        <Alert className="rpt-summary" type="warning" showIcon={false}
          message={<>
            <span className="sum-label" style={{ color: 'var(--warn)' }}>口径与警告</span>
            <ul className="rpt-warn-list">{(r.warnings ?? []).map((w, i) => <li key={i}>{w}</li>)}</ul>
          </>} />
      )}

      {r.persona === 'elderly' && (
        <Alert className="rpt-summary" type="info" showIcon={false}
          message={<><span className="sum-label">老年友好解读</span>本页按老年人口径计算（步速 52m/min，已含过街等待与步速折减）；过街设施：天桥 {r.crossings?.overpass ?? 0} 处 · 地下通道 {r.crossings?.underpass ?? 0} 处。公园绿地可作歇憩点参考。<b>口径边界：台阶、坡度、无障碍通道等障碍未建模</b>——步速折减是参数化近似，无障碍能力需实地核验，不能以「分数不差」替代无障碍评估。</>} />
      )}

      <Alert className="rpt-summary" type="info" showIcon={false}
        message={<><span className="sum-label">诊断</span>{r.score.summary}</>} />

      {(r.score.missingDataCategories?.length ?? 0) > 0 && (
        <div className="rpt-sub" style={{ margin: '-8px 0 10px', color: 'var(--warn)' }}>
          ※ {(r.score.missingDataCategories ?? []).join('、')}检索失败或不完整，已取数量仅供参考，相关类别未计入评分。
        </div>
      )}

      <div className="sec-title">数据完整性与来源</div>
      {!sameRules(r) && <Alert className="rpt-summary" type="info" showIcon={false} message="此项目的算法或规则与当前版本不同，已保留历史结果。请重新体检后继续规划。" />}
      {p ? (
        <div className="rpt-sub report-source">
          报告编号：{p.reportId}<br />
          版本：{p.applicationVersion} · {p.algorithmVersion}<br />
          规则：{p.ruleVersion} / {p.ruleFingerprint}<br />
          数据通道：{p.channels.map((c) => CHANNEL_LABEL[c]).join('、')}；坐标 BD-09；住宅小区作为人口代理。<br />
          设施最早采集：{p.poiCollectedAt ? new Date(p.poiCollectedAt).toLocaleString('zh-CN') : '无可用采集记录'}；
          {p.poiCacheHits}/{p.poiQueries} 次检索全部命中缓存。路线缓存的原始采集时间暂未记录。
        </div>
      ) : (
        <div className="rpt-sub">此报告未记录版本与采集来源，请重新体检以建立完整记录。</div>
      )}
      <div className="rpt-sub">“已取完”仅表示本次关键词返回结果已取尽，不代表现实设施普查。数量为去重后已取 / 上游原始总数；达到上限时不会继续消耗配额。</div>

      {searches.length > 0 && (
        <Table<PoiSearchCompleteness>
          className="tbl data-quality"
          size="small"
          pagination={false}
          rowKey={(s) => `${s.keyword}:${s.source}`}
          columns={[
            {
              title: '关键词 / 来源',
              render: (_, s) => (
                <>
                  {s.keyword}<br />
                  <span className="rpt-sub">{CHANNEL_LABEL[s.source]}{s.cacheHit ? ' · 缓存' : ''}</span>
                </>
              )
            },
            { title: '已取 / 总数', align: 'right', render: (_, s) => `${s.fetchedCount} / ${s.reportedTotal ?? '未知'}` },
            {
              title: '检索状态',
              render: (_, s) => (
                <>
                  <Tag className={`pill ${s.status === 'complete' ? 'ok' : 'mid'}`}>{POI_STATUS[s.status]}</Tag><br />
                  <span className="rpt-sub">{s.pagesFetched}/{s.pageLimit} 页</span>
                </>
              )
            }
          ]}
          dataSource={searches}
        />
      )}

      <div className="sec-title">四维体检（雷达）</div>
      <div id="chart-radar" className="chart-box" />
      <div className="sec-title">设施完整度（柱状：实际 vs 理想）</div>
      <div id="chart-bar" className="chart-box" />

      <div className="sec-title">分类明细</div>
      <div className="rpt-sub" style={{ marginBottom: 4 }}>
        口径说明：「数量」为 2km 半径检索所得（周边统计）；「圈内可达」为步行 {r.minutes} 分钟内真实可抵（时间场判定）；「1km 盲区」为评分细则口径（直线）。
      </div>
      <Table
        className="tbl"
        size="small"
        pagination={false}
        rowKey={(d) => d.category}
        columns={[
          {
            title: '类别',
            render: (_, d) => (
              <>
                <span className="dot" style={{ background: CATEGORY_MAP[d.category].color }} />
                {d.name}
                {d.missingData && <> <Tag className="pill mid">数据不完整</Tag></>}
              </>
            )
          },
          { title: '数量', align: 'right', render: (_, d) => `${r.pois.filter((p2) => p2.category === d.category).length}${d.missingData ? '（已取）' : ''}` },
          { title: '圈内可达', align: 'right', render: (_, d) => d.category === 'residential' ? '—' : String(cumBy[d.category] ?? 0) },
          { title: '最近', align: 'right', render: (_, d) => d.nearestM != null ? `${d.nearestM}m` : '—' },
          { title: '完整度', align: 'right', render: (_, d) => d.missingData ? '—' : `${Math.round(d.completeness * 100)}%` }
        ]}
        dataSource={r.score.details}
      />

      <div className="sec-title">过街便利度</div>
      {r.crossings ? (
        <div className="rpt-sub">
          扫描 {r.crossings.scanned} 条步行路段：过街天桥 {r.crossings.overpass} 处 · 地下通道 {r.crossings.underpass} 处 · 平面过街提示 {r.crossings.crosswalkHint} 处。<br />
          过街设施影响老年人等人群的实际步行可达性，已纳入速度折减。
        </div>
      ) : (
        <div className="rpt-sub">未启用过街设施扫描。</div>
      )}

      {explainResult(r).map((e) => (
        <Alert key={e.title} className="rpt-summary" type="info" showIcon={false}
          message={<><span className="sum-label">解读</span><b>{e.title}</b> —— {e.text}</>} />
      ))}

      {correctionsCount > 0 && (
        <div className="rpt-sub" style={{ marginTop: 8 }}>
          现场纠错标注 {correctionsCount} 条（如已核验/停业/迁移/分类错误）。<b>口径说明：人工标注仅作现场记录，未计入评分与统计</b>——避免单人主观修改统计口径；可在地图设施弹窗撤销，导出 JSON 随附全部记录。
        </div>
      )}
    </>
  );
}
