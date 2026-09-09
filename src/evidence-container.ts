import { createHash, timingSafeEqual } from 'node:crypto';

/** Format compatibility is pinned; rGi's payload schema is an application profile. */
export const EVIDENCE_FORMAT = Object.freeze({
  schema: 'rgi.replay-evidence/1',
  manifestSchema: 'rgi.evidence-manifest/1',
  rvfVersion: 1,
  ruvectorCommit: 'edaffffb3b85768eb1f3ec1f683b7f46f0506af4',
  rvmCommit: '0973d77e5a9e99065376e8ef772a4a1d16e88c75',
  executable: false,
  authenticated: false,
  maxPayloadBytes: 16 * 1024 * 1024,
  maxContainerBytes: 16 * 1024 * 1024 + 8192,
});

const HEADER = 64;
const ROOT = 4096;
const META = 0x07;
const MANIFEST = 0x05;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0x82f63b78 : 0);
  return c >>> 0;
});
const align = (n: number): number => Math.ceil(n / HEADER) * HEADER;
const shake = (bytes: Uint8Array): Buffer => createHash('shake256', { outputLength: 16 }).update(bytes).digest();
const sha = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest();

function crc32c(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (c >>> 8) ^ CRC_TABLE[(c ^ byte) & 255]!;
  return (c ^ 0xffffffff) >>> 0;
}

/** Strict deterministic JSON; no coercion, getters, cycles or silent dropped fields. */
function canonical(value: unknown): Buffer {
  const active = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  function account(text: string): string {
    bytes += Buffer.byteLength(text);
    if (bytes > EVIDENCE_FORMAT.maxPayloadBytes) throw new Error('evidence_payload_too_large');
    return text;
  }
  function visit(v: unknown, depth: number): string {
    if (++nodes > 500_000 || depth > 64) throw new Error('evidence_structure_limit');
    if (v === null) return account('null');
    if (typeof v === 'boolean') return account(v ? 'true' : 'false');
    if (typeof v === 'string') {
      if (Buffer.byteLength(v) > EVIDENCE_FORMAT.maxPayloadBytes) throw new Error('evidence_payload_too_large');
      return account(JSON.stringify(v));
    }
    if (typeof v === 'number' && Number.isFinite(v)) return account(JSON.stringify(v));
    if (typeof v !== 'object' || active.has(v)) throw new Error('invalid_evidence_json');
    const prototype = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && prototype !== Object.prototype && prototype !== null) throw new Error('invalid_evidence_json');
    if (Object.getOwnPropertySymbols(v).length) throw new Error('invalid_evidence_json');
    active.add(v);
    let result: string;
    if (Array.isArray(v)) {
      if (prototype !== Array.prototype || v.length > 500_000 || Object.keys(v).length !== v.length ||
          Object.getOwnPropertyNames(v).length !== v.length + 1) throw new Error('invalid_evidence_json');
      const values: string[] = [];
      for (let i = 0; i < v.length; i++) {
        const property = Object.getOwnPropertyDescriptor(v, String(i));
        if (!property || !('value' in property)) throw new Error('invalid_evidence_json');
        values.push(visit(property.value, depth + 1));
      }
      account('[]' + ','.repeat(Math.max(0, values.length - 1)));
      result = '[' + values.join(',') + ']';
    } else {
      const keys = Object.getOwnPropertyNames(v).sort();
      const values: string[] = [];
      for (const key of keys) {
        if (++nodes > 500_000) throw new Error('evidence_structure_limit');
        const property = Object.getOwnPropertyDescriptor(v, key)!;
        if (!property.enumerable || !('value' in property)) throw new Error('invalid_evidence_json');
        values.push(account(JSON.stringify(key) + ':') + visit(property.value, depth + 1));
      }
      account('{}' + ','.repeat(Math.max(0, values.length - 1)));
      result = '{' + values.join(',') + '}';
    }
    active.delete(v);
    return result;
  }
  return Buffer.from(visit(value, 0));
}

