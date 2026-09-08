import type { PolicyDecision, PolicyInput, RuntimeConfig, Action, Observation } from './contracts.ts';

export function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(value))
    throw new Error('invalid_identifier');
}
export function money(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('invalid_cost');
}
export function confidence(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error('invalid_confidence');
}
export function boundedJson(value: unknown, limit: number): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > limit) throw new Error('record_too_large');
  return encoded;
}
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
export function validateConfig(config: RuntimeConfig): void {
  if (!Array.isArray(config.allowedCapabilities) || config.allowedCapabilities.length > 256)
    throw new Error('invalid_capabilities');
  config.allowedCapabilities.forEach(identifier);
  money(config.budgetMicros); confidence(config.minConfidence);
  for (const k of ['maxQueue', 'maxObservations', 'maxRecordBytes', 'maxDatabaseBytes', 'actionTimeoutMs', 'leaseMs', 'idleMs'] as const)
    if (!Number.isSafeInteger(config[k]) || config[k] < 1 || config[k] > 1_000_000_000)
      throw new Error(`invalid_config:${k}`);
  if (config.maxRecordBytes > 1_048_576 || config.maxQueue > 100000 || config.maxObservations > 100000)
    throw new Error('invalid_config:capacity');
  if (config.leaseMs < config.actionTimeoutMs * 2) throw new Error('lease_too_short');
  if (config.idleMs > config.leaseMs / 4) throw new Error('idle_exceeds_lease');
  if (config.maxDatabaseBytes < 1048576) throw new Error('database_limit_too_small');
}
export function validateAction(action: Action, limit = 65536): void {
  if (!action || typeof action !== 'object') throw new Error('invalid_action');
  identifier(action.id); identifier(action.capability);
  money(action.estimatedCostMicros); confidence(action.confidence);
  if (!action.payload || typeof action.payload !== 'object' || Array.isArray(action.payload))
    throw new Error('invalid_payload');
  boundedJson(action, limit);
}
export function validateObservation(observation: Observation, limit = 65536): void {
  identifier(observation.id); identifier(observation.source); identifier(observation.modality);
  money(observation.timestamp); confidence(observation.confidence); boundedJson(observation, limit);
}
/** Audited portable fallback. Native/WASM implementations must pass parity fixtures. */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  try {
    identifier(input.capability);
    if (!Array.isArray(input.allowedCapabilities) || input.allowedCapabilities.length > 256)
      throw new Error('invalid_capabilities');
    input.allowedCapabilities.forEach(identifier);
    [input.spentMicros, input.reservedMicros, input.requestedMicros, input.budgetMicros].forEach(money);
    confidence(input.confidence); confidence(input.minConfidence);
    if (typeof input.stopped !== 'boolean') throw new Error('invalid_stopped');
  } catch { return { allowed: false, reason: 'invalid_input' }; }
  if (input.stopped) return { allowed: false, reason: 'stopped' };
  if (!input.allowedCapabilities.includes(input.capability)) return { allowed: false, reason: 'capability_denied' };
  if (input.confidence < input.minConfidence) return { allowed: false, reason: 'invalid_confidence' };
  const total = BigInt(input.spentMicros) + BigInt(input.reservedMicros) + BigInt(input.requestedMicros);
  if (total > BigInt(input.budgetMicros)) return { allowed: false, reason: 'budget_exhausted' };
  return { allowed: true, reason: 'allowed' };
}
