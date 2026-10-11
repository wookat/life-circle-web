import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getPanelView } from '../panels.js';
import { ReportPanel } from './panels/ReportPanel.js';

/** 已迁移到 React+AntD 的页签；panels.render() 对其跳过 innerHTML。 */
const REACT_TABS = new Set(['report']);

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
    </>,
    host
  );
}
