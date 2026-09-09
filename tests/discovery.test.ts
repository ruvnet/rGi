import test from 'node:test';
import assert from 'node:assert/strict';
import {DiscoveryEngine, validateDiscoveryPolicy, validateDiscoveryProblem} from '../src/discovery.ts';
import type {DiscoveryPolicy, DiscoveryProblem} from '../src/discovery.ts';

function problem(): DiscoveryProblem {
  return {version: 1, inputs: ['constant', 'bit0', 'bit1', 'identity', 'query'],
    hypotheses: [[9, 0, 0, 0, 10], [9, 1, 0, 1, 11], [9, 0, 1, 2, 12], [9, 1, 1, 3, 13]],
    costs: [1, 1, 1, 3, 1], probeIndices: [0, 1, 2, 3], queryIndices: [4]};
}
function policy(strategy: DiscoveryPolicy['strategy'] = 'information'): DiscoveryPolicy {
  return {strategy, seed: 123, maxProbes: 4, maxCost: 8};
}
function bruteEntropy(rows: number[][], input: number): number {
  const groups = new Map<number, number>();
  for (const row of rows) groups.set(row[input]!, (groups.get(row[input]!) ?? 0) + 1);
  let entropy = 0;
  for (const count of groups.values()) {
    const probability = count / rows.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

test('information selection agrees with independent probability entropy and elimination', () => {
  for (let variant = 0; variant < 12; variant++) {
    const p: DiscoveryProblem = {version: 1, inputs: ['a', 'b', 'c', 'd', 'e', 'f', 'q'],
      hypotheses: Array.from({length: 16}, (_, row) => [row % 2, (row >> 1) % 2, (row >> 2) % 2, row >> 3, row % 4, row % 8, row]),
      costs: Array.from({length: 7}, (_, index) => 1 + ((index + variant) % 3)),
      probeIndices: [0, 1, 2, 3, 4, 5], queryIndices: [6]};
    for (let truth = 0; truth < p.hypotheses.length; truth++) {
      const engine = new DiscoveryEngine(p, {strategy: 'information', seed: 0, maxCost: 7, maxProbes: 4});
      let rows = [...p.hypotheses], cost = 0, steps = 0;
      const used = new Set<number>();
      while (rows.length > 1 && steps < 4) {
        const available = p.probeIndices.filter(index => !used.has(index) && p.costs[index]! <= 7 - cost)
          .map(index => ({index, entropy: bruteEntropy(rows, index), cost: p.costs[index]!}))
          .filter(candidate => candidate.entropy > 0)
          .sort((a, b) => b.entropy / b.cost - a.entropy / a.cost || a.cost - b.cost || a.index - b.index);
        const reference = available[0], actual = engine.reserve();
        if (!reference) { assert.equal(actual, null); break; }
        assert.ok(actual);
        assert.equal(actual.inputIndex, reference.index);
        assert.ok(Math.abs(actual.entropyBits - reference.entropy) < 1e-12);
        assert.equal(actual.survivorCountBefore, rows.length);
        used.add(actual.inputIndex); cost += actual.cost; steps++;
        const output = p.hypotheses[truth]![actual.inputIndex]!;
        rows = rows.filter(row => row[actual.inputIndex] === output);
        engine.observe(output);
        assert.equal(engine.state.survivors, rows.length);
      }
      assert.equal(engine.state.spentCost, cost);
      assert.equal(engine.state.probes, steps);
      assert.equal(engine.predict(6), rows.length === 1 ? truth : null);
    }
  }
});

test('information per cost can prefer a lower entropy experiment', () => {
  const engine = new DiscoveryEngine(problem(), policy());
  const decision = engine.reserve()!;
  assert.equal(bruteEntropy(problem().hypotheses, 3), 2);
  assert.deepEqual(decision, {inputIndex: 1, cost: 1, entropyBits: 1, survivorCountBefore: 4});
});

test('equal information rates prefer lower cost then declared order', () => {
  const p = problem(); p.costs[3] = 2; p.probeIndices = [3, 2, 1, 0];
  assert.equal(new DiscoveryEngine(p, policy()).reserve()!.inputIndex, 2);
  p.probeIndices = [1, 2, 3, 0];
  assert.equal(new DiscoveryEngine(p, policy()).reserve()!.inputIndex, 1);
});

test('permuting output labels preserves entropy ties', () => {
  const p: DiscoveryProblem = {version: 1, inputs: ['left', 'right', 'query'],
    hypotheses: Array.from({length: 13}, (_, index) => {
      const group = index < 1 ? 0 : index < 3 ? 1 : index < 6 ? 2 : 3;
      return [group, [8, 255, 2, 19][group]!, index];
    }), costs: [1, 1, 1], probeIndices: [1, 0], queryIndices: [2]};
  const expected = bruteEntropy(p.hypotheses, 0);
  const decision = new DiscoveryEngine(p, policy()).reserve()!;
  assert.equal(decision.inputIndex, 1);
  assert.ok(Math.abs(decision.entropyBits - expected) < 1e-12);
});

test('reservations burn budgets before the oracle and reject overlapping reservations', () => {
  const engine = new DiscoveryEngine(problem(), policy());
  engine.reserve();
  assert.deepEqual(engine.state, {spentCost: 1, probes: 1, survivors: 4, status: 'pending'});
  assert.equal(engine.predict(0), null);
  assert.throws(() => engine.reserve(), /pending/);
  assert.equal(engine.state.probes, 1);
  engine.observe(1);
  assert.deepEqual(engine.state, {spentCost: 1, probes: 1, survivors: 2, status: 'ready'});
  engine.reserve(); engine.fail();
  assert.deepEqual(engine.state, {spentCost: 2, probes: 2, survivors: 2, status: 'failed'});
  assert.equal(engine.reserve(), null);
  assert.equal(engine.predict(4), null);
});

test('invalid observations terminally fail and never refund a reserved call', () => {
  for (const invalid of [NaN, Infinity, -1, 256, 1.5, undefined, '1', {}, null]) {
    const engine = new DiscoveryEngine(problem(), policy()); engine.reserve();
    assert.throws(() => engine.observe(invalid as number), /observation/);
    assert.deepEqual(engine.state, {spentCost: 1, probes: 1, survivors: 4, status: 'failed'});
    assert.equal(engine.reserve(), null);
    assert.equal(engine.predict(4), null);
  }
  const unreserved = new DiscoveryEngine(problem(), policy());
  assert.throws(() => unreserved.observe(0), /observation/);
  assert.deepEqual(unreserved.state, {spentCost: 0, probes: 0, survivors: 4, status: 'failed'});
});

test('out of prior observations produce inconsistency and abstention', () => {
  const engine = new DiscoveryEngine(problem(), policy()); engine.reserve(); engine.observe(255);
  assert.deepEqual(engine.state, {spentCost: 1, probes: 1, survivors: 0, status: 'inconsistent'});
  assert.equal(engine.predict(0), null);
  assert.equal(engine.reserve(), null);
});

test('predictions require consensus rather than guessing a surviving hypothesis', () => {
  const engine = new DiscoveryEngine(problem(), policy());
  assert.equal(engine.predict(0), 9);
  assert.equal(engine.predict(4), null);
  engine.reserve(); engine.observe(1);
  assert.equal(engine.predict(1), 1);
  assert.equal(engine.predict(4), null);
  engine.reserve(); engine.observe(0);
  assert.deepEqual(engine.state, {spentCost: 2, probes: 2, survivors: 1, status: 'exhausted'});
  assert.equal(engine.predict(4), 11);
  assert.equal(engine.reserve(), null);
  for (const index of [-1, 5, 0.5, NaN]) assert.throws(() => engine.predict(index), /prediction_index/);
});

test('known singleton prior stops without spending budget', () => {
  const p = problem(); p.hypotheses = [p.hypotheses[2]!];
  for (const strategy of ['information', 'fixed', 'random'] as const) {
    const engine = new DiscoveryEngine(p, policy(strategy));
    assert.equal(engine.state.status, 'exhausted');
    assert.equal(engine.reserve(), null);
    assert.equal(engine.predict(4), 12);
  }
});

test('information stops at zero information while fixed still follows its declared schedule', () => {
  const p = problem(); p.probeIndices = [0];
  const active = new DiscoveryEngine(p, policy());
  assert.equal(active.state.status, 'exhausted');
  assert.equal(active.reserve(), null);
  assert.equal(active.predict(4), null);
  const fixed = new DiscoveryEngine(p, policy('fixed'));
  assert.deepEqual(fixed.reserve(), {inputIndex: 0, cost: 1, entropyBits: 0, survivorCountBefore: 4});
  fixed.observe(9);
  assert.equal(fixed.state.status, 'exhausted');
  assert.equal(fixed.predict(4), null);
  for (let size = 2; size <= 256; size++) {
    const constant: DiscoveryProblem = {version: 1, inputs: ['constant', 'query'],
      hypotheses: Array.from({length: size}, (_, row) => [0, row]), costs: [1, 1], probeIndices: [0], queryIndices: [1]};
    assert.equal(new DiscoveryEngine(constant, policy()).reserve(), null);
  }
});

test('all strategies obey strict budgets and skip unaffordable probes', () => {
  for (const strategy of ['information', 'fixed', 'random'] as const) {
    for (const limits of [{maxCost: 0, maxProbes: 4}, {maxCost: 8, maxProbes: 0}]) {
      const engine = new DiscoveryEngine(problem(), {...policy(strategy), ...limits});
      assert.equal(engine.state.status, 'exhausted');
      assert.equal(engine.reserve(), null);
    }
    const p = problem(); p.costs = [5, 2, 3, 4, 1];
    const engine = new DiscoveryEngine(p, {...policy(strategy), maxCost: 2});
    assert.equal(engine.reserve()!.inputIndex, 1);
    engine.observe(0);
    assert.equal(engine.state.status, 'exhausted');
    assert.equal(engine.state.spentCost, 2);
    assert.equal(engine.reserve(), null);
  }
  const engine = new DiscoveryEngine(problem(), {...policy(), maxProbes: 1});
  engine.reserve(); engine.observe(1);
  assert.equal(engine.state.status, 'exhausted');
  assert.equal(engine.state.survivors, 2);
  assert.equal(engine.predict(4), null);
});

test('fixed probes consume declared order without revisiting inputs', () => {
  const p = problem(); p.probeIndices = [0, 2, 1, 3];
  const engine = new DiscoveryEngine(p, policy('fixed'));
  const selected: number[] = [];
  for (let decision = engine.reserve(); decision; decision = engine.reserve()) {
    selected.push(decision.inputIndex); engine.observe(p.hypotheses[3]![decision.inputIndex]!);
  }
  assert.deepEqual(selected, [0, 2, 1]);
  assert.equal(engine.predict(4), 13);
});

test('seeded random selection is reproducible, supports seed zero and samples all affordable inputs', () => {
  function run(seed: number): number[] {
    const p = problem(), engine = new DiscoveryEngine(p, {...policy('random'), seed});
    const result: number[] = [];
    for (let decision = engine.reserve(); decision; decision = engine.reserve()) {
      result.push(decision.inputIndex); engine.observe(p.hypotheses[0]![decision.inputIndex]!);
    }
    assert.equal(new Set(result).size, result.length);
    return result;
  }
  for (const seed of [0, 1, 123, 0xffff_ffff]) assert.deepEqual(run(seed), run(seed));
  assert.notDeepEqual(run(1), run(123));
  const first = new Set(Array.from({length: 256}, (_, seed) => run(seed)[0]));
  assert.deepEqual([...first].sort(), [0, 1, 2, 3]);
});

test('caller mutation of problem, policy, decisions and state cannot alter the engine', () => {
  const p = problem(), rules = policy(), engine = new DiscoveryEngine(p, rules);
  p.inputs.length = 0; p.hypotheses[0]![1] = 255; p.hypotheses.length = 0;
  p.costs[1] = 99; p.probeIndices.reverse(); p.queryIndices.length = 0;
  rules.maxCost = 0; rules.maxProbes = 0; rules.strategy = 'fixed';
  const state = engine.state; state.spentCost = 1_000_000; state.status = 'failed';
  const decision = engine.reserve()!;
  assert.equal(decision.inputIndex, 1); decision.inputIndex = 0; decision.cost = 99;
  engine.observe(0);
  assert.equal(engine.state.spentCost, 1);
  assert.equal(engine.state.survivors, 2);
  assert.equal(engine.predict(1), 0);
  assert.equal(engine.reserve()!.inputIndex, 2);
});

test('problem validation rejects ambiguous shapes, duplicates, overlapping inputs and malformed tables', () => {
  const bad: unknown[] = [null, [], {...problem(), extra: 1}, {...problem(), version: 2},
    {...problem(), inputs: ['x', 'x', 'b', 'c', 'd']}, {...problem(), inputs: [1, 'b', 'c', 'd', 'e']},
    {...problem(), costs: [1]}, {...problem(), costs: [0, 1, 1, 1, 1]},
    {...problem(), costs: [1_000_001, 1, 1, 1, 1]}, {...problem(), hypotheses: []},
    {...problem(), hypotheses: [[0, 1]]}, {...problem(), hypotheses: [[0, 1, 2, 3, 256]]},
    {...problem(), hypotheses: [[0, 1, 2, 3, 0.5]]}, {...problem(), hypotheses: [[0, 1, 2, 3, -1]]},
    {...problem(), hypotheses: [problem().hypotheses[0], problem().hypotheses[0]]},
    {...problem(), probeIndices: []}, {...problem(), queryIndices: []}, {...problem(), probeIndices: [1, 1]},
    {...problem(), queryIndices: [4, 4]}, {...problem(), queryIndices: [1]}, {...problem(), probeIndices: [5]},
    {...problem(), probeIndices: [0.5]}, {...problem(), inputs: ['one']}];
  for (const value of bad) assert.throws(() => validateDiscoveryProblem(value), /invalid_/);
});

test('validation rejects getters and proxies without executing caller code', () => {
  let calls = 0;
  const proxy = new Proxy(problem(), {ownKeys() {calls++; return [];}, get() {calls++; return 1;}});
  const accessor = {...problem()}; Object.defineProperty(accessor, 'costs', {enumerable: true, get() {calls++; return [1];}});
  const rowProxy = problem(); rowProxy.hypotheses[0] = new Proxy([0], {get() {calls++; return 1;}});
  for (const value of [proxy, accessor, rowProxy]) assert.throws(() => validateDiscoveryProblem(value), /invalid_mission_proof/);
  assert.throws(() => validateDiscoveryPolicy(new Proxy(policy(), {})), /invalid_mission_proof/);
  assert.equal(calls, 0);
});

test('maximum table and byte output 255 work while larger tables and invalid policy bounds fail', () => {
  const p: DiscoveryProblem = {version: 1, inputs: Array.from({length: 128}, (_, i) => String(i)),
    hypotheses: Array.from({length: 256}, (_, row) => Array.from({length: 128}, () => row)),
    costs: Array.from({length: 128}, () => 1_000_000), probeIndices: Array.from({length: 127}, (_, i) => i), queryIndices: [127]};
  const engine = new DiscoveryEngine(p, {strategy: 'information', seed: 0xffff_ffff, maxProbes: 128, maxCost: 128_000_000});
  assert.equal(engine.reserve()!.entropyBits, 8);
  engine.observe(255);
  assert.equal(engine.predict(127), 255);
  assert.throws(() => validateDiscoveryProblem({...p, hypotheses: [...p.hypotheses, p.hypotheses[0]]}), /hypotheses/);
  assert.throws(() => validateDiscoveryProblem({...p, inputs: [...p.inputs, '129']}), /inputs/);
  for (const value of [{...policy(), maxProbes: 129}, {...policy(), maxCost: 128_000_001},
    {...policy(), maxProbes: -1}, {...policy(), maxCost: -1}, {...policy(), maxCost: 1.5},
    {...policy(), maxProbes: 1.5}, {...policy(), seed: -1}, {...policy(), seed: 0x1_0000_0000},
    {...policy(), seed: 0.5}, {...policy(), seed: NaN}, {...policy(), strategy: 'oracle'}, {...policy(), extra: 1}]) {
    assert.throws(() => validateDiscoveryPolicy(value), /invalid_/);
  }
});
