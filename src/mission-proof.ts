import {createHash, createPrivateKey, createPublicKey, sign, verify} from 'node:crypto';
import {types} from 'node:util';
import type {EvidenceSpec, MissionArm, MissionEvent, MissionExample, MissionProof, ReplayResult} from './mission-contracts.ts';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_DEPTH = 64;
const ARMS: readonly MissionArm[] = ['baseline', 'reset', 'retained'];
const KINDS = new Set(['begin', 'learn', 'snapshot', 'restart', 'restore', 'predict', 'end']);
const SHA256 = /^[a-f0-9]{64}$/;

function invalid(reason: string): never { throw new Error(`invalid_mission_proof:${reason}`); }

/** Deterministic UTF16 key ordering and JSON number/string encoding, not an RFC 8785 claim. */
export function canonicalJson(value: unknown): string {
  const chunks: string[] = [];
  const ancestors = new Set<object>();
  let bytes = 0, nodes = 0;
  function emit(chunk: string): void {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_BYTES) invalid('json_bytes');
    chunks.push(chunk);
  }
  function visit(item: unknown, depth: number): void {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) invalid('json_complexity');
    if (item === null) { emit('null'); return; }
    if (typeof item === 'boolean') { emit(item ? 'true' : 'false'); return; }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid('json_number');
      emit(JSON.stringify(item)); return;
    }
    if (typeof item === 'string') {
      if (item.length > MAX_BYTES) invalid('json_bytes');
      emit(JSON.stringify(item)); return;
    }
    if (typeof item !== 'object' || types.isProxy(item)) invalid('json_type');
    if (ancestors.has(item)) invalid('json_cycle');
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid('json_prototype');
    const keys = Reflect.ownKeys(item);
    if (keys.length > MAX_NODES || keys.some(key => typeof key !== 'string')) invalid('json_keys');
    ancestors.add(item);
    if (array) {
      if (item.length > MAX_NODES || keys.length !== item.length + 1) invalid('json_array');
      emit('[');
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid('json_descriptor');
        if (i) emit(',');
        visit(descriptor.value, depth + 1);
      }
      emit(']');
    } else {
      emit('{');
      (keys as string[]).sort().forEach((key, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!('value' in descriptor) || !descriptor.enumerable) invalid('json_descriptor');
        if (key.length > MAX_BYTES) invalid('json_bytes');
        if (index) emit(',');
        emit(JSON.stringify(key)); emit(':'); visit(descriptor.value, depth + 1);
      });
      emit('}');
    }
    ancestors.delete(item);
  }
  visit(value, 0);
  return chunks.join('');
}

export function hashValue(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('object');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== keys.length || actual.some((key, i) => key !== expected[i])) invalid('fields');
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function boundedMessage(value: unknown, spec: EvidenceSpec): void {
  if (Buffer.byteLength(canonicalJson(value)) > spec.maxMessageBytes) invalid('message_bytes');
}

/** Validate all host supplied declarations before exposing any audit query. */
export function validateEvidenceSpec(spec: EvidenceSpec): void {
  canonicalJson(spec);
  record(spec, ['id', 'artifactSha256', 'train', 'transfer', 'retention', 'maxRequests', 'timeoutMs', 'maxMessageBytes']);
  if (typeof spec.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(spec.id)) invalid('id');
  if (typeof spec.artifactSha256 !== 'string' || !SHA256.test(spec.artifactSha256)) invalid('artifact_sha256');
  if (!integer(spec.maxRequests, 1, 100_000) || !integer(spec.timeoutMs, 1, 60_000) ||
      !integer(spec.maxMessageBytes, 1024, 1024 * 1024)) invalid('limits');
  for (const examples of [spec.train, spec.transfer, spec.retention]) {
    if (!Array.isArray(examples) || examples.length < 1 || examples.length > 256) invalid('examples');
    for (const example of examples) {
      record(example, ['input', 'output']);
      boundedMessage(example.input, spec); boundedMessage(example.output, spec);
    }
  }
  boundedMessage(spec.train, spec);
  const trained = new Set(spec.train.map(example => canonicalJson(example.input)));
  if (trained.size !== spec.train.length) invalid('duplicate_training_input');
  const audited = new Set<string>();
  for (const example of [...spec.transfer, ...spec.retention]) {
    const input = canonicalJson(example.input);
    if (audited.has(input)) invalid('duplicate_audit_input');
    audited.add(input);
  }
  if ([...spec.transfer, ...spec.retention].some(example => trained.has(canonicalJson(example.input)))) invalid('train_audit_overlap');
  if (spec.maxRequests < 3 + spec.transfer.length + spec.retention.length) invalid('request_budget');
}

/** Append host observed data; final replay is required before treating the chain as complete. */
export function appendEvent(proof: MissionProof, arm: MissionArm, kind: MissionEvent['kind'], payload: unknown): void {
  if (proof.version !== 1 || !Array.isArray(proof.events) || proof.events.length >= 4096 || !ARMS.includes(arm) || !KINDS.has(kind)) invalid('append');
  if (proof.events.length === 0) validateEvidenceSpec(proof.spec);
  const previousHash = proof.events.at(-1)?.hash ?? hashValue({version: 1, spec: proof.spec});
  const body = {sequence: proof.events.length + 1, previousHash, arm, kind, payload: JSON.parse(canonicalJson(payload)) as unknown};
  proof.events.push({...body, hash: hashValue(body)});
}

