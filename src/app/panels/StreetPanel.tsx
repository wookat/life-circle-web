import { Button, Input } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { banner } from '../../hud.js';
import { streetMounts, streetStart } from '../../panels.js';

/**
 * 街道体检：表单 React 化；进度/任务列表/配额行仍由 panels.ts 的
 * updateStreetStatus/refreshJobList/refreshUsageLine 以 innerHTML 刷新，
 * 通过 ref 挂载一次（React 不管理其子树）。
 */
export function StreetPanel() {
  const [addr, setAddr] = useState('');
  const [scope, setScope] = useState('street');
  const [radius, setRadius] = useState('2500');
  const [max, setMax] = useState('10');
  const [persona, setPersona] = useState('adult');
  const [busy, setBusy] = useState(false);
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    el.innerHTML = '<div id="street-status"></div><div id="street-usage" class="rpt-sub" style="margin-top:8px"></div><div id="street-jobs" class="rpt-sub" style="margin-top:8px"></div>';
    streetMounts();
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
          <select
            id="street-scope" style={{ height: 30 }} value={scope}
            onChange={(e) => {
              const v = e.target.value;
              setScope(v);
              setRadius(v === 'district' ? '5000' : '2500');
              setMax(v === 'district' ? '16' : '10');
            }}
          >
            <option value="street">街道体检</option>
            <option value="district">城区试点</option>
          </select>
          <label className="lbl">采样半径</label>
          <select id="street-persona" style={{ height: 30 }} title="批量体检人群" value={persona} onChange={(e) => setPersona(e.target.value)}>
            <option value="adult">一般成人</option>
            <option value="elderly">老年人</option>
            <option value="child">儿童(陪同)</option>
          </select>
          <select id="street-radius" style={{ height: 30 }} value={radius} onChange={(e) => setRadius(e.target.value)}>
            <option value="1500">1.5 km</option>
            <option value="2500">2.5 km</option>
            <option value="3000">3 km</option>
            <option value="5000">5 km</option>
            <option value="6500">6.5 km</option>
          </select>
          <label className="lbl">采样点上限</label>
          <select id="street-max" style={{ height: 30 }} value={max} onChange={(e) => setMax(e.target.value)}>
            <option value="6">6</option>
            <option value="10">10</option>
            <option value="16">16</option>
            <option value="24">24</option>
          </select>
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
      <div ref={mountRef} />
    </>
  );
}
