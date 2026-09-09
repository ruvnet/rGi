import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpus, platform, arch } from 'node:os';
import {
  DiscoveryEngine,
  validateDiscoveryProblem,
  validateDiscoveryPolicy,
  type DiscoveryProblem,
  type DiscoveryPolicy,
  type ProbeDecision,
} from '../src/discovery.ts';

/** A deliberately straightforward reference: allocate output-count Maps and
 * calculate logarithms for each candidate. No production selection code is reused.
 * Both constructors validate and copy the same public problem outside timing.
 * Only the first reservation is benchmarked, so every row initially survives.
 */
class NaiveSelector {
  private readonly problem: DiscoveryProblem;
  private readonly policy: DiscoveryPolicy;
  private reserved = false;

  constructor(problem: DiscoveryProblem, policy: DiscoveryPolicy) {
    validateDiscoveryProblem(problem);
    validateDiscoveryPolicy(policy);
    this.problem = structuredClone(problem);
    this.policy = { ...policy };
  }

  reserve(): ProbeDecision | null {
    if (this.reserved) throw new Error('benchmark_reference_already_reserved');
    this.reserved = true;
    if (this.policy.maxProbes === 0 || this.problem.hypotheses.length <= 1) return null;
    let selected: ProbeDecision | null = null;
    let bestRate = -1;
    for (const inputIndex of this.problem.probeIndices) {
      const cost = this.problem.costs[inputIndex]!;
      if (cost > this.policy.maxCost) continue;
      const outputs = new Map<number, number>();
      for (const row of this.problem.hypotheses) {
        const output = row[inputIndex]!;
        outputs.set(output, (outputs.get(output) ?? 0) + 1);
      }
      // Group equal partition sizes to make entropy invariant to output labels.
      // Ordered partition summation also avoids a numerical tie-breaking confound.
      const partitions = new Map<number, number>();
      for (const count of outputs.values()) partitions.set(count, (partitions.get(count) ?? 0) + 1);
      let weightedLogs = 0;
      for (const count of [...partitions.keys()].sort((left, right) => left - right))
        weightedLogs += partitions.get(count)! * (count * Math.log2(count));
      const survivors = this.problem.hypotheses.length;
      const entropyBits = Math.max(0, Math.log2(survivors) - weightedLogs / survivors);
      if (entropyBits <= 0) continue;
      const rate = entropyBits / cost;
      if (rate > bestRate || (rate === bestRate && (selected === null || cost < selected.cost))) {
        selected = { inputIndex, cost, entropyBits, survivorCountBefore: survivors };
        bestRate = rate;
      }
    }
    return selected;
  }
}

function publicProblem(): DiscoveryProblem {
  const width = 64;
  const hypotheses = Array.from({ length: 256 }, (_, row) =>
    Array.from({ length: width }, (_, column) => {
      // The query column guarantees unique complete hypotheses. Probe columns
      // use a fixed integer mixer with output alphabets from two to 256 values.
      if (column === 0) return row;
      let value = Math.imul(row + 1, 0x9e3779b1) ^ Math.imul(column + 1, 0x85ebca6b);
      value ^= value >>> 16;
      value = Math.imul(value, 0x7feb352d);
      value ^= value >>> 15;
      value = Math.imul(value, 0x846ca68b);
      value ^= value >>> 16;
      return (value >>> 0) & ((2 ** (1 + (column % 8))) - 1);
    }));
  return {
    version: 1,
    inputs: Array.from({ length: width }, (_, index) => `public-input-${index}`),
    hypotheses,
    costs: Array.from({ length: width }, (_, index) => 1 + (index % 3)),
    probeIndices: Array.from({ length: width - 1 }, (_, index) => index + 1),
    queryIndices: [0],
  };
}

function sameDecision(actual: ProbeDecision | null, expected: ProbeDecision | null): void {
  assert.deepEqual(actual, expected, 'optimized selection differs from independent reference');
  if (actual !== null && expected !== null)
    assert.equal(actual.entropyBits / actual.cost, expected.entropyBits / expected.cost);
}

/** Reproducible selection microbenchmark. Repetitions are fixed before measuring;
 * negative speedups are reported without retrying or applying timing thresholds.
 */
