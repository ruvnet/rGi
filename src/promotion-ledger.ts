import { DatabaseSync } from 'node:sqlite';
import { evaluateCandidate, type CandidateEvaluation, type PromotionDecision } from './evaluation.ts';

export interface PromotionLedgerConfig { totalAlpha: number; maxEvaluations: number }
const evaluatedReasons = new Set(['gate_passed', 'capability_violation', 'domain_regression',
  'cost_regression', 'no_improvement', 'insufficient_significance']);

/** Durable host-owned audit consumption. Exact IDs prevent reuse within this DB;
 * they cannot establish semantic independence or prevent a host resetting the DB.
 * The caller owns the SQLite connection and must not call inside a transaction. */
export class PromotionLedger {
  private readonly db: DatabaseSync;
  private readonly totalAlpha: number;
  private readonly maxEvaluations: number;
  constructor(db: DatabaseSync, config: PromotionLedgerConfig) {
    if (!config || !Number.isFinite(config.totalAlpha) || config.totalAlpha <= 0
      || config.totalAlpha > 0.05 || !Number.isSafeInteger(config.maxEvaluations)
      || config.maxEvaluations < 1 || config.maxEvaluations > 1000
      || config.totalAlpha / config.maxEvaluations === 0) throw new Error('invalid_ledger_config');
    this.db = db; this.totalAlpha = config.totalAlpha; this.maxEvaluations = config.maxEvaluations;
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS rgi_evaluation_config (
        id INTEGER PRIMARY KEY CHECK(id=1), total_alpha REAL NOT NULL, max_evaluations INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS rgi_evaluations (
        candidate_id TEXT PRIMARY KEY, baseline_id TEXT NOT NULL, alpha REAL NOT NULL,
        manifest_sha256 TEXT NOT NULL, decision TEXT NOT NULL, created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS rgi_evaluation_tasks (
        task_id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES rgi_evaluations(candidate_id));`);
      this.db.prepare('INSERT OR IGNORE INTO rgi_evaluation_config(id,total_alpha,max_evaluations) VALUES(1,?,?)')
        .run(this.totalAlpha, this.maxEvaluations);
      this.assertConfig();
    });
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private assertConfig(): void {
    const row = this.db.prepare('SELECT total_alpha,max_evaluations FROM rgi_evaluation_config WHERE id=1').get();
    if (!row || row.total_alpha !== this.totalAlpha || row.max_evaluations !== this.maxEvaluations)
      throw new Error('ledger_config_mismatch');
  }
  get count(): number {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM rgi_evaluations').get()!.n);
  }
  evaluate(input: CandidateEvaluation): PromotionDecision {
    const decision = evaluateCandidate(input);
    if (!evaluatedReasons.has(decision.reason)) throw new Error(`invalid_evaluation:${decision.reason}`);
    if (input.alpha > this.totalAlpha / this.maxEvaluations) throw new Error('ledger_alpha_exceeded');
    return this.transaction(() => {
      this.assertConfig();
      if (this.db.prepare('SELECT 1 FROM rgi_evaluations WHERE candidate_id=?').get(input.candidateId))
        throw new Error('candidate_reused');
      if (this.count >= this.maxEvaluations) throw new Error('evaluation_budget_exhausted');
      const lookup = this.db.prepare('SELECT 1 FROM rgi_evaluation_tasks WHERE task_id=?');
      for (const id of input.auditIds) if (lookup.get(id)) throw new Error('audit_reused');
      this.db.prepare(`INSERT INTO rgi_evaluations
        (candidate_id,baseline_id,alpha,manifest_sha256,decision,created) VALUES(?,?,?,?,?,?)`)
        .run(input.candidateId, input.baselineId, input.alpha, decision.manifestSha256,
          JSON.stringify(decision), Date.now());
      const insert = this.db.prepare('INSERT INTO rgi_evaluation_tasks(task_id,candidate_id) VALUES(?,?)');
      for (const id of input.auditIds) insert.run(id, input.candidateId);
      return decision;
    });
  }
}