/** Recompute control flow and scores. This validates receipts, not truthful execution. */
export function replayProof(proof: MissionProof): ReplayResult {
  canonicalJson(proof);
  record(proof, ['version', 'spec', 'events']);
  if (proof.version !== 1 || !Array.isArray(proof.events) || proof.events.length > 4096) invalid('version_events');
  validateEvidenceSpec(proof.spec);
  let previousHash = hashValue({version: 1, spec: proof.spec});
  for (const [index, event] of proof.events.entries()) {
    record(event, ['sequence', 'previousHash', 'hash', 'arm', 'kind', 'payload']);
    if (event.sequence !== index + 1 || event.previousHash !== previousHash || typeof event.hash !== 'string' || !SHA256.test(event.hash)) invalid('chain');
    const {hash, ...body} = event;
    if (hashValue(body) !== hash) invalid('event_hash');
    previousHash = hash;
  }
  let cursor = 0;
  function take(arm: MissionArm, kind: MissionEvent['kind'], keys: readonly string[]): Record<string, unknown> {
    const event = proof.events[cursor++];
    if (!event || event.arm !== arm || event.kind !== kind) invalid('control_flow');
    return record(event.payload, keys);
  }
  const arms: ReplayResult['arms'] = [];
  for (const arm of ARMS) {
    take(arm, 'begin', []);
    const learned = take(arm, 'learn', ['examples', 'result']);
    if (!same(learned.examples, proof.spec.train)) invalid('training_examples');
    boundedMessage(learned.result, proof.spec);
    const snapshot = take(arm, 'snapshot', ['state']).state;
    boundedMessage(snapshot, proof.spec);
    take(arm, 'restart', []);
    let requests = 2;
    if (arm === 'retained') {
      const restored = take(arm, 'restore', ['state']).state;
      if (!same(restored, snapshot)) invalid('restore_state');
      requests++;
    }
    function score(phase: 'transfer' | 'retention', examples: MissionExample[]): number {
      let correct = 0;
      for (const [index, example] of examples.entries()) {
        const prediction = take(arm, 'predict', ['phase', 'index', 'input', 'output']);
        if (prediction.phase !== phase || prediction.index !== index || !same(prediction.input, example.input)) invalid('prediction_query');
        boundedMessage(prediction.output, proof.spec);
        if (same(prediction.output, example.output)) correct++;
        requests++;
      }
      return correct;
    }
    const transferCorrect = score('transfer', proof.spec.transfer);
    const retentionCorrect = score('retention', proof.spec.retention);
    const end = take(arm, 'end', ['requests']);
    if (end.requests !== requests || requests > proof.spec.maxRequests) invalid('request_budget');
    arms.push({arm, requests, transferCorrect, transferTotal: proof.spec.transfer.length, retentionCorrect, retentionTotal: proof.spec.retention.length});
  }
  if (cursor !== proof.events.length) invalid('trailing_events');
  const [baseline, reset, retained] = arms;
  return {
    valid: true, rootHash: previousHash, arms,
    retainedImproves: retained!.transferCorrect > reset!.transferCorrect,
    retentionPassed: retained!.retentionCorrect >= Math.max(baseline!.retentionCorrect, reset!.retentionCorrect),
  };
}

export interface SignedMissionProof {
  version: 1;
  algorithm: 'Ed25519';
  proof: MissionProof;
  signature: string;
}

function signingBytes(proof: MissionProof): Buffer {
  return Buffer.from(`rgi.mission-proof.v1\n${canonicalJson(proof)}`);
}

export function signProof(proof: MissionProof, privateKeyPEM: string): SignedMissionProof {
  replayProof(proof);
  const privateKey = createPrivateKey(privateKeyPEM);
  if (privateKey.asymmetricKeyType !== 'ed25519') invalid('signing_key');
  const copy = JSON.parse(canonicalJson(proof)) as MissionProof;
  const envelope: SignedMissionProof = {version: 1, algorithm: 'Ed25519', proof: copy, signature: sign(null, signingBytes(copy), privateKey).toString('base64')};
  canonicalJson(envelope);
  return envelope;
}

/** Trust must be supplied by the verifier. The artifact cannot choose its own trusted signer. */
export function verifySignedProof(envelope: SignedMissionProof, expectedPublicKeyPEM: string): ReplayResult {
  canonicalJson(envelope);
  record(envelope, ['version', 'algorithm', 'proof', 'signature']);
  if (envelope.version !== 1 || envelope.algorithm !== 'Ed25519' || typeof envelope.signature !== 'string') invalid('signature_envelope');
  const publicKey = createPublicKey(expectedPublicKeyPEM);
  if (publicKey.asymmetricKeyType !== 'ed25519') invalid('signing_key');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signature ||
      !verify(null, signingBytes(envelope.proof), publicKey, signature)) invalid('signature');
  return replayProof(envelope.proof);
}
