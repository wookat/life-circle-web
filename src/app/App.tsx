import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Input, Modal, Segmented, Tabs } from 'antd';
import { AimOutlined, EnvironmentOutlined, FileTextOutlined, QuestionCircleOutlined, SearchOutlined, ShareAltOutlined } from '@ant-design/icons';
import { banner } from '../hud.js';
import { render as renderPanel } from '../panels.js';
import { PanelBody } from './PanelBody.js';
import { init, ui } from './controller.js';

const TABS = [
  { key: 'report', label: '体检报告' },
  { key: 'checklist', label: '对标清单' },
  { key: 'gaps', label: '灰色区域' },
  { key: 'plan', label: '规划建议' },
  { key: 'compare', label: '方案对比' },
  { key: 'street', label: '街道体检' },
  { key: 'log', label: '运行日志' }
].map((t) => ({ ...t, label: <span data-tab={t.key}>{t.label}</span> }));

export default function App() {
  const [helpOpen, setHelpOpen] = useState(false);
  const [mapType, setMapType] = useState<'2d' | 'satellite' | '3d'>('2d');
  const [activeTab, setActiveTab] = useState('report');
  const collapseRef = useRef<((side: 'left' | 'right') => void) | null>(null);

  useEffect(() => {
    const onTab = (e: Event) => setActiveTab((e as CustomEvent<string>).detail);
    window.addEventListener('lc:tab', onTab);
    collapseRef.current = ui.collapseInit();
    renderPanel();
    void init().catch((e) => {
      console.error(e);
      banner(`初始化失败：${(e as Error).message}`);
    });
    return () => window.removeEventListener('lc:tab', onTab);
  }, []);

  return (
    <div id="app">
      <header id="topbar">
        <div className="brand">
          <svg className="logo-mark" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
            <rect x="1" y="1" width="30" height="30" rx="8" fill="#2f6fed" />
            <circle cx="16" cy="16" r="9.5" fill="none" stroke="#ffffff" strokeWidth="2" strokeDasharray="4.2 2.9" strokeLinecap="round" />
            <circle cx="16" cy="16" r="3.4" fill="#ffffff" />
          </svg>
          <span className="app-name">15分钟生活圈 · 智能体检与规划助手</span>
          <span id="mode-badge" className="badge badge-warn" title="数据通道状态">检测中…</span>
        </div>
        <div className="controls">
          <Button id="btn-sidebar" className="btn ghost only-narrow" aria-label="打开图层侧栏" onClick={() => ui.toggleDrawer('sidebar')}>图层</Button>
          <Button id="btn-panel" className="btn ghost only-narrow" aria-label="打开体检报告" onClick={() => ui.toggleDrawer('panel')} icon={<FileTextOutlined />}>报告</Button>
          <Input id="addr-input" placeholder="输入地址 / 小区名，回车定位" onPressEnter={() => void ui.locate()} />
          <Button id="btn-locate" title="地理编码定位" icon={<SearchOutlined />} onClick={() => void ui.locate()}>定位</Button>
          <Button id="btn-pick" className="btn ghost" title="在地图上点击选择中心点" icon={<AimOutlined />} onClick={() => ui.togglePick()}>图上选点</Button>
          <Button id="btn-help" title="使用说明" icon={<QuestionCircleOutlined />} onClick={() => setHelpOpen(true)}>使用说明</Button>
          <span className="divider" />
          <label className="lbl" htmlFor="persona">人群</label>
          <select id="persona" defaultValue="adult" onChange={(e) => ui.setPersona(e.target.value as 'adult' | 'elderly' | 'child')}>
            <option value="adult">一般成人</option>
            <option value="elderly">老年人</option>
            <option value="child">儿童(陪同)</option>
          </select>
          <label className="lbl" htmlFor="minutes">时长</label>
          <select id="minutes" defaultValue="15" onChange={(e) => ui.setMinutes(e.target.value)}>
            <option value="15">15 分钟</option>
            <option value="10">10 分钟</option>
            <option value="5">5 分钟</option>
          </select>
          <Button id="btn-analyze" type="primary" icon={<EnvironmentOutlined />} onClick={() => ui.runAnalyze()}>开始体检</Button>
        </div>
      </header>

      <main id="layout">
        <aside id="sidebar">
          <section className="card" id="projects-card">
            <h3>本地项目</h3>
            <label htmlFor="project-name">当前项目名称</label>
            <Input id="project-name" maxLength={100} placeholder="完成体检后自动创建项目" autoComplete="off" />
            <div className="project-actions">
              <Button id="project-save" className="btn ghost" disabled>保存</Button>
              <Button id="project-save-as" className="btn ghost" disabled>另存为</Button>
            </div>
            <label htmlFor="project-list">已保存项目</label>
            <select id="project-list" aria-label="已保存项目"><option value="">暂无本地项目</option></select>
            <div className="project-actions">
              <Button id="project-open" className="btn ghost" disabled>打开</Button>
              <Button id="project-delete" className="btn ghost" disabled>删除</Button>
            </div>
            <div className="project-actions">
              <Button id="project-import" className="btn ghost">导入项目</Button>
              <Button id="project-export" className="btn ghost" disabled>导出项目</Button>
            </div>
            <input id="project-file" type="file" accept=".json,application/json" className="hidden" />
            <p id="project-status" className="project-status" role="status" aria-live="polite">完成体检后自动保存。</p>
            <p className="project-note">仅保存在当前浏览器。分析结果与规划选择会自动保存；请导出项目备份，换设备后可导入继续。</p>
          </section>
          <section className="card">
            <h3>图层</h3>
            <label><Checkbox id="ly-heat" defaultChecked onChange={(e) => ui.toggleLayer('heat', e.target.checked)} /> 步行时间热力面</label>
            <label><Checkbox id="ly-rings" defaultChecked onChange={(e) => ui.toggleLayer('rings', e.target.checked)} /> 等时环（5/10/15 分）</label>
            <label><Checkbox id="ly-poi" defaultChecked onChange={(e) => ui.toggleLayer('poi', e.target.checked)} /> 设施 POI</label>
            <label><Checkbox id="ly-gap" defaultChecked onChange={(e) => ui.toggleLayer('gap', e.target.checked)} /> 灰色区域</label>
            <label><Checkbox id="ly-plan" defaultChecked onChange={(e) => ui.toggleLayer('plan', e.target.checked)} /> 补点规划建议</label>
            <label><Checkbox id="ly-cross" defaultChecked onChange={(e) => ui.toggleLayer('cross', e.target.checked)} /> 过街设施扫描（体检时执行并回标地图）</label>
          </section>
          <section className="card" id="legend-card">
            <h3>图例</h3>
            <div className="heat-legend">
              <span className="grad"></span>
              <div className="heat-ticks"><i>0′</i><i>5′</i><i>10′</i><i>15′</i><i>20′+</i></div>
              <p className="legend-note">步行时间热力面：颜色越深可达性越差</p>
            </div>
            <div id="legend-pois" className="poi-legend"></div>
            <div className="legend-lines">
              <div className="ll-item"><span className="ll-line" style={{ borderTop: '2px dashed #7cb342' }}></span>步行 5 分钟可达边界</div>
              <div className="ll-item"><span className="ll-line" style={{ borderTop: '2px dashed #fb8c00' }}></span>步行 10 分钟可达边界</div>
              <div className="ll-item"><span className="ll-line" style={{ borderTop: '2.5px solid #e53935' }}></span>步行 15 分钟可达边界</div>
              <div className="ll-item"><span className="ll-line" style={{ borderTop: '1.5px dashed #00bcd4' }}></span>补点服务半径（1km）</div>
              <div className="ll-item"><span className="ll-line" style={{ borderTop: '1.5px solid #c62828' }}></span>设施盲区轮廓（重/中度）</div>
              <div className="ll-item"><span className="ll-line" style={{ borderTop: '1.5px dashed #78909c' }}></span>过街扫描路段（细虚线）/ 过街设施段（彩色实线）</div>
            </div>
          </section>
          <section className="card" id="channel-card">
            <h3>数据通道</h3>
            <div id="channel-list" className="channel-list">待分析…</div>
          </section>
        </aside>

        <div id="map-wrap">
          <div id="map"></div>
          <div id="map-type-switch" className="hidden" role="group" aria-label="地图形态">
            <Segmented value={mapType} onChange={(v) => { const m = v as '2d' | 'satellite' | '3d'; setMapType(m); ui.setMapType(m); }}
              options={[{ value: '2d', label: '平面' }, { value: 'satellite', label: '卫星' }, { value: '3d', label: '3D' }]} />
          </div>
          <button id="edge-left" className="edge-toggle edge-left" title="折叠左侧栏" aria-label="折叠左侧栏" onClick={() => collapseRef.current?.('left')}>◀</button>
          <button id="edge-right" className="edge-toggle edge-right" title="折叠右侧报告栏" aria-label="折叠右侧报告栏" onClick={() => collapseRef.current?.('right')}>▶</button>
          <div id="ctx-menu" className="hidden" onClick={(e) => { const act = (e.target as HTMLElement).dataset.act; if (act) ui.ctxAction(act); }}>
            <button data-act="center">设为中心点</button>
            <button data-act="analyze">设为中心点并体检</button>
          </div>
          <div id="map-placeholder" className="hidden">
            <div className="ph-box">
              <div className="ph-title">演示模式</div>
              <div className="ph-text">未配置百度地图 AK，地图底图不可用。<br />体检引擎将以合成数据完整运行，可查看右侧全部报告。<br />配置方法见 README（BAIDU_MAP_AK_BROWSER）。</div>
            </div>
          </div>
        </div>

        <section id="panel">
          <PanelBody />
          <nav id="panel-tabs">
            <Tabs activeKey={activeTab} size="small" onChange={(k) => { setActiveTab(k); ui.selectTab(k); }} items={TABS} />
          </nav>
          <div id="panel-body">
            <div id="panel-legacy"><div className="empty-tip">选择中心点后点击「开始体检」</div></div>
            <div id="panel-react" />
          </div>
          <div id="panel-footer" className="hidden">
            <Button id="btn-print" className="btn ghost" onClick={() => ui.print()}>完整报告 / PDF</Button>
            <Button id="btn-facility-csv" className="btn ghost" onClick={() => ui.facilityCsv()}>设施 CSV</Button>
            <Button id="btn-json" className="btn ghost" onClick={() => ui.exportJson()}>导出 JSON</Button>
            <Button id="btn-share" className="btn ghost" icon={<ShareAltOutlined />} onClick={() => void ui.share()}>只读分享</Button>
          </div>
        </section>
      </main>

      <div id="hud" className="hidden">
        <div className="hud-box">
          <div className="hud-title" id="hud-title">分析中…</div>
          <ul id="hud-steps"></ul>
          <div className="hud-note" id="hud-note"></div>
        </div>
      </div>

      <div id="banner" className="hidden"></div>

      <Modal open={helpOpen} onCancel={() => setHelpOpen(false)} footer={null} title="使用说明">
        <ol className="modal-body" style={{ paddingLeft: 20, lineHeight: 2 }}>
          <li>输入地址定位，或直接在地图上<b>点击/右键</b>选择中心点；</li>
          <li>选择人群（老年人速度更慢，可达范围更小）；</li>
          <li>点击「开始体检」，系统基于真实路网计算步行时间场；</li>
          <li>查看体检报告、对标清单与补点规划建议；</li>
          <li>图层开关控制热力面/等时环/POI/盲区/补点/过街扫描的显示；</li>
          <li>左上角可切换平面、卫星或 3D 地图；两侧栏可用边缘按钮折叠。</li>
        </ol>
      </Modal>
    </div>
  );
}
