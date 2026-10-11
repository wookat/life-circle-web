import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { comparisonFixture } from '../fixtures/comparison.js';
import { createProject, serializeProject, PROJECT_STORAGE_KEY, type WorkbenchSnapshot } from '../../src/projects.js';
import { analyzeGaps, buildChecklist, computeScore, type AnalysisResult } from '../../shared/index.js';

const emptyWorkbench = (): WorkbenchSnapshot => ({ acceptedSites: [], rejectedSites: [] });
// antd Select：id 落在内部 input 上；点击展开后从 portal 下拉里按选项文案选
async function selectAntd(page: Page, id: string, label: string | RegExp) {
  const sel = page.locator(`#${id}`);
  const wrap = sel.locator('xpath=ancestor-or-self::*[contains(concat(" ",normalize-space(@class)," ")," ant-select ")]').first();
  await wrap.click();
  const opt = page.locator('.ant-select-dropdown .ant-select-item-option').getByText(label as string, { exact: typeof label === 'string' });
  await opt.first().click();
}
async function importFixture(page: Page, result = comparisonFixture(), workbench = emptyWorkbench()) {
  const project = createProject(result, workbench, '完整流程验收');
  await page.locator('#project-file').setInputFiles({ name: 'project.json', mimeType: 'application/json', buffer: Buffer.from(serializeProject(project)) });
  await expect(page.locator('#project-status')).toContainText('已导入');
}
async function store(page: Page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), PROJECT_STORAGE_KEY);
}
async function current(page: Page) {
  const data = await store(page);
  return data.projects.find((p: any) => p.id === data.recentId);
}
async function download(page: Page, button: string) {
  const pending = page.waitForEvent('download');
  await page.locator(button).click();
  return readFile((await (await pending).path())!, 'utf8');
}

/** Exercise map wiring without loading the real SDK, requesting tiles or using an AK. */
async function fakeMap(page: Page) {
  await page.route('**/api/config', route => route.fulfill({ json: { browserAk: 'offline-sdk-stub', hasServerAk: false, mock: true } }));
  await page.addInitScript(() => {
    const state: any = { centers: [], overlays: [], events: {}, info: '' };
    (window as any).__mapTest = state;
    class Point { constructor(public lng: number, public lat: number) {} }
    class Overlay {
      events: Record<string, (e: any) => void> = {};
      constructor(public kind: string, public args: any[]) {}
      addEventListener(name: string, callback: (e: any) => void) { this.events[name] = callback; }
      setStyle() {}
    }
    const overlay = (kind: string) => class extends Overlay { constructor(...args: any[]) { super(kind, args); } };
    (window as any).BMapGL = {
      Point,
      Map: class {
        centerAndZoom(point: Point, zoom: number) { state.centers.push({ lat: point.lat, lng: point.lng, zoom }); }
        enableScrollWheelZoom() {}
        addControl() {}
        addEventListener(name: string, callback: (e: any) => void) { state.events[name] = callback; }
        addOverlay(item: Overlay) { state.overlays.push(item); }
        removeOverlay(item: Overlay) { state.overlays = state.overlays.filter((x: Overlay) => x !== item); }
        openInfoWindow(info: Overlay) { state.info = info.args[0]; }
      },
      Marker: overlay('Marker'), Label: overlay('Label'), GroundOverlay: overlay('GroundOverlay'),
      Polyline: overlay('Polyline'), Polygon: overlay('Polygon'), Circle: overlay('Circle'),
      InfoWindow: overlay('InfoWindow'), Bounds: overlay('Bounds'), Icon: overlay('Icon'), Size: overlay('Size'),
      ScaleControl: overlay('ScaleControl'), NavigationControl3D: overlay('NavigationControl3D')
    };
  });
}

test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

