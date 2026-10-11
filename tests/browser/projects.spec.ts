import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { buildIsochroneModel, buildTimeField, generateMockPois, analyzeGaps, computeScore, buildChecklist,
  planFacilitiesFromCoverage, type AnalysisResult } from '../../shared/index.js';
import { createProvenance } from '../../shared/provenance.js';
import { createProject, serializeProject, PROJECT_STORAGE_KEY } from '../../src/projects.js';

function fixture() {
  const center = { lat: 28.46, lng: 117.97 };
  const model = buildIsochroneModel(center, Array.from({ length: 16 }, () => ({ ok: true, distM: 1320 })), { dirs: 16, minutes: 15, speed: 80 });
  const field = buildTimeField(model, { n: 21, cellM: 120 });
  const pois = generateMockPois(center).filter(p => p.category !== 'pharmacy' && p.category !== 'primarySchool');
  const gap = analyzeGaps(field, pois);
  const generatedAt = new Date().toISOString();
  const result: AnalysisResult = { center, centerName: '离线验收社区', persona: 'adult', minutes: 15, generatedAt,
    model, field, rings: [], pois, gap, score: computeScore(center, pois, gap), checklist: buildChecklist(center, pois),
    planSites: planFacilitiesFromCoverage(gap, gap.coveredMasks, field, 80), crossings: null, steps: [], mock: true,
    provenance: createProvenance({ generatedAt, channels: ['mock'], mock: true }) };
  return createProject(result, { acceptedSites: [], rejectedSites: [] }, '浏览器验收项目');
}
async function importProject(page: Page, value = serializeProject(fixture())) {
  await page.locator('#project-file').setInputFiles({ name: 'project.json', mimeType: 'application/json', buffer: Buffer.from(value) });
}
async function stored(page: Page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), PROJECT_STORAGE_KEY);
}

test.beforeEach(async ({ page }) => {
  // A test failure must never fall through to a real provider or map SDK.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

test('无密钥体检自动保存，刷新恢复，重新体检创建独立项目', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.locator('#btn-analyze').click();
  await expect(page.locator('#project-status')).toContainText('已保存', { timeout: 20_000 });
  await expect(page.locator('.data-quality tbody tr')).toHaveCount(12);
  const first = await stored(page);
  expect(first.projects).toHaveLength(1);
  expect(first.projects[0].result.provenance.mock).toBe(true);
  await page.reload();
  await expect(page.locator('#project-status')).toContainText('已打开');
  expect((await stored(page)).recentId).toBe(first.recentId);
  await expect(page.locator('.report-source')).toContainText(first.projects[0].result.provenance.reportId);
  await page.locator('#btn-analyze').click();
  await expect(page.locator('#project-status')).toContainText('已保存', { timeout: 20_000 });
  expect((await stored(page)).projects).toHaveLength(2);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('report.png') });
});

test('采纳和跳过自动保存，导出导入与刷新后仍可撤销', async ({ page }) => {
  await page.goto('/');
  await importProject(page);
  await expect(page.locator('#project-status')).toContainText('已导入');
  await page.locator('[data-tab="plan"]').click();
  await page.locator('[data-act="accept"]').first().click();
  await page.locator('[data-act="reject"]').first().click();
  const before = (await stored(page)).projects[0];
  expect(before.workbench.acceptedSites).toHaveLength(1);
  expect(before.workbench.rejectedSites).toHaveLength(1);
  await page.reload();
  await expect(page.locator('#project-status')).toContainText('已打开');
  await page.locator('[data-tab="plan"]').click();
  await expect(page.locator('[data-act="undo-accept"]')).toHaveCount(1);
  await expect(page.locator('[data-act="undo-reject"]')).toHaveCount(1);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#project-export').click();
  const download = await downloadPromise;
  const backup = await readFile((await download.path())!, 'utf8');
  expect(JSON.parse(backup).workbench).toEqual(before.workbench);
  await importProject(page, backup);
  await expect(page.locator('#project-status')).toContainText('已导入');
  expect((await stored(page)).projects).toHaveLength(2);
  await page.locator('[data-tab="plan"]').click();
  await page.locator('[data-act="undo-accept"]').click();
  await page.locator('[data-act="undo-reject"]').click();
  const after = await stored(page);
  expect(after.projects.find((p: any) => p.id === after.recentId).workbench).toEqual({ acceptedSites: [], rejectedSites: [] });
  expect(after.projects.find((p: any) => p.id === after.recentId).result.score).toEqual(before.result.score);
});