/** Bound nesting and lexical tokens before JSON.parse allocates the value graph. */
function checkJsonAllocation(bytes: Uint8Array): void {
  let depth = 0;
  let tokens = 0;
  let quoted = false;
  let escaped = false;
  let primitive = false;
  for (const byte of bytes) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) quoted = false;
      continue;
    }
    if (byte === 0x22) { quoted = true; primitive = false; tokens++; }
    else if (byte === 0x5b || byte === 0x7b) { depth++; primitive = false; tokens++; }
    else if (byte === 0x5d || byte === 0x7d) { depth--; primitive = false; }
    else if (byte === 0x2c || byte === 0x3a || byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) primitive = false;
    else if (!primitive) { primitive = true; tokens++; }
    if (depth > 65 || tokens > 500_000) throw new Error('evidence_structure_limit');
  }
}

function segment(type: number, payload: Buffer, id: number): Buffer {
  const result = Buffer.alloc(align(HEADER + payload.length));
  result.writeUInt32LE(0x52564653, 0);
  result[4] = 1;
  result[5] = type;
  result.writeBigUInt64LE(BigInt(id), 8);
  result.writeBigUInt64LE(BigInt(payload.length), 16);
  result[32] = 2; // SHAKE256, first 128 bits: the upstream RVF enum.
  shake(payload).copy(result, 40);
  result.writeUInt32LE(result.length - HEADER - payload.length, 60);
  payload.copy(result, HEADER);
  return result;
}

function rootPage(fileId: Buffer, offset: number, length: number): Buffer {
  const page = Buffer.alloc(ROOT);
  page.writeUInt32LE(0x52564d30, 0);
  page.writeUInt16LE(1, 4);
  page.writeBigUInt64LE(BigInt(offset), 8);
  page.writeBigUInt64LE(BigInt(length), 16);
  page[0x22] = 1; // f32, with zero vectors and zero dimensions.
  page.writeUInt32LE(1, 0x24);
  fileId.copy(page, 0xf00);
  page.writeUInt32LE(crc32c(page.subarray(0, 0xffc)), 0xffc);
  return page;
}

function manifestFor(payload: Buffer, digest = sha(payload)): Buffer {
  return canonical({
    schema: EVIDENCE_FORMAT.manifestSchema,
    profile: EVIDENCE_FORMAT.schema,
    capabilities: [],
    executable: false,
    payload: { segmentId: 1, type: 'meta', bytes: payload.length, sha256: digest.toString('hex') },
  });
}

/** Genuine RVF v1 metadata + manifest segments and a 4096 byte root page. */
export function packEvidence(payload: unknown): Buffer {
  const data = canonical({ schema: EVIDENCE_FORMAT.schema, payload });
  const digest = sha(data);
  const meta = segment(META, data, 1);
  const manifest = segment(MANIFEST, manifestFor(data, digest), 2);
  const page = rootPage(digest.subarray(0, 16), meta.length, manifest.length);
  return Buffer.concat([meta, manifest, page]);
}

function readSegment(input: Buffer, offset: number, expectedType: number, id: number, bodyEnd: number): { payload: Buffer; end: number } {
  if (offset + HEADER > bodyEnd) throw new Error('truncated_evidence_segment');
  const header = input.subarray(offset, offset + HEADER);
  if (header.readUInt32LE(0) !== 0x52564653 || header[4] !== 1 || header[5] !== expectedType ||
      header.readUInt16LE(6) !== 0 || header.readBigUInt64LE(8) !== BigInt(id) ||
      header.readBigUInt64LE(24) !== 0n || header[32] !== 2 || header[33] !== 0 ||
      header.readUInt16LE(34) !== 0 || header.readUInt32LE(36) !== 0 || header.readUInt32LE(56) !== 0) {
    throw new Error('unsupported_evidence_segment');
  }
  const length = header.readBigUInt64LE(16);
  if (length > BigInt(EVIDENCE_FORMAT.maxPayloadBytes) || length > BigInt(bodyEnd - offset - HEADER)) {
    throw new Error('evidence_segment_bounds');
  }
  const payloadEnd = offset + HEADER + Number(length);
  const end = align(payloadEnd);
  if (end > bodyEnd || header.readUInt32LE(60) !== end - payloadEnd) throw new Error('evidence_segment_bounds');
  if (input.subarray(payloadEnd, end).some(byte => byte !== 0)) throw new Error('evidence_padding');
  const payload = input.subarray(offset + HEADER, payloadEnd);
  if (!timingSafeEqual(shake(payload), header.subarray(40, 56))) throw new Error('evidence_hash_mismatch');
  return { payload, end };
}

