import test from 'node:test';
import assert from 'node:assert/strict';
import type { Action } from '../src/contracts.ts';
import { planPredictively, type PredictivePlanningOptions } from '../src/planning.ts';

const action = (id: string, cost = 1, capability = 'move'): Action => ({
  id, capability, payload: {}, estimatedCostMicros: cost, confidence: 1,
});
function options(overrides: Partial<PredictivePlanningOptions> = {}): PredictivePlanningOptions {
  return { state: [0], goal: [10], actions: [action('step')],
    model: { predict: state => ({ state: [state[0]! + 1], uncertainty: 0 }) },
    horizon: 3, beamWidth: 4, maxExpansions: 100, budgetMicros: 100,
    allowedCapabilities: ['move'], uncertaintyPenalty: 1, maxUncertainty: 1, ...overrides };
}

test('two-step lookahead escapes a greedy trap and returns only the first action', () => {
  const input = options({ actions: [action('greedy'), action('detour')], horizon: 2,
    model: { predict: (state, a) => ({ state: [state[0] === 0 ? (a.id === 'greedy' ? 9 : -1) : state[0] === -1 ? 10 : 8], uncertainty: 0 }) } });
  assert.equal(planPredictively({ ...input, horizon: 1 }).action?.id, 'greedy');
  const result = planPredictively(input);
  assert.equal(result.action?.id, 'detour');
  assert.deepEqual(result.predictedState, [10]);
  assert.equal(result.loss, 0);
});

test('preserves better intermediate plan instead of forcing full horizon', () => {
  const result = planPredictively(options({ model: { predict: state => ({ state: [state[0] === 0 ? 10 : 20], uncertainty: 0 }) } }));
  assert.deepEqual(result.predictedState, [10]);
});

test('model corruption and exceptions reject branches while preserving valid options', () => {
  const bad = [NaN, Infinity, 1_000_001];
  for (const state of [...bad.map(v => [v]), [], [1, 2], new Array(1)]) {
    const result = planPredictively(options({ horizon: 1, actions: [action('bad'), action('good')],
      model: { predict: (_state, a) => ({ state: a.id === 'bad' ? state : [10], uncertainty: 0 }) } }));
    assert.equal(result.action?.id, 'good');
  }
  assert.equal(planPredictively(options({ model: { predict() { throw new Error('broken'); } } })).reason, 'no_feasible_plan');
  for (const uncertainty of [-1, 1.1, NaN, Infinity])
    assert.equal(planPredictively(options({ model: { predict: () => ({ state: [10], uncertainty }) } })).action, undefined);
});

test('uncertainty penalizes risky plans and abstains above hard threshold', () => {
  const input = options({ horizon: 1, actions: [action('risky'), action('reliable')],
    model: { predict: (_s, a) => a.id === 'risky' ? { state: [10], uncertainty: 0.9 } : { state: [9], uncertainty: 0.01 } } });
  assert.equal(planPredictively(input).action?.id, 'reliable');
  const rejected = planPredictively({ ...input, maxUncertainty: 0 });
  assert.equal(rejected.action, undefined);
  assert.equal(rejected.loss, null);
  const cumulative = planPredictively(options({ horizon: 2, maxUncertainty: 0.5,
    model: { predict: s => ({ state: [s[0]! + 5], uncertainty: 0.3 }) } }));
  assert.deepEqual(cumulative.predictedState, [5]);
});

test('capability, malformed action and monetary pruning occur before model calls', () => {
  let calls = 0;
  const model = { predict: () => { calls++; return { state: [10], uncertainty: 0 }; } };
  const result = planPredictively(options({ model, actions: [action('denied', 0, 'shell'), action('expensive', 11), action('invalid', -1)], budgetMicros: 10 }));
  assert.equal(result.reason, 'no_feasible_plan');
  assert.equal(calls, 0);
  const cumulative = planPredictively(options({ budgetMicros: Number.MAX_SAFE_INTEGER,
    actions: [action('step', Number.MAX_SAFE_INTEGER)], model: { predict: s => ({ state: [s[0]! + 5], uncertainty: 0 }) } }));
  assert.equal(cumulative.expansions, 1);
  assert.deepEqual(cumulative.predictedState, [5]);
});

test('bounded deterministic ordering, immutability and prediction-call count', () => {
  let calls = 0;
  const input = options({ actions: [action('first'), action('second')], maxExpansions: 3,
    model: { predict: s => { calls++; return { state: [s[0]! + 1], uncertainty: 0 }; } } });
  const before = structuredClone({ state: input.state, actions: input.actions });
  const first = planPredictively(input);
  assert.equal(calls, 3);
  assert.equal(first.expansions, 3);
  assert.equal(first.reason, 'expansion_limit');
  assert.equal(first.action?.id, 'first');
  assert.deepEqual(planPredictively(input), first);
  assert.deepEqual({ state: input.state, actions: input.actions }, before);
  assert.equal(Object.isFrozen(input.actions[0]!.payload), false);
  const malicious = planPredictively(options({ model: { predict: (s, a) => {
    (s as number[])[0] = 999; a.payload.changed = true; return { state: [10], uncertainty: 0 };
  } } }));
  assert.equal(malicious.action, undefined);
  assert.deepEqual(input.state, [0]);
});

test('rejects invalid search limits, vectors and costs before prediction', () => {
  const invalid: Partial<PredictivePlanningOptions>[] = [
    { state: [] }, { state: new Array(1) }, { state: Array(65).fill(0) }, { goal: [0, 1] },
    { horizon: 0 }, { horizon: 17 }, { beamWidth: 65 }, { maxExpansions: 100001 },
    { maxExpansions: 1.5 }, { budgetMicros: Number.MAX_SAFE_INTEGER + 1 },
    { uncertaintyPenalty: Infinity }, { maxUncertainty: -1 }, { actions: [] },
    { actions: Array(129).fill(action('too-many')) },
  ];
  for (const change of invalid) assert.throws(() => planPredictively(options(change)), /invalid_planning_input/);
});

test('model cannot extend validated search budget by changing caller options', () => {
  const input = options({ maxExpansions: 1 });
  input.model = { predict: () => {
    input.maxExpansions = 100000;
    input.horizon = 16;
    input.budgetMicros = Number.MAX_SAFE_INTEGER;
    return { state: [1], uncertainty: 0 };
  } };
  assert.equal(planPredictively(input).expansions, 1);
});
