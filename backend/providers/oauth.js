import { createHash, randomBytes, randomUUID } from 'node:crypto';

const MAX_STATE = 64;

function base64Url(buffer) { return Buffer.from(buffer).toString('base64url'); }
function verifier() { return base64Url(randomBytes(32)); }
function challenge(value) { return base64Url(createHash('sha256').update(value).digest()); }

export class OAuthManager {
  constructor({ secrets, now = () => Date.now(), fetchImpl = fetch } = {}) { this.secrets = secrets; this.now = now; this.fetch = fetchImpl; this.states = new Map(); }
  begin({ provider, authorizationUrl, clientId, redirectUri, scopes = [] }) {
    if (!this.secrets || typeof authorizationUrl !== 'string' || typeof clientId !== 'string' || typeof redirectUri !== 'string') throw Object.assign(new Error('OAuth configuration is incomplete'), { code: 'OAUTH_CONFIG_INVALID' });
    const parsed = new URL(authorizationUrl); if (!['https:'].includes(parsed.protocol)) throw Object.assign(new Error('OAuth authorization URL must use HTTPS'), { code: 'OAUTH_URL_INVALID' });
    const state = randomUUID(); const codeVerifier = verifier(); this.states.set(state, { provider, clientId, redirectUri, codeVerifier, createdAt: this.now() });
    while (this.states.size > MAX_STATE) this.states.delete(this.states.keys().next().value);
    parsed.searchParams.set('response_type', 'code'); parsed.searchParams.set('client_id', clientId); parsed.searchParams.set('redirect_uri', redirectUri); parsed.searchParams.set('scope', scopes.join(' ')); parsed.searchParams.set('state', state); parsed.searchParams.set('code_challenge', challenge(codeVerifier)); parsed.searchParams.set('code_challenge_method', 'S256');
    return { state, authorizationUrl: parsed.href, expiresAt: this.now() + 5 * 60_000 };
  }
  async exchange({ state, code, tokenUrl, tokenField = 'access_token', refreshField = 'refresh_token', secretPrefix }) {
    const pending = this.states.get(state); if (!pending || this.now() - pending.createdAt > 5 * 60_000) throw Object.assign(new Error('OAuth state expired or invalid'), { code: 'OAUTH_STATE_INVALID' });
    this.states.delete(state); const parsed = new URL(tokenUrl); if (parsed.protocol !== 'https:') throw Object.assign(new Error('OAuth token URL must use HTTPS'), { code: 'OAUTH_URL_INVALID' });
    const response = await this.fetch(parsed, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: pending.clientId, redirect_uri: pending.redirectUri, code_verifier: pending.codeVerifier }).toString() });
    if (!response.ok) throw Object.assign(new Error(`OAuth token exchange failed: HTTP ${response.status}`), { code: 'OAUTH_EXCHANGE_FAILED' });
    const data = await response.json(); const access = data?.[tokenField]; if (typeof access !== 'string' || !access) throw Object.assign(new Error('OAuth response has no access token'), { code: 'OAUTH_RESPONSE_INVALID' });
    const prefix = `${secretPrefix}.${pending.provider}`; await this.secrets.set(`${prefix}.access`, access); if (typeof data?.[refreshField] === 'string' && data[refreshField]) await this.secrets.set(`${prefix}.refresh`, data[refreshField]);
    return { provider: pending.provider, accessRef: `secret://${prefix}.access`, refreshRef: data?.[refreshField] ? `secret://${prefix}.refresh` : null, expiresIn: Number.isSafeInteger(data?.expires_in) ? data.expires_in : null };
  }
}
