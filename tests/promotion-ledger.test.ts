import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromotionLedger } from '../src/promotion-ledger.ts';
import type { CandidateEvaluation } from '../src/evaluation.ts';

function fixture(id = 'one', success = true): CandidateEvaluation {
  const pairs = Array.from({ length: 30 }, (_, i) => ({ taskId: `${id}:${i}`, domain: 'software',
    baselineSuccess: false, candidateSuccess: success, baselineCostMicros: 10,
    candidateCostMicros: 10, capabilityViolations: 0 }));
  return { candidateId: id, baselineId: 'base', trainIds: [], selectionIds: [],
    auditIds: pairs.map(pair => pair.taskId), pairs, alpha: 0.01, familySize: 1,
    minPairs: 30, maxCostRatio: 1 };
}
const config = { totalAlpha: 0.05, maxEvaluations: 5 };

test('reopening preserves candidate and audit consumption with immutable config', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rgi-ledger-'));
  let db = new DatabaseSync(join(directory, 'ledger.db'));
  try {
    new PromotionLedger(db, config).evaluate(fixture()); db.close();
    db = new DatabaseSync(join(directory, 'ledger.db'));
    const ledger = new PromotionLedger(db, config);
    assert.equal(ledger.count, 1);
    assert.throws(() => ledger.evaluate(fixture()), /candidate_reused/);
    assert.throws(() => ledger.evaluate({ ...fixture(), candidateId: 'new' }), /audit_reused/);
    assert.throws(() => new PromotionLedger(db, { totalAlpha: 0.04, maxEvaluations: 5 }), /ledger_config_mismatch/);
    assert.throws(() => new PromotionLedger(db, { totalAlpha: 0.05, maxEvaluations: 4 }), /ledger_config_mismatch/);
    assert.equal(ledger.count, 1);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('rejected well-formed candidates burn their audit set and attempt', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new PromotionLedger(db, config);
    const result = ledger.evaluate(fixture('failed', false));
    assert.equal(result.promote, false); assert.equal(ledger.count, 1);
    assert.throws(() => ledger.evaluate({ ...fixture('failed'), candidateId: 'retry' }), /audit_reused/);
    const row = db.prepare('SELECT decision,manifest_sha256,alpha FROM rgi_evaluations').get()!;
    assert.deepEqual(JSON.parse(String(row.decision)), result);
    assert.equal(row.manifest_sha256, result.manifestSha256); assert.equal(row.alpha, 0.01);
  } finally { db.close(); }
});
test('per-attempt alpha cannot bypass persisted total alpha budget', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new PromotionLedger(db, config);
    assert.throws(() => ledger.evaluate({ ...fixture(), alpha: 0.05 }), /ledger_alpha_exceeded/);
    assert.equal(ledger.count, 0);
    assert.equal(ledger.evaluate(fixture()).promote, true);
  } finally { db.close(); }
});
test('attempt budget exhausts for accepted and rejected candidates', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new PromotionLedger(db, { totalAlpha: 0.05, maxEvaluations: 2 });
    ledger.evaluate(fixture('first')); ledger.evaluate(fixture('second', false));
    assert.throws(() => ledger.evaluate(fixture('third')), /evaluation_budget_exhausted/);
    assert.equal(ledger.count, 2);
  } finally { db.close(); }
});
test('duplicate audit batch rolls back without consuming any fresh IDs', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new PromotionLedger(db, config); ledger.evaluate(fixture());
    const conflict = fixture('two'); conflict.auditIds[29] = 'one:0'; conflict.pairs[29]!.taskId = 'one:0';
    assert.throws(() => ledger.evaluate(conflict), /audit_reused/);
    assert.equal(ledger.count, 1);
    assert.equal(ledger.evaluate(fixture('two')).promote, true);
    const duplicate = fixture('three'); duplicate.auditIds[0] = duplicate.auditIds[1]!;
    assert.throws(() => ledger.evaluate(duplicate), /invalid_evaluation/);
    assert.equal(ledger.count, 2);
  } finally { db.close(); }
});
test('two database connections serialize attempts and cannot reuse evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rgi-ledger-concurrent-'));
  const first = new DatabaseSync(join(directory, 'ledger.db'));
  const second = new DatabaseSync(join(directory, 'ledger.db'));
  try {
    const a = new PromotionLedger(first, config), b = new PromotionLedger(second, config);
    second.exec('PRAGMA busy_timeout=0'); first.exec('BEGIN IMMEDIATE');
    assert.throws(() => b.evaluate(fixture()), /locked/);
    first.exec('COMMIT');
    assert.equal(a.count, 0); a.evaluate(fixture());
    assert.throws(() => b.evaluate(fixture()), /candidate_reused/);
    assert.throws(() => b.evaluate({ ...fixture(), candidateId: 'second' }), /audit_reused/);
    assert.equal(b.count, 1);
  } finally { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('invalid configs and malformed evidence cannot consume attempts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const totalAlpha of [NaN, Infinity, 0, -1, 0.06])
      assert.throws(() => new PromotionLedger(db, { ...config, totalAlpha }), /invalid_ledger_config/);
    for (const maxEvaluations of [NaN, Infinity, 0, -1, 1.5, 1001])
      assert.throws(() => new PromotionLedger(db, { ...config, maxEvaluations }), /invalid_ledger_config/);
    const ledger = new PromotionLedger(db, config);
    assert.throws(() => ledger.evaluate({ ...fixture(), alpha: NaN }), /invalid_evaluation/);
    assert.equal(ledger.count, 0);
  } finally { db.close(); }
});
