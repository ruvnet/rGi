import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const local = process.argv.includes('--local');
type Check = { name: string; command: string; args: string[]; timeout?: number; scanner?: boolean };
const checks: Check[] = [
  { name: 'typescript', command: 'npm', args: ['run', 'typecheck'] },
  { name: 'typescript-tests', command: 'npm', args: ['test'] },
  { name: 'rust-tests', command: 'cargo', args: ['test', '--workspace', '--locked'], timeout: 300_000 },
  { name: 'rust-format', command: 'cargo', args: ['fmt', '--all', '--check'] },
  { name: 'rust-clippy', command: 'cargo', args: ['clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings'], timeout: 300_000 },
  { name: 'native-build', command: 'cargo', args: ['build', '-p', 'rgi-napi', '--release', '--locked'], timeout: 300_000 },
  { name: 'wasm-build', command: 'cargo', args: ['build', '-p', 'rgi-wasm', '--target', 'wasm32-unknown-unknown', '--release', '--locked'], timeout: 300_000 },
  { name: 'binding-execution-parity', command: 'node', args: ['scripts/check-bindings.ts'] },
  { name: 'benchmark', command: 'node', args: ['scripts/benchmark.ts'] },
  { name: 'runtime-benchmark', command: 'node', args: ['scripts/benchmark-runtime.ts'] },
  { name: 'adaptation-benchmark', command: 'node', args: ['scripts/benchmark-adaptation.ts'] },
  { name: 'generalization-framework', command: 'node', args: ['scripts/benchmark-generalization.ts'] },
  { name: 'sequential-mission', command: 'node', args: ['scripts/benchmark-mission.ts'] },
  { name: 'rvf-proof-replay', command: 'node', args: ['scripts/replay-mission.ts', 'artifacts/mission.rvf', 'artifacts/mission.public.pem'] },
  { name: 'rvm-proof-replay', command: 'node', args: ['scripts/replay-mission.ts', 'artifacts/mission.rvm.rvf', 'artifacts/mission.public.pem', '--rvm'] },
  { name: 'upstream-rvm-parser', command: 'node', args: ['scripts/verify-rvm-format.ts', 'artifacts/mission.rvm.rvf'] },
  { name: 'active-discovery', command: 'node', args: ['scripts/benchmark-discovery.ts'] },
  { name: 'discovery-rvf-replay', command: 'node', args: ['scripts/replay-discovery.ts', 'artifacts/discovery.rvf', 'artifacts/discovery.public.pem'] },
  { name: 'discovery-rvm-replay', command: 'node', args: ['scripts/replay-discovery.ts', 'artifacts/discovery.rvm.rvf', 'artifacts/discovery.public.pem', '--rvm'] },
  { name: 'npm-advisories', command: 'npm', args: ['audit', '--json'], scanner: true },
  { name: 'rust-advisories', command: 'cargo', args: ['audit', '--json'], scanner: true },
];
const hash = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
const versions = Object.fromEntries(['node', 'npm', 'cargo', 'rustc'].map(command => {
  const result = spawnSync(command, ['--version'], { cwd: root, encoding: 'utf8', shell: false, timeout: 10_000 });
  return [command, result.status === 0 ? result.stdout.trim() : 'unavailable'];
}));
const tracked = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', shell: false });
const sources = tracked.status === 0 ? [...new Set(tracked.stdout.split('\0').filter(Boolean))].filter(path => !path.startsWith('artifacts/') && existsSync(resolve(root, path))).sort() : [];
const sourceHashes = Object.fromEntries(sources.map(path => [path, hash(readFileSync(resolve(root, path)))]));
async function execute(check: Check): Promise<{ status: number | null; signal: string | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise(resolveResult => {
    const child = spawn(check.command, check.args, { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let error: Error | undefined;
    const timer = setTimeout(() => { error = new Error('Command timeout'); child.kill('SIGKILL'); }, check.timeout ?? 120_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length + stderr.length > 8 * 1024 * 1024) { error = new Error('Output limit exceeded'); child.kill('SIGKILL'); } });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (stdout.length + stderr.length > 8 * 1024 * 1024) { error = new Error('Output limit exceeded'); child.kill('SIGKILL'); } });
    child.on('error', failure => { error = failure; });
    child.on('close', (status, signal) => { clearTimeout(timer); resolveResult({ status, signal, stdout, stderr, error }); });
  });
}
const results = [];
for (const check of checks) {
  const started = performance.now();
  console.log(`${check.name}: running`);
  const result = await execute(check);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const unavailable = result.error?.message.includes('ENOENT') || /tsc: not found|no such command: [`']audit|can't find crate for [`']std|target may not be installed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|failed to (download|fetch)|Could not resolve|network is unreachable/i.test(output);
  const status = result.status === 0 && !result.error ? 'passed' : unavailable ? 'blocked' : 'failed';
  console.log(`${check.name}: ${status}`);
  // Hash raw output for reproducibility; never persist potentially sensitive command output.
  results.push({ name: check.name, command: [check.command, ...check.args], status, exitCode: result.status, signal: result.signal, durationMs: Math.round(performance.now() - started), outputSha256: hash(output), reason: status === 'passed' ? null : unavailable ? 'Required tool, target, or advisory service unavailable.' : 'Command failed. Reproduce the recorded command locally.', advisoryDataTimestamp: check.scanner ? 'Not independently established; command execution time is not feed freshness.' : undefined });
}
const complete = results.every(result => result.status === 'passed');
const failed = results.some(result => result.status === 'failed');
mkdirSync(resolve(root, 'artifacts'), { recursive: true });
writeFileSync(resolve(root, 'artifacts/harness.json'), JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), mode: local ? 'local' : 'release', complete, releaseGatePassed: complete, versions, sourceHashes, results, limitations: ['Passing checks is not proof of AGI, safety, production readiness or authorization to publish.', 'Advisory checks do not replace review of reachable code.', 'No scanner stdout is retained to reduce accidental secret disclosure.'] }, null, 2) + '\n');
console.log(complete ? 'All checks passed.' : 'INCOMPLETE: release gate not satisfied.');
process.exitCode = failed || (!local && !complete) ? 1 : 0;
