import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveBudget } from './context/budget.js';
import { SecretStore } from './secrets/store.js';
import { normalizeProviderConfig, capabilitySnapshot } from './providers/registry.js';

export function endpointFor({ url, fullUrl }) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.hash) throw new Error('请求地址不能包含用户信息或片段');
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
    throw new Error('仅支持 HTTPS；本地 localhost 可使用 HTTP');
  }
  if (!fullUrl && (parsed.search || parsed.pathname.endsWith('/chat/completions'))) {
    throw new Error('基础地址应填写 API 根路径；完整地址请打开「完整 URL」');
  }
  return fullUrl ? parsed.href : new URL('chat/completions', `${parsed.href.replace(/\/+$/, '')}/`).href;
}

export function reasoningProfile(item = {}) {
  const haystack = `${item.provider ?? ''} ${item.model ?? ''} ${item.url ?? ''}`.toLowerCase();
  if (item.reasoningProtocol === 'deepseek' || /deepseek/.test(haystack)) {
    return { protocol: 'deepseek', label: 'DeepSeek 思考强度', options: [{ value: 'default', label: '模型默认' }, { value: 'none', label: '关闭（none）' }, { value: 'low', label: '低（low）' }, { value: 'high', label: '高（high）' }, { value: 'max', label: '最高（max）' }] };
  }
  if (item.reasoningProtocol === 'openai' || /(^|[^a-z])o[134](?:-|_|$)|gpt-[56](?:-|\.|$)/.test(haystack)) {
    return { protocol: 'openai', label: 'OpenAI 推理强度', options: [{ value: 'default', label: '模型默认' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }] };
  }
  return { protocol: 'none', label: '未确认思考控制', options: [{ value: 'default', label: '模型默认' }] };
}

async function readLimited(response, limit = 1024 * 1024) {
  const text = await response.text();
  if (text.length > limit) throw new Error('响应过大');
  return text;
}

