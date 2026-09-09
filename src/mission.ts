import {DatabaseSync} from 'node:sqlite';
import {readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import type {MissionArm,MissionProof,MissionSpec,IsolatedSession,ReplayResult} from './mission-contracts.ts';
import {appendEvent,canonicalJson,hashValue,replayProof,validateEvidenceSpec} from './mission-proof.ts';
import {createIsolatedSession} from './isolated-session.ts';

export interface MissionResult {proof:MissionProof;replay:ReplayResult;elapsedMs:number;launches:number;requests:number}
/** Host-owned sequential evaluation, separate from the production execution queue.
 * Audits are single use. Incomplete external effects are never silently retried. */
export async function runMission(spec:MissionSpec,database:DatabaseSync):Promise<MissionResult>{
  const {modulePath,...raw}=spec;
  validateEvidenceSpec(raw);
  const evidenceSpec=JSON.parse(canonicalJson(raw)) as typeof raw;
  const size=statSync(modulePath);if(!size.isFile()||size.size>1024*1024)throw new Error('invalid_agent_bundle');
  if(createHash('sha256').update(readFileSync(modulePath)).digest('hex')!==spec.artifactSha256)throw new Error('artifact_hash_mismatch');
  database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
  database.exec(`CREATE TABLE IF NOT EXISTS rgi_missions(id TEXT PRIMARY KEY,spec_hash TEXT NOT NULL,spec TEXT NOT NULL,status TEXT NOT NULL,proof TEXT,error TEXT);
    CREATE TABLE IF NOT EXISTS rgi_mission_audits(fingerprint TEXT PRIMARY KEY,mission_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rgi_mission_training(fingerprint TEXT PRIMARY KEY,mission_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rgi_mission_events(mission_id TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(mission_id,sequence));`);
  database.exec('BEGIN IMMEDIATE');
  try{
    database.prepare('INSERT INTO rgi_missions(id,spec_hash,spec,status) VALUES(?,?,?,?)').run(evidenceSpec.id,hashValue(evidenceSpec),canonicalJson(evidenceSpec),'running');
    const prior=database.prepare('SELECT 1 FROM rgi_mission_audits WHERE fingerprint=?');
    for(const e of [...evidenceSpec.train,...evidenceSpec.transfer,...evidenceSpec.retention])if(prior.get(hashValue(e.input)))throw new Error('audit_reused');
    const trained=database.prepare('SELECT 1 FROM rgi_mission_training WHERE fingerprint=?');
    for(const e of [...evidenceSpec.transfer,...evidenceSpec.retention])if(trained.get(hashValue(e.input)))throw new Error('training_exposure');
    const insert=database.prepare('INSERT INTO rgi_mission_audits(fingerprint,mission_id) VALUES(?,?)');
    for(const e of [...evidenceSpec.transfer,...evidenceSpec.retention])insert.run(hashValue(e.input),evidenceSpec.id);
    const learn=database.prepare('INSERT OR IGNORE INTO rgi_mission_training(fingerprint,mission_id) VALUES(?,?)');
    for(const e of evidenceSpec.train)learn.run(hashValue(e.input),evidenceSpec.id);
    database.exec('COMMIT');
  }catch(error){database.exec('ROLLBACK');throw error;}
  const start=performance.now();let launches=0,totalRequests=0,session:IsolatedSession|undefined;
  const proof:MissionProof={version:1,spec:evidenceSpec,events:[]};
  let proofBytes=Buffer.byteLength(canonicalJson(proof));
  const record=(arm:MissionArm,kind:Parameters<typeof appendEvent>[2],payload:unknown)=>{
    const bytes=Buffer.byteLength(canonicalJson({sequence:proof.events.length+1,previousHash:'0'.repeat(64),hash:'0'.repeat(64),arm,kind,payload}))+(proof.events.length?1:0);
    if(proofBytes+bytes>8*1024*1024)throw new Error('mission_evidence_limit');
    proofBytes+=bytes;
    appendEvent(proof,arm,kind,payload);
    const event=proof.events.at(-1)!;
    database.prepare('INSERT INTO rgi_mission_events VALUES(?,?,?)').run(evidenceSpec.id,event.sequence,canonicalJson(event));
  };
  const open=async(arm:MissionArm)=>{
    launches++;return createIsolatedSession({modulePath,mode:arm,artifactSha256:evidenceSpec.artifactSha256,
      timeoutMs:evidenceSpec.timeoutMs,maxMessageBytes:evidenceSpec.maxMessageBytes});
  };
  try{
    for(const arm of ['baseline','reset','retained'] as const){
      let requests=0;
      const request=async(method:Parameters<IsolatedSession['request']>[0],payload:unknown)=>{
        if(requests>=evidenceSpec.maxRequests)throw new Error('request_budget_exhausted');
        requests++;totalRequests++;return session!.request(method,payload);
      };
      record(arm,'begin',{});session=await open(arm);
      const learned=await request('learn',evidenceSpec.train);
      record(arm,'learn',{examples:evidenceSpec.train,result:learned});
      const state=await request('snapshot',null);record(arm,'snapshot',{state});
      const checkpointSequence=proof.events.at(-1)!.sequence;
      await session.close();session=undefined;record(arm,'restart',{});
      session=await open(arm);
      if(arm==='retained'){
        const row=database.prepare('SELECT body FROM rgi_mission_events WHERE mission_id=? AND sequence=?').get(evidenceSpec.id,checkpointSequence)!;
        const saved=JSON.parse(String(row.body));
        const expected=proof.events.find(e=>e.sequence===checkpointSequence)!;
        if(canonicalJson(saved)!==canonicalJson(expected))throw new Error('checkpoint_integrity_mismatch');
        const restored=saved.payload.state;
        await request('restore',restored);record(arm,'restore',{state:restored});
      }
      for(const phase of ['transfer','retention'] as const){
        for(let index=0;index<evidenceSpec[phase].length;index++){
          const input=evidenceSpec[phase][index]!.input;
          const output=await request('predict',input);record(arm,'predict',{phase,index,input,output});
        }
      }
      await session.close();session=undefined;record(arm,'end',{requests});
    }
    const replay=replayProof(proof);
    database.prepare('UPDATE rgi_missions SET status=?,proof=? WHERE id=?').run('complete',canonicalJson(proof),evidenceSpec.id);
    return {proof,replay,elapsedMs:performance.now()-start,launches,requests:totalRequests};
  }catch(error){
    // Persist a generic failure code without retaining arbitrary plugin error strings.
    database.prepare('UPDATE rgi_missions SET status=?,error=? WHERE id=?').run('failed','mission_interrupted_or_invalid',evidenceSpec.id);
    throw error;
  }finally{await session?.close();}
}
