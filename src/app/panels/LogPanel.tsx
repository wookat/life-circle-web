import { CHANNEL_LABEL } from '../../hud.js';
import type { AnalysisResult } from '../../../shared/types.js';

export function LogPanel({ r }: { r: AnalysisResult | null }) {
  if (!r) return <div className="empty-tip">先完成一次体检</div>;
  return (
    <>
      {r.mock && <div className="log-line log-warn">当前处于演示数据模式（未配置 AK 或上游全部熔断）</div>}
      {r.steps.map((s, i) => (
        <div className="log-line" key={i}>
          <b>{s.name}</b> — 通道 {CHANNEL_LABEL[s.usage.channel]} · {s.usage.ms}ms
          {s.usage.cacheHit ? ' · 缓存命中' : ''}{s.usage.note ? ` · ${s.usage.note}` : ''}
        </div>
      ))}
    </>
  );
}
