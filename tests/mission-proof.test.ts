import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {appendEvent, canonicalJson, hashValue, replayProof, signProof, validateEvidenceSpec, verifySignedProof} from '../src/mission-proof.ts';
import type {EvidenceSpec, MissionArm, MissionProof} from '../src/mission-contracts.ts';

function spec(): EvidenceSpec {
  return {id: 'proof-test', artifactSha256: 'a'.repeat(64), train: [{input: 1, output: 2}],
    transfer: [{input: 2, output: 4}, {input: 3, output: 6}], retention: [{input: 4, output: 8}],
    maxRequests: 6, timeoutMs: 1000, maxMessageBytes: 4096};
}
function proof(): MissionProof {
  const result: MissionProof = {version: 1, spec: spec(), events: []};
  for (const arm of ['baseline', 'reset', 'retained'] as MissionArm[]) {
    appendEvent(result, arm, 'begin', {});
    appendEvent(result, arm, 'learn', {examples: result.spec.train, result: {learned: true}});
    appendEvent(result, arm, 'snapshot', {state: {factor: 2}});
    appendEvent(result, arm, 'restart', {});
    if (arm === 'retained') appendEvent(result, arm, 'restore', {state: {factor: 2}});
    for (const phase of ['transfer', 'retention'] as const) {
      result.spec[phase].forEach((example, index) => appendEvent(result, arm, 'predict', {
        phase, index, input: example.input, output: phase === 'retention' || arm === 'retained' ? example.output : null,
      }));
    }
    appendEvent(result, arm, 'end', {requests: arm === 'retained' ? 6 : 5});
  }
  return result;
}
function rechain(value: MissionProof): void {
  const previous = value.events;
  value.events = [];
  for (const event of previous) appendEvent(value, event.arm, event.kind, event.payload);
}

test('canonical JSON ignores key insertion order and preserves valid values', () => {
  assert.equal(canonicalJson({z: -0, a: [null, true, 'a\n']}), '{"a":[null,true,"a\\n"],"z":0}');
  assert.equal(hashValue({b: 2, a: 1}), hashValue({a: 1, b: 2}));
  assert.equal(canonicalJson(Object.assign(Object.create(null), {a: 1})), '{"a":1}');
});

test('canonical JSON rejects ambiguous values without invoking accessors or proxies', () => {
  let invoked = false;
  const accessor = {get x() {invoked = true; return 1;}};
  const proxy = new Proxy({}, {ownKeys() {invoked = true; return [];}});
  const extraArray = [1]; Object.assign(extraArray, {hidden: 2});
  const cycle: unknown[] = []; cycle.push(cycle);
  for (const value of [NaN, Infinity, -Infinity, undefined, 1n, () => 1, Symbol(), new Date(),
    accessor, proxy, extraArray, cycle, Array(1), {a: undefined}, {[Symbol()]: 1}, Object.defineProperty({}, 'hidden', {value: 1})]) {
    assert.throws(() => canonicalJson(value), /invalid_mission_proof/);
  }
  assert.equal(invoked, false);
  let deep: unknown = 0; for (let i = 0; i < 66; i++) deep = [deep];
  assert.throws(() => canonicalJson(deep), /json_complexity/);
  assert.throws(() => canonicalJson('x'.repeat(8 * 1024 * 1024)), /json_bytes/);
});

