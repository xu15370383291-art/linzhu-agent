import { randomUUID } from 'node:crypto';

export function requestId() { return randomUUID(); }

function integer(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

export function normalizeUsage(raw, { source = 'provider' } = {}) {
  const input = integer(raw?.inputTokens ?? raw?.prompt_tokens ?? raw?.input_tokens);
  const output = integer(raw?.outputTokens ?? raw?.completion_tokens ?? raw?.output_tokens);
  const total = integer(raw?.totalTokens ?? raw?.total_tokens) ?? (input !== null && output !== null ? input + output : null);
  const cached = integer(raw?.cachedInputTokens ?? raw?.prompt_tokens_details?.cached_tokens ?? raw?.input_tokens_details?.cached_tokens);
  const reasoning = integer(raw?.reasoningTokens ?? raw?.completion_tokens_details?.reasoning_tokens ?? raw?.output_tokens_details?.reasoning_tokens);
  if ([input, output, total, cached, reasoning].some(value => value !== null && !Number.isSafeInteger(value))) return null;
  if (total !== null && input !== null && output !== null && total < input + output) return null;
  return { inputTokens: input, outputTokens: output, totalTokens: total, ...(cached === null ? {} : { cachedInputTokens: cached }),
    ...(reasoning === null ? {} : { reasoningTokens: reasoning }), source };
}

export function usageFromResponse(response) {
  const usage = normalizeUsage(response?.usage);
  return usage?.totalTokens !== null || usage?.inputTokens !== null || usage?.outputTokens !== null ? usage : null;
}

export function usageEstimate(messages, tools = []) {
  const text = JSON.stringify({ messages, tools });
  const inputTokens = Math.max(1, Math.ceil([...text].length / 3));
  return { inputTokens, outputTokens: null, totalTokens: inputTokens, source: 'tokenizer_estimate' };
}
