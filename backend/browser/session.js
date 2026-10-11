import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { webUrl } from '../tools/web.js';

const MAX_HTML_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 24_000;
const MAX_LINKS = 80;
const NAVIGATION_TIMEOUT_MS = 20_000;

function cancelled() { return Object.assign(new Error('Browser operation cancelled'), { code: 'CANCELLED' }); }

const TEXT_TYPES = /^(text\/(html|css|javascript|plain)|application\/(javascript|json|xhtml\+xml))(?:;|$)/i;

function safeHeaders(input = {}) {
  const result = {};
  for (const key of ['content-type', 'content-security-policy', 'x-content-type-options', 'access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods']) {
    const value = input[key]; if (typeof value === 'string' && value.length < 4096) result[key] = value;
  }
  result['cache-control'] = 'no-store';
  return result;
}

export class ControlledBrowser {
  constructor({ web, executablePath = null, chromiumApi = chromium, timeoutMs = NAVIGATION_TIMEOUT_MS } = {}) { this.web = web; this.executablePath = executablePath; this.chromium = chromiumApi; this.timeoutMs = timeoutMs; this.browser = null; }

  async status() {
    try {
      const browser = await this.launch();
      await browser.close(); this.browser = null;
      return { available: true, mode: 'isolated-render-only', cookies: 'ephemeral-none', network: 'pre-fetched-html-only', forms: 'blocked', downloads: 'blocked' };
    } catch (error) { return { available: false, code: 'BROWSER_UNAVAILABLE', message: error.message }; }
  }

