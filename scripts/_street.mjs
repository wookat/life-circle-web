import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:29229');
const ctx = browser.contexts()[0] ?? await browser.newContext();
const page = await ctx.newPage();
await page.setViewportSize({ width: 1600, height: 950 });
await page.goto('http://localhost:5174/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2000);
await page.locator('[data-tab="street"]').click();
await page.waitForTimeout(1200);
// 发起一个合成任务渲染状态区
await page.locator('#street-addr').fill('上饶市信州区东市街道');
await page.locator('#btn-street-start').click();
await page.waitForTimeout(2500);
await page.screenshot({ path: '/tmp/street-react.png' });
console.log('saved');
await page.close(); await browser.close();
