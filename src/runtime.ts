import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_CONFIG } from './contracts.ts';
import type { Action, Executor, Planner, Observation, PolicyEvaluator, RuntimeConfig } from './contracts.ts';
import { evaluatePolicy, validateConfig, validateAction, boundedJson, money, deepFreeze } from './policy.ts';
import { Store } from './store.ts';

export interface RuntimeOptions {
  dbPath: string; config?: Partial<RuntimeConfig>; executor: Executor;
  planner?: Planner; policy?: PolicyEvaluator;
}
/** Perpetual means supervised/restartable, not immortal or unconstrained. */
export class Runtime {
  readonly config: RuntimeConfig;
  readonly store: Store;
  readonly owner = randomUUID();
  readonly executor: Executor;
  readonly planner?: Planner;
  readonly policy: PolicyEvaluator;
  private active = false;
  private closed = false;
  private controller?: AbortController;
  constructor(options: RuntimeOptions) {
    this.config = { ...DEFAULT_CONFIG, ...options.config, allowedCapabilities: [...(options.config?.allowedCapabilities ?? [])] };
    validateConfig(this.config);
    deepFreeze(this.config);
    this.executor = options.executor; this.planner = options.planner;
    this.policy = options.policy ?? evaluatePolicy;
    this.store = new Store(options.dbPath,this.config);
    try { this.store.acquire(this.owner); } catch (error) { this.store.close(); throw error; }
  }
  private check(): void {
    if (this.closed) throw new Error('runtime_closed');
    this.store.assertOwner(this.owner);
  }
  enqueue(action: Action): boolean {
    this.check();
    return this.store.transaction(() => this.store.enqueue(action));
  }
  observe(observation: Observation): void {
    this.check(); this.store.transaction(() => this.store.observe(observation));
  }
  status(): ReturnType<Store['status']> { this.check(); return this.store.status(); }
  checkpoint(name:string,value:unknown):void {
    this.check();this.store.transaction(()=>this.store.checkpoint(name,value));
  }
  restore(name:string):unknown {this.check();return this.store.restore(name);}
  stop(): void { this.check(); this.store.stop(); this.controller?.abort(); }
  resume(): void { this.check(); this.store.transaction(() => this.store.resume()); }
  reconcile(id: string, actualCostMicros: number, outcome: unknown): void {
    this.check(); if (this.active) throw new Error('runtime_busy');
    this.store.transaction(() => this.store.reconcile(id,actualCostMicros,outcome));
  }
  async step(): Promise<boolean> {
    this.check();
    if (this.active) throw new Error('runtime_busy');
    this.active = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      this.store.renew(this.owner);
      if (this.store.control().stopped) return false;
      if (!this.store.next() && this.planner) {
        const control = this.store.control();
        const actions = await this.deadline(() => this.planner!.plan({
          observations:this.store.observations(),sequence:control.sequence,
          remainingBudgetMicros:Math.max(0,this.config.budgetMicros-control.spentMicros-control.reservedMicros), signal,
        }),signal);
        this.check();
        if (signal.aborted || this.store.control().stopped) return false;
        if (!Array.isArray(actions) || actions.length > this.config.maxQueue) throw new Error('invalid_plan');
        this.store.transaction(() => {
          for (const action of actions) this.store.enqueue(action);
          this.store.db.prepare('UPDATE control SET sequence=sequence+1 WHERE id=1').run();
        });
      }
      const action = this.store.next();
      if (!action) return false;
      validateAction(action, this.config.maxRecordBytes);
      deepFreeze(action);
      const admitted = this.store.transaction(() => {
        this.check();
        const control = this.store.control();
        const input = deepFreeze({ stopped:control.stopped,spentMicros:control.spentMicros,reservedMicros:control.reservedMicros,
          capability:action.capability,allowedCapabilities:[...this.config.allowedCapabilities],
          requestedMicros:action.estimatedCostMicros,budgetMicros:this.config.budgetMicros,
          confidence:action.confidence,minConfidence:this.config.minConfidence });
        // A plugin evaluator can narrow authority, never widen the host policy.
        const host = evaluatePolicy(input);
        const decision = host.allowed ? this.policy(input) : host;
        if (decision.allowed !== true) { this.store.deny(action.id, String(decision.reason).slice(0,128)); return false; }
        this.store.reserve(action); return true;
      });
      if (!admitted) return true;
      const aborted = new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('execution_interrupted')), { once:true });
      });
      timeout = setTimeout(() => this.controller?.abort(), this.config.actionTimeoutMs);
      heartbeat = setInterval(() => {
        try {
          this.store.renew(this.owner);
          if (this.store.control().stopped) this.controller?.abort();
        } catch { this.controller?.abort(); }
      }, Math.max(1, Math.min(250,this.config.leaseMs / 4)));
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => this.executor.execute(action, { signal,idempotencyKey:action.id })), aborted,
        ]);
        this.check();
        if (signal.aborted) throw new Error('execution_interrupted');
        money(result.actualCostMicros); boundedJson(result.output,this.config.maxRecordBytes);
        this.store.transaction(() => this.store.finish(action,result.output,result.actualCostMicros));
      } catch {
        // Unknown execution outcome must not be silently retried or release its reservation.
        this.check();
        this.store.transaction(() => this.store.uncertain(action.id,'execution_outcome_unknown'));
      }
      return true;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      this.active = false; this.controller = undefined;
    }
  }
  private async deadline<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(fn),new Promise<never>((_,reject) => {
        signal.addEventListener('abort',() => reject(new Error('planning_interrupted')),{once:true});
        timer = setTimeout(() => { this.controller?.abort(); reject(new Error('planning_timeout')); },this.config.actionTimeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async run(options: { signal?: AbortSignal; maxSteps?: number } = {}): Promise<void> {
    if (options.maxSteps !== undefined && (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 1))
      throw new Error('invalid_max_steps');
    const abort = () => { this.controller?.abort(); };
    options.signal?.addEventListener('abort',abort,{once:true});
    try {
      let steps = 0;
      while (!options.signal?.aborted && !this.store.control().stopped && (options.maxSteps === undefined || steps < options.maxSteps)) {
        try { await this.step(); }
        catch (error) {
          if (options.signal?.aborted) break;
          this.check();this.store.stop();throw error;
        }
        steps++;
        if (!options.signal?.aborted && !this.store.control().stopped) {
          try { await delay(this.config.idleMs,undefined,{signal:options.signal}); }
          catch (error) { if (!options.signal?.aborted) throw error; }
        }
      }
    } finally { options.signal?.removeEventListener('abort',abort); }
  }
  close(): void {
    if (this.closed) return;
    if (this.active) throw new Error('runtime_busy');
    this.store.release(this.owner); this.store.close(); this.closed = true;
  }
}
