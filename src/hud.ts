import type { ChannelName } from '../shared/types.js';

/** 分析进度 HUD：步骤、耗时、当前通道一目了然（React 渲染，lc:hud 事件广播） */

const CHANNEL_LABEL: Record<ChannelName, string> = {
  server: '服务端',
  client: '浏览器端',
  mock: '合成兜底'
};

export interface HudStep {
  name: string;
  status: 'wait' | 'doing' | 'done' | 'fail';
  channel?: ChannelName;
  ms?: number;
}
export interface HudView { visible: boolean; title: string; steps: HudStep[]; note: string }
export interface BannerView { visible: boolean; text: string; kind: 'warn' | 'info'; tick: number }

let hudView: HudView = { visible: false, title: '', steps: [], note: '' };
let bannerView: BannerView = { visible: false, text: '', kind: 'warn', tick: 0 };
let bannerTimer: ReturnType<typeof setTimeout> | null = null;

const emit = () => window.dispatchEvent(new CustomEvent('lc:hud'));

export const getHudView = () => hudView;
export const getBannerView = () => bannerView;

export class Hud {
  private t0 = 0;

  start(title: string, stepNames: string[]) {
    hudView = {
      visible: true, title, note: '',
      steps: stepNames.map((name) => ({ name, status: 'wait' as const })),
    };
    this.t0 = performance.now();
    emit();
  }

  doing(idx: number, note?: string) {
    hudView.steps[idx].status = 'doing';
    if (note) hudView.note = note;
    emit();
  }

  done(idx: number, channel: ChannelName, ms: number) {
    hudView.steps[idx].status = 'done';
    hudView.steps[idx].channel = channel;
    hudView.steps[idx].ms = ms;
    emit();
  }

  fail(idx: number) {
    hudView.steps[idx].status = 'fail';
    emit();
  }

  note(text: string) {
    hudView.note = text;
    emit();
  }

  finish() {
    setTimeout(() => { hudView = { ...hudView, visible: false }; emit(); }, 350);
  }
}

export function banner(text: string, kind: 'warn' | 'info' = 'warn', timeoutMs = 6000) {
  bannerView = { visible: true, text, kind, tick: Date.now() };
  emit();
  if (bannerTimer) clearTimeout(bannerTimer);
  const tick = bannerView.tick;
  bannerTimer = setTimeout(() => {
    if (bannerView.tick === tick) { bannerView = { ...bannerView, visible: false }; emit(); }
  }, timeoutMs);
}

export { CHANNEL_LABEL };