test('报告 JSON 保留当前决策与 A/B，导出失败提示且不丢数据', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await importFixture(page);
  await page.locator('[data-tab="plan"]').click();
  await page.locator('[data-act="accept"]').first().click();
  await page.locator('[data-tab="compare"]').click();
  await page.locator('[data-scenario-save="A"]').click();
  const before = await store(page), project = await current(page);
  const report = JSON.parse(await download(page, '#btn-json'));
  expect(report.provenance).toEqual(project.result.provenance);
  expect(report.workbench.scenarios).toEqual(project.workbench.scenarios);
  expect(report.workbench.acceptedSites[0].latLng).toEqual(project.workbench.acceptedSites[0].latLng);
  expect(report.score).toEqual(project.result.score);
  expect(report.mock).toBe(true);
  await page.evaluate(() => { URL.createObjectURL = () => { throw new Error('simulated download failure'); }; });
  await page.locator('#btn-json').click();
  await expect(page.locator('#banner')).toContainText('JSON 导出失败');
  expect(await store(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test('街道结果首次更新后即可定位，地图未知覆盖与列表一致且名称安全', async ({ page }) => {
  await fakeMap(page);
  const community = { name: '<img src=x onerror="alert(1)">验收社区', center: { lat: 28.46, lng: 117.97 }, score: 60, grade: 'D', coverageShare: null, dominantMissing: null };
  await page.route('**/api/batch/**', route => route.fulfill({ json: route.request().method() === 'POST'
    ? { status: 0, jobId: 'offline-map-job', total: 1 }
    : { status: 0, job: { status: 'done', done: 1, total: 1, communities: [community], summary: { avgScore: 60, weakList: [community] } } } }));
  await page.goto('/'); await page.locator('[data-tab="street"]').click();
  await page.locator('#street-addr').fill('离线测试街道'); await page.locator('#btn-street-start').click();
  await expect(page.locator('#btn-weak-csv')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#street-status')).toContainText('无法评估');
  await page.evaluate(() => { (window as any).__mapTest.centers = []; });
  await page.locator('#street-status [data-fly]').click();
  expect(await page.evaluate(() => (window as any).__mapTest.centers)).toEqual([{ ...community.center, zoom: 16 }]);
  const info = await page.evaluate(() => {
    const state = (window as any).__mapTest;
    state.overlays.filter((o: any) => o.kind === 'Marker').at(-1).events.click({});
    return state.info;
  });
  expect(info).toContain('无法评估');
  expect(info).toContain('&lt;img'); expect(info).not.toContain('<img');
});

test('另存为、切换和删除不会串改方案，取消删除保留项目', async ({ page }) => {
  let accept = false; page.on('dialog', d => accept ? d.accept() : d.dismiss());
  await page.goto('/'); await importFixture(page);
  await page.locator('[data-tab="plan"]').click(); await page.locator('[data-act="accept"]').first().click();
  await page.locator('[data-tab="compare"]').click(); await page.locator('[data-scenario-save="A"]').click();
  await page.locator('#project-name').fill('项目原件'); await page.locator('#project-save').click();
  const original = await current(page);
  await page.locator('#project-save-as').click();
  const copy = await current(page);
  expect(copy.id).not.toBe(original.id); expect(copy.name).toBe('项目原件（副本）');
  expect(copy.workbench).toEqual(original.workbench);
  accept = true; await page.locator('#compare-reset').click();
  await page.locator('[data-scenario-save="B"]').click();
  const changedCopy = await current(page);
  expect(changedCopy.workbench.acceptedSites).toHaveLength(0);
  expect(changedCopy.workbench.scenarios.B.acceptedSites).toHaveLength(0);
  await selectAntd(page, 'project-list', /^项目原件 ·/); await page.locator('#project-open').click();
  expect(await current(page)).toEqual(original);
  await expect(page.locator('#project-name')).toHaveValue('项目原件');
  await selectAntd(page, 'project-list', /^项目原件（副本） ·/); await page.locator('#project-open').click();
  expect(await current(page)).toEqual(changedCopy);
  accept = false; const beforeDelete = await store(page); await page.locator('#project-delete').click();
  expect(await store(page)).toEqual(beforeDelete);
  accept = true; await page.locator('#project-delete').click();
  expect((await store(page)).projects).toEqual([original]);
  await selectAntd(page, 'project-list', /^项目原件 ·/); await page.locator('#project-open').click();
  await page.locator('#project-delete').click();
  expect((await store(page)).projects).toEqual([]);
  await page.locator('[data-tab="plan"]').click(); await page.locator('[data-act="undo-accept"]').click();
  expect((await store(page)).projects).toEqual([]);
  const backup = JSON.parse(await download(page, '#project-export'));
  expect(backup.workbench.acceptedSites).toHaveLength(0);
  await page.reload(); await expect(page.locator('#project-list')).toHaveValue(''); // antd Select 内层 input 无选中时值为空
  await expect(page.locator('#project-export')).toBeDisabled();
});

test('取消覆盖、载入和清空不改数据，零补点方案与未记录可区分', async ({ page }) => {
  let accept = true; page.on('dialog', d => accept ? d.accept() : d.dismiss());
  await page.goto('/'); await importFixture(page);
  await page.locator('[data-tab="plan"]').click();
  await page.locator('[data-act="accept"]').first().click(); await page.locator('[data-act="reject"]').first().click();
  await page.locator('[data-tab="compare"]').click(); await page.locator('[data-scenario-save="A"]').click();
  const a = (await current(page)).workbench.scenarios.A;
  await expect(page.locator('[data-scenario-load="B"]')).toBeDisabled();
  await expect(page.locator('.comparison-table')).toContainText('未记录');
  await page.locator('#compare-reset').click(); await page.locator('[data-scenario-save="B"]').click();
  await expect(page.locator('[data-scenario-load="B"]')).toBeEnabled();
  await expect(page.locator('.comparison-table')).not.toContainText('未记录');
  await page.locator('#compare-plan').click(); await page.locator('[data-act="accept"]').first().click();
  await page.locator('[data-tab="compare"]').click();
  const before = await store(page); accept = false;
  for (const selector of ['[data-scenario-save="A"]', '[data-scenario-load="B"]', '#compare-reset']) {
    await page.locator(selector).click(); expect(await store(page)).toEqual(before);
  }
  accept = true; await page.locator('[data-scenario-load="A"]').click();
  const loaded = await current(page);
  expect(loaded.workbench.acceptedSites).toEqual(a.acceptedSites);
  expect(loaded.workbench.rejectedSites).toEqual(a.rejectedSites);
  await page.locator('[data-scenario-save="B"]').click();
  expect((await current(page)).workbench.scenarios.A).toEqual(a);
  await page.reload(); await expect(page.locator('#project-status')).toContainText('已打开');
  await page.locator('[data-tab="plan"]').click();
  await expect(page.locator('[data-act="undo-accept"]')).toHaveCount(1);
  await expect(page.locator('[data-act="undo-reject"]')).toHaveCount(1);
});

for (const [persona, speed, minutes] of [['adult', 80, 5], ['elderly', 52, 10], ['child', 65, 15]] as const) {
  test(`${persona} ${minutes} 分钟重新体检隔离旧方案，主要报告页签可用`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('/'); await importFixture(page);
    await page.locator('[data-tab="compare"]').click(); await page.locator('[data-scenario-save="A"]').click();
    const old = await current(page);
    await selectAntd(page, 'persona', { adult: '一般成人', elderly: '老年人', child: '儿童(陪同)' }[persona]);
    await selectAntd(page, 'minutes', `${minutes} 分钟`);
    await page.locator('#ly-cross').uncheck(); await page.locator('#btn-analyze').click();
    await expect(page.locator('#project-export')).toBeDisabled(); await expect(page.locator('#persona')).toBeDisabled();
    await expect(page.locator('#btn-analyze')).toBeEnabled({ timeout: 20_000 });
    await expect(page.locator('#project-status')).toContainText('已保存', { timeout: 20_000 });
    const fresh = await current(page);
    expect(fresh.id).not.toBe(old.id); expect(fresh.result.persona).toBe(persona); expect(fresh.result.minutes).toBe(minutes);
    expect(fresh.result.field.speed).toBe(speed); expect(fresh.result.model.speed).toBe(speed);
    expect(fresh.result.crossings).toBeNull(); expect(fresh.workbench.scenarios).toBeUndefined();
    expect((await store(page)).projects.find((p: any) => p.id === old.id)).toEqual(old);
    await expect(page.locator('.data-quality tbody tr')).toHaveCount(12);
    await page.locator('[data-tab="checklist"]').click();
    await expect(page.locator('#panel-body tbody tr')).toHaveCount(fresh.result.checklist.length);
    await page.locator('[data-tab="gaps"]').click(); await expect(page.locator('#panel-body')).toContainText('盲区点位');
    await page.locator('[data-tab="log"]').click(); await expect(page.locator('#panel-body')).toContainText('设施 POI 检索');
    await page.locator('[data-tab="plan"]').click(); await expect(page.locator('#panel-body')).toContainText('工作台');
    await page.locator('[data-tab="compare"]').click(); await expect(page.locator('[data-scenario-load="A"]')).toBeDisabled();
    const report = JSON.parse(await download(page, '#btn-json'));
    expect(report.persona).toBe(persona); expect(report.minutes).toBe(minutes); expect(report.provenance.reportId).toBe(fresh.result.provenance.reportId);
    expect(errors).toEqual([]);
  });
}

test('无住宅样本的比较和完整报告保留无法评估，历史规则禁止覆盖方案', async ({ page }) => {
  const r: AnalysisResult = comparisonFixture();
  r.pois = r.pois.filter(p => p.category !== 'residential');
  r.gap = analyzeGaps(r.field, r.pois); r.score = computeScore(r.center, r.pois, r.gap);
  r.checklist = buildChecklist(r.center, r.pois); r.planSites = [];
  await page.goto('/'); await importFixture(page, r);
  await page.locator('[data-tab="compare"]').click(); await page.locator('[data-scenario-save="A"]').click();
  const metrics = page.locator('.comparison-table tbody tr').nth(1);
  await expect(metrics.locator('td').nth(0)).toHaveText('无法评估');
  await expect(metrics.locator('td').nth(1)).toHaveText('无法评估');
  await expect(metrics.locator('td').nth(2)).toHaveText('未记录');
  const popupPending = page.waitForEvent('popup'); await page.locator('#btn-print').click();
  const popup = await popupPending;
  await expect(popup.locator('main')).toContainText('三件套全覆盖：无法评估');
  await expect(popup.locator('.comparison-table')).toHaveText(await page.locator('.comparison-table').textContent() ?? '');
  const old = comparisonFixture(); old.provenance!.ruleVersion = 'historic-rules';
  await importFixture(page, old);
  await page.locator('[data-tab="compare"]').click();
  await expect(page.locator('[data-scenario-save="A"]')).toBeDisabled();
  await expect(page.locator('#compare-reset')).toBeDisabled();
  await expect(page.locator('#panel-body')).toContainText('历史规则');
});

test('跨体检方案文件被拒绝，原项目与当前工作台不变', async ({ page }) => {
  await page.goto('/'); await importFixture(page);
  await page.locator('[data-tab="compare"]').click(); await page.locator('[data-scenario-save="A"]').click();
  const before = await store(page), invalid = await current(page);
  invalid.workbench.scenarios.A.baselineKey = 'baseline-v1-another-report';
  await page.locator('#project-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
  await expect(page.locator('#project-status')).toContainText('基线不一致');
  expect(await store(page)).toEqual(before);
  await expect(page.locator('[data-scenario-load="A"]')).toBeEnabled();
});

test('地图图层开关、刷新恢复与工作台更改同步，无需真实地图请求', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await fakeMap(page); await page.goto('/'); await importFixture(page);
  const overlayCount = (kind: string) => page.evaluate(k => (window as any).__mapTest.overlays.filter((o: any) => o.kind === k).length, kind);
  expect(await overlayCount('GroundOverlay')).toBe(1);
  expect(await overlayCount('Polyline')).toBeGreaterThan(0); expect(await overlayCount('Polygon')).toBeGreaterThan(0);
  await page.locator('#ly-heat').uncheck(); expect(await overlayCount('GroundOverlay')).toBe(0);
  await page.locator('#ly-heat').check(); expect(await overlayCount('GroundOverlay')).toBe(1);
  await page.locator('#ly-rings').uncheck(); expect(await overlayCount('Polyline')).toBe(0);
  await page.locator('#ly-gap').uncheck(); expect(await overlayCount('Polygon')).toBe(0);
  const markers = await overlayCount('Marker'); await page.locator('#ly-poi').uncheck();
  expect(await overlayCount('Marker')).toBeLessThan(markers);
  await page.locator('#ly-plan').uncheck(); expect(await overlayCount('Circle')).toBe(0);
  await page.locator('#ly-plan').check();
  await page.locator('[data-tab="plan"]').click(); await page.locator('[data-act="accept"]').first().click();
  const before = await current(page), circles = await overlayCount('Circle');
  await page.reload(); await expect(page.locator('#project-status')).toContainText('已打开');
  expect(await current(page)).toEqual(before); expect(await overlayCount('Circle')).toBe(circles);
  await page.locator('[data-tab="plan"]').click();
  const point = before.workbench.acceptedSites[0].latLng;
  await page.locator('.accepted [data-fly]').click();
  expect(await page.evaluate(() => (window as any).__mapTest.centers.at(-1))).toEqual({ ...point, zoom: 16 });
  expect(errors).toEqual([]);
});

test('地址回车定位、过期响应保护和图上选点模式可用', async ({ page }) => {
  await fakeMap(page);
  await page.route('**/api/config', route => route.fulfill({ json: { browserAk: 'offline-sdk-stub', hasServerAk: true, mock: false } }));
  let slow: Route | undefined;
  const newest = { lat: 28.47, lng: 117.98 }, picked = { lat: 28.48, lng: 117.99 };
  await page.route('**/api/baidu/geocoding/v3?**', route => {
    if (new URL(route.request().url()).searchParams.get('address') === '较早的慢请求') { slow = route; return; }
    return route.fulfill({ json: { status: 0, result: { location: newest } } });
  });
  await page.route('**/api/baidu/reverse_geocoding/v3?**', route => route.fulfill({ json: { status: 0, result: { formatted_address: '图选测试社区' } } }));
  await page.goto('/'); await expect(page.locator('#mode-badge')).toContainText('服务端');
  await page.locator('#addr-input').fill('较早的慢请求'); await page.locator('#addr-input').press('Enter');
  await expect.poll(() => Boolean(slow)).toBe(true);
  await page.locator('#addr-input').fill('最新地址'); await page.locator('#btn-locate').click();
  await expect.poll(() => page.evaluate(() => (window as any).__mapTest.centers.at(-1))).toEqual({ ...newest, zoom: 15 });
  const previous = await page.evaluate(() => (window as any).__mapTest.centers);
  const completed = page.waitForResponse(r => r.url().includes(encodeURIComponent('较早的慢请求')));
  await slow!.fulfill({ json: { status: 0, result: { location: { lat: 20, lng: 100 } } } });
  await (await completed).finished();
  // Flush application promise continuations before checking that no stale center was drawn.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  expect(await page.evaluate(() => (window as any).__mapTest.centers)).toEqual(previous);
  await page.evaluate(p => (window as any).__mapTest.events.click({ latlng: p }), picked);
  expect(await page.evaluate(() => (window as any).__mapTest.centers)).toEqual(previous);
  await page.locator('#btn-pick').click();
  await page.evaluate(p => (window as any).__mapTest.events.click({ latlng: p }), picked);
  await expect(page.locator('#btn-pick')).toHaveText('图上选点');
  await expect.poll(() => page.evaluate(() => (window as any).__mapTest.centers.at(-1))).toEqual({ ...picked, zoom: 15 });
  await expect.poll(() => page.evaluate(() => (window as any).__mapTest.overlays.filter((o: any) => o.kind === 'Label').at(-1)?.args[0])).toBe('图选测试社区');
});

test('批量任务取消、失败提示和再次发起可用，导出失败不清空结果', async ({ page }) => {
  let cancelled = false, fail = false, posts = 0;
  const community = { name: '取消前已完成社区', center: { lat: 28.46, lng: 117.97 }, score: 60, grade: 'D', coverageShare: .4, dominantMissing: 'pharmacy' };
  await page.route('**/api/batch/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/cancel/')) { cancelled = true; return route.fulfill({ json: { status: 0 } }); }
    if (route.request().method() === 'POST') { posts++; return route.fulfill({ json: { status: 0, jobId: `offline-${posts}`, total: 2 } }); }
    return route.fulfill({ json: { status: 0, job: { status: fail ? 'error' : cancelled ? 'cancelled' : 'running', done: 1, total: 2, current: '待处理社区', communities: [community], error: '受控任务失败' } } });
  });
  await page.goto('/'); await page.locator('[data-tab="street"]').click();
  await page.locator('#street-addr').fill('离线测试街道'); await page.locator('#btn-street-start').click();
  await expect(page.locator('#btn-street-cancel')).toBeVisible({ timeout: 10_000 });
  await page.locator('#btn-street-cancel').click();
  await expect(page.locator('#street-status')).toContainText('已取消', { timeout: 10_000 });
  await expect(page.locator('#street-status')).toContainText(community.name);
  fail = true; await page.locator('#btn-street-start').click();
  await expect(page.locator('#street-status')).toContainText('受控任务失败', { timeout: 10_000 });
  expect(posts).toBe(2);
  await page.route('**/api/batch/status/**', route => route.fulfill({ json: { status: 0, job: { status: 'done', done: 1, total: 1, communities: [community], summary: { weakList: [community] } } } }));
  await page.locator('#btn-street-start').click(); await expect(page.locator('#btn-weak-csv')).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => { URL.createObjectURL = () => { throw new Error('simulated failure'); }; });
  await page.locator('#btn-weak-csv').click();
  await expect(page.locator('#banner')).toContainText('薄弱社区表导出失败');
  await expect(page.locator('#street-status')).toContainText(community.name);
});
test('路线核验：合成兜底如实提示，不写核验缓存', async ({ page }) => {
  await page.goto('/');
  await importFixture(page);
  const uid = comparisonFixture().pois.find(p => p.category !== 'residential')!.uid;
  await page.evaluate(uid => {
    const btn = document.createElement('button');
    btn.setAttribute('data-route-uid', uid);
    document.body.appendChild(btn);
    btn.click();
    btn.remove();
  }, uid);
  await expect(page.locator('#banner')).toContainText('合成兜底');
  const routeKeys = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('lc-route-v1')));
  expect(routeKeys).toEqual([]);
});

