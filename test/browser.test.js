import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlledBrowser, createControlledBrowser, browserLimits } from '../backend/browser/session.js';
import { WebTools } from '../backend/tools/web.js';

function fakeBrowserHarness() {
  const state = { launchOptions: null, contextOptions: null, routeHandler: null, wsHandler: null, pageOptions: [], closed: 0, goto: null };
  const mainFrame = {};
  state.mainFrame = mainFrame;
  const page = {
    async route(_pattern, handler) { state.routeHandler = handler; },
    async routeWebSocket(_pattern, handler) { state.wsHandler = handler; },
    async addInitScript() {}, on() {},
    mainFrame() { return mainFrame; },
    async goto(url, options) { state.goto = { url, options }; const route = { request: () => ({ frame: () => page.mainFrame(), method: () => 'GET', resourceType: () => 'document', isNavigationRequest: () => true, url: () => url }), async fulfill(value) { state.pageOptions.push(value); }, async abort(reason) { state.aborted = reason; } }; await state.routeHandler(route); },
    async waitForTimeout() {},
    async evaluate(_fn, args) { return state.evalResult ?? { title: 'Fixture', text: `page ${args.offset}`, links: [], forms: [{ method: 'post', action: args.sourceUrl }], startChar: args.offset, nextStartChar: 10, totalChars: 20, truncated: true, untrusted: true }; },
  };
  const context = { async newPage() { return page; }, async route(_pattern, handler) { state.routeHandler = handler; }, on() {}, async close() { state.closed++; } };
  const browser = { isConnected: () => true, async newContext(options) { state.contextOptions = options; return context; }, async close() { state.browserClosed = true; } };
  const chromiumApi = { async launch(options) { state.launchOptions = options; return browser; } };
  return { state, chromiumApi };
}

test('controlled browser routes requests through approved public transport and blocks side effects', async () => {
  const { state, chromiumApi } = fakeBrowserHarness(); const requests = [];
  const web = { async request(url, options) { requests.push({ href: url.href, options }); return { url: url.href, headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'blocked=1' }, body: '<html><head><title>Fixture</title></head><body>Hello</body></html>' }; } };
  const browser = new ControlledBrowser({ web, chromiumApi });
  const result = await browser.render({ url: 'https://example.com/page', startChar: 10, requestOptions: { details: { tool: 'browser_open' } } });
  assert.equal(result.title, 'Fixture'); assert.equal(result.text, 'page 10'); assert.equal(result.nextStartChar, 10); assert.equal(result.untrusted, true);
  assert.equal(requests.length, 1); assert.equal(requests[0].options.details.tool, 'browser_open');
  assert.deepEqual(state.contextOptions, { acceptDownloads: false, serviceWorkers: 'block', javaScriptEnabled: true, ignoreHTTPSErrors: false });
  assert.equal(Object.hasOwn(state.pageOptions[0].headers, 'set-cookie'), false); assert.equal(state.pageOptions[0].headers['cache-control'], 'no-store');
  assert.equal(state.closed, 1); assert.equal(result.forms[0].method, 'post'); assert.equal(browserLimits.maxLinks, 80);
  const ws = { close(value) { state.wsClosed = value; } }; state.wsHandler(ws); assert.equal(state.wsClosed.code, 1008);
  const blocked = { request: () => ({ frame: () => state.mainFrame, method: () => 'POST', resourceType: () => 'document', isNavigationRequest: () => true, url: () => 'https://example.com/form' }), async abort(reason) { state.blockReason = reason; }, async fulfill() { assert.fail('non-GET request fulfilled'); } };
  await state.routeHandler(blocked); assert.equal(state.blockReason, 'blockedbyclient');
  await browser.close(); assert.equal(state.browserClosed, true);
});

