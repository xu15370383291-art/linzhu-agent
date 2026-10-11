import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { chromium } from 'playwright';

const port = 4300 + Math.floor(Math.random() * 500);
const baseURL = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['backend/workbench/server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let browser;
let launchError;
let serverOutput = '';
for (const stream of [server.stdout, server.stderr]) {
  stream?.on('data', chunk => {
    serverOutput = `${serverOutput}${chunk}`.slice(-4000);
  });
}

try {
  await once(server, 'spawn');
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      const response = await fetch(`${baseURL}/api/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!ready) throw new Error(`预览服务器未能就绪。${serverOutput}`);

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await chromium.launch({ headless: true, executablePath });
} catch (error) {
  launchError = error;
}

test('prototype UI browser tests', { skip: launchError ? `无法启动本机 Edge/Chromium：${launchError.message}` : false }, async t => {
  const pageErrors = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${baseURL}/index.html?testMode=1`, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.__lingzhuTest.clearStorage());
  await page.reload({ waitUntil: 'networkidle' });

  await t.test('relocated server keeps the project root and exposes only frontend assets', async () => {
    const health = await fetch(`${baseURL}/api/health`).then(response => response.json());
    assert.equal(path.resolve(health.root), path.resolve(process.cwd()));
    assert.equal((await fetch(`${baseURL}/live.html`)).status, 200);
    assert.equal((await fetch(`${baseURL}/server.js`)).status, 404);
    assert.equal((await fetch(`${baseURL}/extensions-store.js`)).status, 404);
  });

  await t.test('新建、空态、发送与审批通过形成完整流程', async () => {
    await page.locator('.new-chat').click();
    await page.getByRole('heading', { name: '从一个任务开始' }).waitFor();
    const input = page.getByRole('textbox', { name: '发送给灵珠的消息' });
    await input.fill('检查项目结构并给出建议');
    await input.press('Enter');
    await page.getByText('正在读取工作区').waitFor();
    await page.getByText('需要你的确认').waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: /检查变更/ }).click();
    const expandedWidth = await page.locator('.main-pane').evaluate(element => element.getBoundingClientRect().width);
    await page.locator('.panel-close').click();
    assert.equal(await page.locator('#review-panel').isVisible(), false);
    const collapsedWidth = await page.locator('.main-pane').evaluate(element => element.getBoundingClientRect().width);
    assert.ok(collapsedWidth > expandedWidth, '收起审批区后聊天工作区应扩展');
    await page.getByRole('button', { name: /检查变更/ }).click();
    assert.equal(await page.locator('#review-panel').isVisible(), true);
    assert.equal(await page.locator('.main-pane').evaluate(element => element.getBoundingClientRect().width), expandedWidth);
    await page.getByRole('button', { name: '批准并继续' }).click();
    await page.getByText('审批已通过。原型演示流程已完成；没有文件被写入或修改。').waitFor();
    assert.equal(await page.evaluate(() => window.__lingzhuTest.getState().status), 'done');
    assert.equal(await page.locator('#review-panel').isVisible(), false);
  });

  await t.test('拒绝审批不会写入文件，并可在新会话搜索和切换', async () => {
    await page.locator('.new-chat').click();
    await page.getByRole('textbox', { name: '发送给灵珠的消息' }).fill('修复会话保存逻辑');
    await page.getByRole('textbox', { name: '发送给灵珠的消息' }).press('Enter');
    await page.getByText('需要你的确认').waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: '拒绝' }).click();
    await page.getByText('你已拒绝这项变更。原型流程已停止，没有文件被写入或修改。').waitFor();
    assert.equal(await page.evaluate(() => window.__lingzhuTest.getState().status), 'cancelled');

    await page.getByRole('button', { name: /搜索会话/ }).click();
    await page.getByRole('searchbox', { name: /会话名称或内容/ }).fill('修复会话');
    await page.locator('.search-result').click();
    await page.getByText('操作已拒绝').waitFor();
    assert.equal(await page.locator('.breadcrumb strong').textContent(), '修复会话保存逻辑');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('.breadcrumb strong').textContent(), '修复会话保存逻辑');
  });

  await t.test('运行中可取消、失败可重试并完成', async () => {
    await page.goto(`${baseURL}/index.html?scenario=failure&testMode=1`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '重试', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__lingzhuTest.getState().status), 'failed');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByText('任务已完成。我已整理出清晰的结果，并检查了输出内容。').waitFor({ timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__lingzhuTest.getState().status), 'done');

    await page.goto(`${baseURL}/index.html?scenario=empty&testMode=1`, { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: '发送给灵珠的消息' }).fill('执行一个可取消任务');
    await page.getByRole('textbox', { name: '发送给灵珠的消息' }).press('Enter');
    await page.locator('.cancel-action').waitFor();
    await page.locator('.cancel-action').click();
    assert.equal(await page.evaluate(() => window.__lingzhuTest.getState().status), 'cancelled');
  });

  await t.test('刷新恢复会话、搜索无结果、键盘快捷键与窄视口可用', async () => {
    await page.goto(`${baseURL}/index.html?testMode=1`, { waitUntil: 'networkidle' });
    await page.evaluate(() => window.__lingzhuTest.clearStorage());
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /新建会话/ }).click();
    await page.getByRole('textbox', { name: '发送给灵珠的消息' }).fill('请汇总本周进展');
    await page.getByRole('textbox', { name: '发送给灵珠的消息' }).press('Enter');
    await page.getByText('任务已完成。我已整理出清晰的结果，并检查了输出内容。').waitFor({ timeout: 5000 });
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.evaluate(() => window.__lingzhuTest.getState().status), 'done');
    await page.keyboard.press('Control+j');
    await page.getByRole('searchbox').fill('不存在的会话');
    await page.getByText('没有找到匹配的会话').waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await page.getByRole('heading', { name: '从一个任务开始' }).waitFor();
    await page.setViewportSize({ width: 800, height: 720 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.deepEqual(pageErrors, []);
  });

  await t.test('刷新中断的任务可重试并进入审批状态', async () => {
    await page.goto(`${baseURL}/index.html?testMode=1`, { waitUntil: 'networkidle' });
    await page.evaluate(() => window.__lingzhuTest.clearStorage());
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.new-chat').click();
    const input = page.getByRole('textbox', { name: '发送给灵珠的消息' });
    await input.fill('刷新时恢复任务状态');
    await input.press('Enter');
    await page.getByText('正在读取工作区').waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.evaluate(() => window.__lingzhuTest.getState().status), 'failed');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByText('需要你的确认').waitFor({ timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__lingzhuTest.getState().status), 'approval');
    await page.getByRole('button', { name: '拒绝' }).click();
  });

  await t.test('成功预置、Shift+Enter 与动态画布均正常', async () => {
    await page.goto(`${baseURL}/index.html?scenario=success&testMode=1`, { waitUntil: 'networkidle' });
    assert.equal(await page.evaluate(() => window.__lingzhuTest.getState().status), 'done');
    await page.goto(`${baseURL}/index.html?scenario=empty&testMode=1`, { waitUntil: 'networkidle' });
    const input = page.getByRole('textbox', { name: '发送给灵珠的消息' });
    await input.fill('第一行');
    await input.press('Shift+Enter');
    await input.type('第二行');
    assert.equal(await page.evaluate(() => window.__lingzhuTest.getState().sessions[0].messages.length), 0);
    await input.press('Enter');
    assert.match(await page.locator('.user-message p').textContent(), /第一行\s+第二行/);
    const paintedPixels = await page.locator('#network-canvas').evaluate(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) count += 1;
      return count;
    });
    assert.ok(paintedPixels > 0, '动态粒子画布应包含可见绘制内容');
  });

  await t.test('审批预览和减少动态效果均正常显示', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => localStorage.setItem('lingzhu-prototype-shell-v1', JSON.stringify({
      autoReview: false,
      sidebarCollapsed: true,
    })));
    await page.goto(`${baseURL}/index.html?scenario=approval`, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#review-panel').isVisible(), true);
    assert.equal(await page.locator('.approve-button').isVisible(), true);
    assert.equal(await page.locator('.app-shell').evaluate(element => element.classList.contains('sidebar-collapsed')), false);
    assert.equal(await page.locator('#network-canvas').isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.setViewportSize({ width: 944, height: 944 });
    const narrowReviewRect = await page.locator('#review-panel').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, position: getComputedStyle(element).position };
    });
    assert.equal(narrowReviewRect.position, 'fixed');
    assert.equal(Math.round(narrowReviewRect.right), 944);
    assert.equal(Math.round(narrowReviewRect.top), 52);
    assert.equal(Math.round(narrowReviewRect.bottom), 944);
    assert.ok(narrowReviewRect.left > 400, '窄屏审批面板应固定在右侧，而不是掉到主内容底部');
    const narrowMainRect = await page.locator('.main-pane').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
    assert.equal(Math.round(narrowMainRect.right), Math.round(narrowReviewRect.left), '主内容区应在审批面板左侧结束');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  await context.close();
});

test.after(async () => {
  await browser?.close();
  server.kill();
});
