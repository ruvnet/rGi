import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVIDENCE_FORMAT, unpackRvmEvidence } from '../src/evidence-container.ts';

const path = process.argv[2] ?? 'artifacts/mission.rvm.rvf';
const info = await stat(path);
if (!info.isFile() || info.size > EVIDENCE_FORMAT.maxContainerBytes) throw new Error('rvm_oracle_input_bounds');
const bytes = await readFile(path);
unpackRvmEvidence(bytes);

async function pinned(name: string, expected: string): Promise<string> {
  const source = await readFile(new URL(`../vendor/rvm/${name}.rs.source`, import.meta.url));
  const blob = createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
  if (blob !== expected) throw new Error('rvm_oracle_source_identity');
  return source.toString();
}

const fullContainer = await pinned('container', 'bdf5b15668499147c504cee67caecb8eba9fc7c7');
const fullFormat = await pinned('format', '4f975c3c029d894b9665de30d77f14b8db4eb07b');
const tests = '\n#[cfg(test)]';
const signing = '/// Build the canonical message an Ed25519 segment signature covers.';
const alignment = '/// Round `n` up to the next 64-byte segment boundary.';
if (!fullContainer.includes(tests) || !fullFormat.includes(tests) || !fullFormat.includes(signing) || !fullFormat.includes(alignment)) {
  throw new Error('rvm_oracle_source_layout');
}
// Extract the actual parsing functions unchanged. Signature message construction
// is outside this structural inspection gate, so it and upstream unit tests are
// omitted. Only the dependency free error enum is supplied by this thin wrapper.
const container = fullContainer.slice(0, fullContainer.indexOf(tests));
const format = fullFormat.slice(0, fullFormat.indexOf(signing)) +
  fullFormat.slice(fullFormat.indexOf(alignment), fullFormat.indexOf(tests));
const rust = `#![allow(dead_code)]
extern crate alloc;
mod error {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum RvfError {
        BadMagic, Truncated, UnsupportedVersion(u8), PayloadOutOfBounds,
        PayloadTooLarge, MalformedFooter, SignedFlagWithoutFooter, NoSegments,
        TrailingBytes, TooManySegments, NoForwardProgress,
    }
    pub type RvfResult<T> = core::result::Result<T, RvfError>;
}
mod format {
${format}
}
mod container {
${container}
}
fn main() {
    let path = std::env::args().nth(1).expect("file argument required");
    let bytes = std::fs::read(path).expect("read evidence");
    assert!(bytes.len() <= 16 * 1024 * 1024 + 8192, "file bound");
    let segments = container::walk(&bytes).expect("upstream RVM parser rejected evidence");
    assert_eq!(segments.len(), 2);
    assert_eq!(segments[0].header.seg_type, format::SEG_TYPE_META);
    assert_eq!(segments[1].header.seg_type, format::SEG_TYPE_MANIFEST);
    assert_eq!(segments[0].header.segment_id, 1);
    assert_eq!(segments[1].header.segment_id, 2);
    assert!(segments.iter().all(|s| !s.is_executable() && !s.is_signed()));
    assert!(container::root_manifest(&segments).is_some());
    println!("accepted: 2 data segments; 0 executable segments");
}
`;

const directory = await mkdtemp(join(tmpdir(), 'rgi-rvm-oracle-'));
try {
  const sourcePath = join(directory, 'inspect.rs');
  const executable = join(directory, process.platform === 'win32' ? 'inspect.exe' : 'inspect');
  const input = join(directory, 'mission.rvm.rvf');
  await writeFile(sourcePath, rust);
  await writeFile(input, bytes);
  const compiler = execFileSync('rustc', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  execFileSync('rustc', ['--edition=2021', '-O', sourcePath, '-o', executable], { encoding: 'utf8', timeout: 60_000 });
  const result = execFileSync(executable, [input], { encoding: 'utf8', timeout: 10_000 }).trim();
  for (const mutation of ['magic', 'length'] as const) {
    const corrupted = Buffer.from(bytes);
    if (mutation === 'magic') corrupted[0] = 0;
    else corrupted.writeBigUInt64LE(0xffffffffffffffffn, 16);
    await writeFile(input, corrupted);
    let rejected = false;
    try { execFileSync(executable, [input], { stdio: 'pipe', timeout: 10_000 }); }
    catch (error) { rejected = typeof error === 'object' && error !== null && 'status' in error && error.status === 101; }
    if (!rejected) throw new Error('rvm_oracle_failed_corruption_check');
  }
  console.log(JSON.stringify({
    ok: true, result, compiler, upstreamCommit: EVIDENCE_FORMAT.rvmCommit,
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    positiveCases: 1, corruptionCases: 2, scope: 'upstream structural parser compatibility',
    fullRvmVerification: false, rvmExecution: false,
  }));
} finally { await rm(directory, { recursive: true, force: true }); }
