import { chromium } from 'playwright';
import fs from 'node:fs';

const results = {};
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 950 } });
const page = await ctx.newPage();
let analyzeData = null;
page.on('response', async (res) => {
  if (res.url().includes('/api/analyze') && res.request().method() === 'POST') {
    try { analyzeData = (await res.json()).report; } catch {}
  }
});

async function waitForAnalyze() {
  // 等按钮恢复可用且拿到报告（动态分页后最坏 ~90s）
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(3000);
    const enabled = await page.locator('#btn-analyze').isEnabled().catch(() => false);
    if (enabled && analyzeData) break;
  }
  await page.waitForTimeout(2000);
}

async function sampleCase(title, addr, persona, shot) {
  analyzeData = null;
  await page.goto('http://localhost:8807/');
  await page.waitForTimeout(3000);
  await page.evaluate(([a, p]) => {
    document.getElementById('addr-input').value = a;
    document.getElementById('btn-locate').click();
    const sel = document.getElementById('persona');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, p);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, [addr, persona]);
  await page.waitForTimeout(3000);
  await page.locator('#btn-analyze').click();
  await waitForAnalyze();
  await page.locator('[data-tab="report"]').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shot });
  const r = analyzeData;
  results[title] = {
    score: r?.score?.total, grade: r?.score?.grade, dims: r?.score?.dims,
    coverageShare: r?.gap?.coverageShare, covUnavail: r?.gap?.coverageUnavailable,
    cumulative: r?.cumulative,
    poiSearch: (r?.poiSearch ?? []).map(s => `${s.keyword} ${s.fetchedCount}/${s.reportedTotal ?? '?'} ${s.status} 页${s.pagesFetched}`),
    warnings: r?.warnings, centerName: r?.centerName, fingerprint: r?.provenance?.ruleFingerprint
  };
  console.log(title, '→', r?.score?.total, r?.score?.grade);
}

await sampleCase('A-adult', '江西省上饶市江西师范大学数字产业学院', 'adult', 'v2-A-adult.png');
await sampleCase('A-elderly', '江西省上饶市江西师范大学数字产业学院', 'elderly', 'v2-A-elderly.png');
await sampleCase('B-urban', '上饶市信州区中心广场', 'adult', 'v2-B-urban.png');

// 街道批量（1280×720）
const page2 = await b.newPage({ viewport: { width: 1280, height: 720 } });
let batchDone = null;
page2.on('response', async (res) => {
  if (res.url().includes('/api/batch/status/')) {
    try { const d = await res.json(); if (d.job) batchDone = d.job; } catch {}
  }
});
await page2.goto('http://localhost:8807/');
await page2.waitForTimeout(2500);
await page2.locator('[data-tab="street"]').click();
await page2.evaluate(() => {
  document.getElementById('street-addr').value = '上饶市信州区东市街道';
  const sel = document.getElementById('street-persona');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'adult');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
await page2.locator('#btn-street-start').click();
for (let i = 0; i < 48; i++) {
  await page2.waitForTimeout(10000);
  if (batchDone && batchDone.status !== 'running' && batchDone.status !== 'queued') break;
}
await page2.screenshot({ path: 'v2-street.png' });
results.street = { status: batchDone?.status, done: batchDone?.done, total: batchDone?.total, summary: batchDone?.summary };
console.log('street →', batchDone?.status, batchDone?.summary?.avgScore);

// 城区试点（1600×950）
const page3 = await b.newPage({ viewport: { width: 1600, height: 950 } });
let distDone = null;
page3.on('response', async (res) => {
  if (res.url().includes('/api/batch/status/')) {
    try { const d = await res.json(); if (d.job) distDone = d.job; } catch {}
  }
});
await page3.goto('http://localhost:8807/');
await page3.waitForTimeout(2500);
await page3.locator('[data-tab="street"]').click();
await page3.selectOption('#street-scope', 'district');
await page3.evaluate(() => {
  document.getElementById('street-addr').value = '上饶市信州区';
  const radius = document.getElementById('street-radius');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(radius, '5000');
  radius.dispatchEvent(new Event('change', { bubbles: true }));
});
await page3.locator('#btn-street-start').click();
for (let i = 0; i < 90; i++) {
  await page3.waitForTimeout(10000);
  if (distDone && distDone.status !== 'running' && distDone.status !== 'queued') break;
}
await page3.waitForTimeout(2000);
await page3.screenshot({ path: 'v2-district.png' });
results.district = { status: distDone?.status, done: distDone?.done, total: distDone?.total, summary: distDone?.summary, error: distDone?.error };
console.log('district →', distDone?.status, distDone?.summary?.avgScore);

fs.writeFileSync('v2-measurements.json', JSON.stringify(results, null, 2));
await b.close();
console.log('ALL DONE');