test('controlled browser uses turn-scoped transport, bounds output and fails on cross-origin redirects', async () => {
  const { state, chromiumApi } = fakeBrowserHarness();
  const approvals = [];
  const web = new WebTools({ browser: new ControlledBrowser({ chromiumApi }), approve: async details => { approvals.push(details); return true; }, resolver: async () => [{ address: '93.184.216.34', family: 4 }], transport: async url => ({ status: 200, url: url.href, headers: { 'content-type': 'text/html' }, body: '<html><head><title>Live</title></head><body>Rendered</body></html>' }) });
  state.evalResult = { title: 'Live', text: 'Rendered', links: [], forms: [], startChar: 0, nextStartChar: null, totalChars: 8, truncated: false, untrusted: true };
  web.browser.web = web;
  const turnWeb = web.forTurn({ approve: async details => { approvals.push({ ...details, source: 'turn' }); return true; } });
  turnWeb.browser = web.browser;
  const result = await turnWeb.openBrowser({ url: 'https://example.com/' });
  assert.equal(result.title, 'Live');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].source, 'turn');
  assert.equal(state.closed, 1);
  assert.equal(turnWeb.browser.web, web);

  const redirects = new WebTools({ approve: async () => true, resolver: async () => [{ address: '93.184.216.34', family: 4 }], transport: async () => ({ status: 302, headers: { location: 'https://other.example/path' }, body: '' }) }).forTurn();
  await assert.rejects(redirects.request(new URL('https://example.com/'), { signal: new AbortController().signal }), { code: 'BROWSER_CROSS_ORIGIN_REDIRECT' });
});

test('controlled browser rejects local targets before launch and closes context on abort', async () => {
  const { state, chromiumApi } = fakeBrowserHarness(); const web = { async request() { throw Object.assign(new Error('denied'), { code: 'WEB_ACCESS_DENIED' }); } };
  const browser = new ControlledBrowser({ web, chromiumApi });
  await assert.rejects(browser.render({ url: 'http://127.0.0.1' }), { code: 'WEB_ACCESS_DENIED' });
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(browser.render({ url: 'https://example.com', signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(state.closed, 1);
});

test('browser action rejects cross-origin targets before opening a page context', async () => {
  const { state, chromiumApi } = fakeBrowserHarness();
  const browser = new ControlledBrowser({ web: { async request() { assert.fail('no network request expected'); } }, chromiumApi });
  await assert.rejects(browser.render({ url: 'https://example.com/', clickUrl: 'https://other.example/' }), { code: 'BROWSER_CROSS_ORIGIN_ACTION' });
  assert.equal(state.contextOptions, null);
});

test('browser probe reports unavailable without a launchable engine', async () => {
  const result = await createControlledBrowser({ platform: 'linux', chromiumApi: { launch: async () => { throw new Error('missing browser'); } } });
  assert.equal(result.browser, null); assert.equal(result.status.available, false); assert.equal(result.status.code, 'BROWSER_UNAVAILABLE');
});

test('installed browser executes same-origin JavaScript and returns bounded rendered text', async t => {
  const result = await createControlledBrowser();
  if (!result.status.available) { t.skip(`No managed browser engine available: ${result.status.code}`); return; }
  const requests = [];
  result.browser.web = { async request(url) {
    requests.push(url.href);
    const body = url.pathname === '/'
      ? '<!doctype html><html><head><title>Render fixture</title><script src="/app.js"></script></head><body><main id="app">Loading</main><a href="https://example.com/next">Next</a></body></html>'
      : url.pathname === '/app.js'
        ? 'document.addEventListener("DOMContentLoaded", () => { document.querySelector("#app").textContent = "JavaScript rendered successfully"; });'
        : '<!doctype html><html><head><title>Next page</title></head><body><main>Destination rendered</main></body></html>';
    return { url: url.href, status: 200, headers: { 'content-type': url.pathname === '/app.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' }, body };
  } };
  try {
    const page = await result.browser.render({ url: 'https://example.com/', maxChars: 100 });
    assert.equal(page.title, 'Render fixture');
    assert.match(page.text, /JavaScript rendered successfully/);
    assert.deepEqual(requests, ['https://example.com/', 'https://example.com/app.js']);
    assert.equal(page.untrusted, true);
    assert.equal(page.truncated, false);
    requests.length = 0;
    const followed = await result.browser.render({ url: 'https://example.com/', clickUrl: 'https://example.com/next', maxChars: 100,
      web: result.browser.web, requestOptions: { details: { tool: 'browser_open' }, operationGrants: new Set(['https://example.com']), sameOrigin: 'https://example.com', actionUrl: 'https://example.com/next' } });
    assert.equal(followed.title, 'Next page', JSON.stringify({ followed, requests }));
    assert.equal(followed.action.type, 'follow_link');
    assert.ok(requests.includes('https://example.com/next'));
  } finally { await result.browser.close(); }
});
