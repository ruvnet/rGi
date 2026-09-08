import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { baselineFactory, candidateFactory, makeGeneralizationTasks } from '../src/generalization-fixtures.ts';

test('fixtures are deterministic, uniquely identified, with disjoint support and queries', () => {
  const tasks = makeGeneralizationTasks();
  assert.deepEqual(tasks, makeGeneralizationTasks());
  assert.equal(tasks.length, 48);
  assert.equal(new Set(tasks.map(task => task.id)).size, tasks.length);
  assert.equal(new Set(tasks.filter(task => task.split === 'transfer').map(task => task.family)).size, 3);
  for (const task of tasks) {
    const support = new Set(task.support.map(example => JSON.stringify(example.input)));
    assert.ok(task.support.length > 0 && task.support.length <= 8);
    assert.equal(task.queries.length, 6);
    for (const query of task.queries) assert.equal(support.has(JSON.stringify(query.input)), false);
  }
});

test('finite learner solves supported instances with identical opportunity metering', async () => {
  const signal = new AbortController().signal;
  let frozenCorrect = 0;
  let total = 0;
  for (const task of makeGeneralizationTasks()) {
    const candidate = candidateFactory.create();
    const baseline = baselineFactory.create();
    assert.deepEqual(await candidate.learn!(task.support, signal), await baseline.learn!(task.support, signal));
    for (const query of task.queries) {
      const learned = await candidate.predict(query.input, signal);
      const frozen = await baseline.predict(query.input, signal);
      assert.deepEqual(learned.output, query.output);
      assert.equal(learned.costMicros, 1);
      assert.equal(learned.modelCalls, 1);
      assert.equal(learned.humanInterventions, 0);
      if (JSON.stringify(frozen.output) === JSON.stringify(query.output)) frozenCorrect++;
      total++;
    }
  }
  assert.ok(frozenCorrect < total);
});

test('instances isolate learning, reject unsupported inputs and honor cancellation', async () => {
  const signal = new AbortController().signal;
  const learned = candidateFactory.create();
  await learned.learn!([{ input: 'a', output: 'c' }, { input: 'b', output: 'a' }], signal);
  assert.equal((await learned.predict('abc', signal)).output, 'cab');
  assert.equal((await candidateFactory.create().predict('abc', signal)).output, 'abc');
  assert.equal((await learned.predict({ arbitrary: true }, signal)).output, null);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(learned.predict('abc', controller.signal));
  await assert.rejects(learned.learn!([], controller.signal));
});

test('without support both agents use identical prediction and metering policies', async () => {
  const signal = new AbortController().signal;
  for (const task of makeGeneralizationTasks()) {
    const candidate = candidateFactory.create();
    const baseline = baselineFactory.create();
    for (const query of task.queries)
      assert.deepEqual(await candidate.predict(query.input, signal), await baseline.predict(query.input, signal));
  }
});

test('artifact hash identifies actual shared implementation source', () => {
  const expected = createHash('sha256').update(readFileSync(new URL('../src/generalization-fixtures.ts', import.meta.url))).digest('hex');
  assert.equal(candidateFactory.artifactSha256, expected);
  assert.equal(baselineFactory.artifactSha256, expected);
  assert.notEqual(candidateFactory.id, baselineFactory.id);
});
