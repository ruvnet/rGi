import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { Action, Observation, RuntimeConfig, JobStatus, ExecutionFeedback } from './contracts.ts';
import { boundedJson, identifier, money, validateAction, validateObservation } from './policy.ts';

type Row = Record<string, unknown>;
export interface Job { id: string; action: Action; status: JobStatus; reason: string | null }
/** Single writer lease plus SQLite transactions. Store paths are trusted host configuration. */
export class Store {
  readonly db: DatabaseSync;
  readonly config: RuntimeConfig;
  constructor(path: string, config: RuntimeConfig, initialize = true) {
    this.config = config;
    this.db = new DatabaseSync(path);
    if (!initialize) return;
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
    if (version > 2) { this.db.close(); throw new Error('unsupported_database_version'); }
    if(version===1){
      const active=this.db.prepare('SELECT owner,lease_until FROM control WHERE id=1').get();
      if(active?.owner!==null&&Number(active?.lease_until)>Date.now()){
        this.db.close();throw new Error('migration_requires_stopped_runtime');
      }
    }
    const pageSize = Number(this.db.prepare('PRAGMA page_size').get()?.page_size);
    const maxPages = Math.floor(config.maxDatabaseBytes / pageSize);
    const actualMax = Number(this.db.prepare(`PRAGMA max_page_count=${maxPages}`).get()?.max_page_count);
    if (actualMax > maxPages) { this.db.close(); throw new Error('database_exceeds_limit'); }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS control (
        id INTEGER PRIMARY KEY CHECK(id=1), stopped INTEGER NOT NULL DEFAULT 0,
        spent INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0,
        sequence INTEGER NOT NULL DEFAULT 0, owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO control(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL, action TEXT NOT NULL,
        status TEXT NOT NULL, reason TEXT, result TEXT, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, created);
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY, body TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
        job_id TEXT, detail TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (name TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feedback (seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT UNIQUE NOT NULL,body TEXT NOT NULL);
      PRAGMA user_version=2;
    `);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  control(): { stopped: boolean; spentMicros: number; reservedMicros: number; sequence: number } {
    const row = this.db.prepare('SELECT * FROM control WHERE id=1').get() as Row;
    return { stopped: row.stopped === 1, spentMicros: Number(row.spent), reservedMicros: Number(row.reserved), sequence: Number(row.sequence) };
  }
  acquire(owner: string): void {
    this.transaction(() => {
      const now = Date.now();
      const row = this.db.prepare('SELECT owner, lease_until FROM control WHERE id=1').get() as Row;
      if (row.owner !== null && Number(row.lease_until) > now) throw new Error('runtime_already_owned');
      this.db.prepare('UPDATE control SET owner=?,lease_until=? WHERE id=1').run(owner, now + this.config.leaseMs);
      const running = this.db.prepare("SELECT id FROM jobs WHERE status='running'").all() as Row[];
      this.db.prepare("UPDATE jobs SET status='uncertain',reason='interrupted' WHERE status='running'").run();
      if (running.length) {
        this.db.prepare('UPDATE control SET stopped=1 WHERE id=1').run();
        for (const job of running) {
          this.receipt('uncertain', String(job.id), 'interrupted');
          const action=this.job(String(job.id))?.action;
          if(action)this.recordFeedback(action,'uncertain',undefined,null,'interrupted');
        }
      }
    });
  }
  assertOwner(owner: string): void {
    const row = this.db.prepare('SELECT owner,lease_until FROM control WHERE id=1').get() as Row;
    if (row.owner !== owner || Number(row.lease_until) <= Date.now()) throw new Error('lease_lost');
  }
  renew(owner: string): void {
    this.transaction(() => {
      this.assertOwner(owner);
      this.db.prepare('UPDATE control SET lease_until=? WHERE id=1').run(Date.now() + this.config.leaseMs);
    });
  }
  release(owner: string): void {
    this.db.prepare('UPDATE control SET owner=NULL,lease_until=0 WHERE id=1 AND owner=?').run(owner);
  }
  receipt(kind: string, id: string | null, detail: string): void {
    this.db.prepare('INSERT INTO receipts(kind,job_id,detail,created) VALUES(?,?,?,?)').run(kind,id,detail,Date.now());
  }
  enqueue(action: Action): boolean {
    validateAction(action, this.config.maxRecordBytes);
    const body = boundedJson(action, this.config.maxRecordBytes);
    const digest = createHash('sha256').update(body).digest('hex');
    const existing = this.db.prepare('SELECT digest FROM jobs WHERE id=?').get(action.id) as Row | undefined;
    if (existing) {
      if (existing.digest !== digest) throw new Error('idempotency_conflict');
      return false;
    }
    // Leave disk headroom to record outcomes of already admitted work. WAL needs
    // separate filesystem quotas; max_page_count only caps the SQLite main database.
    const pages = Number(this.db.prepare('PRAGMA page_count').get()?.page_count);
    const size = Number(this.db.prepare('PRAGMA page_size').get()?.page_size);
    if (pages * size > this.config.maxDatabaseBytes * 0.8) throw new Error('journal_capacity_reached');
    const row = this.db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running','uncertain')").get() as Row;
    if (Number(row.n) >= this.config.maxQueue) throw new Error('queue_full');
    this.db.prepare("INSERT INTO jobs(id,digest,action,status,created) VALUES(?,?,?,'queued',?)")
      .run(action.id,digest,body,Date.now());
    this.receipt('queued', action.id, action.capability);
    return true;
  }
  next(): Action | undefined {
    const row = this.db.prepare("SELECT action FROM jobs WHERE status='queued' ORDER BY created,rowid LIMIT 1").get() as Row | undefined;
    return row ? JSON.parse(String(row.action)) as Action : undefined;
  }
  reserve(action: Action): void {
    const control = this.control();
    money(control.reservedMicros + action.estimatedCostMicros);
    this.db.prepare('UPDATE control SET reserved=reserved+? WHERE id=1').run(action.estimatedCostMicros);
    this.db.prepare("UPDATE jobs SET status='running' WHERE id=? AND status='queued'").run(action.id);
    this.receipt('started',action.id,'reserved');
  }
  deny(id: string, reason: string): void {
    this.db.prepare("UPDATE jobs SET status='denied',reason=? WHERE id=?").run(reason,id);
    this.receipt('denied',id,reason);
    const action=this.job(id)?.action;if(action)this.recordFeedback(action,'denied',undefined,0,reason);
  }
  finish(action: Action, output: unknown, actualCostMicros: number): void {
    money(actualCostMicros);
    const control = this.control(); money(control.spentMicros + actualCostMicros);
    const body = boundedJson(output, this.config.maxRecordBytes);
    this.db.prepare('UPDATE control SET reserved=reserved-?,spent=spent+? WHERE id=1')
      .run(action.estimatedCostMicros,actualCostMicros);
    this.db.prepare("UPDATE jobs SET status='succeeded',result=? WHERE id=?").run(body,action.id);
    if (this.control().spentMicros + this.control().reservedMicros > this.config.budgetMicros)
      this.db.prepare('UPDATE control SET stopped=1 WHERE id=1').run();
    this.receipt('succeeded',action.id,JSON.stringify({actualCostMicros}));
    this.recordFeedback(action,'succeeded',output,actualCostMicros,null);
  }
  uncertain(id: string, reason: string): void {
    this.db.prepare("UPDATE jobs SET status='uncertain',reason=? WHERE id=? AND status='running'").run(reason,id);
    this.db.prepare('UPDATE control SET stopped=1 WHERE id=1').run();
    this.receipt('uncertain',id,reason);
    const action=this.job(id)?.action;if(action)this.recordFeedback(action,'uncertain',undefined,null,reason);
  }
  observe(observation: Observation): void {
    validateObservation(observation, this.config.maxRecordBytes);
    const body = boundedJson(observation, this.config.maxRecordBytes);
    const existing = this.db.prepare('SELECT body FROM observations WHERE id=?').get(observation.id) as Row | undefined;
    if (existing && existing.body !== body) throw new Error('observation_conflict');
    this.db.prepare('INSERT OR IGNORE INTO observations(id,body,created) VALUES(?,?,?)').run(observation.id,body,Date.now());
    this.db.prepare('DELETE FROM observations WHERE id IN (SELECT id FROM observations ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET ?)').run(this.config.maxObservations);
  }
  observations(): Observation[] {
    return this.db.prepare('SELECT body FROM observations ORDER BY created,rowid').all().map(row => JSON.parse(String(row.body)) as Observation);
  }
  private recordFeedback(action:Action,status:ExecutionFeedback['status'],output:unknown,cost:number|null,reason:string|null):void{
    let record:ExecutionFeedback={actionId:action.id,capability:action.capability,status,payload:action.payload,
      ...(output===undefined?{}:{output}),omitted:false,actualCostMicros:cost,reason,timestamp:Date.now()};
    let body:string;
    try{body=boundedJson(record,this.config.maxRecordBytes);}
    catch{
      record={actionId:action.id,capability:action.capability,status,omitted:true,actualCostMicros:cost,reason,timestamp:Date.now()};
      body=boundedJson(record,this.config.maxRecordBytes);
    }
    this.db.prepare('DELETE FROM feedback WHERE job_id=?').run(action.id);
    this.db.prepare('INSERT INTO feedback(job_id,body) VALUES(?,?)').run(action.id,body);
    this.db.prepare('DELETE FROM feedback WHERE seq NOT IN (SELECT seq FROM feedback ORDER BY seq DESC LIMIT ?)').run(this.config.maxOutcomeContext);
  }
  outcomes():ExecutionFeedback[]{
    return this.db.prepare('SELECT body FROM feedback ORDER BY seq').all().map(row=>JSON.parse(String(row.body)) as ExecutionFeedback);
  }
  stop(): void { this.db.prepare('UPDATE control SET stopped=1 WHERE id=1').run(); }
  checkpoint(name: string, value: unknown): void {
    identifier(name);
    const body = boundedJson(value,this.config.maxRecordBytes);
    if(this.db.prepare('SELECT body FROM checkpoints WHERE name=?').get(name)?.body===body)return;
    this.db.prepare('INSERT INTO checkpoints(name,body) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET body=excluded.body').run(name,body);
    this.receipt('checkpoint',null,name);
  }
  restore(name: string): unknown {
    identifier(name);
    const row = this.db.prepare('SELECT body FROM checkpoints WHERE name=?').get(name);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  status(): ReturnType<Store['control']> & { jobs: Record<string, number> } {
    const jobs: Record<string, number> = {};
    for (const row of this.db.prepare('SELECT status,count(*) AS n FROM jobs GROUP BY status').all()) jobs[String(row.status)] = Number(row.n);
    return { ...this.control(), jobs };
  }
  job(id: string): Job | undefined {
    const row = this.db.prepare('SELECT id,action,status,reason FROM jobs WHERE id=?').get(id) as Row | undefined;
    return row ? { id:String(row.id),action:JSON.parse(String(row.action)) as Action,status:row.status as JobStatus,reason:row.reason as string|null } : undefined;
  }
  /** Reconciliation is operator initiated, never retried automatically. */
  reconcile(id: string, actualCostMicros: number, outcome: unknown): void {
    const job = this.job(id);
    if (!job || job.status !== 'uncertain') throw new Error('not_uncertain');
    this.finish(job.action,outcome,actualCostMicros);
    this.receipt('reconciled',id,'operator');
  }
  resume(): void {
    const state = this.status();
    if ((state.jobs.uncertain ?? 0) > 0 || state.spentMicros + state.reservedMicros > this.config.budgetMicros)
      throw new Error('unsafe_resume');
    this.db.prepare('UPDATE control SET stopped=0 WHERE id=1').run();
    this.receipt('resumed',null,'operator');
  }
  close(): void { this.db.close(); }
}