/** Strict rGi evidence profile reader. Other valid RVF profiles are rejected. */
export function unpackEvidence(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < ROOT + HEADER * 2 ||
      bytes.byteLength > EVIDENCE_FORMAT.maxContainerBytes || bytes.byteLength % HEADER !== 0 ||
      bytes.buffer instanceof SharedArrayBuffer) throw new Error('evidence_container_bounds');
  // Own the snapshot: the caller cannot change bytes during verification.
  const input = Buffer.from(bytes);
  const bodyEnd = input.length - ROOT;
  const data = readSegment(input, 0, META, 1, bodyEnd);
  const manifest = readSegment(input, data.end, MANIFEST, 2, bodyEnd);
  if (manifest.end !== bodyEnd) throw new Error('unexpected_evidence_segments');
  const digest = sha(data.payload);
  const expectedManifest = manifestFor(data.payload, digest);
  if (manifest.payload.length !== expectedManifest.length || !timingSafeEqual(manifest.payload, expectedManifest)) throw new Error('evidence_manifest_mismatch');
  const expectedRoot = rootPage(digest.subarray(0, 16), data.end, manifest.end - data.end);
  if (!timingSafeEqual(input.subarray(bodyEnd), expectedRoot)) throw new Error('evidence_root_mismatch');
  checkJsonAllocation(data.payload);
  let envelope: unknown;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.payload)); }
  catch { throw new Error('invalid_evidence_json'); }
  const canonicalData = canonical(envelope);
  if (canonicalData.length !== data.payload.length || !timingSafeEqual(canonicalData, data.payload)) throw new Error('noncanonical_evidence_json');
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope) ||
      Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, 'payload') ||
      (envelope as { schema?: unknown }).schema !== EVIDENCE_FORMAT.schema) throw new Error('invalid_evidence_schema');
  return (envelope as { payload: unknown }).payload;
}

/** External publication of this digest anchors identity; embedded hashes alone do not. */
export function evidenceIdentity(bytes: Uint8Array): string {
  unpackEvidence(bytes);
  return sha(bytes).toString('hex');
}

/** RVM's pinned low level inspector accepts segments, without the rvforge root page. */
export function rvmEvidenceSegments(bytes: Uint8Array): Buffer {
  unpackEvidence(bytes);
  return Buffer.from(bytes.subarray(0, bytes.length - ROOT));
}

/** Read the same evidence profile through RVM's segment stream transport. */
export function unpackRvmEvidence(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER * 2 ||
      bytes.byteLength > EVIDENCE_FORMAT.maxContainerBytes - ROOT || bytes.byteLength % HEADER !== 0 ||
      bytes.buffer instanceof SharedArrayBuffer) throw new Error('evidence_container_bounds');
  const input = Buffer.from(bytes);
  const data = readSegment(input, 0, META, 1, input.length);
  const manifest = readSegment(input, data.end, MANIFEST, 2, input.length);
  if (manifest.end !== input.length) throw new Error('unexpected_evidence_segments');
  const page = rootPage(sha(data.payload).subarray(0, 16), data.end, manifest.end - data.end);
  return unpackEvidence(Buffer.concat([input, page]));
}
