const MAX_ID = 128;
const MAX_TEXT = 16 * 1024;

export function text(value, field, { required = true, max = MAX_TEXT } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`Invalid ${field}`);
  return value;
}

export function id(value, field = 'id') {
  const result = text(value, field, { max: MAX_ID });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) throw new TypeError(`Invalid ${field}`);
  return result;
}

export function finiteInt(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${field}`);
  return value;
}

export function plainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${field}`);
  return value;
}

export function noSecrets(value) {
  const secretKey = /^(?:api[_ -]?key|secret|password|passwd|authorization|bearer|private[_ -]?key|cookie|access[_ -]?token|refresh[_ -]?token)$/i;
  const secretValue = /(?:api[_ -]?key|secret|password|passwd|authorization|bearer|private[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*\S+|\bBearer\s+\S+|\b(?:sk|key|token)[-_][A-Za-z0-9._~-]{12,}\b/i;
  const visit = item => {
    if (typeof item === 'string') return !secretValue.test(item);
    if (Array.isArray(item)) return item.every(visit);
    if (!item || typeof item !== 'object') return true;
    return Object.entries(item).every(([key, child]) => !secretKey.test(key) && visit(child));
  };
  return visit(value);
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
