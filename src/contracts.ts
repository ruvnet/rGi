/** Host-owned contracts. Observation, inference and action are different records. */
export interface Observation {
  id: string; source: string; timestamp: number; modality: string;
  data: unknown; confidence: number;
}
export interface Action {
  id: string; capability: string; payload: Record<string, unknown>;
  estimatedCostMicros: number; confidence: number;
}
export interface ExecutionContext { signal: AbortSignal; idempotencyKey: string }
export interface ExecutionResult { output: unknown; actualCostMicros: number }
export interface Executor {
  execute(action: Action, context: ExecutionContext): Promise<ExecutionResult>;
}
export interface PlanningContext {
  observations: Observation[]; sequence: number;
  remainingBudgetMicros: number; signal: AbortSignal;
}
export interface Planner { plan(context: PlanningContext): Promise<Action[]> }
export interface PolicyInput {
  capability: string; allowedCapabilities: string[];
  spentMicros: number; reservedMicros: number; requestedMicros: number;
  budgetMicros: number; confidence: number; minConfidence: number; stopped: boolean;
}
export interface PolicyDecision { allowed: boolean; reason: string }
export type PolicyEvaluator = (input: PolicyInput) => PolicyDecision;
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'denied' | 'uncertain';
export interface RuntimeConfig {
  allowedCapabilities: string[]; budgetMicros: number; minConfidence: number;
  maxQueue: number; maxObservations: number; maxRecordBytes: number;
  maxDatabaseBytes: number;
  actionTimeoutMs: number; leaseMs: number; idleMs: number;
}
export const DEFAULT_CONFIG: RuntimeConfig = {
  allowedCapabilities: [], budgetMicros: 0, minConfidence: 0.8,
  maxQueue: 128, maxObservations: 256, maxRecordBytes: 65536,
  maxDatabaseBytes: 268435456,
  actionTimeoutMs: 30000, leaseMs: 60000, idleMs: 250,
};
