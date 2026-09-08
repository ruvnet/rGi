import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { evaluatePolicy } from '../src/policy.ts';
import type { PolicyInput } from '../src/contracts.ts';

const input: PolicyInput = { capability: 'simulation.step', allowedCapabilities: ['simulation.step'], spentMicros: 1, reservedMicros: 1, requestedMicros: 1, budgetMicros: 100, confidence: 1, minConfidence: 0.8, stopped: false };
const iterations = 100_000;
let accepted = 0;
for (let i = 0; i < 10_000; i++) evaluatePolicy(input);
const samples: number[] = [];
for (let batch = 0; batch < 20; batch++) {
  const start = performance.now();
  for (let i = 0; i < iterations / 20; i++) if (evaluatePolicy(input).allowed) accepted++;
  samples.push((performance.now() - start) / (iterations / 20));
}
if (accepted !== iterations) throw new Error('benchmark_correctness_failure');
samples.sort((a, b) => a - b);
const averageMs = samples.reduce((a, b) => a + b, 0) / samples.length;
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), benchmark: 'portable-policy-evaluation', iterations, accepted, warmupIterations: 10000, sampleDefinition: 'Mean latency per operation in each of 20 batches; quantiles are batch means, not individual operation latency.', meanMicros: averageMs * 1000, medianBatchMeanMicros: samples[10]! * 1000, p95BatchMeanMicros: samples[18]! * 1000, operationsPerSecond: 1000 / averageMs, environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown' }, limitations: ['Single local microbenchmark; not a production throughput guarantee.', 'Excludes persistence, models, network, native bindings and physical actuation.', 'No human baseline or AGI capability is measured.'] };
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/benchmark.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
