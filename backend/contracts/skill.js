import { createHash } from 'node:crypto';
import { id, text, noSecrets } from './common.js';

export const SKILL_STATES = new Set(['discovered', 'validated', 'disabled', 'enabled', 'loaded', 'updated', 'revalidated']);
export const SKILL_SCOPES = new Set(['builtin', 'user', 'project']);

export function validateSkillManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid skill manifest');
  const manifest = {
    id: id(input.id, 'skill.id'),
    name: text(input.name, 'skill.name', { max: 160 }),
    description: text(input.description, 'skill.description', { max: 4096 }),
    version: input.version === undefined ? '0.0.0' : text(input.version, 'skill.version', { max: 64 }),
    scope: input.scope === undefined ? 'project' : input.scope,
    state: input.state === undefined ? 'discovered' : input.state,
    tools: input.tools === undefined ? [] : input.tools,
    resources: input.resources === undefined ? [] : input.resources,
  };
  if (!SKILL_SCOPES.has(manifest.scope) || !SKILL_STATES.has(manifest.state)) throw new TypeError('Invalid skill scope or state');
  for (const [field, list] of [['tools', manifest.tools], ['resources', manifest.resources]]) {
    if (!Array.isArray(list) || list.length > 64 || list.some(item => typeof item !== 'string' || item.length > 256)) throw new TypeError(`Invalid skill.${field}`);
  }
  if (!noSecrets(manifest)) throw new TypeError('Skill manifest contains sensitive field names');
  return Object.freeze({ ...manifest, tools: [...manifest.tools], resources: [...manifest.resources] });
}

export function skillFingerprint({ manifest, body = '' }) {
  const checked = validateSkillManifest(manifest);
  if (typeof body !== 'string' || body.length > 128 * 1024) throw new TypeError('Invalid skill body');
  return createHash('sha256').update(JSON.stringify(checked)).update('\0').update(body).digest('hex');
}
