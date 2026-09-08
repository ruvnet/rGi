/** Host-owned contracts. Observation, inference and action are different records. */
export interface Observation {
  id: string; source: string; timestamp: number; modality: string;
  data: unknown; confidence: number;
  expiresAt?: number;
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
  outcomes: ExecutionFeedback[];
  remainingBudgetMicros: number; signal: AbortSignal;
}
export interface Planner {
  plan(context: PlanningContext): Promise<Action[]>;
  snapshot?(): unknown;
  restore?(snapshot: unknown): void;
}
/** Completed transport execution is not independently verified task success. */
export interface ExecutionFeedback {
  actionId:string;capability:string;status:'succeeded'|'denied'|'uncertain';
  payload?:Record<string,unknown>;output?:unknown;omitted:boolean;
  actualCostMicros:number|null;reason:string|null;timestamp:number;
}
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
  maxOutcomeContext:number;maxObservationAgeMs:number;
  actionTimeoutMs: number; leaseMs: number; idleMs: number;
}
export const DEFAULT_CONFIG: RuntimeConfig = {
  allowedCapabilities: [], budgetMicros: 0, minConfidence: 0.8,
  maxQueue: 128, maxObservations: 256, maxRecordBytes: 65536,
  maxDatabaseBytes: 268435456,
  maxOutcomeContext:32,maxObservationAgeMs:300000,
  actionTimeoutMs: 30000, leaseMs: 60000, idleMs: 250,
};
