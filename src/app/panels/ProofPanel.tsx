import { Alert, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { AnalysisResult, ChannelUsage } from '../../../shared/types.js';
import { CHANNEL_LABEL } from '../../hud.js';
import { BATCH_ROWS, DELIVERABLES, GATES, MAPPING_ROWS, REPO, blob } from '../proofData.js';

type StepRow = { name: string; channel: string; ms: number; cacheHit: boolean; note?: string };

const stepCols: ColumnsType<StepRow> = [
  { title: '调用步骤', dataIndex: 'name', width: 104, ellipsis: true },
  { title: '通道', dataIndex: 'channel', width: 88, render: (c: string) => <Tag>{c}</Tag> },
  { title: '耗时', dataIndex: 'ms', width: 72, align: 'right', render: (ms: number) => `${ms}ms` },
  { title: '缓存', dataIndex: 'cacheHit', width: 52, render: (h: boolean) => (h ? '命中' : '—') },
  { title: '说明', dataIndex: 'note', ellipsis: true },
];

const batchCols: ColumnsType<(typeof BATCH_ROWS)[number]> = [
  { title: '批次', dataIndex: 'batch', width: 92 },
  { title: '点位', dataIndex: 'site', width: 150, ellipsis: true },
  { title: '人群', dataIndex: 'persona', width: 52 },
  { title: '评级', dataIndex: 'grade', width: 64 },
  { title: '累积机会', dataIndex: 'opportunity', width: 88, ellipsis: true },
  { title: '插值 MAE', dataIndex: 'mae', width: 124 },
  { title: '备注', dataIndex: 'note', ellipsis: true },
];

const gateCols: ColumnsType<(typeof GATES)[number]> = [
  { title: '门禁', dataIndex: 'name', width: 132 },
  { title: '结果', dataIndex: 'result', width: 168 },
  { title: '复现命令', dataIndex: 'reproduce', ellipsis: true, render: (c: string) => <code>{c}</code> },
];

const mapCols: ColumnsType<(typeof MAPPING_ROWS)[number]> = [
  { title: '评分细则', dataIndex: 'rule', width: 124 },
  { title: '本项目实现', dataIndex: 'impl', ellipsis: true },
  {
    title: '证据位置', dataIndex: 'evidence', width: 220,
    render: (e: { label: string; href: string }) => (
      <Typography.Link href={e.href} target="_blank" rel="noreferrer">{e.label}</Typography.Link>
    ),
  },
];

function LiveEvidence({ r }: { r: AnalysisResult }) {
  const steps: StepRow[] = r.steps.map((s: { name: string; usage: ChannelUsage }) => ({
    name: s.name,
    channel: CHANNEL_LABEL[s.usage.channel] ?? s.usage.channel,
    ms: s.usage.ms,
    cacheHit: Boolean(s.usage.cacheHit),
    note: s.usage.note,
  }));
  const totalMs = steps.reduce((a, s) => a + s.ms, 0);
  const cacheHits = steps.filter((s) => s.cacheHit).length;
  const channels = [...new Set(steps.map((s) => s.channel))].join(' / ');
  return (
    <>
      <Alert
        className="rpt-summary" type="info" showIcon={false}
        message={r.mock
          ? '本次运行为演示数据（合成通道），下表为本地会话真实步骤记录。'
          : `本次体检真实调用：${steps.length} 步 · 合计 ${(totalMs / 1000).toFixed(1)}s · 通道 ${channels} · 缓存命中 ${cacheHits}`}
      />
      <Table<StepRow>
        size="small" rowKey={(s) => s.name + s.ms} columns={stepCols} dataSource={steps}
        pagination={false} scroll={{ x: 'max-content' }} style={{ marginTop: 8 }}
      />
      {r.accuracy && (
        <div className="log-line" style={{ marginTop: 8 }}>
          插值精度自证：抽样 {r.accuracy.samples} 路真实算路核验，MAE {r.accuracy.maeMinutes} 分钟
          （{r.accuracy.maePercent}%）· 最差偏差 {r.accuracy.worstPercent}%
        </div>
      )}
      {r.popCoverage && (
        <div className="log-line">
          人口覆盖（WorldPop 2020 · 100m 栅格）：等时圈 {Math.round(r.popCoverage.popIn).toLocaleString()} 人
          / 理想圈 {Math.round(r.popCoverage.popEval).toLocaleString()} 人 ≈ {Math.round(r.popCoverage.share * 100)}%
        </div>
      )}
      {(r.warnings?.length ?? 0) > 0 && (
        <div style={{ marginTop: 8 }}>
          <b>本次降级 / 容错事件（如实记录，不掩盖）：</b>
          {r.warnings!.map((w, i) => <div className="log-line log-warn" key={i}>{w}</div>)}
        </div>
      )}
    </>
  );
}

export function ProofPanel({ r }: { r: AnalysisResult | null }) {
  return (
    <>
      <div className="empty-title" style={{ marginTop: 4 }}>本次运行证据</div>
      {r
        ? <LiveEvidence r={r} />
        : <div className="log-line">先完成一次体检——这里会记录本次会话的真实调用步骤、耗时、通道与降级事件。</div>}

      <div className="empty-title" style={{ marginTop: 18 }}>实测跑批记录（真 AK · 服务端通道）</div>
      <Table
        size="small" rowKey={(x) => x.site + x.persona} columns={batchCols} dataSource={BATCH_ROWS}
        pagination={false} scroll={{ x: 'max-content' }} style={{ marginTop: 8 }}
      />
      <div className="log-line">
        全量口径与人工核对过程：<Typography.Link href={blob('docs/COMPARISON_TEST.md')} target="_blank" rel="noreferrer">docs/COMPARISON_TEST.md</Typography.Link>
        {' '}｜在线演示可复现：<Typography.Link href="https://wookat.github.io/life-circle-web/" target="_blank" rel="noreferrer">wookat.github.io/life-circle-web</Typography.Link>
      </div>

      <div className="empty-title" style={{ marginTop: 18 }}>工程门禁</div>
      <div className="log-line" style={{ margin: '6px 0' }}>
        <Typography.Link href={`${REPO}/actions`} target="_blank" rel="noreferrer">
          <img alt="CI status" src={`${REPO}/actions/workflows/ci.yml/badge.svg`} style={{ verticalAlign: '-3px' }} />
        </Typography.Link>
        {' '}GitHub Actions · main 分支全绿（点击进流水记录）
      </div>
      <Table
        size="small" rowKey="name" columns={gateCols} dataSource={GATES}
        pagination={false} scroll={{ x: 'max-content' }} style={{ marginTop: 8 }}
      />

      <div className="empty-title" style={{ marginTop: 18 }}>交付物清单（点开可核）</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '8px 0' }}>
        {DELIVERABLES.map((d) => (
          <Typography.Link key={d.path} href={blob(d.path)} target="_blank" rel="noreferrer">
            <Tag color="blue" style={{ cursor: 'pointer' }}>{d.name}</Tag>
          </Typography.Link>
        ))}
      </div>

      <div className="empty-title" style={{ marginTop: 18 }}>评审细则 ↔ 实现对照</div>
      <Table
        size="small" rowKey="rule" columns={mapCols} dataSource={MAPPING_ROWS}
        pagination={false} scroll={{ x: 'max-content' }} style={{ marginTop: 8 }}
      />
      <div className="log-line" style={{ marginTop: 8, color: 'var(--ink-2)' }}>
        口径声明：本页数字均标注批次与来源；不同日期复测的 POI 计数存在日间漂移，以仓库文档为正式口径。
      </div>
    </>
  );
}