test('路线核验：真实通道距离与时间场并列，重复核验命中缓存', async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({ json: { browserAk: '', hasServerAk: true, mock: false } }));
  await page.route('**/api/baidu/direction/**', route => route.fulfill({ json: { status: 0, result: { routes: [{ distance: 1234, steps: [] }] } } }));
  await page.goto('/');
  await importFixture(page);
  const uid = comparisonFixture().pois.find(p => p.category !== 'residential')!.uid;
  const click = (uid: string) => page.evaluate(uid => {
    const btn = document.createElement('button');
    btn.setAttribute('data-route-uid', uid);
    document.body.appendChild(btn);
    btn.click();
    btn.remove();
  }, uid);
  await click(uid);
  await expect(page.locator('#banner')).toContainText('真实路网 1234m');
  await expect(page.locator('#banner')).toContainText('时间场估计');
  await click(uid);
  await expect(page.locator('#banner')).toContainText('缓存');
  await expect(page.locator('#banner')).toContainText('1234m');
});

test('规划编辑：自定义候选采纳进方案，预算约束随项目保存', async ({ page }) => {
  await page.goto('/');
  await importFixture(page);
  await page.locator('[data-tab="plan"]').click();
  await page.locator('#pe-lat').fill('28.46');
  await page.locator('#pe-lng').fill('117.97');
  await page.locator('#pe-add').click();
  await expect(page.locator('#panel-body')).toContainText('28.46000, 117.97000');
  await page.locator('[data-planact="adopt-custom"]').first().click();
  const saved = await store(page);
  const project = saved.projects.find((p: any) => p.id === saved.recentId);
  expect(project.workbench.acceptedSites[0].rationale).toContain('自定义候选');
  await page.locator('#pe-max').fill('1');
  await page.locator('#pe-budget-apply').click();
  const after = await store(page);
  const project2 = after.projects.find((p: any) => p.id === saved.recentId);
  expect(project2.workbench.budget).toMatchObject({ maxSites: 1 });
  await page.reload();
  await expect(page.locator('#project-status')).toContainText('已恢复', { timeout: 10_000 });
  await page.locator('[data-tab="plan"]').click();
  await expect(page.locator('#panel-body')).toContainText('规划编辑');
});