test('replay recomputes sequential scores and budgets with a stable chain', () => {
  const result = replayProof(proof());
  assert.deepEqual(result.arms.map(arm => [arm.requests, arm.transferCorrect, arm.retentionCorrect]), [[5, 0, 1], [5, 0, 1], [6, 2, 1]]);
  assert.equal(result.retainedImproves, true);
  assert.equal(result.retentionPassed, true);
  assert.match(result.rootHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(result, replayProof(JSON.parse(canonicalJson(proof())) as MissionProof));
});

test('appended payloads cannot be mutated through caller references', () => {
  const value: MissionProof = {version: 1, spec: spec(), events: []};
  const payload = {x: 1}; appendEvent(value, 'baseline', 'begin', payload); payload.x = 2;
  assert.deepEqual(value.events[0]!.payload, {x: 1});
});

test('replay rejects tampering, chain changes and truncation', () => {
  const tampered = proof(); (tampered.events[4]!.payload as {output: unknown}).output = 4;
  assert.throws(() => replayProof(tampered), /event_hash/);
  const previous = proof(); previous.events[0]!.previousHash = 'b'.repeat(64);
  assert.throws(() => replayProof(previous), /chain/);
  const sequence = proof(); sequence.events[1]!.sequence = 1;
  assert.throws(() => replayProof(sequence), /chain/);
  const truncated = proof(); truncated.events.pop();
  assert.throws(() => replayProof(truncated), /control_flow/);
  const empty = proof(); empty.events = [];
  assert.throws(() => replayProof(empty), /control_flow/);
});

test('even rehashed proofs reject reordered arms and wrong queries', () => {
  const order = proof(); order.events[0]!.arm = 'reset'; rechain(order);
  assert.throws(() => replayProof(order), /control_flow/);
  const input = proof(); (input.events[4]!.payload as {input: unknown}).input = 999; rechain(input);
  assert.throws(() => replayProof(input), /prediction_query/);
  const index = proof(); (index.events[4]!.payload as {index: number}).index = 1; rechain(index);
  assert.throws(() => replayProof(index), /prediction_query/);
  const phase = proof(); (phase.events[4]!.payload as {phase: string}).phase = 'retention'; rechain(phase);
  assert.throws(() => replayProof(phase), /prediction_query/);
});

test('replay rejects answer disclosure in prediction payload and undeclared fields', () => {
  const value = proof(); Object.assign(value.events[4]!.payload as object, {expectedOutput: 4}); rechain(value);
  assert.throws(() => replayProof(value), /fields/);
  const extra = proof(); Object.assign(extra, {passed: true});
  assert.throws(() => replayProof(extra), /fields/);
  const trailing = proof(); appendEvent(trailing, 'retained', 'end', {requests: 6});
  assert.throws(() => replayProof(trailing), /trailing_events/);
});

test('replay rejects substituted training, restore mismatch and oversized snapshots', () => {
  const training = proof(); (training.events[1]!.payload as {examples: unknown}).examples = []; rechain(training);
  assert.throws(() => replayProof(training), /training_examples/);
  const restore = proof(); const event = restore.events.find(item => item.kind === 'restore')!;
  event.payload = {state: {factor: 3}}; rechain(restore);
  assert.throws(() => replayProof(restore), /restore_state/);
  const snapshot = proof(); snapshot.events[2]!.payload = {state: 'x'.repeat(5000)}; rechain(snapshot);
  assert.throws(() => replayProof(snapshot), /message_bytes/);
  const missingRestore = proof(); missingRestore.events = missingRestore.events.filter(item => item.kind !== 'restore'); rechain(missingRestore);
  assert.throws(() => replayProof(missingRestore), /control_flow/);
});

test('spec and replay reject insufficient budgets and falsified request receipts', () => {
  const insufficient = spec(); insufficient.maxRequests = 5;
  assert.throws(() => validateEvidenceSpec(insufficient), /request_budget/);
  const receipt = proof(); receipt.events.find(event => event.kind === 'end')!.payload = {requests: 4}; rechain(receipt);
  assert.throws(() => replayProof(receipt), /request_budget/);
  for (const [key, value] of [['maxRequests', NaN], ['timeoutMs', 60001], ['maxMessageBytes', 1023], ['artifactSha256', 'unbound'], ['id', '']] as const) {
    const invalid = {...spec(), [key]: value};
    assert.throws(() => validateEvidenceSpec(invalid), /invalid_mission_proof/);
  }
});

test('every phase is populated and train inputs cannot overlap either audit phase', () => {
  for (const phase of ['train', 'transfer', 'retention'] as const) {
    const empty = spec(); empty[phase] = [];
    assert.throws(() => validateEvidenceSpec(empty), /examples/);
  }
  for (const phase of ['transfer', 'retention'] as const) {
    const overlap = spec(); overlap[phase][0]!.input = 1;
    assert.throws(() => validateEvidenceSpec(overlap), /train_audit_overlap/);
  }
  const canonicalOverlap = spec(); canonicalOverlap.train[0]!.input = {a: 1, b: 2};
  canonicalOverlap.transfer[0]!.input = {b: 2, a: 1};
  assert.throws(() => validateEvidenceSpec(canonicalOverlap), /train_audit_overlap/);
});

test('duplicate inputs are rejected within every phase and across both audit phases', () => {
  for (const phase of ['train', 'transfer', 'retention'] as const) {
    const repeated = spec();
    repeated[phase].push({input: repeated[phase][0]!.input, output: 'changed answer'});
    assert.throws(() => validateEvidenceSpec(repeated), phase === 'train' ? /duplicate_training_input/ : /duplicate_audit_input/);
  }
  const acrossAudit = spec(); acrossAudit.retention[0]!.input = acrossAudit.transfer[0]!.input;
  assert.throws(() => validateEvidenceSpec(acrossAudit), /duplicate_audit_input/);
  const canonicalDuplicate = spec(); canonicalDuplicate.transfer[0]!.input = {a: 1, b: 2};
  canonicalDuplicate.retention[0]!.input = {b: 2, a: 1};
  assert.throws(() => validateEvidenceSpec(canonicalDuplicate), /duplicate_audit_input/);
});

test('retention regression is reported independently from transfer gain', () => {
  const value = proof(); const lastPrediction = value.events.findLast(event => event.kind === 'predict')!;
  (lastPrediction.payload as {output: unknown}).output = null; rechain(value);
  const result = replayProof(value);
  assert.equal(result.retainedImproves, true); assert.equal(result.retentionPassed, false);
});

test('Ed25519 verification requires a pinned external signer and binds the full proof', () => {
  const signer = generateKeyPairSync('ed25519');
  const privatePEM = signer.privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
  const publicPEM = signer.publicKey.export({type: 'spki', format: 'pem'}).toString();
  const value = proof(); const envelope = signProof(value, privatePEM);
  assert.deepEqual(verifySignedProof(envelope, publicPEM), replayProof(value));
  value.spec.id = 'changed-outside-envelope';
  assert.equal(verifySignedProof(envelope, publicPEM).valid, true);
  const other = generateKeyPairSync('ed25519').publicKey.export({type: 'spki', format: 'pem'}).toString();
  assert.throws(() => verifySignedProof(envelope, other), /signature/);
  envelope.proof.spec.id = 'tampered';
  assert.throws(() => verifySignedProof(envelope, publicPEM), /signature/);
  const unsigned = signProof(proof(), privatePEM); unsigned.signature += '\n';
  assert.throws(() => verifySignedProof(unsigned, publicPEM), /signature/);
});
