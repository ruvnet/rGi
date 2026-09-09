import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryFixtures, type DiscoveryFixture } from '../src/discovery-fixtures.ts';

// Reference evaluators deliberately use a different representation and operations
// from the fixture builders. Every hypothesis is checked, not only the target row.
function reference(family: string, rule: number, input: string): number {
  if (family === 'threshold') {
    const boundary = Array.from({ length: 16 }, (_, index) => index + index + 1)[rule]!;
    return Number(input) < boundary ? 0 : 1;
  }
  if (family === 'modular-affine') {
    const coefficients = Array.from({ length: 12 }, (_, gain) =>
      Array.from({ length: 12 }, (_, offset) => ({ gain, offset }))).flat();
    const { gain, offset } = coefficients[rule]!;
    let result = offset;
    for (let count = 0; count < Number(input); count++) {
      result += gain;
      while (result >= 12) result -= 12;
    }
    return result;
  }
  assert.equal(family, 'boolean-composition');
  const operations = rule.toString(3).padStart(3, '0').split('').reverse().map(Number);
  const bits = input.split('').reverse().map(Number);
  const pairOutputs = operations.map((operation, pair) => {
    const sum = bits[pair * 2]! + bits[pair * 2 + 1]!;
    return operation === 0 ? Number(sum === 2) : operation === 1 ? Number(sum > 0) : Number(sum === 1);
  });
  return pairOutputs.reduce((sum, value) => sum + value, 0) % 2;
}

function representatives(tasks: DiscoveryFixture[]): DiscoveryFixture[] {
  return [...new Map(tasks.map(task => [task.family, task])).values()];
}

test('discovery fixtures are deterministic, exhaustively cover declared targets and hold fixed budgets', () => {
  const tasks = discoveryFixtures();
  assert.deepEqual(tasks, discoveryFixtures());
  assert.equal(tasks.length, 187);
  assert.equal(new Set(tasks.map(task => task.id)).size, tasks.length);
  const expected = [
    { family: 'threshold', count: 16, budget: { maxProbes: 3, maxCost: 3 } },
    { family: 'modular-affine', count: 144, budget: { maxProbes: 2, maxCost: 4 } },
    { family: 'boolean-composition', count: 27, budget: { maxProbes: 4, maxCost: 4 } },
  ];
  for (const { family, count, budget } of expected) {
    const familyTasks = tasks.filter(task => task.family === family);
    assert.equal(familyTasks.length, count);
    assert.deepEqual(familyTasks.map(task => task.target).sort((a, b) => a - b),
      Array.from({ length: count }, (_, index) => index));
    assert.equal(new Set(familyTasks.map(task => JSON.stringify(task.problem.probeIndices))).size, 1);
    assert.equal(new Set(familyTasks.map(task => JSON.stringify(task.problem))).size, 1);
    for (const task of familyTasks) {
      assert.equal(task.problem.hypotheses.length, count);
      assert.deepEqual(task.budget, budget);
      assert.ok(task.target >= 0 && task.target < task.problem.hypotheses.length);
      assert.equal('target' in task.problem, false);
    }
  }
});

test('every public truth table agrees with independent reference rules', () => {
  for (const task of representatives(discoveryFixtures())) {
    for (const [rule, row] of task.problem.hypotheses.entries()) {
      assert.deepEqual(row, task.problem.inputs.map(input => reference(task.family, rule, input)),
        `${task.family} rule ${rule}`);
    }
  }
});

test('probe and query inputs are distinct, bounded and all rules are distinguishable from complete probes', () => {
  for (const task of discoveryFixtures()) {
    const { inputs, hypotheses, costs, probeIndices, queryIndices } = task.problem;
    assert.equal(task.problem.version, 1);
    assert.ok(inputs.length <= 128);
    assert.equal(new Set(inputs).size, inputs.length);
    assert.ok(hypotheses.length <= 256);
    assert.equal(costs.length, inputs.length);
    assert.ok(costs.every(cost => Number.isSafeInteger(cost) && cost > 0));
    assert.equal(new Set([...probeIndices, ...queryIndices]).size, inputs.length);
    assert.equal(probeIndices.length + queryIndices.length, inputs.length);
    for (const index of [...probeIndices, ...queryIndices])
      assert.ok(Number.isSafeInteger(index) && index >= 0 && index < inputs.length);
    for (const row of hypotheses) {
      assert.equal(row.length, inputs.length);
      assert.ok(row.every(output => Number.isSafeInteger(output) && output >= 0 && output <= 255));
    }
    assert.equal(new Set(hypotheses.map(row => JSON.stringify(row))).size, hypotheses.length);
    assert.equal(new Set(hypotheses.map(row => JSON.stringify(probeIndices.map(index => row[index])))).size,
      hypotheses.length, `${task.family}: full probe pool identifies every rule`);
  }
});

test('fixtures expose varied probe costs and do not share mutable task state', () => {
  const tasks = discoveryFixtures();
  const modular = tasks.find(task => task.family === 'modular-affine')!;
  assert.deepEqual([...new Set(modular.problem.probeIndices.map(index => modular.problem.costs[index]))].sort(), [1, 2, 3]);
  const [first, second] = tasks;
  const secondCopy = structuredClone(second!);
  first!.problem.inputs[0] = 'changed';
  first!.problem.hypotheses[0]![0] = 255;
  first!.problem.costs[0] = 255;
  first!.problem.probeIndices.reverse();
  first!.problem.queryIndices.reverse();
  first!.budget.maxCost = 255;
  assert.deepEqual(second, secondCopy);
  assert.notDeepEqual(first, discoveryFixtures()[0]);
});
