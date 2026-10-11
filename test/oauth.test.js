import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuthManager } from '../backend/providers/oauth.js';

test('OAuth manager uses PKCE, rejects insecure endpoints and stores tokens as Secret references', async () => {
  const values = new Map(); const secrets = { async set(id, value) { values.set(id, value); } };
  const manager = new OAuthManager({ secrets, now: () => 1_700_000_000_000, fetchImpl: async (_url, options) => { assert.match(options.body, /code_verifier=/); return { ok: true, async json() { return { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 }; } }; } });
  const started = manager.begin({ provider: 'demo', authorizationUrl: 'https://auth.example/authorize', clientId: 'client', redirectUri: 'http://127.0.0.1:32123/callback', scopes: ['chat'] });
  assert.match(started.authorizationUrl, /code_challenge=/); assert.match(started.authorizationUrl, /state=/);
  const exchanged = await manager.exchange({ state: started.state, code: 'code', tokenUrl: 'https://auth.example/token', secretPrefix: 'oauth' });
  assert.equal(exchanged.accessRef, 'secret://oauth.demo.access'); assert.equal(values.get('oauth.demo.access'), 'access-secret');
  await assert.rejects(manager.exchange({ state: started.state, code: 'reuse', tokenUrl: 'https://auth.example/token', secretPrefix: 'oauth' }), { code: 'OAUTH_STATE_INVALID' });
  assert.throws(() => manager.begin({ provider: 'demo', authorizationUrl: 'http://auth.example/authorize', clientId: 'x', redirectUri: 'http://127.0.0.1/cb' }), { code: 'OAUTH_URL_INVALID' });
});