test('坏文件、摘要与恶意类别被拒绝，原项目和页面保持可用', async ({ page }) => {
  await page.goto('/');
  await importProject(page);
  await expect(page.locator('#project-status')).toContainText('已导入');
  const before = await stored(page);
  for (const text of ['{broken', '{"score":80}', '{"format":"life-circle-project","schemaVersion":99}']) {
    await importProject(page, text);
    await expect(page.locator('#project-status')).toHaveAttribute('data-error', 'true');
    expect(await stored(page)).toEqual(before);
  }
  const attack = JSON.parse(serializeProject(fixture()));
  attack.result.cumulative = { total: 0, byCategory: {}, categoriesCovered: 0, missingCategories: ['<img src=x onerror="window.injected=true">'] };
  await importProject(page, JSON.stringify(attack));
  await expect(page.locator('#project-status')).toHaveAttribute('data-error', 'true');
  expect(await page.evaluate(() => (window as any).injected)).toBeUndefined();
  expect(await stored(page)).toEqual(before);
});

test('本地存储满时旧数据不变，当前结果仍可导出', async ({ page }) => {
  await page.goto('/');
  await importProject(page);
  await expect(page.locator('#project-status')).toContainText('已导入');
  const before = await stored(page);
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(k, v) {
      if (k === key) throw new DOMException('full', 'QuotaExceededError');
      return original.call(this, k, v);
    };
  }, PROJECT_STORAGE_KEY);
  await page.locator('#project-name').fill('未成功保存的新名称');
  await page.locator('#project-save').click();
  await expect(page.locator('#project-status')).toContainText('空间不足');
  expect(await stored(page)).toEqual(before);
  const pending = page.waitForEvent('download');
  await page.locator('#project-export').click();
  const backup = JSON.parse(await readFile((await (await pending).path())!, 'utf8'));
  expect(backup.name).toBe('未成功保存的新名称');
});

test('代理分页截断及配额耗尽可见，后续关键词和过街扫描不再请求', async ({ page }) => {
  const queries: string[] = [];
  let crossings = 0;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let body: any;
    if (url.pathname === '/api/config') body = { browserAk: '', hasServerAk: true, mock: false };
    else if (url.pathname.includes('reverse_geocoding')) body = { status: 0, result: { formatted_address: '受控分页社区' } };
    else if (url.pathname.includes('routematrix')) body = { status: 0, result: (url.searchParams.get('destinations') ?? '').split('|').map(() => ({ distance: { value: 1300 } })) };
    else if (url.pathname.includes('/place/')) {
      const kw = url.searchParams.get('query')!;
      const n = Number(url.searchParams.get('page_num'));
      queries.push(`${kw}:${n}`);
      body = kw === '诊所' ? { status: 302, message: '测试配额耗尽' } : { status: 0, total: 100,
        results: Array.from({ length: 20 }, (_, i) => ({ uid: `${n}-${i}`, name: `医院${n}-${i}`, location: { lat: 28.505 + (n * 20 + i) * 0.0001, lng: 118.02 } })) };
    } else if (url.pathname.endsWith('/usage')) {
      body = { status: 0, usage: { date: '2026-10-12', requests: { place: 0, route: 0, geo: 0, total: 0 }, cacheHits: 0, dailyBudget: 2000, overBudget: false, note: 'local-process-counter' } };
    } else { crossings++; body = { status: 0, result: { routes: [] } }; }
    await route.fulfill({ json: body });
  });
  await page.goto('/');
  await page.locator('#btn-analyze').click();
  await expect(page.locator('#project-status')).toContainText('已保存', { timeout: 20_000 });
  expect(queries).toEqual(['医院:0', '医院:1', '医院:2', '诊所:0']);
  expect(crossings).toBe(0);
  await expect(page.locator('.data-quality')).toContainText('达到上限');
  await expect(page.locator('.data-quality')).toContainText('未执行');
  const result = (await stored(page)).projects[0].result;
  expect(result.quotaExhausted).toBe(true);
  expect(result.gap.coverageShare).toBeNull();
  expect(result.planSites).toHaveLength(0);
});

test('旧规则仅查看历史值，不按当前规则重算或恢复被跳过建议', async ({ page }) => {
  const old = fixture();
  old.result.provenance!.ruleVersion = 'historic-rules';
  old.result.model.speed = old.result.field.speed = 75;
  old.workbench.acceptedSites = [old.result.planSites[0]];
  await page.goto('/');
  await importProject(page, serializeProject(old));
  await expect(page.locator('#project-status')).toContainText('已导入');
  await expect(page.locator('#panel-body')).toContainText('速度 75m/min');
  await page.locator('[data-tab="plan"]').click();
  await expect(page.locator('#panel-body')).toContainText('重新体检');
  await expect(page.locator('[data-act="accept"]')).toHaveCount(0);
});

test('窄屏侧栏可导入与保存项目', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.locator('#btn-sidebar').click();
  await importProject(page);
  await expect(page.locator('#project-status')).toContainText('已导入');
  await expect(page.locator('#project-export')).toBeVisible();
  await page.locator('#project-name').fill('手机端验收');
  await page.locator('#project-save').click();
  await expect(page.locator('#project-status')).toContainText('已保存');
  await expect(page.locator('#project-list').locator('xpath=ancestor::*[contains(@class,"ant-select")]').locator('.ant-select-selection-item')).toContainText('手机端验收');
  await page.screenshot({ path: testInfo.outputPath('mobile-projects.png') });
});
