import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { EVIDENCE_FORMAT, evidenceIdentity, packEvidence, rvmEvidenceSegments, unpackEvidence, unpackRvmEvidence } from '../src/evidence-container.ts';

const BLOBS: Record<string, string> = {
  'rvf': '9d4b28cdcaeceabda49f526d772b9c934ddc6760',
  'rvf-writer': '568f3dd69ba9aa83cb432a5ef810ef121981bcd9',
  'validate': 'a25345aa91c54a9881e0cd95e69aee1bbfd8c516',
  'hash': 'e044e58c11fe7bbe4e367de1cb60f0c250d35eea',
  'errors': '565571d3a0d7ba80a34a3474fbf5152b513ccf96',
};
const urls = new Map<string, string>();
async function upstreamUrl(name: string): Promise<string> {
  if (urls.has(name)) return urls.get(name)!;
  const source = await readFile(new URL(`../vendor/rvforge/${name}.ts.source`, import.meta.url));
  // The unmodified upstream source must match its pinned Git blob, before it runs.
  const blob = createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
  assert.equal(blob, BLOBS[name]);
  let output = ts.transpileModule(source.toString(), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText;
  const imports = [...output.matchAll(/from ['"]\.\/([^'"]+)['"]/g)];
  for (const match of imports) output = output.replace(match[0], `from ${JSON.stringify(await upstreamUrl(match[1]!))}`);
  const url = 'data:text/javascript;base64,' + Buffer.from(output).toString('base64');
  urls.set(name, url);
  return url;
}

function sortedJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(sortedJson).join(',') + ']';
  if (v !== null && typeof v === 'object') return '{' + Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, value]) => JSON.stringify(k) + ':' + sortedJson(value)).join(',') + '}';
  return JSON.stringify(v);
}

async function upstreamPack(data: Buffer): Promise<Buffer> {
  const writer = await import(await upstreamUrl('rvf-writer'));
  const sha = createHash('sha256').update(data).digest();
  const meta = writer.writeSegment(7, data, 1);
  const manifest = writer.writeSegment(5, Buffer.from(sortedJson({
    schema: EVIDENCE_FORMAT.manifestSchema, profile: EVIDENCE_FORMAT.schema,
    capabilities: [], executable: false,
    payload: { segmentId: 1, type: 'meta', bytes: data.length, sha256: sha.toString('hex') },
  })), 2);
  return Buffer.concat([meta, manifest, writer.rootManifestPage(sha.subarray(0, 16), meta.length, manifest.length)]);
}

test('RVF evidence has deterministic canonical bytes and preserves JSON data', () => {
  const payload = { z: [null, true, 1.5, 'λ'], a: { failed: false } };
  const bytes = packEvidence(payload);
  assert.deepEqual(unpackEvidence(bytes), payload);
  assert.deepEqual(packEvidence({ a: { failed: false }, z: payload.z }), bytes);
  assert.equal(bytes.subarray(0, 4).toString('hex'), '53465652');
  assert.equal(bytes.subarray(bytes.length - 4096, bytes.length - 4092).toString('hex'), '304d5652');
  assert.equal(bytes.length % 64, 0);
  assert.equal(evidenceIdentity(bytes), createHash('sha256').update(bytes).digest('hex'));
});

test('production output equals the pinned upstream RVForge writer byte for byte', async () => {
  for (const payload of [null, {}, { receipt: 'ok', rewards: [0, 1] }, 'x'.repeat(129)]) {
    const reference = await upstreamPack(Buffer.from(sortedJson({ schema: EVIDENCE_FORMAT.schema, payload })));
    assert.deepEqual(packEvidence(payload), reference);
    assert.deepEqual(unpackEvidence(reference), payload);
  }
});

