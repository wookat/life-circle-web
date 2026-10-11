import { Button, Input, Select } from 'antd';
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
          <Select
            id="street-scope" value={scope} style={{ width: 108 }}
            options={[{ value: 'street', label: '街道体检' }, { value: 'district', label: '城区试点' }]}
            onChange={(v) => {
              setScope(v);
              setRadius(v === 'district' ? '5000' : '2500');
              setMax(v === 'district' ? '16' : '10');
            }}
          />
          <label className="lbl">采样半径</label>
          <Select
            id="street-persona" value={persona} title="批量体检人群" style={{ width: 108 }}
            options={[{ value: 'adult', label: '一般成人' }, { value: 'elderly', label: '老年人' }, { value: 'child', label: '儿童(陪同)' }]}
            onChange={setPersona}
          />
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
      <div ref={mountRef} />
    </>
  );
}