export async function testModelConnection(item, timeoutMs = 20_000) {
  if (!item.apiKey && item.auth !== 'none' && item.provider !== 'ollama') throw Object.assign(new Error('请先配置 API Key'), { code: 'CONFIG' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('连接测试超时'), { code: 'TIMEOUT' })), timeoutMs);
  const started = performance.now();
  try {
    let response;
    try {
      response = await fetch(endpointFor(item), { method: 'POST', headers: { ...(item.apiKey ? { Authorization: `Bearer ${item.apiKey}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify({ model: item.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8 }), signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    }
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('服务商请求失败'), { status: response.status }); }
    let result;
    try { result = JSON.parse(await readLimited(response)); } catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw error; }
    if (!result?.choices?.[0]?.message) throw new Error('服务返回的格式不是 Chat Completions');
    return { ok: true, code: 'OK', elapsedMs: Math.round(performance.now() - started) };
  } finally { clearTimeout(timer); }
}

export function modelConnectionError(error) {
  if (error?.name === 'TimeoutError' || error?.code === 'TIMEOUT') return { code: 'TIMEOUT', message: '连接超时，请检查地址、网络或服务端响应速度' };
  if (error?.name === 'TypeError') return { code: 'NETWORK', message: '无法连接到请求地址，请检查地址和网络' };
  if (error?.status === 401 || error?.status === 403) return { code: 'AUTH', message: `鉴权失败（HTTP ${error.status}），请检查 API Key` };
  if (error?.status === 400 || error?.status === 404) return { code: 'MODEL_OR_ENDPOINT', message: `请求参数、地址或模型 ID 无效（HTTP ${error.status}），请核对服务商文档` };
  if (error?.status === 429) return { code: 'RATE_LIMIT', message: '服务商限流（HTTP 429），请稍后重试' };
  if (error?.status >= 500) return { code: 'PROVIDER', message: `服务商暂时不可用（HTTP ${error.status}）` };
  if (error?.code === 'CONFIG') return { code: 'CONFIG', message: '请先配置 API Key' };
  return { code: 'INVALID_RESPONSE', message: '服务返回格式不符合 OpenAI Chat Completions，请检查接口协议' };
}

function validate(input, existing) {
  const name = String(input.name ?? '').trim();
  const model = String(input.model ?? '').trim();
  const url = String(input.url ?? '').trim();
  const fullUrl = input.fullUrl === true;
  const streaming = input.streaming === undefined ? existing?.streaming !== false : input.streaming === true;
  const contextWindow = input.contextWindow === undefined ? existing?.contextWindow : Number(input.contextWindow);
  const outputReserve = input.outputReserve === undefined ? existing?.outputReserve : Number(input.outputReserve);
  const reasoningEffort = input.reasoningEffort === undefined ? existing?.reasoningEffort : String(input.reasoningEffort);
  const reasoningProtocol = input.reasoningProtocol === undefined ? existing?.reasoningProtocol : String(input.reasoningProtocol);
  if (!name || name.length > 80 || !model || model.length > 160 || !url || url.length > 2000) {
    throw new Error('名称、模型 ID 和请求地址均为必填项，且不能过长');
  }
  endpointFor({ url, fullUrl });
  resolveBudget({ contextWindow, outputReserve });
  if (reasoningProtocol !== undefined && !['auto', 'openai', 'deepseek', 'none'].includes(reasoningProtocol)) {
    throw new Error('思考参数协议无效');
  }
  if (reasoningEffort !== undefined && !['default', 'auto', 'enabled', 'disabled', 'none', 'low', 'medium', 'high', 'max', 'minimal', 'xhigh'].includes(reasoningEffort)) {
    throw new Error('思考挡位无效，请按模型支持的选项选择');
  }
  const provider = input.provider ?? existing?.provider ?? 'openai-compatible';
  const auth = input.auth ?? existing?.auth ?? (provider === 'ollama' ? 'none' : 'api-key');
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096)) {
    throw new Error('API Key 格式无效');
  }
  return { id: existing?.id ?? randomUUID(), name, model, url, fullUrl, streaming, provider, auth,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(outputReserve === undefined ? {} : { outputReserve }),
    ...(reasoningEffort === undefined || reasoningEffort === 'auto' ? {} : { reasoningEffort }),
    ...(reasoningProtocol === undefined || reasoningProtocol === 'auto' ? {} : { reasoningProtocol }),
    ...(input.capabilities || existing?.capabilities ? { capabilities: input.capabilities ?? existing.capabilities } : {}),
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : existing?.apiKey !== undefined ? { apiKey: existing.apiKey } : {}),
    ...(input.secretRef !== undefined ? { secretRef: input.secretRef } : existing?.secretRef ? { secretRef: existing.secretRef } : {}) };
}

export class Models {
  constructor(root, { secrets = new SecretStore(root) } = {}) {
    this.dir = path.join(root, '.agent-data');
    this.file = path.join(this.dir, 'models.json');
    this.secrets = secrets;
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      let migrated = false;
      for (const item of data.items ?? []) {
        if (!item.apiKey) continue;
        const secretRef = item.secretRef || `secret://provider.${item.id}`;
        await this.secrets.set(secretRef.slice('secret://'.length), item.apiKey);
        item.secretRef = secretRef;
        delete item.apiKey;
        migrated = true;
      }
      if (migrated) await this.write(data);
      return data;
    }
    catch (error) {
      if (error.code === 'ENOENT') return { selectedId: null, items: [] };
      throw error;
    }
  }

  async save(data) {
    await this.write(data);
  }

  async write(data) {
    await mkdir(this.dir, { recursive: true });
    const temp = path.join(this.dir, `${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.file);
  }

  public(data) {
    return { selectedId: data.selectedId, items: data.items.map(({ apiKey, secretRef, ...item }) => ({ ...item, reasoningProfile: reasoningProfile(item), hasKey: Boolean(secretRef || apiKey) })) };
  }

  async list() { return this.public(await this.load()); }

  async upsert(input, id) {
    const data = await this.load();
    const index = id ? data.items.findIndex(item => item.id === id) : -1;
    if (id && index < 0) throw new Error('模型不存在');
    const existing = data.items[index];
    const item = validate(input, existing);
    const suppliedKey = input.apiKey;
    if (suppliedKey !== undefined && suppliedKey !== '') {
      const secretRef = input.secretRef || `secret://provider.${item.id}`;
      await this.secrets.set(secretRef.slice('secret://'.length), suppliedKey);
      if (await this.secrets.resolve(secretRef) !== suppliedKey) {
        throw Object.assign(new Error('模型密钥保存后校验失败，配置未更新。'), { code: 'MODEL_SECRET_UNAVAILABLE' });
      }
      delete item.apiKey;
      item.secretRef = secretRef;
    } else if (suppliedKey === '' && !existing?.secretRef) {
      item.secretRef = undefined;
      delete item.apiKey;
    } else if (existing?.secretRef) {
      item.secretRef = existing.secretRef;
      delete item.apiKey;
    } else if (existing?.apiKey) {
      const secretRef = `secret://provider.${item.id}`;
      await this.secrets.set(secretRef.slice('secret://'.length), existing.apiKey);
      item.secretRef = secretRef;
      delete item.apiKey;
    }
    delete item.apiKey;
    normalizeProviderConfig(item);
    if (index < 0) data.items.push(item);
    else data.items[index] = item;
    data.selectedId ??= item.id;
    await this.save(data);
    return this.public(data);
  }

  async select(id) {
    const data = await this.load();
    if (!data.items.some(item => item.id === id)) throw new Error('模型不存在');
    data.selectedId = id;
    await this.save(data);
    return this.public(data);
  }

  async remove(id) {
    const data = await this.load();
    if (!data.items.some(item => item.id === id)) throw new Error('模型不存在');
    data.items = data.items.filter(item => item.id !== id);
    if (data.selectedId === id) data.selectedId = data.items[0]?.id ?? null;
    await this.save(data);
    return this.public(data);
  }

  async get(id) {
    const data = await this.load();
    const item = data.items.find(item => item.id === (id ?? data.selectedId));
    if (!item) return item;
    const result = { ...item };
    if (result.secretRef) {
      try {
        result.apiKey = await this.secrets.resolve(result.secretRef);
        if (!result.apiKey) throw new Error('Missing model secret');
      } catch {
        throw Object.assign(new Error('已保存的模型密钥无法读取或解密，请在模型配置页重新保存 API Key，并测试已保存连接。'), { code: 'MODEL_SECRET_UNAVAILABLE' });
      }
    }
    return result;
  }

  async capabilities(id) {
    const item = await this.get(id);
    if (!item) return null;
    return { provider: item.provider ?? 'openai-compatible', model: item.model, capabilities: item.capabilities ?? {}, testedAt: item.capabilitiesTestedAt ?? null };
  }

  async preview(input, id) {
    const data = await this.load();
    const existing = id ? data.items.find(item => item.id === id) : undefined;
    if (id && !existing) throw new Error('模型不存在');
    return validate(input, existing);
  }
}
