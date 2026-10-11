import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { zipSync } from 'fflate';
import { SkillStore } from '../../backend/skills/store.js';

const port = 4900 + Math.floor(Math.random() * 500);
const baseURL = `http://127.0.0.1:${port}`;
const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'extensions-manager-'));
const server = spawn(process.execPath, ['backend/workbench/server.js'], {
  cwd: process.cwd(), env: { ...process.env, PORT: String(port), EXTENSIONS_DATA_ROOT: dataRoot, SKILLS_DATA_ROOT: dataRoot },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let browser; let launchError; let serverOutput = '';
for (const stream of [server.stdout, server.stderr]) stream?.on('data', chunk => { serverOutput = `${serverOutput}${chunk}`.slice(-3000); });
try {
  await once(server, 'spawn');
  const deadline = Date.now() + 6000; let ready = false;
  while (Date.now() < deadline && server.exitCode === null) {
    try { if ((await fetch(`${baseURL}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  if (!ready) throw new Error(`扩展预览服务未能就绪。${serverOutput}`);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await chromium.launch({ headless: true, executablePath });
} catch (error) { launchError = error; }

test('插件与技能管理端到端流程', { skip: launchError ? `无法启动本机 Edge/Chromium：${launchError.message}` : false }, async t => {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, acceptDownloads: true });
  const page = await context.newPage(); const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${baseURL}/extensions/plugins`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(process.cwd(), 'artifacts/screenshots/extensions-manager-desktop.png'), fullPage: true });

  await t.test('真实路径、来源页签、搜索与安装状态同步', async () => {
    assert.equal(await page.locator('#import-trigger').isHidden(), true, '插件管理不应提供技能格式导入入口');
    await page.getByRole('heading', { name: '插件' }).waitFor();
    assert.equal(await page.locator('.catalog-item').count(), 4);
    await page.getByRole('searchbox', { name: '搜索插件' }).fill('表格');
    await page.getByRole('heading', { name: '数据' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.catalog-item').length === 1);
    assert.equal(await page.locator('.catalog-item').count(), 1);
    await page.getByRole('searchbox', { name: '搜索插件' }).fill('');
    await page.getByRole('link', { name: '个人' }).click();
    assert.match(page.url(), /source=personal/);
    await page.getByText('还没有个人插件').waitFor();
    await page.getByRole('link', { name: '公开' }).click();
    const item = page.locator('.catalog-item').filter({ hasText: '日程整理' });
    await item.locator('[data-install]').click();
    await page.getByText('日程整理', { exact: true }).first().waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.installed-item').length === 1);
    assert.equal(await page.locator('.installed-item').count(), 1);
    await page.locator('.catalog-item').filter({ hasText: '日程整理' }).locator('.catalog-action').click();
    await page.getByRole('heading', { name: '日程整理' }).waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('已安装 · 已启用').waitFor();
    await page.getByRole('button', { name: '← 返回插件列表' }).click();
    assert.match(page.url(), /\/extensions\/plugins/);
  });

  await t.test('个人技能新建、保存、编辑、直接访问和未保存提醒', async () => {
    await page.getByRole('link', { name: '技能' }).click();
    await page.getByRole('button', { name: '＋ 添加' }).click();
    assert.equal(await page.locator('#import-trigger').isHidden(), false);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '＋ 添加' }).click();
    await page.getByRole('button', { name: /新建个人技能/ }).click();
    assert.match(page.url(), /\/extensions\/skills\/new$/);
    await page.locator('[name="skillId"]').fill('test-skill');
    await page.locator('[name="name"]').fill('测试技能');
    await page.locator('[name="description"]').fill('用于验证持久化流程');
    await page.locator('[name="category"]').fill('测试');
    await page.locator('[name="content"]').fill('# 验收正文\n\n保存后刷新仍应存在。');
    await page.getByRole('button', { name: '保存并安装', exact: true }).click();
    await page.getByRole('heading', { name: '测试技能' }).waitFor();
    const detailUrl = page.url();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('保存后刷新仍应存在。').waitFor();
    const storedSkill = await page.evaluate(async () => (await (await fetch('/api/skills/test-skill')).json()));
    assert.match(storedSkill.content, /保存后刷新仍应存在/);
    assert.equal(storedSkill.enabled, true);
    const exportDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 JSON' }).click();
    assert.match((await exportDownload).suggestedFilename(), /\.extension\.json$/);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('[name="description"]').fill('更新后的描述');
    await page.getByRole('button', { name: '保存并安装', exact: true }).click();
    await page.locator('.detail-description').getByText('更新后的描述', { exact: true }).waitFor();
    await page.goto(detailUrl, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '测试技能' }).waitFor();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('[name="name"]').fill('未保存名称');
    page.once('dialog', dialog => { assert.match(dialog.message(), /尚未保存/); void dialog.dismiss(); });
    await page.getByRole('link', { name: '插件' }).click();
    await page.locator('[name="name"]').waitFor();
    assert.match(page.url(), /\/edit$/);
  });

  await t.test('确认卸载和删除、JSON 导入导出及移动端布局', async () => {
    await page.goto(`${baseURL}/extensions/plugins/demo-calendar`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '卸载' }).click();
    await page.getByRole('button', { name: '确认' }).click();
    await page.locator('.catalog-item').filter({ hasText: '日程整理' }).locator('[data-install]').waitFor();
    const exportResult = await page.evaluate(async () => {
      const response = await fetch('/api/extensions/export?id=test-skill');
      return { status: response.status, data: await response.json() };
    });
    assert.equal(exportResult.status, 200);
    assert.equal(exportResult.data.format, 'lingzhu-skill-export');
    const imported = await page.evaluate(async data => {
      const response = await fetch('/api/extensions/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      return { status: response.status, body: await response.json() };
    }, exportResult.data);
    assert.equal(imported.status, 201);
    assert.equal(imported.body.items.length, 1);
    const invalid = await page.evaluate(async () => {
      const response = await fetch('/api/extensions/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'wrong', schemaVersion: 1, items: [] }) });
      return response.status;
    });
    assert.equal(invalid, 400);
    await page.goto(`${baseURL}/extensions/skills?source=personal`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '＋ 添加' }).click();
    await page.locator('#import-file').setInputFiles({ name: 'skill.extension.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exportResult.data)) });
    await page.getByText(/已导入 1 个个人技能/).waitFor();
    await page.goto(`${baseURL}/extensions/skills?source=personal`, { waitUntil: 'networkidle' });
    const importedRow = page.locator('.catalog-item').filter({ hasText: '测试技能' }).last();
    await importedRow.locator('.catalog-open').first().click();
    await page.getByRole('heading', { name: '测试技能' }).waitFor();
    await page.getByRole('button', { name: '删除个人内容' }).click();
    await page.getByRole('button', { name: '确认' }).click();
    await page.getByRole('heading', { name: '技能', exact: true }).waitFor();
    const originalRows = page.locator('.catalog-item').filter({ hasText: '测试技能' });
    assert.equal(await originalRows.count(), 2, '删除其中一个导入副本后，原技能及另一副本应保留');
    await originalRows.locator('.catalog-open').first().click();
    await page.getByText('保存后刷新仍应存在。').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseURL}/extensions/skills?source=personal`, { waitUntil: 'networkidle' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: '打开导航' }).click();
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('sidebar-open')), true);
    const overlap = await page.locator('.extensions-mobile-bar button').evaluate(button => {
      const a = button.getBoundingClientRect(); const b = document.querySelector('.extensions-mobile-bar span').getBoundingClientRect();
      return a.right > b.left && a.left < b.right;
    });
    assert.equal(overlap, false, '移动导航按钮与标题不得重叠');
    await page.locator('.catalog-item').first().waitFor();
    await page.screenshot({ path: path.join(process.cwd(), 'artifacts/screenshots/extensions-manager-mobile.png'), fullPage: true });
    assert.deepEqual(pageErrors, []);
  });

  await t.test('skillpack 导入保存在当前项目', async () => {
    const archive = zipSync({
      'project-formatter/SKILL.md': Buffer.from('---\nname: project-formatter\ntitle: 项目格式化\ndescription: 在当前项目按统一格式处理\n---\n\n使用资源辅助格式化。', 'utf8'),
      'project-formatter/references/style.md': Buffer.from('统一使用简体中文。', 'utf8'),
      'project-formatter/assets/template.txt': Buffer.from('输出模板'),
    });
    const response = await fetch(`${baseURL}/api/skills/import-pack`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: archive });
    assert.equal(response.status, 201);
    const imported = await response.json(); assert.equal(imported.id, 'project-formatter');
    const otherProject = new SkillStore(path.join(dataRoot, 'other-project'));
    await assert.rejects(otherProject.load('project-formatter'), /不存在/);
    const data = await (await fetch(`${baseURL}/api/extensions?type=skill`)).json();
    assert.equal(data.items.some(item => item.id === 'project-formatter' && item.source === 'personal'), true);
    await page.goto(`${baseURL}/extensions/skills?source=personal`, { waitUntil: 'networkidle' });
    await page.locator('.catalog-item').filter({ hasText: '项目格式化' }).waitFor();
  });

  await context.close();
});

test.after(async () => {
  await browser?.close(); server.kill(); await rm(dataRoot, { recursive: true, force: true });
});