test('the actual pinned upstream file validator accepts evidence and sees no executable code', async () => {
  const validator = await import(await upstreamUrl('validate'));
  const directory = await mkdtemp(join(tmpdir(), 'rgi-upstream-rvf-'));
  try {
    const file = join(directory, 'evidence.rvf');
    const bytes = packEvidence({ episodes: [{ id: 'a', outcome: true }] });
    await writeFile(file, bytes);
    const result = await validator.validateRvf(file, { deep: true });
    assert.equal(result.ok, true);
    assert.equal(result.segments.count, 2);
    assert.equal(result.segments.executableCount, 0);
    assert.deepEqual(result.segments.byType, { meta: 1, manifest: 1 });
    assert.equal(result.identity.sha256, evidenceIdentity(bytes));
    assert.equal(result.root.signaturePresent, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('all segment header bytes are covered by canonical profile checks or content identity', () => {
  const bytes = packEvidence({ receipt: 'ok' });
  for (let i = 0; i < 64; i++) {
    const changed = Buffer.from(bytes);
    changed[i] = changed[i]! ^ 1;
    assert.throws(() => unpackEvidence(changed), `header byte ${i}`);
  }
});

test('payload, padding, manifest, root and appended data changes fail closed', () => {
  const bytes = packEvidence({ receipt: 'ok' });
  const payloadLength = Number(bytes.readBigUInt64LE(16));
  const second = Math.ceil((64 + payloadLength) / 64) * 64;
  for (const i of [64, 64 + payloadLength, second + 64, bytes.length - 4096, bytes.length - 1]) {
    const changed = Buffer.from(bytes);
    changed[i] = changed[i]! ^ 1;
    assert.throws(() => unpackEvidence(changed));
  }
  assert.throws(() => unpackEvidence(Buffer.concat([bytes, Buffer.alloc(64)])));
  for (const length of [0, 1, 63, 4096, bytes.length - 64, bytes.length - 1]) assert.throws(() => unpackEvidence(bytes.subarray(0, length)));
});

test('strict JSON rejects aliases, getters, nonfinite values, cycles and sparse arrays', () => {
  let calls = 0;
  const getter = { get value() { calls++; return 1; } };
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const hidden = [1]; Object.defineProperty(hidden, 'hidden', { value: 2 });
  for (const value of [undefined, NaN, Infinity, 1n, () => 1, new Date(), new Map(), getter, cyclic, Array(2), hidden, { a: undefined }]) {
    assert.throws(() => packEvidence(value));
  }
  assert.equal(calls, 0);
  assert.throws(() => packEvidence('x'.repeat(EVIDENCE_FORMAT.maxPayloadBytes + 1)), /too_large/);
  let deep: unknown = null;
  for (let i = 0; i < 70; i++) deep = { deep };
  assert.throws(() => packEvidence(deep), /structure_limit/);
});

test('valid hashes cannot disguise malformed UTF8, duplicate keys or wrong application schema', async () => {
  for (const data of [
    Buffer.from([0xff]),
    Buffer.from('{"payload":1,"payload":2,"schema":"rgi.replay-evidence/1"}'),
    Buffer.from('{"payload":1,"schema":"wrong"}'),
    Buffer.from('{ "payload":1,"schema":"rgi.replay-evidence/1"}'),
  ]) {
    const container = await upstreamPack(data);
    assert.throws(() => unpackEvidence(container), /json|schema/);
  }
});

test('valid checksums cannot bypass JSON allocation limits', async () => {
  for (const data of [
    '['.repeat(70) + '0' + ']'.repeat(70),
    '[' + '0,'.repeat(500_000) + '0]',
  ]) {
    const container = await upstreamPack(Buffer.from(data));
    assert.throws(() => unpackEvidence(container), /structure_limit/);
  }
});

test('RVM segment inspection input is an RVF stream, never a renamed executable image', () => {
  const bytes = packEvidence({ verified: false });
  const stream = rvmEvidenceSegments(bytes);
  assert.deepEqual(stream, bytes.subarray(0, bytes.length - 4096));
  assert.deepEqual(unpackRvmEvidence(stream), { verified: false });
  assert.equal(stream[5], 7);
  stream[0] = 0;
  assert.throws(() => unpackRvmEvidence(stream));
  assert.equal(bytes[0], 0x53);
  assert.equal(EVIDENCE_FORMAT.executable, false);
  assert.equal(EVIDENCE_FORMAT.authenticated, false);
});

test('RVM evidence rejects full containers, truncation, appended segments and payload tampering', () => {
  const bytes = packEvidence({ experiment: 1 });
  const stream = rvmEvidenceSegments(bytes);
  assert.throws(() => unpackRvmEvidence(bytes));
  assert.throws(() => unpackRvmEvidence(stream.subarray(0, stream.length - 64)));
  assert.throws(() => unpackRvmEvidence(Buffer.concat([stream, Buffer.alloc(64)])));
  stream[64] = stream[64]! ^ 1;
  assert.throws(() => unpackRvmEvidence(stream), /hash/);
});

test('shared backing buffers and oversized declared lengths are rejected before parsing payloads', () => {
  assert.throws(() => unpackEvidence(new Uint8Array(new SharedArrayBuffer(8192))), /bounds/);
  const bytes = packEvidence({ test: 1 });
  bytes.writeBigUInt64LE(0xffffffffffffffffn, 16);
  assert.throws(() => unpackEvidence(bytes), /bounds/);
});
