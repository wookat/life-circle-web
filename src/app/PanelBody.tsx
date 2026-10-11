import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getPanelView } from '../panels.js';
import { ReportPanel } from './panels/ReportPanel.js';
import { ChecklistPanel } from './panels/ChecklistPanel.js';
import { GapsPanel } from './panels/GapsPanel.js';
import { PlanPanel } from './panels/PlanPanel.js';
import { ComparePanel } from './panels/ComparePanel.js';
import { StreetPanel } from './panels/StreetPanel.js';
import { LogPanel } from './panels/LogPanel.js';

/** 已迁移到 React+AntD 的页签；panels.render() 对其跳过 innerHTML。 */
const REACT_TABS = new Set(['report', 'checklist', 'gaps', 'plan', 'compare', 'street', 'log']);

type PanelView = ReturnType<typeof getPanelView>;

export function PanelBody() {
  const [view, setView] = useState<PanelView>(() => getPanelView());
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const tabs = ((window as unknown as { __lcReactTabs?: Set<string> }).__lcReactTabs ??= new Set<string>());
    REACT_TABS.forEach((t) => tabs.add(t));
    setHost(document.getElementById('panel-react'));
    const onPanel = () => setView(getPanelView());
    window.addEventListener('lc:panel', onPanel);
    return () => window.removeEventListener('lc:panel', onPanel);
  }, []);

  if (!host) return null;
  return createPortal(
    <>
      {view.tab === 'report' && <ReportPanel r={view.result} correctionsCount={view.correctionsCount} />}
      {view.tab === 'checklist' && <ChecklistPanel r={view.result} />}
      {view.tab === 'gaps' && <GapsPanel r={view.result} />}
      {view.tab === 'plan' && <PlanPanel r={view.result} />}
      {view.tab === 'compare' && <ComparePanel r={view.result} />}
      {view.tab === 'street' && <StreetPanel />}
      {view.tab === 'log' && <LogPanel r={view.result} />}
    </>,
    host
  );
}
