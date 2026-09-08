/** Synthetic, known-prior program induction fixtures, not evidence of AGI or unseen-domain
 * generalization. Both agents enumerate the same finite program library. Only the candidate
 * conditions on support examples. Cost and model-call units are synthetic counters, not
 * provider charges or neural model calls. No family labels or query answers enter agents. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AgentFactory, AgentReply, Example, TransferAgent, TransferTask } from './generalization-contracts.ts';

type Program = (input: unknown) => unknown;
const modular: Program[] = [];
const affine: Program[] = [];
for (const modulus of [5, 7, 11]) for (const gain of [1, 2, 3]) for (const offset of [0, 1, 2, 3])
  modular.push(input => Number.isSafeInteger(input) ? ((input as number) * gain + offset) % modulus : undefined);
for (const gain of [-2, -1, 1, 2]) for (const offset of [-3, -1, 1, 3])
  affine.push(input => Number.isSafeInteger(input) ? (input as number) * gain + offset : undefined);
const symbols: Program[] = ['abc', 'acb', 'bac', 'bca', 'cab', 'cba'].map(permutation => input =>
  typeof input === 'string' && /^[abc]{1,3}$/.test(input)
    ? [...input].map(symbol => permutation['abc'.indexOf(symbol)]!).join('') : undefined);
const operations = [
  (a: boolean, b: boolean) => a && b,
  (a: boolean, b: boolean) => a || b,
  (a: boolean, b: boolean) => a !== b,
  (a: boolean, b: boolean) => a === b,
  (a: boolean, b: boolean) => !a || b,
  (a: boolean, b: boolean) => a && !b,
];
const boolean: Program[] = operations.map(operation => input =>
  Array.isArray(input) && input.length === 5 && input.every(value => typeof value === 'boolean')
    ? operation(input[0] as boolean, input[1] as boolean) : undefined);
const programs: readonly Program[] = [...modular, ...affine, ...symbols, ...boolean];
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (index + 1);
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

function makeTask(family: string, index: number, pool: unknown[], prior: readonly Program[], retention = false): TransferTask {
  const seed = (retention ? 9000 : family === 'modular-arithmetic' ? 1000 : family === 'symbol-substitution' ? 2000 : 3000) + index;
  const truth = prior[(index * 7 + 1) % prior.length]!;
  const candidates = shuffled(pool, seed);
  let consistent = [...programs];
  const support: Example[] = [];
  // Select identifying support using only the declared finite prior and candidate inputs.
  // Query outputs are never supplied to an agent, even during support construction.
  for (const input of candidates) {
    const output = truth(input);
    if (consistent.some(program => !same(program(input), output))) {
      support.push({ input, output });
      consistent = consistent.filter(program => same(program(input), output));
    }
  }
  if (support.length > 8) throw new Error('fixture_support_limit');
  const supportInputs = new Set(support.map(example => JSON.stringify(example.input)));
  const queries = candidates.filter(input => !supportInputs.has(JSON.stringify(input))).slice(0, 6)
    .map(input => ({ input, output: truth(input) }));
  if (queries.length !== 6) throw new Error('fixture_query_count');
  return { id: `${retention ? 'retention' : 'transfer'}:${family}:${seed}`, family,
    split: retention ? 'retention' : 'transfer', seed, support, queries };
}

/** 36 transfer instances from three explicitly preprogrammed families and 12 retention
 * instances from the declared development family. Boolean inputs have three distractor
 * bits. All families are in the prior; these are instance holdouts, not prior-free OOD. */
export function makeGeneralizationTasks(): TransferTask[] {
  const symbolInputs = ['a', 'b', 'c'];
  for (const a of 'abc') for (const b of 'abc') {
    symbolInputs.push(a + b);
    for (const c of 'abc') symbolInputs.push(a + b + c);
  }
  const boolInputs = Array.from({ length: 32 }, (_, value) => Array.from({ length: 5 }, (_, bit) => Boolean(value & (1 << bit))));
  return Array.from({ length: 12 }, (_, index) => [
    makeTask('modular-arithmetic', index, Array.from({ length: 48 }, (_, x) => 1000 + index * 100 + x), modular),
    makeTask('symbol-substitution', index, symbolInputs, symbols),
    makeTask('boolean-program', index, boolInputs, boolean),
    makeTask('affine-integer', index, Array.from({ length: 48 }, (_, x) => 10000 + index * 100 + x), affine, true),
  ]).flat();
}

class FinitePriorAgent implements TransferAgent {
  private hypotheses = [...programs];
  private readonly adapt: boolean;
  constructor(adapt: boolean) { this.adapt = adapt; }
  async learn(examples: readonly Example[], signal: AbortSignal): Promise<Omit<AgentReply, 'output'>> {
    signal.throwIfAborted();
    if (this.adapt) for (const example of examples) {
      signal.throwIfAborted();
      this.hypotheses = this.hypotheses.filter(program => same(program(example.input), example.output));
    }
    return { costMicros: examples.length, modelCalls: examples.length, humanInterventions: 0 };
  }
  async predict(input: unknown, signal: AbortSignal): Promise<AgentReply> {
    signal.throwIfAborted();
    const applicable = this.hypotheses.filter(program => program(input) !== undefined);
    // Both use the same first-consistent hypothesis policy, including without support.
    // v2 fixes the public v1 diagnostic's confounded abstention-versus-guess comparator.
    const prediction = applicable[0]?.(input);
    const output = prediction ?? null;
    return { output, costMicros: 1, modelCalls: 1, humanInterventions: 0 };
  }
}

const artifactSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
export const baselineFactory: AgentFactory = {
  id: 'finite-prior-frozen-v2', artifactSha256, create: () => new FinitePriorAgent(false),
};
export const candidateFactory: AgentFactory = {
  id: 'finite-prior-support-v2', artifactSha256, create: () => new FinitePriorAgent(true),
};
