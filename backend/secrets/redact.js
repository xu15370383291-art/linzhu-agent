const SECRET_KEYS = /^(?:api[_ -]?key|secret|password|passwd|token|cookie|authorization|private[_ -]?key|access[_ -]?token|refresh[_ -]?token)$/i;
const SECRET_VALUE = /(?:api[_ -]?key|secret|password|passwd|authorization|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*[^\s,;]+|Bearer\s+[A-Za-z0-9._~+/=-]+|(?:sk|key|token)[-_][A-Za-z0-9._~-]{12,}/gi;

export function redactText(value, secrets = []) {
  if (typeof value !== 'string') return value;
  let result = value;
  for (const secret of secrets.filter(item => typeof item === 'string' && item.length >= 4)) result = result.split(secret).join('[redacted]');
  return result.replace(SECRET_VALUE, '[redacted]');
}

export function redact(value, secrets = []) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.test(key) ? '[redacted]' : redact(item, secrets)]));
}
