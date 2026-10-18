import { createHash } from 'node:crypto';

export interface RSIEvidencePolicy {
  expectedRunId: string;
  expectedSourceSha256: string;
  expectedReceiptSha256: string;
  nowMs: number;
  maxAgeMs: number;
}

export interface RSIEvidenceInspection {
  valid: boolean;
  reason: string;
  localCandidateAccepted: boolean;
  eligibleForPromotion: false;
  runId: string | null;
  costUsd: number | null;
  billingKnown: boolean;
}

const digest = (s: string): string => createHash('sha256').update(s).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

/** Read-only bridge from a host-verified experiment receipt. Hashes bind bytes,
 * not truth, signer identity or permission. It never calls the promotion gate. */
export function inspectRSIEvidence(serialized: string, policy: RSIEvidencePolicy): RSIEvidenceInspection {
  const result: RSIEvidenceInspection = { valid: false, reason: 'invalid_input', localCandidateAccepted: false,
    eligibleForPromotion: false, runId: null, costUsd: null, billingKnown: false };
  const deny = (reason: string): RSIEvidenceInspection => ({ ...result, reason });
  try {
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 1_048_576
      || !policy || typeof policy.expectedRunId !== 'string' || !policy.expectedRunId
      || !hash(policy.expectedSourceSha256) || !hash(policy.expectedReceiptSha256)
      || !nonnegative(policy.nowMs) || !nonnegative(policy.maxAgeMs) || policy.maxAgeMs === 0)
      return deny('invalid_policy');
    if (digest(serialized) !== policy.expectedReceiptSha256) return deny('receipt_digest_mismatch');
    const value: unknown = JSON.parse(serialized);
    if (!object(value) || value.schema_version !== 1 || value.run_id !== policy.expectedRunId
      || value.source_sha256 !== policy.expectedSourceSha256) return deny('source_or_run_mismatch');
    const at = typeof value.created_at === 'string' ? Date.parse(value.created_at) : NaN;
    if (!Number.isFinite(at) || at > policy.nowMs || policy.nowMs-at > policy.maxAgeMs) return deny('stale_receipt');
    const decision = value.decision, accounting = value.accounting, promotion = value.promotion;
    if (!object(decision) || typeof decision.status !== 'string' || !['accepted','rejected'].includes(decision.status)
      || typeof decision.gain_ratio !== 'number' || !Number.isFinite(decision.gain_ratio)
      || typeof decision.correctness_no_regression !== 'boolean' || typeof decision.rollback_verified !== 'boolean'
      || !object(accounting) || !(accounting.cost_usd === null || nonnegative(accounting.cost_usd))
      || typeof accounting.cost_coverage !== 'string' || !accounting.cost_coverage
      || !nonnegative(accounting.runtime_seconds) || !nonnegative(accounting.model_tokens)
      || !nonnegative(accounting.connector_calls) || !object(promotion) || promotion.eligible !== false)
      return deny('invalid_receipt');
    const journal=value.journal_at_receipt_write;
    if (!object(journal) || journal.run_id !== value.run_id || journal.decision !== decision.status
      || !object(journal.evidence) || !object(journal.spec)) return deny('journal_mismatch');
    const evidence=journal.evidence, spec=journal.spec;
    const flags=['correctness_no_regression','security_no_regression','reliability_no_regression','holdout_passed','rollback_verified'];
    if (!nonnegative(evidence.baseline) || evidence.baseline === 0 || !nonnegative(evidence.candidate)
      || typeof spec.lower_is_better !== 'boolean' || !nonnegative(spec.min_gain) || spec.min_gain < .10
      || flags.some(flag=>typeof evidence[flag] !== 'boolean')) return deny('invalid_evaluation');
    const gain=spec.lower_is_better ? (evidence.baseline-evidence.candidate)/evidence.baseline
      : (evidence.candidate-evidence.baseline)/evidence.baseline;
    if (Math.abs(gain-decision.gain_ratio)>1e-10) return deny('gain_mismatch');
    const accepted = decision.status === 'accepted';
    if (accepted && (decision.gain_ratio < .10 || decision.correctness_no_regression !== true
      || decision.rollback_verified !== true || flags.some(flag=>evidence[flag] !== true) || gain < spec.min_gain)) return deny('invalid_acceptance');
    return { valid: true, reason: 'independent_rgi_audit_required', localCandidateAccepted: accepted,
      eligibleForPromotion: false, runId: policy.expectedRunId, costUsd: accounting.cost_usd as number | null,
      billingKnown: accounting.cost_usd !== null && accounting.cost_coverage === 'complete' };
  } catch {
    return deny('invalid_receipt');
  }
}
