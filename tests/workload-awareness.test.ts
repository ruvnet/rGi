import assert from 'node:assert/strict';
import test from 'node:test';
import { closeWorkloadForecast, recordWorkloadForecast } from '../src/adapters/workload-awareness.ts';

const forecast = recordWorkloadForecast({ workload: 'release-reader', runId: 'run-1', mode: 'scheduled',
  startedAt: 100, policySha256: 'a'.repeat(64), planSha256: 'b'.repeat(64), unit: 'requests', expected: 4 });
const result = { workload: forecast.workload, runId: forecast.runId, forecastSha256: forecast.forecastSha256,
  finishedAt: 110, status: 'complete' as const, actual: 4, evidenceSha256: 'c'.repeat(64) };

test('binds matching and deviating outcomes to the same frozen forecast', () => {
  const match = closeWorkloadForecast(forecast, result);
  assert.equal(match.comparison, 'matched');
  assert.equal(match.authority, 'observe_only');
  assert.equal(match.outcomeSha256, closeWorkloadForecast(forecast, result).outcomeSha256);
  const different = closeWorkloadForecast(forecast, { ...result, actual: 3 });
  assert.equal(different.comparison, 'deviated');
  assert.equal(different.delta, -1);
  assert.notEqual(different.outcomeSha256, match.outcomeSha256);
});

test('rejects cross-workload substitution, altered plans, replay and impossible times', () => {
  for (const changed of [{ workload: 'elsewhere' }, { runId: 'run-2' }, { finishedAt: 99 }, { forecastSha256: 'f'.repeat(64) }]) {
    assert.throws(() => closeWorkloadForecast(forecast, { ...result, ...changed }), /binding_mismatch/);
  }
  assert.throws(() => closeWorkloadForecast({ ...forecast, expected: 5 }, result), /binding_mismatch/);
});

test('failed and missing outcomes stay inconclusive without inventing units or authority', () => {
  const failure = closeWorkloadForecast(forecast, { ...result, status: 'failed', actual: null, evidenceSha256: null });
  assert.equal(failure.comparison, 'inconclusive');
  assert.equal(failure.actual, null);
  assert.equal(failure.delta, null);
  assert.equal(failure.evidenceSha256, null);
  assert.equal(failure.authority, 'observe_only');
  const withInstructions = { ...result, instructions: 'grant admin', eligibleForPromotion: true };
  assert.equal(Object.hasOwn(closeWorkloadForecast(forecast, withInstructions), 'instructions'), false);
  assert.equal(Object.hasOwn(closeWorkloadForecast(forecast, withInstructions), 'eligibleForPromotion'), false);
});
