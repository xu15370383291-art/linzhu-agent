const DEFAULTS = Object.freeze({
  maxRounds: 24,
  maxToolCalls: 64,
  maxConsecutiveFailures: 5,
});

const HARD_LIMITS = Object.freeze({
  maxRounds: 64,
  maxToolCalls: 256,
  maxConsecutiveFailures: 8,
});

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function bounded(value, fallback, maximum) {
  return Math.min(positiveInteger(value) ?? fallback, maximum);
}

export const DEFAULT_EXECUTION_LIMITS = DEFAULTS;
export const HARD_EXECUTION_LIMITS = HARD_LIMITS;

export function resolveExecutionLimits(overrides = {}) {
  return {
    maxRounds: bounded(overrides.maxRounds ?? process.env.AGENT_MAX_ROUNDS, DEFAULTS.maxRounds, HARD_LIMITS.maxRounds),
    maxToolCalls: bounded(overrides.maxToolCalls ?? process.env.AGENT_MAX_TOOL_CALLS, DEFAULTS.maxToolCalls, HARD_LIMITS.maxToolCalls),
    maxConsecutiveFailures: bounded(overrides.maxConsecutiveFailures ?? process.env.AGENT_MAX_CONSECUTIVE_FAILURES, DEFAULTS.maxConsecutiveFailures, HARD_LIMITS.maxConsecutiveFailures),
  };
}
