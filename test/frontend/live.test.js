import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

test('live workspace components', async t => {
  const server = http.createServer(async (req, res) => {
    try {
      const file = new URL(`.${req.url}`, new URL('../../frontend/workbench/', import.meta.url));
      const data = await readFile(file);
      res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html'); res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
  const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  const sessions = Array.from({ length: 45 }, (_, i) => ({ id: `session-${i}`, title: `任务 ${i}`, updatedAt: Date.now() - i * 86400000 }));
  sessions.push({ id: 'project-session', title: '项目中的会话', updatedAt: Date.now(), messageCount: 1, project: { id: 'project-1', name: '演示项目', path: 'D:\\projects\\demo' } });
  const projects = [{ id: 'project-1', name: '演示项目', path: 'D:\\projects\\demo' }];
  const archivedIds = new Set();
  let turn; let releaseTurn; let lastTurnPayload; let streamMode = false; let streamCalls = 0; let lastEventHeader = ''; let securityMode = 'safe'; let sentUserMessage = null;
  const skillItems = [
    { id: 'meeting-notes', name: '会议整理', description: '从讨论记录中整理决策、行动项和负责人', enabled: true, installed: true, icon: '记' },
    { id: 'disabled-skill', name: '停用技能', description: '不可用于当前对话', enabled: false, installed: true },
    { id: 'invalid-skill', name: '无效技能', description: 'frontmatter 格式错误', invalid: true, error: 'YAML 格式错误', installed: true },
  ];
  await page.route('**/api/**', async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    let data;
    if (path === '/api/events') {
      if (!streamMode) return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: ': connected\n\n' });
      streamCalls++; lastEventHeader = req.headers()['last-event-id'] || '';
      const events = streamCalls === 1
        ? [{ id: 'stream-1', type: 'turn.delta', payload: { turnId: 'stream-turn', sessionId: 'session-0', text: '实时回答' } }]
        : [{ id: 'stream-1', type: 'turn.delta', payload: { turnId: 'stream-turn', text: '重复' } }, { id: 'stream-2', type: 'turn.delta', payload: { turnId: 'stream-turn', text: '·第二段' } }];
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: events.map(event => `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`).join('') });
    }
    else if (path === '/api/security-mode' && req.method() === 'POST') { securityMode = req.postDataJSON().mode; data = securityMode; }
    else if (path === '/api/security-mode' && req.method() === 'GET') data = { requested: securityMode, active: securityMode };
    else if (path === '/api/sessions' && req.method() === 'GET') data = sessions.filter(session => archivedIds.has(session.id) === (new URL(req.url()).searchParams.get('archived') === 'true'));
    else if (path === '/api/sessions' && req.method() === 'POST') data = { id: 'created-session', title: '新会话', updatedAt: Date.now() };
    else if (path === '/api/projects' && req.method() === 'GET') data = { items: sessions.some(session => session.project?.id === 'project-1' && (session.messageCount ?? 0) > 0) ? projects : [], available: true };
    else if (path === '/api/projects/pick' && req.method() === 'POST') data = { cancelled: false, project: projects[0] };
    else if (path.match(/^\/api\/sessions\/[^/]+\/(archive|restore)$/) && req.method() === 'POST') {
      const [, id, action] = path.match(/^\/api\/sessions\/([^/]+)\/(archive|restore)$/);
      if (action === 'archive') archivedIds.add(id); else archivedIds.delete(id);
      data = { id, archivedAt: action === 'archive' ? new Date().toISOString() : null };
    }
    else if (path.startsWith('/api/sessions/')) { const session = sessions.find(s => path.endsWith(s.id)); data = { ...session, ...(archivedIds.has(session?.id) ? { archivedAt: new Date().toISOString() } : {}), messages: [{ role: 'assistant', content: '测试消息\n'.repeat(300), createdAt: Date.now() }, { role: 'assistant', content: '# 结果\n\n**完成**了处理。\n\n- 第一项\n- 第二项\n\n```js\nconst answer = 42;\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 检查 | 通过 |\n\n<script>window.__markdownXss = true</script>', createdAt: Date.now() }, { role: 'user', content: '请阅读这个文件', attachment: { id: 'upload-1', name: 'history-notes.md', mediaType: 'text/plain', sizeBytes: 12 }, createdAt: Date.now() }, ...(session?.id === 'session-0' && sentUserMessage ? [sentUserMessage] : [])] }; }
    else if (path === '/api/models') data = { items: [{ id: 'model-1', name: '测试模型' }], selectedId: 'model-1' };
    else if (path === '/api/skills') data = skillItems;
    else if (path === '/api/skills/meeting-notes/inspect') data = { id: 'meeting-notes', body: '# 正常技能正文' };
    else if (path === '/api/diagnostics') data = { root: 'D:\\workspace', worker: { available: false }, failClosed: true, securityMode: { requested: securityMode, active: securityMode } };
    else if (path === '/api/tools') data = { items: [{ name: 'read_file', description: '读取文件', risk: 'read', approval: 'none' }, ...Array.from({ length: 80 }, (_, i) => ({ name: `tool_${i}`, description: `测试工具 ${i}`, risk: 'read', approval: 'none' }))] };
    else if (path === '/api/attachments/upload') data = { id: 'upload-1', name: 'notes.md', mediaType: 'text/plain', sizeBytes: 12, preview: '# local notes' };
    else if (path === '/api/turns') {
      const input = req.postDataJSON(); lastTurnPayload = input; sentUserMessage = { role: 'user', content: input.input, ...(input.skillReference ? { skillReference: input.skillReference } : {}), createdAt: Date.now() }; turn = { id: input.turnId, sessionId: input.sessionId, status: 'running', createdAt: Date.now() };
      await new Promise(resolve => { releaseTurn = resolve; }); data = turn;
    } else if (path.endsWith('/cancel')) { turn.status = 'cancelled'; data = turn; releaseTurn(); }
    else if (path.startsWith('/api/turns/')) data = turn;
    else throw new Error(`Unexpected API: ${path}`);
    await route.fulfill({ json: data });
  });
  const url = `http://127.0.0.1:${server.address().port}/live.html`;
  await page.goto(url); await page.locator('.session-item').first().waitFor();
  await t.test('starts with an unsaved blank conversation', async () => {
    assert.equal(await page.locator('#session-title').textContent(), '新会话');
    assert.equal(await page.locator('#messages .empty-state').isVisible(), true);
    assert.equal(await page.locator('.session-item.active').count(), 0);
    assert.equal(await page.locator('#access-toggle').count(), 0);
    assert.equal(await page.locator('#access-dialog').count(), 0);
    assert.equal(await page.locator('#project-toggle').isVisible(), true);
    assert.equal(await page.locator('#project-current-label').textContent(), '选择项目');
    assert.equal(await page.locator('#project-browse').isVisible(), false);
  });
  await page.locator('.session-item').filter({ hasText: '任务 0' }).click();
  await t.test('slash menu trigger, search, keyboard, submenu and skill context', async () => {
    const input = page.getByRole('textbox', { name: '消息内容' }); const menu = page.locator('#slash-menu');
    const promptText = () => input.evaluate(element => { const clone = element.cloneNode(true); clone.querySelectorAll('.skill-inline-token').forEach(token => token.remove()); return clone.innerText.replace(/\u00a0/g, ' ').replace(/\n+$/, '').replace(/\n/g, ' '); });
    const setCaret = offset => input.evaluate((element, position) => {
      element.focus(); const selection = getSelection(); const range = document.createRange();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let node; let remaining = position;
      while ((node = walker.nextNode())) { if (remaining <= node.textContent.length) { range.setStart(node, remaining); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); return; } remaining -= node.textContent.length; }
      range.selectNodeContents(element); range.collapse(false); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    }, offset);
    const selectChipEdge = (after = false, select = false) => input.evaluate((element, options) => {
      const token = element.querySelector('.skill-inline-token'); const range = document.createRange();
      if (options.select) range.selectNode(token); else { if (options.after) range.setStartAfter(token); else range.setStartBefore(token); range.collapse(true); }
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); element.focus();
    }, { after, select });
    await input.fill('/'); assert.equal(await menu.isVisible(), true);
    assert.equal(await menu.locator('.slash-section-title').allTextContents().then(items => items.join(' ')).then(text => text.includes('功能') && text.includes('技能')), true);
    assert.equal(await menu.locator('[data-slash-option="skill:disabled-skill"]').isDisabled(), true);
    assert.equal(await menu.locator('[data-slash-option="skill:invalid-skill"]').isDisabled(), true);
    await input.fill('/草稿'); await setCaret(0); await page.keyboard.press('Delete');
    assert.equal(await menu.isVisible(), false); assert.equal(await promptText(), '草稿');
    await input.fill('/'); await page.locator('#session-title').click(); assert.equal(await menu.isVisible(), true);
    await input.focus();
    await page.setViewportSize({ width: 390, height: 844 }); await input.fill('/');
    const popupBounds = await menu.boundingBox(); const promptBounds = await input.boundingBox();
    assert.ok(popupBounds && promptBounds && popupBounds.x >= 0 && popupBounds.x + popupBounds.width <= 390 && popupBounds.y >= 0 && popupBounds.y + popupBounds.height <= 844);
    assert.ok(popupBounds.y + popupBounds.height <= promptBounds.y + 1);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.keyboard.press('Escape'); assert.equal(await menu.isVisible(), true); assert.equal(await promptText(), '/');
    await input.fill(' /'); assert.equal(await menu.isVisible(), false);
    await input.fill('帮我/工具'); assert.equal(await menu.isVisible(), false);
    await input.fill('https://example.com'); assert.equal(await menu.isVisible(), false);
    await input.fill('/');
    const composingEnter = await input.evaluate(element => { const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true, keyCode: 229 }); element.dispatchEvent(event); return event.defaultPrevented; });
    assert.equal(composingEnter, false); assert.equal(await menu.isVisible(), true); assert.equal(await promptText(), '/');
    await input.fill('/工具'); assert.equal(await menu.locator('[role="option"]').count(), 1); assert.equal(await menu.locator('[role="option"]').first().getAttribute('data-slash-option'), 'tools');
    await input.fill('/not-a-match'); assert.equal(await menu.getByText('没有匹配的功能或技能').isVisible(), true);
    await input.fill('/安全'); await menu.getByRole('option', { name: /操作审批模式/ }).click();
    assert.equal(await menu.locator('.slash-back').isVisible(), true); await page.keyboard.press('Escape'); assert.equal(await menu.locator('.slash-back').count(), 0); assert.equal(await promptText(), '/安全');
    await input.fill('前文后文'); await setCaret(2); await page.locator('#skill-picker').selectOption('meeting-notes');
    assert.equal(await menu.isVisible(), false);
    assert.equal(await input.locator('.skill-inline-token').count(), 1);
    assert.equal(await input.locator('.skill-token-name').textContent(), '会议整理');
    assert.match(await promptText(), /^前文 .* 后文$/);
    assert.equal(await input.locator('.skill-inline-token').getAttribute('contenteditable'), 'false');
    await input.press('Shift+Enter'); await page.keyboard.type('第二行'); assert.match(await promptText(), /第二行/);
    await selectChipEdge(false); await page.keyboard.press('Delete');
    assert.equal(await input.locator('.skill-inline-token').count(), 0);
    await input.fill('/会议整理'); await menu.getByRole('option', { name: /会议整理/ }).click();
    await selectChipEdge(false, true); await page.keyboard.press('Backspace');
    assert.equal(await input.locator('.skill-inline-token').count(), 0);
    await input.fill('/'); await input.press('ArrowDown'); assert.equal(await menu.locator('[aria-selected="true"]').count(), 1);
    await input.fill('/会议整理'); await menu.getByRole('option', { name: /会议整理/ }).click();
    await page.keyboard.type('请整理本次会议'); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: '停止任务' }).waitFor();
    assert.equal(lastTurnPayload.skillId, 'meeting-notes');
    assert.equal(lastTurnPayload.input, '请整理本次会议');
    assert.deepEqual(lastTurnPayload.skillReference, { skillId: 'meeting-notes', displayName: '会议整理', offset: 0 });
    await page.getByRole('button', { name: '停止任务' }).click(); await page.getByText('已取消', { exact: true }).waitFor();
    assert.equal((await promptText()).trimStart(), '请整理本次会议');
    assert.equal(await input.locator('.skill-inline-token').count(), 1);
    await page.locator('.message.user .skill-inline-token .skill-token-name').last().waitFor();
    assert.equal(await page.locator('.message.user .skill-inline-token .skill-token-name').last().textContent(), '会议整理');
  });
  await t.test('grouping, pin persistence, search and export', async () => {
    assert.equal(await page.locator('.session-item').count(), 46);
    await page.locator('.session-row').filter({ has: page.locator('.session-item').filter({ hasText: '任务 0' }) }).locator('.session-menu summary').click(); await page.getByRole('button', { name: '在此浏览器置顶会话' }).click();
    assert.match(await page.locator('.group-heading').allTextContents().then(items => items.join(' ')), /置顶/);
    await page.reload(); await page.locator('.session-item').filter({ hasText: '任务 0' }).waitFor(); assert.match(await page.locator('.group-heading').allTextContents().then(items => items.join(' ')), /置顶/);
    await page.locator('.session-item').filter({ hasText: '任务 0' }).click();
    await page.locator('.group-heading').filter({ hasText: '置顶' }).click(); assert.equal(await page.locator('.session-item').count(), 45);
    await page.locator('.group-heading').filter({ hasText: '置顶' }).click(); assert.equal(await page.locator('.session-item').count(), 46);
    await page.locator('#search-toggle').click(); await page.getByRole('searchbox').fill('任务 0');
    assert.equal(await page.locator('.session-item').count(), 1);
    const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: '导出当前会话', exact: true }).click(); assert.equal((await downloaded).suggestedFilename(), '任务 0.md');
    await page.getByRole('searchbox').fill('');
  });
  await t.test('project conversations are grouped separately from ordinary sessions', async () => {
    assert.equal(await page.locator('.session-item').count(), 46);
    assert.match(await page.locator('.group-heading').allTextContents().then(items => items.join(' ')), /演示项目/);
    assert.equal(await page.locator('.session-category-heading').textContent(), '普通对话');
    assert.equal(await page.locator('.session-item').filter({ hasText: '项目中的会话' }).count(), 1);
    await page.locator('#project-toggle').click();
    assert.equal(await page.locator('#project-menu').isVisible(), true);
    assert.equal(await page.locator('.project-option').count(), 2);
    assert.equal(await page.locator('.project-option').filter({ hasText: '演示项目' }).count(), 1);
    await page.getByRole('searchbox', { name: '搜索项目' }).fill('not found');
    assert.equal(await page.locator('.project-option').count(), 1);
    assert.equal(await page.getByText('没有匹配的项目').isVisible(), true);
    await page.getByRole('searchbox', { name: '搜索项目' }).fill('');
    await page.locator('.project-option').filter({ hasText: '演示项目' }).click();
    assert.equal(await page.locator('#project-menu').isVisible(), false);
    assert.equal(await page.locator('#project-current-label').textContent(), '演示项目');
    await page.locator('#project-toggle').click();
    assert.equal(await page.locator('.project-option').filter({ hasText: '普通对话' }).count(), 1);
    await page.getByRole('button', { name: '新建项目' }).click();
    await page.waitForFunction(() => document.querySelector('#project-current-label')?.textContent === '演示项目');
    await page.locator('.session-item').filter({ hasText: '任务 0' }).click();
    await page.locator('.collapsed-message').waitFor();
  });
  await t.test('sessions can be archived, found in archive, and restored', async () => {
    const target = page.locator('.session-row[data-session-id="session-1"]');
    await target.locator('.session-menu summary').click();
    await page.getByRole('button', { name: '归档会话', exact: true }).click();
    await page.locator('.session-row[data-session-id="session-1"]').waitFor({ state: 'detached' });
    assert.equal(archivedIds.has('session-1'), true);
    await page.getByRole('button', { name: '归档', exact: true }).click();
    await page.locator('.session-row[data-session-id="session-1"]').waitFor();
    assert.equal(await page.locator('.session-row[data-session-id="session-1"]').count(), 1);
    assert.equal(await page.locator('#list-heading').textContent().then(text => text.includes('已归档会话')), true);
    await page.locator('.session-row[data-session-id="session-1"] .session-item').click();
    await page.waitForFunction(() => document.querySelector('#prompt')?.getAttribute('aria-disabled') === 'true');
    assert.equal(await page.getByRole('textbox', { name: '消息内容' }).getAttribute('aria-disabled'), 'true');
    assert.match(await page.locator('#composer-state').textContent(), /只读/);
    await page.locator('.session-row[data-session-id="session-1"]').locator('.session-menu summary').click();
    await page.getByRole('button', { name: '恢复到最近会话', exact: true }).click();
    await page.locator('.session-row[data-session-id="session-1"]').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '归档', exact: true }).click();
    await page.locator('.session-row[data-session-id="session-1"]').waitFor();
    await page.locator('.session-row[data-session-id="session-1"] .session-item').click();
    await page.waitForFunction(() => document.querySelector('#prompt')?.getAttribute('aria-disabled') === 'false');
    assert.equal(await page.getByRole('textbox', { name: '消息内容' }).getAttribute('aria-disabled'), 'false');
    assert.equal(archivedIds.has('session-1'), false);
    await page.locator('.session-item').filter({ hasText: '任务 0' }).click();
    await page.locator('.collapsed-message').waitFor();
    assert.deepEqual(errors, []);
  });
  await t.test('message actions, tools and preserved animation', async () => {
    assert.equal(await page.locator('.collapsed-message').count(), 1);
    const historyAttachment = page.locator('.message-attachment').first();
    assert.equal(await historyAttachment.isVisible(), true);
    assert.equal(await historyAttachment.locator('strong').textContent(), 'history-notes.md');
    assert.equal(await historyAttachment.getAttribute('href'), '/api/attachments/upload-1/open');
    assert.equal(await historyAttachment.getAttribute('target'), '_blank');
    await page.getByRole('button', { name: '展开全文', exact: true }).click(); assert.equal(await page.locator('.collapsed-message').count(), 0);
    await page.getByRole('button', { name: '收起', exact: true }).click();
    await page.getByRole('button', { name: '复制消息', exact: true }).first().click(); assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), '测试消息\n'.repeat(300));
    const markdown = page.locator('.message-text').nth(1); assert.equal(await markdown.locator('h1').textContent(), '结果');
    assert.equal(await markdown.locator('.markdown-list li').count(), 2); assert.equal(await markdown.locator('.markdown-table tbody td').nth(1).textContent(), '通过');
    assert.equal(await markdown.locator('script').count(), 0); assert.equal(await markdown.locator('p').filter({ hasText: 'window.__markdownXss' }).count(), 1);
    await markdown.getByRole('button', { name: '复制代码' }).click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'const answer = 42;');
    await page.getByRole('button', { name: '工具目录', exact: true }).click(); await page.getByText('read_file', { exact: true }).waitFor();
    const toolDialog = page.locator('#tools-dialog'); const toolList = page.locator('#tool-list');
    await toolList.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const dialogBox = await toolDialog.boundingBox(); const closeBox = await page.getByRole('button', { name: '关闭工具目录' }).boundingBox();
    assert.ok(dialogBox && closeBox && closeBox.y >= dialogBox.y && closeBox.y + closeBox.height <= dialogBox.y + dialogBox.height);
    assert.ok(await toolList.evaluate(element => element.scrollTop > 0));
    await page.getByRole('searchbox', { name: '搜索工具' }).fill('missing'); await page.getByText('没有匹配的工具').waitFor();
    await page.getByRole('button', { name: '关闭工具目录' }).click();
    await page.getByRole('button', { name: '从本机添加附件', exact: true }).click();
    assert.equal(await page.getByText('输入工作区内的文本或 PDF 相对路径。').count(), 0);
    await page.locator('#attachment-file').setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# local notes') });
    assert.equal(await page.getByText(/notes\.md ·/).count(), 1);
    assert.equal(await page.locator('#attachment-selected-card').isVisible(), true);
    assert.match(await page.locator('#attachment-selected-card').getAttribute('href'), /^blob:/);
    assert.equal(await page.locator('#attachment-selected-card').getAttribute('target'), '_blank');
    await page.getByRole('button', { name: '上传并添加', exact: true }).click();
    await page.locator('#attachment-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#attachment-bar').isVisible(), true);
    assert.match(await page.locator('#attachment-card').getAttribute('href'), /^blob:/);
    assert.equal(await page.locator('#attachment-preview-result').isVisible(), false);
    await page.getByRole('button', { name: '移除附件', exact: true }).click();
    const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, height: document.querySelector('.main').getBoundingClientRect().height, pixels: document.querySelector('canvas').getContext('2d').getImageData(0, 0, document.querySelector('canvas').width, document.querySelector('canvas').height).data.some((v, i) => i % 4 === 3 && v > 0) }));
    assert.equal(layout.overflow, false); assert.equal(layout.height, 900); assert.equal(layout.pixels, true);
    await page.screenshot({ path: 'artifacts/screenshots/live-desktop.png' });
  });
  await t.test('permission menu explains actual modes and blocks unrestricted access', async () => {
    const toggle = page.getByRole('button', { name: '操作审批模式', exact: true });
    await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#permission-current').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: /个人文件模式/ }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: /完全访问权限/ }).isDisabled(), true);
    await page.getByRole('button', { name: '了解更多' }).click(); assert.equal(await page.locator('#permission-description').isVisible(), true);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#permission-menu').isVisible(), false);
    await page.setViewportSize({ width: 390, height: 844 }); await toggle.click();
    const bounds = await page.locator('#permission-menu').boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0);
    await page.screenshot({ path: 'artifacts/screenshots/permission-mobile.png' });
    await page.locator('#permission-current').click(); await page.setViewportSize({ width: 1440, height: 900 });
    await toggle.click(); await page.getByRole('button', { name: /个人文件模式/ }).click();
    await page.waitForFunction(() => document.querySelector('#permission-mode-label')?.textContent === '个人文件模式');
    assert.equal(await page.locator('#permission-mode-label').textContent(), '个人文件模式');
    await toggle.click(); await page.getByRole('button', { name: /安全模式/ }).click();
    await page.waitForFunction(() => document.querySelector('#permission-mode-label')?.textContent === '安全模式');
    assert.equal(await page.locator('#permission-mode-label').textContent(), '安全模式');
    await toggle.click(); await page.screenshot({ path: 'artifacts/screenshots/permission-desktop.png' }); await page.keyboard.press('Escape');
  });
  await t.test('SSE streams deltas, preserves Last-Event-ID and deduplicates replay', async () => {
    streamMode = true; streamCalls = 0; lastEventHeader = '';
    turn = { id: 'stream-turn', sessionId: 'session-0', status: 'running' };
    await page.evaluate(() => { sessionStorage.setItem('lingzhu-live-turn', 'stream-turn'); sessionStorage.setItem('lingzhu-live-session', 'session-0'); });
    await page.reload(); await page.locator('.live-message').waitFor();
    await page.waitForFunction(() => document.querySelector('.live-text')?.textContent.includes('实时回答·第二段'));
    const streamed = await page.locator('.live-text').first().textContent();
    assert.equal(streamed, '实时回答·第二段');
    assert.equal(streamed.includes('重复'), false);
    assert.equal(lastEventHeader, 'stream-1'); assert.ok(streamCalls >= 2);
    streamMode = false; await page.evaluate(() => sessionStorage.removeItem('lingzhu-live-turn')); await page.reload();
  });
  await t.test('stop remains enabled while POST is pending', async () => {
    await page.getByRole('textbox', { name: '消息内容' }).fill('测试停止'); await page.getByRole('textbox', { name: '消息内容' }).press('Enter');
    await page.getByRole('button', { name: '停止任务' }).waitFor(); assert.equal(await page.getByRole('button', { name: '停止任务' }).isEnabled(), true);
    await page.getByRole('button', { name: '停止任务' }).click(); await page.getByText('已取消', { exact: true }).waitFor();
    await page.getByRole('button', { name: '运行详情' }).click(); await page.getByText('当前回合', { exact: true }).waitFor();
    assert.match(await page.locator('#turn-details').textContent(), /已取消/); await page.locator('#details-close').click();
  });
  await t.test('mobile history drawer and no overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '会话历史', exact: true }).click(); assert.equal(await page.locator('#sessions').isVisible(), true);
    await page.locator('.session-item').filter({ hasText: '任务 0' }).click(); await page.locator('#history-backdrop').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: 'artifacts/screenshots/live-mobile.png' });
    assert.deepEqual(errors, []);
  });
  await t.test('approval stays dismissed across polling and can reopen', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    turn = { id: 'approval-turn', sessionId: 'session-0', status: 'awaiting_approval', approval: { id: 'approval-1', operation: 'write_file', metadata: { summary: { path: 'test.txt' } } } };
    await page.evaluate(() => { sessionStorage.setItem('lingzhu-live-turn', 'approval-turn'); sessionStorage.setItem('lingzhu-live-session', 'session-0'); });
    await page.reload(); await page.locator('#review').waitFor({ state: 'visible' });
    await page.locator('#review-close').click(); await page.locator('#review').waitFor({ state: 'hidden' });
    await page.waitForTimeout(1600); assert.equal(await page.locator('#review').isVisible(), false);
    await page.locator('#review-open').click(); assert.equal(await page.locator('#review').isVisible(), true);
    await page.getByRole('button', { name: '停止任务' }).click(); await page.getByText('已取消', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  });

  await t.test('task timeline renders backend plan and failed retry action', async () => {
    turn = { id: 'plan-turn', sessionId: 'session-0', status: 'failed', errorCode: 'TEMPORARY_FAILURE', plan: { version: 1, status: 'failed', goal: '整理项目文件', steps: [
      { id: 'understand', label: '理解用户需求', status: 'completed', kind: 'system' },
      { id: 'step-1', label: '读取文件', tool: 'read_file', status: 'failed', errorCode: 'TEMPORARY_FAILURE', errorMessage: '目标文件暂时不可读' },
    ] } };
    await page.route('**/api/turns/plan-turn/retry', async route => route.fulfill({ json: { turnId: 'plan-retry', sessionId: 'session-0', status: 'running' } }));
    await page.route('**/api/turns/plan-retry', async route => route.fulfill({ json: { id: 'plan-retry', sessionId: 'session-0', status: 'running', plan: { version: 1, status: 'running', goal: '整理项目文件', steps: [{ id: 'understand', label: '理解用户需求', status: 'completed' }] } } }));
    await page.evaluate(() => { sessionStorage.setItem('lingzhu-live-turn', 'plan-turn'); sessionStorage.setItem('lingzhu-live-session', 'session-0'); });
    await page.reload();
    await page.locator('.task-plan').waitFor();
    assert.equal(await page.locator('.task-plan-title strong').textContent(), '执行计划');
    assert.match(await page.locator('.task-plan').textContent(), /整理项目文件/);
    assert.equal(await page.locator('.task-plan-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.task-plan-details').isVisible(), false);
    assert.equal(await page.locator('.task-plan-step').first().isVisible(), false);
    await page.getByRole('button', { name: '展开执行计划' }).click();
    assert.equal(await page.locator('.task-plan-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.task-plan-details').isVisible(), true);
    assert.match(await page.locator('.task-plan').textContent(), /读取文件/);
    assert.match(await page.locator('.task-step-error').textContent(), /原因：目标文件暂时不可读/);
    assert.equal(await page.getByRole('button', { name: '重试当前任务' }).isVisible(), true);
    await page.getByRole('button', { name: '重试当前任务' }).click();
    await page.waitForFunction(() => sessionStorage.getItem('lingzhu-live-turn') === 'plan-retry', null, { timeout: 3000 }).catch(async error => {
      const message = await page.locator('#error').textContent();
      throw new Error(`${error.message}; 页面错误：${message}`);
    });
    assert.deepEqual(errors, []);
  });

  await t.test('structured plan is collapsed by default and interrupted plans offer checkpoint recovery', async () => {
    turn = { id: 'structured-turn', sessionId: 'session-0', status: 'interrupted', structuredPlan: { id: 'structured-plan', status: 'interrupted', goal: '创建一个小型项目', phases: [{ id: 'build', title: '实现项目', status: 'running', acceptanceStatus: 'failed', lastErrorMessage: '入口文件内容不匹配', dependsOn: [], acceptance: { type: 'all_steps' } }], steps: [
      { id: 'write', phaseId: 'build', title: '创建入口文件', status: 'interrupted', dependsOn: [], tools: ['write_file'], acceptance: { type: 'file_exists' } },
      { id: 'test', phaseId: 'build', title: '运行测试', status: 'pending', dependsOn: ['write'], tools: ['sandbox_command'], acceptance: { type: 'command_exit_code', exitCode: 0 } },
    ], checkpoints: [{ reason: 'gateway-restarted' }] } };
    let recovered = false;
    await page.route('**/api/turns/structured-turn/recover', async route => { recovered = true; turn.status = 'running'; await route.fulfill({ json: { turnId: 'structured-turn', sessionId: 'session-0', status: 'running' } }); });
    await page.route('**/api/turns/structured-turn', async route => route.fulfill({ json: turn }));
    await page.evaluate(() => { sessionStorage.setItem('lingzhu-live-turn', 'structured-turn'); sessionStorage.setItem('lingzhu-live-session', 'session-0'); });
    await page.reload(); await page.locator('.task-plan-toggle').waitFor();
    assert.equal(await page.locator('.task-plan-details').isVisible(), false);
    assert.match(await page.locator('.task-plan').textContent(), /1 个阶段/);
    await page.getByRole('button', { name: '展开执行计划' }).click();
    assert.match(await page.locator('.task-plan').textContent(), /阶段：实现项目/);
    assert.match(await page.locator('.task-plan').textContent(), /验收：未通过/);
    assert.match(await page.locator('.task-step-error').textContent(), /入口文件内容不匹配/);
    assert.match(await page.locator('.task-plan').textContent(), /依赖/);
    await page.getByRole('button', { name: '从检查点恢复' }).click();
    assert.equal(recovered, true); assert.deepEqual(errors, []);
  });

  await t.test('clarification choices support arrow navigation and Enter', async () => {
    turn = { id: 'clarify-ui', sessionId: 'session-0', status: 'awaiting_clarification', clarification: { question: '请选择要处理的简历', options: [
      { id: 'resume-a', label: '简历 A.pdf', description: '第一份候选文件' },
      { id: 'resume-b', label: '简历 B.pdf', description: '第二份候选文件' },
    ] } };
    await page.route('**/api/turns/clarify-ui/clarify', async route => { turn = { id: 'clarify-ui', sessionId: 'session-0', status: 'completed', plan: { version: 1, status: 'completed', goal: '选择文件', steps: [] } }; await route.fulfill({ json: { turnId: 'clarify-ui', sessionId: 'session-0', status: 'completed', answer: '已处理简历 B.pdf' } }); });
    await page.route('**/api/turns/clarify-ui', async route => route.fulfill({ json: turn }));
    await page.evaluate(() => { sessionStorage.setItem('lingzhu-live-turn', 'clarify-ui'); sessionStorage.setItem('lingzhu-live-session', 'session-0'); });
    await page.reload(); await page.locator('#clarification-dialog').waitFor({ state: 'visible' });
    assert.match(await page.locator('#clarification-question').textContent(), /请选择要处理的简历/);
    const options = page.locator('.clarification-option'); assert.equal(await options.count(), 2); assert.equal(await options.nth(0).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('ArrowDown'); assert.equal(await options.nth(1).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Enter'); await page.locator('#clarification-dialog').waitFor({ state: 'hidden' }); assert.deepEqual(errors, []);
  });
});