test('规划编辑审查修复：禁建区拦截采纳、预算扣减与表单校验', async ({ page }) => {
  await page.goto('/');
  await importFixture(page);
  await page.locator('[data-tab="plan"]').click();
  // F4：禁建区覆盖全域后，自定义候选无法采纳
  await page.locator('#pe-zone').fill('100000');
  await page.locator('#pe-zone-add').click();
  await selectAntd(page, 'pe-cat', '菜市场');
  await page.locator('#pe-lat').fill('28.46');
  await page.locator('#pe-lng').fill('117.97');
  await page.locator('#pe-add').click();
  await page.locator('[data-planact="adopt-custom"]').first().click();
  await expect(page.locator('#banner')).toContainText('禁建区');
  await page.locator('[data-planact="remove-zone"]').first().click();
  // F3：maxSites=1 时采纳一条后，第二条被预算拦下
  await page.locator('#pe-max').fill('1');
  await page.locator('#pe-budget-apply').click();
  await page.locator('[data-planact="adopt-custom"]').first().click();
  const saved = await store(page);
  const project = saved.projects.find((p: any) => p.id === saved.recentId);
  expect(project.workbench.acceptedSites.length).toBe(1);
  const normal = page.locator('[data-act="accept"]');
  if (await normal.count()) {
    await normal.first().click();
    const after = await store(page);
    const p2 = after.projects.find((p: any) => p.id === saved.recentId);
    expect(p2.workbench.acceptedSites.length).toBe(1);
    await expect(page.locator('#banner')).toContainText('上限');
  }
  // F9：非整数上限被表单拦截，不写入快照
  await page.locator('#pe-max').fill('1.5');
  await page.locator('#pe-budget-apply').click();
  await expect(page.locator('#banner')).toContainText('0–100 整数');
  const final = await store(page);
  const p3 = final.projects.find((p: any) => p.id === saved.recentId);
  expect(p3.workbench.budget?.maxSites).toBe(1);
});
test('营业时段：演示模式如实报未知，不默认全天营业', async ({ page }) => {
  await page.goto('/');
  await importFixture(page);
  const uid = comparisonFixture().pois.find(p => p.category !== 'residential')!.uid;
  await page.evaluate(uid => {
    const btn = document.createElement('button');
    btn.setAttribute('data-hours-uid', uid);
    document.body.appendChild(btn);
    btn.click();
    btn.remove();
  }, uid);
  await expect(page.locator('#banner')).toContainText('未知');
  await expect(page.locator('#banner')).toContainText('全天营业');
});
test('历史趋势：同城多期对照，规则差异期标注不可直接比', async ({ page }) => {
  await page.goto('/');
  await importFixture(page); // 第一期（当前规则指纹）
  const mutated = comparisonFixture();
  mutated.generatedAt = '2026-10-12T00:00:00.000Z';
  mutated.score.total = 30;
  mutated.provenance = { ...structuredClone(mutated.provenance!), ruleFingerprint: 'deadbeef' };
  await page.locator('#project-file').setInputFiles({ name: 'p2.json', mimeType: 'application/json', buffer: Buffer.from(serializeProject(createProject(mutated, { acceptedSites: [], rejectedSites: [] }, '第二期·规则调整后'))) });
  await expect(page.locator('#project-status')).toContainText('已导入');
  const third = comparisonFixture();
  third.generatedAt = '2026-10-13T00:00:00.000Z';
  await page.locator('#project-file').setInputFiles({ name: 'p3.json', mimeType: 'application/json', buffer: Buffer.from(serializeProject(createProject(third, { acceptedSites: [], rejectedSites: [] }, '第三期·同口径复测'))) });
  await expect(page.locator('#project-status')).toContainText('已导入');
  await page.locator('[data-tab="compare"]').click();
  await expect(page.locator('#panel-body')).toContainText('历史趋势');
  await expect(page.locator('#panel-body')).toContainText('deadbeef');      // 异规则期被点名
  await expect(page.locator('#trend-table tbody tr')).toHaveCount(3); // 三期全部列出
  await expect(page.locator('#panel-body')).toContainText('同口径 ✓');      // 两期同口径标注
  await expect(page.locator('#panel-body')).toContainText('规则 deadbeef'); // 异规则期点名
  await expect(page.locator('#panel-body')).toContainText('不能仅凭分数上升');
});

