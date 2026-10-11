import { id, text, finiteInt, plainObject, noSecrets, cloneJson } from './common.js';

export const TOOL_RISKS = new Set(['read', 'network', 'write', 'execute', 'message', 'admin']);
export const TOOL_EXECUTION_MODES = new Set(['parallel', 'sequential', 'background']);
export const TOOL_APPROVALS = new Set(['none', 'per-call', 'per-resource', 'explicit']);

export function validateToolContract(input) {
  const value = plainObject(input, 'tool');
  const name = id(value.name, 'tool.name');
  const description = text(value.description, 'tool.description', { max: 4096 });
  const risk = value.risk ?? 'read';
  const executionMode = value.executionMode ?? 'sequential';
  const approval = value.approval ?? (risk === 'read' ? 'none' : 'per-call');
  if (!TOOL_RISKS.has(risk)) throw new TypeError('Invalid tool.risk');
  if (!TOOL_EXECUTION_MODES.has(executionMode)) throw new TypeError('Invalid tool.executionMode');
  if (!TOOL_APPROVALS.has(approval)) throw new TypeError('Invalid tool.approval');
  const capabilities = value.capabilities === undefined ? [] : value.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length > 32 || capabilities.some(item => typeof item !== 'string' || item.length > 128)) throw new TypeError('Invalid tool.capabilities');
  const timeoutMs = value.timeoutMs === undefined ? 30_000 : finiteInt(value.timeoutMs, 'tool.timeoutMs', { min: 1, max: 10 * 60_000 });
  const outputLimit = value.outputLimit === undefined ? 32_000 : finiteInt(value.outputLimit, 'tool.outputLimit', { min: 1, max: 10 * 1024 * 1024 });
  if (value.inputSchema !== undefined) plainObject(value.inputSchema, 'tool.inputSchema');
  if (value.outputSchema !== undefined) plainObject(value.outputSchema, 'tool.outputSchema');
  const contract = {
    name, description, risk, executionMode, approval,
    capabilities: [...new Set(capabilities)], timeoutMs, outputLimit,
    cancellable: value.cancellable !== false,
    auditable: value.auditable !== false,
    background: value.background === true,
    ...(value.inputSchema ? { inputSchema: cloneJson(value.inputSchema) } : {}),
    ...(value.outputSchema ? { outputSchema: cloneJson(value.outputSchema) } : {}),
  };
  if (!noSecrets(contract)) throw new TypeError('Tool contract contains sensitive field names');
  return Object.freeze(contract);
}

export function toolContractFromRegistry(tool) {
  const functionDef = tool?.definition?.function ?? {};
  return validateToolContract({
    name: tool?.name ?? functionDef.name,
    description: functionDef.description,
    risk: tool?.risk,
    executionMode: tool?.executionMode,
    capabilities: tool?.capabilities,
    approval: tool?.approval,
    timeoutMs: tool?.timeoutMs,
    outputLimit: tool?.outputLimit,
    cancellable: tool?.cancellable,
    auditable: tool?.auditable,
    background: tool?.background,
    inputSchema: functionDef.parameters,
    outputSchema: tool?.outputSchema,
  });
}
