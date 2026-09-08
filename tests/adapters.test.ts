import test from 'node:test';
import assert from 'node:assert/strict';
import { AgenticowExecutor } from '../src/adapters/agenticow.ts';
import { MetaHarnessExecutor } from '../src/adapters/metaharness.ts';
import { fromRuField } from '../src/adapters/rufield.ts';
import { RvcsiObservationAdapter } from '../src/adapters/rvcsi.ts';
import { predictConstantVelocity } from '../src/adapters/worldmodel.ts';
import { Runtime } from '../src/runtime.ts';
import type { Action } from '../src/contracts.ts';
const context = () => ({ signal: new AbortController().signal, idempotencyKey: 'test-action' });
const action = (capability: string, payload: Record<string, unknown>): Action => ({ id: 'a', capability, payload, estimatedCostMicros: 0, confidence: 1 });

test('agenticow forwards exact ingest and query signatures without filesystem authority', async () => {
  const calls: unknown[] = [];
  const adapter = new AgenticowExecutor({ dimension: 2,
    ingest(records) { calls.push(records); return { accepted: records.length, rejected: 0, epoch: 1 }; },
    query(vector, k) { calls.push([vector, k]); return [{ id: 2, distance: 0, branch: 'sandbox' }]; },
  });
  assert.deepEqual(await adapter.execute(action('memory.ingest', { id: 2, vector: [1, 0], text: 'evidence' }), context()), { output: { accepted: 1, rejected: 0, epoch: 1 }, actualCostMicros: 0 });
  await adapter.execute(action('memory.query', { vector: [1, 0], k: 3 }), context());
  assert.deepEqual(calls, [[{ id: 2, vector: [1, 0], text: 'evidence' }], [[1, 0], 3]]);
  await assert.rejects(adapter.execute(action('memory.query', { vector: [NaN, 0] }), context()), /Invalid vector/);
  await assert.rejects(adapter.execute(action('memory.query', { vector: [1, 0], k: 1000 }), context()), /limit/);
  await assert.rejects(adapter.execute(action('memory.promote', { vector: [1, 0] }), context()), /Unsupported/);
});

