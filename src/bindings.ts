import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { PolicyEvaluator, PolicyDecision } from './contracts.ts';
/** Load only a host-selected local native addon. Addons are trusted executable code. */
export function nativePolicy(path: string): PolicyEvaluator {
  const addon = createRequire(import.meta.url)(resolve(path)) as { evaluateJson(input: string): string };
  if (typeof addon.evaluateJson !== 'function') throw new Error('invalid_native_binding');
  return input => {
    const decision = JSON.parse(addon.evaluateJson(JSON.stringify(input))) as PolicyDecision;
    if (typeof decision.allowed !== 'boolean' || typeof decision.reason !== 'string')
      throw new Error('invalid_native_response');
    return decision;
  };
}
