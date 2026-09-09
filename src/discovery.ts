import {canonicalJson} from './mission-proof.ts';

/** An explicit, finite prior. Rows are hypotheses and columns are declared inputs. */
export type DiscoveryProblem = {
  version: 1;
  inputs: string[];
  hypotheses: number[][];
  costs: number[];
  probeIndices: number[];
  queryIndices: number[];
};
export type DiscoveryPolicy = {
  strategy: 'information' | 'fixed' | 'random';
  seed: number;
  maxProbes: number;
  maxCost: number;
};
export type ProbeDecision = {
  inputIndex: number;
  cost: number;
  entropyBits: number;
  survivorCountBefore: number;
};
export type DiscoveryState = {
  spentCost: number;
  probes: number;
  survivors: number;
  status: 'ready' | 'pending' | 'exhausted' | 'inconsistent' | 'failed';
};

function invalid(reason: string): never { throw new Error(`invalid_discovery:${reason}`); }
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('object');
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid('fields');
  return value as Record<string, unknown>;
}

/** Validate before reading caller properties; canonicalJson rejects proxies and accessors. */
export function validateDiscoveryProblem(problem: unknown): asserts problem is DiscoveryProblem {
  canonicalJson(problem);
  const p = record(problem, ['version', 'inputs', 'hypotheses', 'costs', 'probeIndices', 'queryIndices']);
  if (p.version !== 1) invalid('version');
  if (!Array.isArray(p.inputs) || p.inputs.length < 2 || p.inputs.length > 128 ||
      p.inputs.some(input => typeof input !== 'string') || new Set(p.inputs).size !== p.inputs.length) invalid('inputs');
  const width = p.inputs.length;
  if (!Array.isArray(p.costs) || p.costs.length !== width || p.costs.some(cost => !integer(cost, 1, 1_000_000))) invalid('costs');
  if (!Array.isArray(p.hypotheses) || p.hypotheses.length < 1 || p.hypotheses.length > 256 ||
      p.hypotheses.length * width > 32_768) invalid('hypotheses');
  const rows = new Set<string>();
  for (const row of p.hypotheses) {
    if (!Array.isArray(row) || row.length !== width || row.some(output => !integer(output, 0, 255))) invalid('row');
    const identity = row.join(',');
    if (rows.has(identity)) invalid('duplicate_hypothesis');
    rows.add(identity);
  }
  const declared = new Set<number>();
  for (const indices of [p.probeIndices, p.queryIndices]) {
    if (!Array.isArray(indices) || indices.length < 1 || indices.length > width) invalid('indices');
    for (const index of indices) {
      if (!integer(index, 0, width - 1) || declared.has(index)) invalid('index_overlap');
      declared.add(index);
    }
  }
}

export function validateDiscoveryPolicy(policy: unknown): asserts policy is DiscoveryPolicy {
  canonicalJson(policy);
  const p = record(policy, ['strategy', 'seed', 'maxProbes', 'maxCost']);
  if (p.strategy !== 'information' && p.strategy !== 'fixed' && p.strategy !== 'random') invalid('strategy');
  if (!integer(p.seed, 0, 0xffff_ffff) || !integer(p.maxProbes, 0, 128) || !integer(p.maxCost, 0, 128_000_000)) invalid('policy_limits');
}

/**
 * Bounded experimental design with a uniform prior over surviving table rows.
 * This is finite hypothesis elimination, not an implementation of an AGI model.
 * The host must reserve before consulting its oracle, then observe or fail once.
 */
export class DiscoveryEngine {
  readonly #width: number;
  readonly #table: Uint8Array;
  readonly #costs: Uint32Array;
  readonly #probeIndices: readonly number[];
  readonly #used: Uint8Array;
  readonly #survivors: Uint16Array;
  readonly #counts = new Uint16Array(256);
  readonly #partitionCounts = new Uint16Array(257);
  readonly #countLogCount: Float64Array;
  readonly #policy: Readonly<DiscoveryPolicy>;
  #random: number;
  #pending: Readonly<ProbeDecision> | null = null;
  #state: DiscoveryState;

