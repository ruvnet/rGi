import type { Action } from './contracts.ts';
import { deepFreeze, identifier, money, validateAction } from './policy.ts';

/** Action-conditioned predictions, never observations or execution authority. */
export interface DynamicsModel {
  predict(state: readonly number[], action: Action): { state: number[]; uncertainty: number };
}
export interface PredictivePlanningOptions {
  state: number[]; goal: number[]; actions: Action[]; model: DynamicsModel;
  horizon: number; beamWidth: number; maxExpansions: number; budgetMicros: number;
  allowedCapabilities: string[]; uncertaintyPenalty: number; maxUncertainty: number;
}
export interface PredictivePlan {
  action?: Action; predictedState?: number[]; loss: number | null;
  expansions: number; reason: string;
}
interface Candidate {
  state: number[]; first?: Action; cost: number; uncertainty: number;
  loss: number; order: number;
}
function vector(value: unknown, dimension?: number): value is number[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 64 &&
    (dimension === undefined || value.length === dimension) &&
    Array.from(value).every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1e6);
}
function boundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}
function goalLoss(state: number[], goal: number[]): number {
  return state.reduce((sum, value, i) => sum + ((value - goal[i]!) / Math.max(1, Math.abs(goal[i]!))) ** 2, 0) / state.length;
}

/**
 * Deterministic beam search with a hard prediction-call budget. Replan after
 * executing only the first action. Earlier feasible prefixes may beat a full
 * horizon. maxUncertainty bounds the conservative path risk sum capped at 1.
 * Prediction callbacks are trusted synchronous code: the expansion budget is
 * not a wall-clock timeout or process isolation boundary.
 */
export function planPredictively(options: PredictivePlanningOptions): PredictivePlan {
  try {
    if (!options || !vector(options.state) || !vector(options.goal, options.state.length) ||
      !Array.isArray(options.actions) || !boundedInteger(options.actions.length, 128) ||
      !boundedInteger(options.horizon, 16) || !boundedInteger(options.beamWidth, 64) ||
      !boundedInteger(options.maxExpansions, 100000) ||
      !options.model || typeof options.model.predict !== 'function' ||
      !Array.isArray(options.allowedCapabilities) || options.allowedCapabilities.length > 256 ||
      !Number.isFinite(options.uncertaintyPenalty) || options.uncertaintyPenalty < 0 || options.uncertaintyPenalty > 1e6 ||
      !Number.isFinite(options.maxUncertainty) || options.maxUncertainty < 0 || options.maxUncertainty > 1)
      throw new Error('invalid');
    money(options.budgetMicros);
    options.allowedCapabilities.forEach(identifier);
  } catch { throw new Error('invalid_planning_input'); }

  // Snapshot validated controls before invoking extension code.
  const { horizon, beamWidth, maxExpansions, budgetMicros, uncertaintyPenalty, maxUncertainty, model } = options;
  const goal = [...options.goal];
  const allowed = new Set(options.allowedCapabilities);
  const actions: Action[] = [];
  for (const action of options.actions) {
    try {
      validateAction(action);
      if (!allowed.has(action.capability) || action.estimatedCostMicros > budgetMicros) continue;
      // Clone before freezing, so caller-owned payloads are never frozen/mutated.
      actions.push(deepFreeze(structuredClone(action)));
    } catch { /* Malformed actions are infeasible, not fatal to other choices. */ }
  }
  let frontier: Candidate[] = [{ state: [...options.state], cost: 0, uncertainty: 0,
    loss: goalLoss(options.state, goal), order: 0 }];
  let best: Candidate | undefined;
  let expansions = 0;
  let order = 0;
  for (let depth = 0; depth < horizon && frontier.length && expansions < maxExpansions; depth++) {
    const next: Candidate[] = [];
    for (const parent of frontier) {
      for (const action of actions) {
        if (expansions >= maxExpansions) break;
        // Subtraction avoids overflowing a safe integer when summing costs.
        if (action.estimatedCostMicros > budgetMicros - parent.cost) continue;
        expansions++;
        try {
          const prediction = model.predict(Object.freeze([...parent.state]), action);
          if (!prediction || !vector(prediction.state, goal.length) ||
            !Number.isFinite(prediction.uncertainty) || prediction.uncertainty < 0 || prediction.uncertainty > 1) continue;
          const cumulative = parent.uncertainty + prediction.uncertainty;
          if (Math.min(1, cumulative) > maxUncertainty) continue;
          const state = [...prediction.state];
          const candidate: Candidate = { state, first: parent.first ?? action,
            cost: parent.cost + action.estimatedCostMicros, uncertainty: cumulative,
            loss: goalLoss(state, goal) + uncertaintyPenalty * cumulative, order: order++ };
          next.push(candidate);
          if (!best || candidate.loss < best.loss) best = candidate;
        } catch { /* Invalid or throwing models only eliminate this branch. */ }
      }
    }
    next.sort((a, b) => a.loss - b.loss || a.order - b.order);
    frontier = next.slice(0, beamWidth);
  }
  if (!best) return { loss: null, expansions, reason: 'no_feasible_plan' };
  return { action: structuredClone(best.first!), predictedState: [...best.state],
    loss: best.loss, expansions, reason: expansions >= maxExpansions ? 'expansion_limit' : 'planned' };
}
