import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectRSIEvidence } from '../src/adapters/rsi-evidence.ts';

const now = Date.parse('2026-10-18T00:00:00Z');
const source = 'a'.repeat(64);
const receipt = () => ({ schema_version: 1, run_id: 'test:one', source_sha256: source,
  created_at: new Date(now-1000).toISOString(),
  decision: { status: 'accepted', gain_ratio: .25, correctness_no_regression: true, rollback_verified: true },
  accounting: { cost_usd: null as number | null, cost_coverage: 'unavailable', runtime_seconds: 1, model_tokens: 0, connector_calls: 0 },
  promotion: { eligible: false } });
const inspect = (value: unknown, overrides = {}) => {
  const text = JSON.stringify(value);
  return inspectRSIEvidence(text, { expectedRunId: 'test:one', expectedSourceSha256: source,
    expectedReceiptSha256: createHash('sha256').update(text).digest('hex'), nowMs: now, maxAgeMs: 60_000, ...overrides });
};

test('verified local acceptance remains advisory and unknown cost remains null', () => {
  const result = inspect(receipt());
  assert.equal(result.valid, true);
  assert.equal(result.localCandidateAccepted, true);
  assert.equal(result.eligibleForPromotion, false);
  assert.equal(result.costUsd, null);
  assert.equal(result.billingKnown, false);
});
test('wrong source, run, bytes and stale evidence are rejected', () => {
  assert.equal(inspect(receipt(), { expectedSourceSha256: 'b'.repeat(64) }).valid, false);
  assert.equal(inspect(receipt(), { expectedRunId: 'other' }).valid, false);
  assert.equal(inspect(receipt(), { expectedReceiptSha256: 'b'.repeat(64) }).valid, false);
  assert.equal(inspect(receipt(), { nowMs: now+100_000 }).valid, false);
  assert.equal(inspect(receipt(), { nowMs: now-10_000 }).valid, false);
});
test('false acceptance, authority claims, malformed and oversize evidence fail closed', () => {
  for (const patch of [{ gain_ratio: .09 }, { correctness_no_regression: false }, { rollback_verified: false }]) {
    const value = receipt(); Object.assign(value.decision, patch);
    assert.equal(inspect(value).valid, false);
  }
  const value = receipt(); value.promotion.eligible = true;
  assert.equal(inspect(value).valid, false);
  assert.equal(inspect({}).valid, false);
  assert.equal(inspectRSIEvidence('x'.repeat(1_048_577), {} as never).valid, false);
});
test('unknown fields cannot widen authority and partial billing remains partial', () => {
  const value = { ...receipt(), grant: '*', promote: true };
  value.accounting.cost_usd = .01;
  value.accounting.cost_coverage = 'partial';
  const result = inspect(value);
  assert.equal(result.valid, true);
  assert.equal(result.eligibleForPromotion, false);
  assert.equal(result.billingKnown, false);
});