  async launch() {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = await this.chromium.launch({ headless: true, ...(this.executablePath ? { executablePath: this.executablePath } : {}), args: ['--disable-background-networking', '--disable-sync', '--disable-extensions', '--disable-quic', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE localhost'] });
    return this.browser;
  }

  async render({ url, clickUrl = null, startChar = 0, maxChars = MAX_TEXT_CHARS, signal, requestOptions = {}, web = this.web } = {}) {
    const source = webUrl(url);
    const linkTarget = clickUrl === null ? null : webUrl(clickUrl);
    if (linkTarget && linkTarget.origin !== source.origin)
      throw Object.assign(new Error('Only same-origin links can be followed'), { code: 'BROWSER_CROSS_ORIGIN_ACTION' });
    if (!web) throw Object.assign(new Error('Controlled web transport unavailable'), { code: 'BROWSER_UNAVAILABLE' });
    if (!Number.isSafeInteger(startChar) || startChar < 0 || startChar > 1_048_576 ||
        !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > MAX_TEXT_CHARS)
      throw Object.assign(new Error('Browser output range is invalid'), { code: 'BROWSER_RANGE_INVALID' });
    const browser = await this.launch(); const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', javaScriptEnabled: true, ignoreHTTPSErrors: false });
    if (signal?.aborted) {
      await context.close().catch(() => {});
      throw cancelled();
    }
    const page = await context.newPage(); const controller = new AbortController(); const cancel = () => controller.abort(cancelled());
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('Browser navigation timed out'), { code: 'BROWSER_TIMEOUT' })), this.timeoutMs); timer.unref?.();
    let mainPage = null;
    let requestError = null;
    try {
      await context.route('**/*', async route => {
        const request = route.request();
        if (request.frame() !== page.mainFrame()) return route.abort('blockedbyclient');
        if (mainPage && new URL(request.url()).origin !== new URL(mainPage.url).origin) return route.abort('blockedbyclient');
        if (request.method() !== 'GET' || !['document', 'script', 'stylesheet', 'xhr', 'fetch', 'other'].includes(request.resourceType())) return route.abort('blockedbyclient');
        let target;
        try { target = webUrl(request.url()); } catch { return route.abort('blockedbyclient'); }
        try {
          const isApprovedAction = request.isNavigationRequest() && request.url() === requestOptions.actionUrl;
          const response = await web.request(target, { ...requestOptions, signal: controller.signal,
            ...(isApprovedAction ? { details: { ...requestOptions.details, action: 'follow_link' } } : {}) });
          const type = response.headers['content-type'] ?? '';
          if (!TEXT_TYPES.test(type) || Buffer.byteLength(response.body) > MAX_HTML_BYTES) return route.abort('blockedbyclient');
          let body = response.body;
          if (request.isNavigationRequest()) {
            if (!/^text\/html(?:;|$)/i.test(type)) return route.fulfill({ status: 415, contentType: 'text/plain', body: 'Unsupported browser document type' });
            mainPage = { url: response.url ?? target.href, contentType: type };
            const base = `<base href="${String(mainPage.url).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`;
            body = /<head\b[^>]*>/i.test(body) ? body.replace(/<head\b[^>]*>/i, match => `${match}${base}`) : `${base}${body}`;
          }
          return route.fulfill({ status: 200, headers: safeHeaders(response.headers), body });
        } catch (error) {
          if (request.isNavigationRequest() || ['APPROVAL_REQUIRED', 'WEB_ACCESS_DENIED', 'BROWSER_CROSS_ORIGIN_REDIRECT'].includes(error?.code)) requestError ??= error;
          if (controller.signal.aborted) await route.abort('timedout').catch(() => {}); else await route.abort('failed').catch(() => {});
        }
      });
      if (typeof page.routeWebSocket === 'function') await page.routeWebSocket('**/*', socket => socket.close({ code: 1008, reason: 'WebSocket access is blocked' }));
      page.on('download', download => { void download.cancel().catch(() => {}); });
      const closePopup = popup => { void popup.close().catch(() => {}); };
      context.on('page', popup => { if (popup !== page) closePopup(popup); });
      await page.addInitScript(() => {
        const deny = event => { event.preventDefault(); event.stopImmediatePropagation(); };
        addEventListener('submit', deny, true); addEventListener('formdata', deny, true);
        for (const method of ['open']) window[method] = () => null;
      });
      controller.signal.throwIfAborted();
      try { await page.goto(source.href, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs }); }
      catch (error) { if (requestError) throw requestError; throw error; }
      if (requestError) throw requestError;
      await page.waitForTimeout(500);
      controller.signal.throwIfAborted();
      if (!mainPage) throw Object.assign(new Error('Browser navigation did not produce an HTML page'), { code: 'BROWSER_NAVIGATION_FAILED' });
      if (linkTarget) {
        const exists = await page.locator('a[href]').evaluateAll((anchors, target) => anchors.some(item => item.href === target), linkTarget.href);
        if (!exists) throw Object.assign(new Error('The requested same-origin link is not present on the page'), { code: 'BROWSER_LINK_NOT_FOUND' });
        await page.goto(linkTarget.href, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
        controller.signal.throwIfAborted();
        if (requestError) throw requestError;
        if (new URL(page.url()).origin !== source.origin)
          throw Object.assign(new Error('The link navigated outside its approved origin'), { code: 'BROWSER_CROSS_ORIGIN_ACTION' });
      }
      const result = await page.evaluate(({ maxChars, maxLinks, sourceUrl, offset }) => {
        const clean = value => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ').trim();
        const title = clean(document.title).slice(0, 300);
        const wholeText = clean(document.body?.innerText ?? '');
        const text = wholeText.slice(offset, offset + maxChars);
        const links = Array.from(document.querySelectorAll('a[href]')).slice(0, maxLinks).flatMap(anchor => {
          try { const target = new URL(anchor.href, sourceUrl); if (!['http:', 'https:'].includes(target.protocol)) return []; return [{ text: clean(anchor.innerText).slice(0, 300), url: target.href }]; }
          catch { return []; }
        });
        const forms = Array.from(document.forms).slice(0, 20).map(form => ({ method: clean(form.method || 'get').toLowerCase(), action: clean(form.action || sourceUrl) }));
        return { title, text, links, forms, startChar: offset, nextStartChar: offset + maxChars < wholeText.length ? offset + maxChars : null, totalChars: wholeText.length, truncated: wholeText.length > maxChars, untrusted: true };
      }, { maxChars, maxLinks: MAX_LINKS, sourceUrl: mainPage.url, offset: startChar });
      return { source: mainPage.url, ...(linkTarget ? { action: { type: 'follow_link', url: linkTarget.href } } : {}), ...result };
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); await context.close().catch(() => {}); }
  }

  async close() { const browser = this.browser; this.browser = null; await browser?.close().catch(() => {}); }
}

export async function createControlledBrowser({ chromiumApi = chromium, executablePath = null, platform = process.platform, env = process.env } = {}) {
  let executable = executablePath;
  if (!executable && platform === 'win32') {
    const candidates = [
      path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    executable = candidates.find(candidate => existsSync(candidate)) ?? null;
  }
  try {
    const browser = new ControlledBrowser({ chromiumApi, executablePath: executable });
    const status = await browser.status();
    if (!status.available) return { browser: null, status };
    return { browser, status: { ...status, engine: executable ? 'Microsoft Edge (Playwright)' : 'Playwright Chromium' } };
  } catch (error) { return { browser: null, status: { available: false, code: 'BROWSER_UNAVAILABLE', message: error.message } }; }
}

export const browserLimits = Object.freeze({ maxDocumentBytes: MAX_HTML_BYTES, maxTextChars: MAX_TEXT_CHARS, maxLinks: MAX_LINKS, timeoutMs: NAVIGATION_TIMEOUT_MS });
