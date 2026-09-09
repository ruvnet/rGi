/** Public finite-prior fixtures for active rule discovery. These measure selection of
 * informative observations inside known rule families, not open-world generalization.
 * Targets enumerate every declared rule; no target is supplied to the learner.
 *
 * Budgets are fixed before observing arm scores: threshold discovery receives three
 * binary observations for sixteen rules; modular discovery receives two observations
 * for two unknown coefficients, subject to a four-unit retrieval budget; Boolean
 * composition receives four binary observations for twenty-seven rules. Some budgets
 * intentionally leave ambiguity. Costs are synthetic retrieval units, not provider
 * charges or measured latency. Do not tune these budgets against benchmark results.
 */
import type { DiscoveryProblem } from './discovery.ts';

export interface DiscoveryFixture {
  id: string;
  family: string;
  problem: DiscoveryProblem;
  target: number;
  budget: { maxProbes: number; maxCost: number };
}

function shuffled(values: readonly number[], seed: number): number[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const other = Math.floor(((state >>> 0) / 0x100000000) * (index + 1));
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

function fixtures(
  family: string,
  source: DiscoveryProblem,
  budget: DiscoveryFixture['budget'],
  seed: number,
): DiscoveryFixture[] {
  // Public acquisition metadata must not encode the hidden target identity.
  const probeOrder = shuffled(source.probeIndices, seed);
  return source.hypotheses.map((_, target) => ({
    id: `${family}:${target}`,
    family,
    target,
    budget: { ...budget },
    // Separate allocations prevent one task or arm from mutating another task.
    problem: {
      version: 1,
      inputs: [...source.inputs],
      hypotheses: source.hypotheses.map(row => [...row]),
      costs: [...source.costs],
      probeIndices: [...probeOrder],
      queryIndices: [...source.queryIndices],
    },
  }));
}

function booleanComposition(rule: number, value: number): number {
  let output = 0;
  for (let pair = 0; pair < 3; pair++) {
    const left = (value >>> (pair * 2)) & 1;
    const right = (value >>> (pair * 2 + 1)) & 1;
    const operation = Math.floor(rule / (3 ** pair)) % 3;
    output ^= operation === 0 ? left & right : operation === 1 ? left | right : left ^ right;
  }
  return output;
}

/** 187 exhaustive targets: 16 thresholds, 144 modular affine maps and 27 Boolean
 * compositions. Query inputs are distinct from probe inputs. Modular queries repeat
 * residue classes at new integer inputs, so this family tests coefficient discovery,
 * not novel arithmetic. Boolean train/query partitioning is fixed independently of
 * rule identity. All arms receive the same prior, input pool, order and budget.
 */
export function discoveryFixtures(): DiscoveryFixture[] {
  const thresholdInputs = Array.from({ length: 32 }, (_, index) => index);
  const modularInputs = Array.from({ length: 24 }, (_, index) => index);
  const booleanInputs = Array.from({ length: 64 }, (_, index) => index);
  const booleanPartition = shuffled(booleanInputs, 0x5a17);
  const threshold: DiscoveryProblem = {
    version: 1,
    inputs: thresholdInputs.map(String),
    hypotheses: Array.from({ length: 16 }, (_, rule) =>
      thresholdInputs.map(value => Number(value >= 2 * rule + 1))),
    costs: thresholdInputs.map(() => 1),
    probeIndices: thresholdInputs.filter(value => value % 2 === 0),
    queryIndices: thresholdInputs.filter(value => value % 2 === 1),
  };
  const modular: DiscoveryProblem = {
    version: 1,
    inputs: modularInputs.map(String),
    hypotheses: Array.from({ length: 144 }, (_, rule) => {
      const gain = Math.floor(rule / 12);
      const offset = rule % 12;
      return modularInputs.map(value => (gain * value + offset) % 12);
    }),
    // Three price tiers in the available probe pool: 1, 2 and 3 units.
    costs: modularInputs.map(value => 1 + Math.floor(value / 4)),
    probeIndices: modularInputs.filter(value => value < 12),
    queryIndices: modularInputs.filter(value => value >= 12),
  };
  const boolean: DiscoveryProblem = {
    version: 1,
    inputs: booleanInputs.map(value => value.toString(2).padStart(6, '0')),
    hypotheses: Array.from({ length: 27 }, (_, rule) =>
      booleanInputs.map(value => booleanComposition(rule, value))),
    costs: booleanInputs.map(() => 1),
    probeIndices: booleanPartition.slice(0, 40),
    queryIndices: booleanPartition.slice(40),
  };
  return [
    ...fixtures('threshold', threshold, { maxProbes: 3, maxCost: 3 }, 0x51ed270b),
    ...fixtures('modular-affine', modular, { maxProbes: 2, maxCost: 4 }, 0xa3b19535),
    ...fixtures('boolean-composition', boolean, { maxProbes: 4, maxCost: 4 }, 0x7f4a7c15),
  ];
}
