import { normalizeVector } from './semantic.js';

const MAX_INPUT_CHARS = 8000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;

function invalid(message) { return Object.assign(new Error(message), { code: 'EMBEDDING_CONFIG_INVALID' }); }

async function boundedText(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw Object.assign(new Error('Embedding response exceeds size limit'), { code: 'EMBEDDING_RESPONSE_TOO_LARGE' });
    return text;
  }
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw Object.assign(new Error('Embedding response exceeds size limit'), { code: 'EMBEDDING_RESPONSE_TOO_LARGE' }); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(data);
}

export function validateEmbeddingSettings(input) {
  if (!input || input.provider !== 'ollama') throw invalid('Only local Ollama embeddings are supported');
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 160) throw invalid('Invalid embedding model');
  let url;
  try { url = new URL(input.baseUrl); } catch { throw invalid('Invalid embedding base URL'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(host) || url.username || url.password || url.hash || url.search || url.port !== '11434')
    throw invalid('Embeddings are restricted to the local Ollama service');
  return { provider: 'ollama', model: input.model.trim(), baseUrl: url.href.replace(/\/+$/, ''), allowSensitive: false,
    dimensions: Number.isSafeInteger(input.dimensions) && input.dimensions > 0 && input.dimensions <= 8192 ? input.dimensions : null };
}

export function createEmbeddingProvider(settings, { fetchImpl = fetch } = {}) {
  const config = validateEmbeddingSettings(settings);
  return Object.freeze({
    provider: 'ollama', model: config.model, dimensions: config.dimensions, external: false, allowSensitive: config.allowSensitive,
    async embed(text, { signal } = {}) {
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_INPUT_CHARS) throw Object.assign(new Error('Embedding input is empty or too large'), { code: 'EMBEDDING_INPUT_INVALID' });
      if (signal?.aborted) throw Object.assign(new Error('Local embedding request cancelled'), { code: 'CANCELLED' });
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), TIMEOUT_MS); timer.unref?.();
      const onAbort = () => controller.abort(signal.reason); signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await fetchImpl(`${config.baseUrl}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ model: config.model, input: text }), signal: controller.signal, redirect: 'error' });
        if (!response.ok) throw Object.assign(new Error(`Local embedding service returned HTTP ${response.status}`), { code: 'EMBEDDING_PROVIDER_ERROR' });
        if (Number(response.headers?.get?.('content-length')) > MAX_RESPONSE_BYTES) throw Object.assign(new Error('Embedding response exceeds size limit'), { code: 'EMBEDDING_RESPONSE_TOO_LARGE' });
        const raw = await boundedText(response);
        let data; try { data = JSON.parse(raw); } catch { throw Object.assign(new Error('Embedding response is invalid JSON'), { code: 'EMBEDDING_RESPONSE_INVALID' }); }
        const vector = normalizeVector(data?.embeddings?.[0]);
        if (!vector || config.dimensions && vector.length !== config.dimensions) throw Object.assign(new Error('Embedding response vector has invalid dimensions'), { code: 'EMBEDDING_VECTOR_INVALID' });
        return vector;
      } catch (error) {
        if (controller.signal.aborted) throw Object.assign(new Error('Local embedding request timed out or was cancelled'), { code: signal?.aborted ? 'CANCELLED' : 'EMBEDDING_TIMEOUT' });
        throw error;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
    },
  });
}
