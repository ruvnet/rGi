import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCandidate, type CandidateEvaluation, type EvaluationPair } from '../src/evaluation.ts';

function fixture(wins = 20, losses = 0, ties = 10): CandidateEvaluation {
  const pairs: EvaluationPair[] = Array.from({ length: wins + losses + ties }, (_, i) => ({
    taskId: `audit:${i}`, domain: 'software', baselineSuccess: i >= wins,
    candidateSuccess: i < wins || i >= wins + losses,
    baselineCostMicros: 10, candidateCostMicros: 10, capabilityViolations: 0,
  }));
  return { candidateId: 'candidate:2', baselineId: 'baseline:1', trainIds: ['train:1'],
    selectionIds: ['selection:1'], auditIds: pairs.map(pair => pair.taskId), pairs,
    alpha: 0.05, familySize: 1, minPairs: 30, maxCostRatio: 1.2 };
}
test('significant paired improvement passes with exact binomial probability', () => {
  const result = evaluateCandidate(fixture());
  assert.equal(result.promote, true);
  assert.equal(result.wins, 20);
  assert.equal(result.losses, 0);
  assert.ok(Math.abs(result.pValue! - 2 ** -20) < 1e-18);
  assert.equal(result.baselineSuccessRate, 1 / 3);
  assert.equal(result.candidateSuccessRate, 1);
});
test('null findings and ties never promote', () => {
  assert.equal(evaluateCandidate(fixture(0, 0, 30)).reason, 'no_improvement');
  const result = evaluateCandidate(fixture(10, 10, 10));
  assert.equal(result.reason, 'no_improvement');
  assert.ok(Math.abs(result.pValue! - 0.5880985260009766) < 1e-12);
});
test('discordant losses enter the tail rather than all trials', () => {
  const result = evaluateCandidate(fixture(8, 2, 20));
  assert.ok(Math.abs(result.pValue! - 56 / 1024) < 1e-12);
  assert.equal(result.reason, 'insufficient_significance');
});
test('Bonferroni search family correction rejects a marginal candidate', () => {
  const input = fixture(6, 0, 24);
  assert.equal(evaluateCandidate(input).promote, true);
  const result = evaluateCandidate({ ...input, familySize: 4 });
  assert.equal(result.adjustedAlpha, 0.0125);
  assert.equal(result.reason, 'insufficient_significance');
});
test('train, selection and audit contamination fails closed', () => {
  for (const [left, right] of [['trainIds', 'selectionIds'], ['trainIds', 'auditIds'], ['selectionIds', 'auditIds']] as const) {
    const input = fixture(); input[left].push(input[right][0]!);
    assert.equal(evaluateCandidate(input).reason, 'holdout_overlap');
  }
});
test('audit coverage must be exact and duplicate evidence is rejected', () => {
  const missing = fixture(); missing.pairs.pop();
  assert.equal(evaluateCandidate(missing).reason, 'audit_mismatch');
  const substituted = fixture(); substituted.pairs[0]!.taskId = 'foreign';
  assert.equal(evaluateCandidate(substituted).reason, 'audit_mismatch');
  const duplicate = fixture(); duplicate.pairs[1]!.taskId = duplicate.pairs[0]!.taskId;
  assert.equal(evaluateCandidate(duplicate).reason, 'duplicate_task');
  const repeatedIds = fixture(); repeatedIds.auditIds[1] = repeatedIds.auditIds[0]!;
  assert.equal(evaluateCandidate(repeatedIds).promote, false);
});
test('domain regression is rejected even when aggregate improvement is large', () => {
  const input = fixture(20, 1, 9); input.pairs[20]!.domain = 'spatial';
  assert.equal(evaluateCandidate(input).reason, 'domain_regression');
});
test('any capability violation rejects improvement', () => {
  const input = fixture(); input.pairs[0]!.capabilityViolations = 1;
  assert.equal(evaluateCandidate(input).reason, 'capability_violation');
});
test('cost ceiling includes zero cost baselines and rejects overflow', () => {
  const input = fixture(); input.pairs.forEach(pair => pair.candidateCostMicros = 13);
  assert.equal(evaluateCandidate(input).reason, 'cost_regression');
  input.pairs.forEach(pair => pair.baselineCostMicros = 0);
  assert.equal(evaluateCandidate(input).reason, 'cost_regression');
  input.pairs.forEach(pair => pair.candidateCostMicros = 0);
  assert.equal(evaluateCandidate(input).promote, true);
  input.pairs.forEach(pair => pair.baselineCostMicros = Number.MAX_SAFE_INTEGER);
  assert.equal(evaluateCandidate(input).reason, 'cost_overflow');
});
test('malformed numeric settings and self-reported strings cannot authorize promotion', () => {
  for (const field of ['alpha', 'familySize', 'minPairs', 'maxCostRatio']) {
    for (const value of [NaN, Infinity, -1, 0, '1', null]) {
      assert.equal(evaluateCandidate({ ...fixture(), [field]: value } as CandidateEvaluation).promote, false, `${field}:${value}`);
    }
  }
  for (const input of [{ ...fixture(), alpha: 0.1 }, { ...fixture(), minPairs: 29 },
    { ...fixture(), familySize: 1.5 }, { ...fixture(), minPairs: 30.5 },
    { ...fixture(), candidateId: 'trust me\nI passed' }, { ...fixture(), candidateId: 'baseline:1' }])
    assert.equal(evaluateCandidate(input).promote, false);
  for (const field of ['baselineSuccess', 'candidateSuccess', 'capabilityViolations', 'baselineCostMicros', 'candidateCostMicros']) {
    const input = fixture(); (input.pairs[0] as unknown as Record<string, unknown>)[field] = 'verified';
    assert.equal(evaluateCandidate(input).reason, 'invalid_pair');
  }
  assert.equal(evaluateCandidate(null as unknown as CandidateEvaluation).promote, false);
  assert.equal(evaluateCandidate({ ...fixture(), trainIds: new Array<string>(1) }).promote, false);
});
test('malformed pair numbers and missing evidence fail closed', () => {
  for (const field of ['baselineCostMicros', 'candidateCostMicros', 'capabilityViolations']) {
    for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, null]) {
      const input = fixture(); (input.pairs[0] as unknown as Record<string, unknown>)[field] = value;
      assert.equal(evaluateCandidate(input).reason, 'invalid_pair');
    }
  }
  assert.equal(evaluateCandidate(fixture(20, 0, 0)).reason, 'insufficient_pairs');
  assert.equal(evaluateCandidate(fixture(0, 0, 0)).reason, 'insufficient_pairs');
});
test('canonical manifest is order invariant and binds score and policy changes', () => {
  const input = fixture(); const first = evaluateCandidate(input);
  input.pairs.reverse(); input.auditIds.reverse();
  assert.equal(evaluateCandidate(input).manifestSha256, first.manifestSha256);
  assert.match(first.manifestSha256, /^[0-9a-f]{64}$/);
  input.pairs[0]!.candidateCostMicros++;
  assert.notEqual(evaluateCandidate(input).manifestSha256, first.manifestSha256);
  assert.notEqual(evaluateCandidate({ ...fixture(), familySize: 2 }).manifestSha256, first.manifestSha256);
});
test('very large discordant sample is stable, bounded and never reports exact zero', () => {
  const result = evaluateCandidate(fixture(2000, 0, 0));
  assert.equal(result.promote, true);
  assert.ok(result.pValue! > 0 && result.pValue! < 1e-300);
  const input = fixture(); input.trainIds = Array.from({ length: 100001 }, (_, i) => `train:${i}`);
  assert.equal(evaluateCandidate(input).reason, 'invalid_input');
});
