import { useRef, useState } from 'react';
import { Alert, Button, Input, Statistic, Table, Tag } from 'antd';
import type { AnalysisResult, GapPatch } from '../../../shared/types.js';
import { CATEGORY_MAP } from '../../../shared/config.js';
import { banner } from '../../hud.js';
import { addSupplement, getSupplements, removeSupplement } from '../../supplements.js';
import { clearBoundary, getBoundary, parseBoundaryGeoJson, saveBoundary } from '../../boundary.js';

function refreshPanel() {
  window.dispatchEvent(new CustomEvent('lc:panel'));
}

export function GapsPanel({ r }: { r: AnalysisResult | null }) {
  const [supp, setSupp] = useState({ name: '', lat: '', lng: '', hh: '', src: '' });
  const [suppJson, setSuppJson] = useState('');
  const bndFileRef = useRef<HTMLInputElement>(null);

  if (!r) return <div className="empty-tip">先完成一次体检</div>;

  const g = r.gap;
  const supplements = getSupplements()?.entries ?? [];
  const boundary = getBoundary();
  const radius = Math.max(...Object.values(r.model.radiusM));

  const addOne = () => {
    const res = addSupplement(r.center, radius, {
      name: supp.name,
      lat: Number(supp.lat),
      lng: Number(supp.lng),
      households: Number(supp.hh),
      source: supp.src
    });
    if (!res) { banner('补录无效：请检查名称、来源与坐标范围。'); return; }
    if (res.duplicate) banner(`提示：50m 内已存在「${res.duplicate.name}」，如非重复录入请忽略。`, 'warn', 8000);
    else if (res.abnormal) banner('提示：该点偏离分析中心超过采样半径（已保留，请确认坐标）。', 'warn', 8000);
    else banner('补录已保存，下一次体检并入采样。', 'info');
    setSupp({ name: '', lat: '', lng: '', hh: '', src: '' });
    refreshPanel();
  };

  const importJson = () => {
    const raw = suppJson.trim();
    if (!raw) { banner('请粘贴 JSON 数组后再导入。'); return; }
    let items: unknown[];
    try { items = JSON.parse(raw); } catch { banner('JSON 解析失败，请检查格式。'); return; }
    if (!Array.isArray(items) || !items.length) { banner('JSON 需为非空数组。'); return; }
    let okN = 0, dup = 0;
    for (const it of items as Record<string, unknown>[]) {
      const res = addSupplement(r.center, radius, {
        name: String(it.name ?? ''), lat: Number(it.lat), lng: Number(it.lng),
        households: Number(it.households), source: String(it.source ?? '未注明来源')
      });
      if (res) { okN++; if (res.duplicate) dup++; }
    }
    banner(`导入完成：成功 ${okN} 条${dup ? `，其中疑似重复 ${dup} 条` : ''}。下一次体检并入采样。`, 'info', 10000);
    refreshPanel();
  };

  const onBoundaryFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const b = parseBoundaryGeoJson(text, file.name.replace(/\.(geo)?json$/i, ''));
    if (!b) { banner('边界解析失败：需要含 Polygon/MultiPolygon 的 GeoJSON。'); return; }
    saveBoundary(b);
    banner(`边界已保存：${b.name}（${b.vertexCount} 顶点）。下一次体检生效。`, 'info', 8000);
    refreshPanel();
  };

  return (
    <>
      <div className="kpi-row">
        <div className="kpi"><Statistic value={g.blindPoints} /><span>盲区点位(格)</span></div>
        <div className="kpi"><Statistic value={g.patches.length} /><span>灰色斑块</span></div>
        <div className="kpi"><Statistic value={g.coverageShare == null ? '—' : `${Math.round(g.coverageShare * 100)}%`} /><span>居住权重全覆盖</span></div>
      </div>
      {g.coverageShare == null && (
        <div className="rpt-sub" style={{ color: 'var(--warn)', marginBottom: 10 }}>
          住宅样本缺失或核心类别数据不完整，三件套全覆盖率无法评估。请查看报告的数据完整性记录。
        </div>
      )}
      <div className="rpt-sub" style={{ marginBottom: 10 }}>
        盲区点位 = 步行时间圈内缺失任一核心设施（菜市场/药店/小学，1km 口径）的网格；
        缺 ≥2 项的连通区域聚合为灰色斑块，按住宅小区密度（人口代理）加权排序。
      </div>

      {!g.patches.length ? (
        <div className="empty-tip">{r.incomplete ? '检索数据不完整，当前没有可确认的灰色区域；不能据此判断覆盖良好。' : '步行圈内未发现灰色区域，请结合住宅样本与数据口径查看。'}</div>
      ) : (
        <Table<GapPatch>
          className="tbl"
          size="small"
          pagination={false}
          rowKey={(p) => p.id}
          columns={[
            {
              title: '斑块',
              render: (_, p) => <>#{p.id} {p.severity === 'severe' ? <Tag className="pill bad">重度</Tag> : <Tag className="pill mid">中度</Tag>}</>
            },
            { title: '缺失', render: (_, p) => p.missingCats.map((c) => CATEGORY_MAP[c].name).join('、') },
            { title: '居住权重', align: 'right', render: (_, p) => `${(p.weightShare * 100).toFixed(0)}%` },
            { title: '最远距离', align: 'right', render: (_, p) => p.maxNearestM > 0 ? `${Math.round(p.maxNearestM)}m` : '无' },
            {
              title: '',
              render: (_, p) => <Button size="small" data-fly={`${p.centroid.lat},${p.centroid.lng}`}>定位</Button>
            }
          ]}
          dataSource={g.patches}
        />
      )}

      <div className="sec-title">住宅样本补录（№9）</div>
      <Alert className="rpt-summary" type="info" showIcon={false}
        message={<>补录样本在下一次体检并入住宅采样（名称带「(补录)」后缀，覆盖率随之更新）；每条须填写<b>来源</b>，可选附汇总户数。真实人口口径未接入，不与样本口径混用。</>} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
        <Input id="supp-name" placeholder="小区名" style={{ width: 130 }} value={supp.name} onChange={(e) => setSupp({ ...supp, name: e.target.value })} />
        <Input id="supp-lat" placeholder="纬度" style={{ width: 100 }} value={supp.lat} onChange={(e) => setSupp({ ...supp, lat: e.target.value })} />
        <Input id="supp-lng" placeholder="经度" style={{ width: 100 }} value={supp.lng} onChange={(e) => setSupp({ ...supp, lng: e.target.value })} />
        <Input id="supp-hh" placeholder="户数(可空)" style={{ width: 90 }} value={supp.hh} onChange={(e) => setSupp({ ...supp, hh: e.target.value })} />
        <Input id="supp-src" placeholder="来源(必填)" style={{ width: 120 }} value={supp.src} onChange={(e) => setSupp({ ...supp, src: e.target.value })} />
        <Button id="supp-add" onClick={addOne}>添加</Button>
      </div>
      <Input.TextArea id="supp-json" style={{ width: '100%', height: 56, fontSize: 12 }}
        placeholder='批量导入 JSON：[{"name":"xx","lat":28.46,"lng":117.97,"households":120,"source":"社区访谈"}]'
        value={suppJson} onChange={(e) => setSuppJson(e.target.value)} />
      <Button id="supp-import" style={{ margin: '6px 0' }} onClick={importJson}>导入 JSON</Button>

      <Table
        className="tbl"
        size="small"
        pagination={false}
        rowKey={(_, i) => String(i)}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '坐标', align: 'right', render: (_, e) => `${e.latLng.lat.toFixed(5)}, ${e.latLng.lng.toFixed(5)}` },
          { title: '户数', render: (_, e) => e.households ?? '—' },
          { title: '来源 / 日期', render: (_, e) => <>{e.source}<br /><span className="rpt-sub">{new Date(e.at).toLocaleString('zh-CN')}</span></> },
          {
            title: '',
            render: (_, _e, i) => <Button size="small" data-supp-remove={i} onClick={() => { removeSupplement(r.center, i); refreshPanel(); }}>移除</Button>
          }
        ]}
        dataSource={supplements}
        locale={{ emptyText: '暂无补录' }}
      />
      <div className="rpt-sub">重复（50m 内）与偏离分析中心的记录会提示；移除后下一次体检不再并入。</div>

      <div className="sec-title">行政边界（№11）</div>
      <Alert className="rpt-summary" type="info" showIcon={false}
        message="导入 GeoJSON（Polygon/MultiPolygon）后，仅边界内的采样与设施参与统计，范围外不参与；边界来自用户导入，准确性以数据源为准。下一次体检生效。" />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0', alignItems: 'center' }}>
        <input type="file" id="bnd-file" accept=".json,.geojson" className="hidden" ref={bndFileRef}
          onChange={(e) => { void onBoundaryFile(e.target.files?.[0]); e.target.value = ''; }} />
        <Button size="small" onClick={() => bndFileRef.current?.click()}>导入边界文件</Button>
        <Button id="bnd-clear" size="small" onClick={() => { clearBoundary(); banner('边界已清除，恢复默认分析范围。', 'info'); refreshPanel(); }}>清除边界</Button>
        <span id="bnd-status" className="rpt-sub">{boundary ? `当前：${boundary.name}（${boundary.vertexCount} 顶点）` : '未设置边界（默认以分析中心半径为范围）'}</span>
      </div>
    </>
  );
}