test('样本补录：登记去重提示、并入下一次体检并在警告中说明口径', async ({ page }) => {
  await page.goto('/');
  await importFixture(page);
  await page.locator('[data-tab="gaps"]').click();
  await page.locator('#supp-name').fill('手工登记小区');
  await page.locator('#supp-lat').fill('28.462');
  await page.locator('#supp-lng').fill('117.972');
  await page.locator('#supp-hh').fill('120');
  await page.locator('#supp-src').fill('社区访谈');
  await page.locator('#supp-add').click();
  await expect(page.locator('#panel-body table tbody tr').filter({ hasText: '手工登记小区' })).toHaveCount(1);
  // 重复录入提示
  await page.locator('#supp-name').fill('重复点');
  await page.locator('#supp-lat').fill('28.462');
  await page.locator('#supp-lng').fill('117.972');
  await page.locator('#supp-src').fill('自填');
  await page.locator('#supp-add').click();
  await expect(page.locator('#banner')).toContainText('50m 内已存在');
  // 重新体检并入
  await page.locator('#ly-cross').uncheck();
  await page.locator('#btn-analyze').click();
  await expect(page.locator('#btn-analyze')).toBeEnabled({ timeout: 20_000 });
  await page.locator('[data-tab="report"]').click();
  await expect(page.locator('#panel-body')).toContainText('人工补录住宅样本 2 条');
  const report = JSON.parse(await (async () => {
    const pending = page.waitForEvent('download');
    await page.locator('#btn-json').click();
    return readFile((await (await pending).path())!, 'utf8');
  })());
  expect(report.warnings.join('')).toContain('人工补录');
  expect(report.score.total).toBe(75); // 补录并入后覆盖率提升：C74 → B75
});


test('老年口径报告含老年友好解读与口径边界说明', async ({ page }) => {
  await page.goto('/');
  await importFixture(page);
  await selectAntd(page, 'persona', '老年人');
  await page.locator('#btn-analyze').click();
  await expect(page.locator('#btn-analyze')).toBeEnabled({ timeout: 20_000 });
  await page.locator('[data-tab="report"]').click();
  await expect(page.locator('#panel-body')).toContainText('老年友好解读');
  await expect(page.locator('#panel-body')).toContainText('无障碍能力需实地核验');
});

