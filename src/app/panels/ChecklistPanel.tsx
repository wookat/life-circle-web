import { Alert, Table, Tag } from 'antd';
import type { AnalysisResult } from '../../../shared/types.js';

export function ChecklistPanel({ r }: { r: AnalysisResult | null }) {
  if (!r) return <div className="empty-tip">先完成一次体检</div>;

  const judged = r.checklist.filter((c) => c.met !== null);
  const metCount = judged.filter((c) => c.met).length;
  const unknownCount = r.checklist.length - judged.length;

  return (
    <>
      <Alert className="rpt-summary" type="info" showIcon={false}
        message={`「完整社区」对标清单：${metCount}/${judged.length} 项达标${unknownCount ? `，另有 ${unknownCount} 项因检索失败无法判断` : ''}。阈值参考《完整居住社区建设标准（试行）》《社区生活圈规划技术指南》通行口径取整，为可配置参考基线。`} />
      <Table
        className="tbl"
        size="small"
        pagination={false}
        rowKey={(c) => c.name}
        columns={[
          {
            title: '设施项',
            render: (_, c) => <>{c.name}<br /><span style={{ color: 'var(--ink-2)', fontSize: 11 }}>{c.basis}</span></>
          },
          { title: '阈值', align: 'right', render: (_, c) => `≤${c.thresholdM}m` },
          { title: '实测最近', align: 'right', render: (_, c) => c.nearestM != null ? `${c.nearestM}m` : '—' },
          {
            title: '判定',
            render: (_, c) =>
              c.met === null ? <Tag className="pill mid">无法判断</Tag>
                : c.met ? <Tag className="pill ok">达标</Tag>
                  : <Tag className="pill bad">缺失</Tag>
          }
        ]}
        dataSource={r.checklist}
      />
    </>
  );
}
