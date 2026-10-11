const providers = new Map();

export function registerProvider(provider) {
  if (!provider || typeof provider.id !== 'string' || typeof provider.validateConfig !== 'function') throw new TypeError('Invalid provider');
  providers.set(provider.id, Object.freeze({ ...provider }));
}

registerProvider({
  id: 'openai-compatible', name: 'OpenAI-compatible', auth: 'api-key',
  capabilities: ['chat', 'streaming', 'tools', 'json'],
  validateConfig: config => ({ ...config, provider: 'openai-compatible', auth: config.auth ?? 'api-key' }),
});
registerProvider({
  id: 'ollama', name: 'Ollama', auth: 'none',
  capabilities: ['chat', 'streaming', 'tools'],
  validateConfig: config => ({ ...config, provider: 'ollama', auth: 'none', apiKey: '' }),
});

export function getProvider(id = 'openai-compatible') { return providers.get(id) ?? null; }
export function listProviders() { return [...providers.values()].map(({ id, name, auth, capabilities }) => ({ id, name, auth, capabilities: [...capabilities] })); }

export function normalizeProviderConfig(config) {
  const provider = getProvider(config.provider);
  if (!provider) throw Object.assign(new Error(`Unsupported provider: ${config.provider}`), { code: 'PROVIDER_UNSUPPORTED' });
  return provider.validateConfig({ ...config });
}

export function capabilitySnapshot(item, { tested = false } = {}) {
  const provider = getProvider(item.provider);
  return {
    ...(item.capabilities ?? {}),
    ...(tested ? { testedAt: new Date().toISOString() } : {}),
    ...(provider ? Object.fromEntries(provider.capabilities.map(capability => [capability, item.capabilities?.[capability] ?? 'unknown'])) : {}),
  };
}
