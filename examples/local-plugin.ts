import type { Executor, Planner } from '../src/contracts.ts';
/** Demonstration only: replace with host-reviewed source-grounded adapters. */
export const planner: Planner = {
  async plan({sequence,remainingBudgetMicros}) {
    if (remainingBudgetMicros < 1) return [];
    return [{id:`local:${sequence}`,capability:'simulation.step',payload:{sequence},estimatedCostMicros:1,confidence:1}];
  },
};
export const executor: Executor = {
  async execute(action,{signal,idempotencyKey}) {
    signal.throwIfAborted();
    return {output:{simulated:true,idempotencyKey,sequence:action.payload.sequence},actualCostMicros:1};
  },
};