  constructor(problem: DiscoveryProblem, policy: DiscoveryPolicy) {
    validateDiscoveryProblem(problem);
    validateDiscoveryPolicy(policy);
    this.#width = problem.inputs.length;
    // Typed arrays are private copies; no caller reference can mutate the prior.
    this.#table = Uint8Array.from(problem.hypotheses.flat());
    this.#costs = Uint32Array.from(problem.costs);
    this.#probeIndices = Object.freeze([...problem.probeIndices]);
    this.#used = new Uint8Array(this.#width);
    this.#survivors = Uint16Array.from(problem.hypotheses, (_, index) => index);
    this.#countLogCount = new Float64Array(problem.hypotheses.length + 1);
    for (let count = 1; count < this.#countLogCount.length; count++) this.#countLogCount[count] = count * Math.log2(count);
    this.#policy = Object.freeze({...policy});
    this.#random = policy.seed || 0x9e3779b9;
    this.#state = {spentCost: 0, probes: 0, survivors: problem.hypotheses.length, status: 'ready'};
    this.#refresh();
  }

  get state(): DiscoveryState { return {...this.#state}; }

  /** Charge both budgets before any observation. A reservation can never be refunded. */
  reserve(): ProbeDecision | null {
    if (this.#state.status === 'pending') invalid('pending');
    if (this.#state.status !== 'ready') return null;
    let selected = -1, entropy = 0, bestRate = -1, affordableCount = 0;
    for (const index of this.#probeIndices) {
      if (!this.#affordable(index)) continue;
      if (this.#policy.strategy === 'random') { affordableCount++; continue; }
      const information = this.#entropy(index);
      if (this.#policy.strategy === 'fixed') { selected = index; entropy = information; break; }
      if (information <= 0) continue;
      const rate = information / this.#costs[index]!;
      if (rate > bestRate || (rate === bestRate && (selected < 0 || this.#costs[index]! < this.#costs[selected]!))) {
        selected = index; entropy = information; bestRate = rate;
      }
    }
    if (this.#policy.strategy === 'random' && affordableCount > 0) {
      // Xorshift32 visits 1..2^32-1. Subtract one, then reject the incomplete
      // final bucket. At most 127 consecutive values can be rejected here.
      const range = 0xffff_ffff;
      const limit = range - (range % affordableCount);
      let value: number;
      do { value = this.#nextRandom() - 1; } while (value >= limit);
      let ordinal = value % affordableCount;
      for (const index of this.#probeIndices) {
        if (this.#affordable(index) && ordinal-- === 0) { selected = index; entropy = this.#entropy(index); break; }
      }
    }
    if (selected < 0) { this.#state.status = 'exhausted'; return null; }
    const decision = {inputIndex: selected, cost: this.#costs[selected]!, entropyBits: entropy, survivorCountBefore: this.#state.survivors};
    this.#used[selected] = 1;
    this.#state.spentCost += decision.cost;
    this.#state.probes++;
    this.#state.status = 'pending';
    this.#pending = Object.freeze(decision);
    return {...decision};
  }

  observe(output: number): void {
    if (this.#state.status !== 'pending' || this.#pending === null || !integer(output, 0, 255)) {
      this.fail(); invalid('observation');
    }
    let remaining = 0;
    for (let index = 0; index < this.#state.survivors; index++) {
      const row = this.#survivors[index]!;
      if (this.#table[row * this.#width + this.#pending.inputIndex] === output) this.#survivors[remaining++] = row;
    }
    this.#state.survivors = remaining;
    this.#pending = null;
    this.#state.status = remaining === 0 ? 'inconsistent' : 'ready';
    this.#refresh();
  }

  /** A host timeout or malformed result burns any outstanding reservation. */
  fail(): void { this.#pending = null; this.#state.status = 'failed'; }

  /** Abstain unless every surviving hypothesis agrees, including after budget exhaustion. */
  predict(inputIndex: number): number | null {
    if (!integer(inputIndex, 0, this.#width - 1)) invalid('prediction_index');
    if (this.#state.status === 'pending' || this.#state.status === 'failed' || this.#state.status === 'inconsistent') return null;
    const output = this.#table[this.#survivors[0]! * this.#width + inputIndex]!;
    for (let index = 1; index < this.#state.survivors; index++) {
      if (this.#table[this.#survivors[index]! * this.#width + inputIndex] !== output) return null;
    }
    return output;
  }

  #affordable(inputIndex: number): boolean {
    return this.#used[inputIndex] === 0 && this.#costs[inputIndex]! <= this.#policy.maxCost - this.#state.spentCost;
  }

  #entropy(inputIndex: number): number {
    this.#counts.fill(0);
    let groups = 0;
    for (let index = 0; index < this.#state.survivors; index++) {
      const output = this.#table[this.#survivors[index]! * this.#width + inputIndex]!;
      if (this.#counts[output] === 0) groups++;
      this.#counts[output] = this.#counts[output]! + 1;
    }
    // A constant experiment has exactly zero information, even when rounding
    // log2(n) - (n * log2(n)) / n would leave a tiny positive residual.
    if (groups <= 1) return 0;
    this.#partitionCounts.fill(0);
    for (const count of this.#counts) if (count > 0) this.#partitionCounts[count] = this.#partitionCounts[count]! + 1;
    let weightedLogs = 0;
    // Sum by partition size so relabeling outputs cannot perturb tie breaking.
    for (let count = 1; count <= this.#state.survivors; count++) weightedLogs += this.#partitionCounts[count]! * this.#countLogCount[count]!;
    const count = this.#state.survivors;
    // log2(n) - sum(c * log2(c)) / n; the clamp handles floating point roundoff.
    return Math.max(0, Math.log2(count) - weightedLogs / count);
  }

  #refresh(): void {
    if (this.#state.status !== 'ready') return;
    if (this.#state.survivors <= 1 || this.#state.probes >= this.#policy.maxProbes ||
        !this.#probeIndices.some(index => this.#affordable(index) && (this.#policy.strategy !== 'information' || this.#entropy(index) > 0))) {
      this.#state.status = 'exhausted';
    }
  }

  #nextRandom(): number {
    let value = this.#random;
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    this.#random = value >>> 0;
    return this.#random;
  }
}
