import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy, validateAction, boundedJson } from '../src/policy.ts';
import type { PolicyInput } from '../src/contracts.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.ts';

const base: PolicyInput = { capability: 'simulation.step', allowedCapabilities: ['simulation.step'], spentMicros: 10, reservedMicros: 20, requestedMicros: 30, budgetMicros: 60, confidence: 0.9, minConfidence: 0.8, stopped: false };
test('policy rejects every malformed numeric boundary', () => {
  for (const key of ['spentMicros', 'reservedMicros', 'requestedMicros', 'budgetMicros'] as const)
    for (const value of [-1, NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, '0', null, undefined])
      assert.equal(evaluatePolicy({ ...base, [key]: value } as PolicyInput).allowed, false, `${key}: ${String(value)}`);
});
test('capability authority is exact and stopped always denies', () => {
  assert.equal(evaluatePolicy(base).allowed, true);
  for (const capability of ['simulation', 'simulation.step.admin', 'Simulation.step', '*', 'simulation.step\n', '__proto__', 'shell.exec'])
    assert.equal(evaluatePolicy({ ...base, capability }).allowed, false);
  assert.equal(evaluatePolicy({ ...base, stopped: true }).reason, 'stopped');
  assert.equal(evaluatePolicy({ ...base, stopped: 0 } as unknown as PolicyInput).allowed, false);
});
test('reservations count against budget without floating point overflow', () => {
  assert.equal(evaluatePolicy({ ...base, requestedMicros: 31 }).reason, 'budget_exhausted');
  assert.equal(evaluatePolicy({ ...base, spentMicros: Number.MAX_SAFE_INTEGER, reservedMicros: 1, requestedMicros: 0, budgetMicros: Number.MAX_SAFE_INTEGER }).allowed, false);
});
test('confidence must be finite bounded and satisfy the threshold', () => {
  for (const confidence of [NaN, Infinity, -0.1, 1.1, 0.7999])
    assert.equal(evaluatePolicy({ ...base, confidence }).allowed, false);
  assert.equal(evaluatePolicy({ ...base, confidence: 0.8 }).allowed, true);
});
test('hostile payloads fail before scheduling', () => {
  const action = { id: 'safe', capability: 'simulation.step', payload: {}, estimatedCostMicros: 0, confidence: 1 };
  for (const payload of [null, [], 'shell command'])
    assert.throws(() => validateAction({ ...action, payload } as never));
  assert.throws(() => validateAction({ ...action, payload: { data: 'x'.repeat(70000) } }));
  const circular: Record<string, unknown> = {}; circular.self = circular;
  assert.throws(() => boundedJson(circular, 65536));
  assert.throws(() => boundedJson(undefined, 65536));
});

test('unauthorized action never reaches executor', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rgi-security-'));
  let executions = 0;
  const runtime = new Runtime({ dbPath: join(directory, 'runtime.db'), config: { allowedCapabilities: ['simulation.step'], budgetMicros: 100 }, executor: { async execute() { executions++; return { output: null, actualCostMicros: 0 }; } } });
  try {
    runtime.enqueue({ id: 'denied', capability: 'shell.exec', payload: {}, estimatedCostMicros: 0, confidence: 1 });
    await runtime.step();
    assert.equal(executions, 0);
  } finally { runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('durable stop survives restart and prevents execution', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rgi-stop-'));
  let executions = 0;
  const options = { dbPath: join(directory, 'runtime.db'), config: { allowedCapabilities: ['simulation.step'], budgetMicros: 100 }, executor: { async execute() { executions++; return { output: null, actualCostMicros: 0 }; } } };
  let runtime = new Runtime(options);
  try {
    runtime.enqueue({ id: 'pending', capability: 'simulation.step', payload: {}, estimatedCostMicros: 0, confidence: 1 });
    runtime.stop(); runtime.close(); runtime = new Runtime(options);
    await runtime.step();
    assert.equal(executions, 0);
  } finally { runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('extension policy cannot widen host capabilities', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rgi-policy-'));
  let executions = 0;
  const runtime = new Runtime({ dbPath: join(directory, 'runtime.db'), config: { allowedCapabilities: [], budgetMicros: 100 }, policy: () => ({ allowed: true, reason: 'untrusted_override' }), executor: { async execute() { executions++; return { output: null, actualCostMicros: 0 }; } } });
  try {
    runtime.enqueue({ id: 'override', capability: 'shell.exec', payload: {}, estimatedCostMicros: 0, confidence: 1 });
    await runtime.step();
    assert.equal(executions, 0);
  } finally { runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('executor mutation cannot corrupt accounting identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rgi-mutation-'));
  const runtime = new Runtime({ dbPath: join(directory, 'runtime.db'), config: { allowedCapabilities: ['simulation.step'], budgetMicros: 100 }, executor: { async execute(action) { action.id = 'wrong'; action.estimatedCostMicros = 90; return { output: null, actualCostMicros: 5 }; } } });
  try {
    runtime.enqueue({ id: 'original', capability: 'simulation.step', payload: {}, estimatedCostMicros: 10, confidence: 1 });
    await runtime.step();
    const state = runtime.status();
    assert.ok(state.reservedMicros >= 0);
    assert.equal(state.jobs.running ?? 0, 0);
    assert.equal((state.jobs.succeeded ?? 0) + (state.jobs.uncertain ?? 0), 1);
  } finally { runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});