test('metaharness invokes only registered validated tools with reserved cost', async () => {
  let calls = 0;
  const adapter = new MetaHarnessExecutor([{ capability: 'analysis.echo', costMicros: 4,
    validate: p => typeof p.text === 'string' && Object.keys(p).length === 1,
    tool: { name: 'echo', server: 'local', description: 'Fixture echo', inputSchema: { type: 'object' }, handler: async p => { calls++; return p.text; } },
  }]);
  const a = { ...action('analysis.echo', { text: 'hello' }), estimatedCostMicros: 4 };
  assert.deepEqual(await adapter.execute(a, context()), { output: 'hello', actualCostMicros: 4 });
  await assert.rejects(adapter.execute({ ...a, estimatedCostMicros: 0 }, context()), /reservation/);
  await assert.rejects(adapter.execute({ ...a, estimatedCostMicros: NaN }, context()), /reservation/);
  await assert.rejects(adapter.execute({ ...a, payload: { text: 'hi', command: 'sh' } }, context()), /payload/);
  await assert.rejects(adapter.execute({ ...a, capability: 'shell.exec' }, context()), /Unregistered/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(adapter.execute(a, { ...context(), signal: controller.signal }));
  assert.equal(calls, 1);
});

test('metaharness rejects duplicate, handlerless, and invalid-cost registrations', () => {
  const entry = { capability: 'a', costMicros: 0, validate: () => true, tool: { name: 'a', server: 'a', description: 'a', inputSchema: {}, handler: async () => null } };
  assert.throws(() => new MetaHarnessExecutor([entry, entry]), /registration/);
  assert.throws(() => new MetaHarnessExecutor([{ ...entry, costMicros: -1 }]), /registration/);
  assert.throws(() => new MetaHarnessExecutor([{ ...entry, tool: { ...entry.tool, handler: undefined } }]), /registration/);
});

test('RuField preserves privacy, calibration, expiry and derived lineage', () => {
  const input = { sourceId: 'sensor-1', location: 'lab', kind: 'motion', value: { occupied: true }, confidence: 0.8, privacyClass: 'restricted' as const, calibrationVersion: 'v1', issuedAt: 100, expiresAt: 200,
    lineage: { origin: 'cognitum-spaces' as const, tenantId: 't', messageId: 'm', sequence: 1, provenance: 'p', derived: true as const } };
  const mapped = fromRuField('o1', input, 150, () => ({ admissible: true }));
  assert.deepEqual(mapped.data, input);
  assert.notEqual(mapped.data, input);
  assert.equal(mapped.source, 'sensor-1');
  assert.throws(() => fromRuField('o1', input, 200, () => ({ admissible: true })), /window/);
  assert.throws(() => fromRuField('o1', input, 150, () => ({ admissible: false, rejection: 'unhealthy-sensor' })), /unhealthy-sensor/);
});

test('rvCSI consumes actual PascalCase serde events and preserves nanosecond u64 precision', () => {
  const json = '[{"event_id":1,"session_id":2,"source_id":"sensor","kind":"MotionDetected","timestamp_ns":1788868800123456789,"confidence":0.8,"evidence_window_ids":[3],"calibration_version":"v1","metadata_json":"{}"}]';
  let seen: bigint | undefined;
  const adapter = new RvcsiObservationAdapter({ drainEventsJson: () => json }, ns => { seen = ns; return Number(ns / 1_000_000n); });
  const events = adapter.drain(context().signal);
  assert.equal(seen, 1788868800123456789n);
  assert.equal(events[0]!.timestamp, 1788868800123);
  assert.equal((events[0]!.data as { timestamp_ns: string }).timestamp_ns, '1788868800123456789');
  assert.match(events[0]!.id, /^rvcsi:[a-f0-9]{64}:2:1$/);
  for (const invalid of [json.replace('MotionDetected', 'motion_detected'), json.replace('[3]', '[]'), json.replace('0.8', '2.0')]) {
    assert.throws(() => new RvcsiObservationAdapter({ drainEventsJson: () => invalid }, () => 1).drain(context().signal));
  }
  assert.throws(() => new RvcsiObservationAdapter({ drainEventsJson: () => '[]' }, () => 1).drain(AbortSignal.abort()));
});

test('worldmodel TS baseline matches upstream trajectory and emits prediction, not observation', () => {
  const object = { id: 1, position: [0, 0, 0] as [number, number, number], velocity: [1, 0, 0] as [number, number, number], last_seen: 0, confidence: 0.9, label: 'obj_1' };
  const result = predictConstantVelocity(object, 2);
  assert.deepEqual(result.state.position, [2, 0, 0]);
  assert.equal(result.state.confidence, 0.9 / 1.4);
  assert.equal(result.state.time_horizon, 2);
  assert.equal(result.kind, 'prediction');
  assert.equal('modality' in result, false);
  assert.equal(predictConstantVelocity(object, 5).state.confidence, 0.45);
  assert.deepEqual(predictConstantVelocity(object, 0).state.position, object.position);
  for (const horizon of [-1, NaN, Infinity, 61]) assert.throws(() => predictConstantVelocity(object, horizon), /horizon/);
  assert.throws(() => predictConstantVelocity({ ...object, position: [NaN, 0, 0] }, 1), /vector/);
  assert.throws(() => predictConstantVelocity({ ...object, velocity: [Number.MAX_VALUE, 0, 0] }, 60), /overflow/);
});

test('rvCSI rejects oversized batch before mapping', () => {
  assert.throws(() => new RvcsiObservationAdapter({ drainEventsJson: () => ' '.repeat(1_048_577) }, () => 0).drain(context().signal), /large/);
  assert.throws(() => new RvcsiObservationAdapter({ drainEventsJson: () => JSON.stringify(Array(1025).fill(null)) }, () => 0).drain(context().signal), /batch/);
});

test('adapter observations cross actual Runtime.observe boundary', () => {
  const runtime = new Runtime({ dbPath: ':memory:', executor: { async execute() { return { output: null, actualCostMicros: 0 }; } } });
  try {
    const raw = { event_id: 1, session_id: 1, source_id: 'lab sensor @ west/北', kind: 'MotionDetected', timestamp_ns: 1000000, confidence: 0.8, evidence_window_ids: [1], calibration_version: 'v1', metadata_json: '{}' };
    const adapter = new RvcsiObservationAdapter({ drainEventsJson: () => JSON.stringify([raw]) }, () => 1);
    const observation = adapter.drain(context().signal)[0]!;
    assert.doesNotThrow(() => runtime.observe(observation));
    assert.equal((observation.data as { source_id: string }).source_id, raw.source_id);
    const field = { sourceId: 'sensor-1', location: 'lab', kind: 'motion', value: 1, confidence: 0.8, privacyClass: 'internal' as const, calibrationVersion: 'v1', issuedAt: 1, expiresAt: 10 };
    assert.doesNotThrow(() => runtime.observe(fromRuField('f1', field, 2, () => ({ admissible: true }))));
    assert.throws(() => fromRuField('f2', { ...field, sourceId: 'lab sensor @ west' }, 2, () => ({ admissible: true })), /invalid_identifier/);
    assert.throws(() => fromRuField('x'.repeat(129), field, 2, () => ({ admissible: true })), /invalid_identifier/);
    assert.throws(() => fromRuField('f3', { ...field, value: 'x'.repeat(65536) }, 2, () => ({ admissible: true })), /record_too_large/);
  } finally { runtime.close(); }
});
