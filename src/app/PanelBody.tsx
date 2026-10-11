import { useEffect, useState } from 'react';
import { getPanelView } from '../panels.js';
import { ReportPanel } from './panels/ReportPanel.js';
import { ChecklistPanel } from './panels/ChecklistPanel.js';
import { GapsPanel } from './panels/GapsPanel.js';
import { PlanPanel } from './panels/PlanPanel.js';
import { ComparePanel } from './panels/ComparePanel.js';
import { StreetPanel } from './panels/StreetPanel.js';
import { LogPanel } from './panels/LogPanel.js';
import { ProofPanel } from './panels/ProofPanel.js';

type PanelView = ReturnType<typeof getPanelView>;

export function PanelBody() {
  const [view, setView] = useState<PanelView>(() => getPanelView());

  useEffect(() => {
    const onPanel = () => setView(getPanelView());
    window.addEventListener('lc:panel', onPanel);
    return () => window.removeEventListener('lc:panel', onPanel);
  }, []);

  return (
    <>
      {view.tab === 'report' && <ReportPanel r={view.result} correctionsCount={view.correctionsCount} />}
      {view.tab === 'checklist' && <ChecklistPanel r={view.result} />}
      {view.tab === 'gaps' && <GapsPanel r={view.result} />}
      {view.tab === 'plan' && <PlanPanel r={view.result} />}
      {view.tab === 'compare' && <ComparePanel r={view.result} />}
      {view.tab === 'street' && <StreetPanel />}
      {view.tab === 'log' && <LogPanel r={view.result} />}
      {view.tab === 'proof' && <ProofPanel r={view.result} />}
    </>
  );
}
