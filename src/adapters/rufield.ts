import type { Observation } from '../contracts.ts';
import { identifier, validateObservation } from '../policy.ts';

/** Autogenous packages/radio-moe/src/observation.ts, ADR-402 observation contract. */
export interface RuFieldObservation {
  sourceId: string;
  location: string;
  kind: string;
  value: unknown;
  confidence: number;
  privacyClass: 'public' | 'internal' | 'restricted' | 'sensitive';
  calibrationVersion: string;
  issuedAt: number;
  expiresAt: number;
  sensorHealth?: number;
  lineage?: { origin: 'cognitum-spaces'; tenantId: string; messageId: string; sequence: number; provenance: string; derived: true };
}

/** Exact injected admission function seam; deployment can bind upstream admitObservation. */
export type ObservationAdmission = (observation: RuFieldObservation, now: number) => { admissible: boolean; rejection?: string };

/** A mapped observation stays evidence, never executable authority. Full metadata survives. */
export function fromRuField(id: string, input: RuFieldObservation, now: number, admit: ObservationAdmission): Observation {
  identifier(id);
  if (!Number.isSafeInteger(now)) throw new Error('Invalid observation identity or clock');
  const observation = structuredClone(input);
  if (!observation || typeof observation !== 'object') throw new Error('Invalid observation');
  // Independent time check prevents stale data even if a host admission callback is permissive.
  if (!Number.isSafeInteger(observation.issuedAt) || !Number.isSafeInteger(observation.expiresAt) || observation.issuedAt > now || observation.expiresAt <= now || observation.expiresAt <= observation.issuedAt) throw new Error('Invalid observation window');
  if (typeof observation.confidence !== 'number' || !Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1) throw new Error('Invalid observation confidence');
  const result = admit(observation, now);
  if (!result.admissible) throw new Error(`Observation rejected: ${result.rejection ?? 'unspecified'}`);
  const mapped: Observation = { id, source: observation.sourceId, timestamp: observation.issuedAt, modality: 'rufield', confidence: observation.confidence, data: observation };
  validateObservation(mapped);
  return mapped;
}
