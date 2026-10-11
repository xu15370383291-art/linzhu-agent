import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ControlledBrowser } from '../browser/session.js';

const fail = message => Object.assign(new Error(message), { code: 'WEB_ACCESS_DENIED' });
const MAX_BYTES = 1024 * 1024;
const clean = text => String(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\x1b/g, '');

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2 || b === 88 && c === 99) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  // Only global unicast IPv6; exclude transition, documentation and special ranges.
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    const first = Number.parseInt(normalized.split(':')[0], 16);
    const second = Number.parseInt(normalized.split(':')[1] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
      !/^2002:/.test(normalized) && !/^3fff:/.test(normalized);
  }
  return false;
}

export function webUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) throw fail('Invalid web URL');
  let url;
  try { url = new URL(value); } catch { throw fail('Invalid web URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port)
    throw fail('Only HTTP/HTTPS default ports without URL credentials are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.endsWith('.') || host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !isIP(host))
    throw fail('Local and internal hostnames are blocked');
  if (isIP(host) && !publicAddress(host)) throw fail('Nonpublic IP addresses are blocked');
  url.hash = '';
  return url;
}

export async function resolvePublic(url, resolver = lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolver(host, { all: true, verbatim: true });
  if (!answers.length || answers.some(answer => !publicAddress(answer.address))) throw fail('DNS resolved to a nonpublic address');
  return answers[0];
}

// The socket connects to the validated IP while TLS verifies the original hostname.
export function pinnedRequest(url, address, { signal, headers = {}, maxBytes = MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal, agent: false, maxHeaderSize: 16384,
      headers: { 'User-Agent': 'PersonalAgent/0.1', Accept: 'text/html, text/plain, application/json', 'Accept-Encoding': 'identity', ...headers },
      lookup: (_host, options, callback) => callback(null, ...(options.all ? [[address]] : [address.address, address.family])),
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('error', error => finish(error));
      response.on('aborted', () => finish(new Error('Web response was interrupted')));
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy();
        finish(null, { status: response.statusCode, headers: response.headers, body: '' });
        return;
      }
      if (Number(response.headers['content-length']) > maxBytes) {
        finish(new Error('Web response exceeds download limit'));
        response.destroy();
        return;
      }
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { finish(new Error('Web response exceeds download limit')); response.destroy(); }
        else chunks.push(chunk);
      });
      response.on('end', () => finish(null, { status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', error => finish(error));
    request.setTimeout(10000, () => request.destroy(new Error('Web socket timeout')));
  });
}

function entities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, name) => {
    if (name[0] !== '#') return named[name.toLowerCase()];
    const code = Number.parseInt(name.slice(name[1].toLowerCase() === 'x' ? 2 : 1), name[1].toLowerCase() === 'x' ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

export function extractPage(body, contentType) {
  if (!/^(text\/(html|plain)|application\/(json|xhtml\+xml))(?:;|$)/i.test(contentType))
    throw new Error('Unsupported content type; only HTML, UTF-8 text and JSON are supported');
  if (/charset\s*=\s*["']?(?!utf-8\b|utf8\b|us-ascii\b)[\w-]+/i.test(contentType))
    throw new Error('Unsupported charset; use a UTF-8 page');
  if (!/html/i.test(contentType)) return { title: '', text: clean(body) };
  const title = entities(body.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]?.replace(/<[^>]*>/g, '') ?? '');
  const text = entities(body.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/(?:p|div|h[1-6]|li|section|article|tr)\s*>|<br\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n')).trim();
  return { title: clean(title).slice(0, 300), text: clean(text) };
}

export class WebTools {
  constructor({ approve = async () => false, searchKey = process.env.BRAVE_SEARCH_API_KEY,
    resolver = lookup, transport = pinnedRequest, timeoutMs = 20000, runTask = action => action(), browser = null, sameOriginOnly = false } = {}) {
    this.approve = approve;
    this.searchKey = searchKey;
    this.resolver = resolver;
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.runTask = runTask;
    this.grants = new Set();
    this.browser = browser;
    this.sameOriginOnly = sameOriginOnly;
  }

  clearGrants() { this.grants.clear(); }

  forTurn({ approve = this.approve } = {}) {
    return new WebTools({ approve, searchKey: this.searchKey, resolver: this.resolver, transport: this.transport,
      timeoutMs: this.timeoutMs, runTask: this.runTask, browser: this.browser, sameOriginOnly: true });
  }

  async openBrowser(args, signal) {
    if (!this.browser) throw Object.assign(new Error('Controlled browser is unavailable'), { code: 'BROWSER_UNAVAILABLE' });
    const requested = webUrl(args.url);
    const clickUrl = args.targetUrl === undefined ? null : webUrl(args.targetUrl).href;
    if (clickUrl && new URL(clickUrl).origin !== requested.origin)
      throw Object.assign(new Error('Only same-origin links can be followed'), { code: 'BROWSER_CROSS_ORIGIN_ACTION' });
    const approved = await this.approve({ tool: 'browser_open', url: requested.href, origin: requested.origin,
      ...(clickUrl ? { action: 'follow_link', targetUrl: clickUrl, targetOrigin: new URL(clickUrl).origin } : {}), signal });
    signal?.throwIfAborted();
    if (approved !== true && approved !== 'session') throw Object.assign(new Error('The user denied this browser operation'), { code: 'USER_DENIED' });
    const operationGrants = new Set([requested.origin, ...(clickUrl ? [new URL(clickUrl).origin] : [])]);
    return this.browser.render({ url: requested.href, clickUrl, startChar: args.startChar ?? 0, signal, maxChars: 12_000,
      web: this, requestOptions: { details: { tool: 'browser_open' }, operationGrants, actionUrl: clickUrl, sameOrigin: requested.origin } });
  }

  async authorize(url, details, signal, operationGrants = null) {
    signal?.throwIfAborted();
    if (this.grants.has(url.origin) || operationGrants?.has(url.origin)) return;
    const answer = await this.approve({ origin: url.origin, url: url.href, ...details, signal });
    signal?.throwIfAborted();
    if (answer !== true && answer !== 'session') throw Object.assign(new Error('The user denied this network request'), { code: 'USER_DENIED' });
    if (answer === 'session') this.grants.add(url.origin);
    else operationGrants?.add(url.origin);
  }

  async request(url, { signal, headers, redirects = true, details = {}, operationGrants = null, sameOrigin = null } = {}) {
    sameOrigin ??= this.sameOriginOnly ? url.origin : null;
    let remaining = this.timeoutMs;
    const network = async (stage, action) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(Object.assign(new Error(`Web ${stage} timed out`), { name: 'TimeoutError' })), Math.max(0, remaining));
      const started = performance.now();
      try {
        return await this.runTask(taskSignal => {
          const activeSignal = AbortSignal.any([signal, controller.signal, ...(taskSignal ? [taskSignal] : [])]);
          activeSignal.throwIfAborted();
          return abortable(action(activeSignal), activeSignal);
        });
      } finally { clearTimeout(timer); remaining -= performance.now() - started; }
    };
    for (let hop = 0; hop <= 5; hop++) {
      signal.throwIfAborted();
      if (sameOrigin && url.origin !== sameOrigin) throw Object.assign(new Error('Cross-origin browser redirects are blocked'), { code: 'BROWSER_CROSS_ORIGIN_REDIRECT' });
      const address = await network('DNS resolution', () => resolvePublic(url, this.resolver));
      await this.authorize(url, details, signal, operationGrants);
      const response = await network('download', activeSignal => this.transport(url, address, { signal: activeSignal, headers }));
      if (response.status >= 300 && response.status < 400) {
        if (!redirects || !response.headers.location || hop === 5) throw new Error('Web redirect blocked or redirect limit reached');
        const next = webUrl(new URL(response.headers.location, url).href);
        if (url.protocol === 'https:' && next.protocol === 'http:') throw fail('HTTPS downgrade redirects are blocked');
        if (sameOrigin && next.origin !== sameOrigin) throw Object.assign(new Error('Cross-origin browser redirects are blocked'), { code: 'BROWSER_CROSS_ORIGIN_REDIRECT' });
        url = next;
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`Web HTTP ${response.status}`);
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('Compressed responses are unsupported');
      if (Buffer.byteLength(response.body) > MAX_BYTES) throw new Error('Web response exceeds download limit');
      return { ...response, url: url.href };
    }
  }

  async execute(name, args, parentSignal) {
    const signal = parentSignal ?? new AbortController().signal;
    signal.throwIfAborted();
    if (name === 'web_fetch') {
      const response = await this.request(webUrl(args.url), { signal, details: { tool: name } });
      const page = extractPage(response.body, response.headers['content-type'] ?? '');
      const start = args.startChar ?? 0;
      if (start > page.text.length) throw new Error('startChar is beyond the page content');
      return { source: response.url, title: page.title, text: page.text.slice(start, start + 12000), startChar: start,
        nextStartChar: start + 12000 < page.text.length ? start + 12000 : null, totalChars: page.text.length, untrusted: true };
    }
    if (name !== 'web_search') throw new Error('Unknown web tool');
    if (!this.searchKey) throw new Error('Search is not configured: set BRAVE_SEARCH_API_KEY before starting the Agent');
    const url = webUrl('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', args.query);
    url.searchParams.set('count', String(args.count ?? 5));
    const response = await this.request(url, { signal, redirects: false,
      headers: { 'X-Subscription-Token': this.searchKey, Accept: 'application/json' }, details: { tool: name, query: args.query } });
    let data;
    try { data = JSON.parse(response.body); } catch { throw new Error('Search provider returned invalid JSON'); }
    if (!Array.isArray(data.web?.results)) throw new Error('Search provider returned an invalid result shape');
    const results = data.web.results.slice(0, args.count ?? 5).flatMap(item => {
      try {
        const source = webUrl(item.url).href;
        return [{ title: clean(String(item.title ?? '')).slice(0, 300), url: source,
          description: extractPage(String(item.description ?? ''), 'text/html').text.slice(0, 1500) }];
      } catch { return []; }
    });
    return { query: args.query, provider: 'Brave', results, untrusted: true };
  }
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
