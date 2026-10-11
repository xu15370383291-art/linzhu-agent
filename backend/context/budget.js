export const DEFAULT_CONTEXT_WINDOW = 32768;
export const DEFAULT_OUTPUT_RESERVE = 4096;
export const SAFETY_MARGIN = 1024;

export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(Math.max(text.length / 4, Buffer.byteLength(text, 'utf8') / 3));
}

export function resolveBudget(settings = {}) {
  const contextWindow = settings.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const outputReserve = settings.outputReserve ?? DEFAULT_OUTPUT_RESERVE;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 2048) {
    throw new Error('Context window must be an integer of at least 2048 tokens.');
  }
  if (!Number.isSafeInteger(outputReserve) || outputReserve < 256 || outputReserve + SAFETY_MARGIN >= contextWindow) {
    throw new Error('Output reserve must leave room for the safety margin.');
  }
  return { contextWindow, outputReserve, inputLimit: contextWindow - outputReserve - SAFETY_MARGIN };
}

export function contextStatus(messages, tools = [], settings = {}) {
  const budget = resolveBudget(settings);
  const messageTokens = estimateTokens(messages);
  const toolTokens = estimateTokens(tools);
  const estimatedInput = messageTokens + toolTokens;
  return { ...budget, messageTokens, toolTokens, estimatedInput, fits: estimatedInput <= budget.inputLimit };
}