export function benchmarkDiscoveryKernel() {
  const problem = publicProblem();
  const policy: DiscoveryPolicy = { strategy: 'information', seed: 1, maxProbes: 1, maxCost: 3 };
  const repetitions = 256;
  const warmupRepetitions = 32;
  const batchSize = 16;

  const expected = new NaiveSelector(problem, policy).reserve();
  sameDecision(new DiscoveryEngine(problem, policy).reserve(), expected);
  assert.ok(expected !== null);

  // Explicit equal-rate cases verify both secondary cost and declared-order ties.
  const ties: DiscoveryProblem = {
    version: 1,
    inputs: ['balanced', 'identity-a', 'identity-b', 'query'],
    hypotheses: [[0, 0, 0, 0], [0, 1, 1, 1], [1, 2, 2, 2], [1, 3, 3, 3]],
    costs: [1, 2, 2, 1],
    probeIndices: [2, 1, 0],
    queryIndices: [3],
  };
  sameDecision(new DiscoveryEngine(ties, policy).reserve(), new NaiveSelector(ties, policy).reserve());
  assert.equal(new NaiveSelector(ties, policy).reserve()!.inputIndex, 0);
  const reordered = { ...ties, probeIndices: [2, 1], queryIndices: [0, 3] };
  sameDecision(new DiscoveryEngine(reordered, policy).reserve(), new NaiveSelector(reordered, policy).reserve());
  assert.equal(new NaiveSelector(reordered, policy).reserve()!.inputIndex, 2);

  const warmNaive = Array.from({ length: warmupRepetitions }, () => new NaiveSelector(problem, policy));
  const warmOptimized = Array.from({ length: warmupRepetitions }, () => new DiscoveryEngine(problem, policy));
  for (let index = 0; index < warmupRepetitions; index++) {
    sameDecision(warmNaive[index]!.reserve(), expected);
    sameDecision(warmOptimized[index]!.reserve(), expected);
  }

  const naiveSetupStart = performance.now();
  const naive = Array.from({ length: repetitions }, () => new NaiveSelector(problem, policy));
  const naiveSetupMs = performance.now() - naiveSetupStart;
  const optimizedSetupStart = performance.now();
  const optimized = Array.from({ length: repetitions }, () => new DiscoveryEngine(problem, policy));
  const optimizedSetupMs = performance.now() - optimizedSetupStart;

  const naiveDecisions: (ProbeDecision | null)[] = Array(repetitions).fill(null);
  const optimizedDecisions: (ProbeDecision | null)[] = Array(repetitions).fill(null);
  let naiveMs = 0;
  let optimizedMs = 0;
  // Alternate which arm runs first in each batch to reduce ordering bias.
  // Construction and correctness assertions are outside every timed section.
  for (let offset = 0; offset < repetitions; offset += batchSize) {
    const measureNaive = () => {
      const start = performance.now();
      for (let index = offset; index < offset + batchSize; index++) naiveDecisions[index] = naive[index]!.reserve();
      naiveMs += performance.now() - start;
    };
    const measureOptimized = () => {
      const start = performance.now();
      for (let index = offset; index < offset + batchSize; index++) optimizedDecisions[index] = optimized[index]!.reserve();
      optimizedMs += performance.now() - start;
    };
    if ((offset / batchSize) % 2 === 0) { measureNaive(); measureOptimized(); }
    else { measureOptimized(); measureNaive(); }
  }
  for (let index = 0; index < repetitions; index++) {
    sameDecision(naiveDecisions[index]!, expected);
    sameDecision(optimizedDecisions[index]!, expected);
  }
  return {
    schemaVersion: 1,
    benchmark: 'finite-prior-initial-information-reservation',
    tableSha256: createHash('sha256').update(Uint8Array.from(problem.hypotheses.flat())).digest('hex'),
    tableBytes: problem.hypotheses.length * problem.inputs.length,
    hypotheses: problem.hypotheses.length,
    inputs: problem.inputs.length,
    probes: problem.probeIndices.length,
    queries: problem.queryIndices.length,
    probeCostRange: [1, 3],
    repetitions,
    warmupRepetitions,
    batchSize,
    selected: expected,
    naiveMs,
    optimizedMs,
    setupMs: { naive: naiveSetupMs, optimized: optimizedSetupMs },
    speedup: naiveMs / optimizedMs,
    environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown' },
    limitations: [
      'Local host microbenchmark of one initial reservation per fresh engine, with every hypothesis surviving.',
      'Both arms validate and copy the same problem during separately timed setup; setup and warmups are excluded from selection times.',
      'Typed table bytes exclude indices, counters, logarithm cache, object overhead and constructor copies.',
      'Fixed public synthetic table and repetition count; no timing threshold or claim of universal acceleration.',
      'Excludes model inference, transport, SQLite and agent execution; this is not an end-to-end speedup or AGI result.',
    ],
  };
}
