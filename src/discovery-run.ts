import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {canonicalJson, hashValue} from './mission-proof.ts';
import {DiscoveryEngine, validateDiscoveryProblem, validateDiscoveryPolicy} from './discovery.ts';
import type {DiscoveryProblem, DiscoveryPolicy, DiscoveryState, ProbeDecision} from './discovery.ts';

export interface DiscoverySpec {id:string; problem:DiscoveryProblem; policy:DiscoveryPolicy}
type EventBody = {kind:'reserve'; decision:ProbeDecision} | {kind:'observe'; output:number} | {kind:'fail'};
export type DiscoveryEvent = EventBody & {sequence:number; previousHash:string; hash:string};
export interface DiscoveryTranscript {version:1; spec:DiscoverySpec; events:DiscoveryEvent[]}
export interface DiscoveryReplay {
  rootHash:string; complete:boolean; state:DiscoveryState;
  predictions:{inputIndex:number; output:number|null}[];
}
function invalid(reason:string):never {throw Error(`invalid_discovery:${reason}`);}
export function exactFields(value:unknown, fields:string[]):asserts value is Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value))invalid('object');
  const keys=Object.keys(value).sort(),expected=[...fields].sort();
  if(keys.length!==expected.length || keys.some((key,i)=>key!==expected[i]))invalid('fields');
}
export function validateDiscoverySpec(spec:DiscoverySpec):void {
  canonicalJson(spec); exactFields(spec,['id','problem','policy']);
  if(typeof spec.id!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(spec.id))invalid('id');
  validateDiscoveryProblem(spec.problem); validateDiscoveryPolicy(spec.policy);
}
function initialHash(spec:DiscoverySpec):string {return hashValue({version:1,spec});}
function rebuild(transcript:DiscoveryTranscript):{engine:DiscoveryEngine;rootHash:string} {
  canonicalJson(transcript);exactFields(transcript,['version','spec','events']);
  if(transcript.version!==1 || !Array.isArray(transcript.events) || transcript.events.length>256)invalid('events');
  validateDiscoverySpec(transcript.spec);
  const engine=new DiscoveryEngine(transcript.spec.problem,transcript.spec.policy);
  let previousHash=initialHash(transcript.spec);
  for(const [i,event] of transcript.events.entries()) {
    if(!event || !['reserve','observe','fail'].includes(event.kind))invalid('event');
    exactFields(event,['sequence','previousHash','hash','kind',...(event.kind==='reserve'?['decision']:event.kind==='observe'?['output']:[])]);
    const {hash,...body}=event;
    if(event.sequence!==i+1 || event.previousHash!==previousHash || hashValue(body)!==hash)invalid('chain');
    if(event.kind==='reserve') {
      const expected=engine.reserve();
      if(!expected || canonicalJson(expected)!==canonicalJson(event.decision))invalid('selection');
    } else {
      if(engine.state.status!=='pending')invalid('outcome_without_reservation');
      if(event.kind==='observe')engine.observe(event.output);else engine.fail();
    }
    previousHash=hash;
  }
  return {engine,rootHash:previousHash};
}
function result(engine:DiscoveryEngine,rootHash:string,queryIndices:number[]):DiscoveryReplay {
  const state=engine.state;
  return {rootHash,complete:!['ready','pending'].includes(state.status),state,
    predictions:queryIndices.map(inputIndex=>({inputIndex,output:engine.predict(inputIndex)}))};
}
/** Recompute every selection, observation update, reservation and consensus prediction. */
export function replayDiscovery(transcript:DiscoveryTranscript,requireComplete=true):DiscoveryReplay {
  const {engine,rootHash}=rebuild(transcript),replay=result(engine,rootHash,transcript.spec.problem.queryIndices);
  if(requireComplete && !replay.complete)invalid('incomplete');
  return replay;
}

/** Trusted synchronous environment callbacks only. SQLite is a trusted host boundary.
 * A running record cannot be retried automatically, including after process death. */
export function advanceDiscovery(spec:DiscoverySpec,database:DatabaseSync,
  oracle:(inputIndex:number)=>number,maxAdditionalProbes=128):{transcript:DiscoveryTranscript;replay:DiscoveryReplay} {
  validateDiscoverySpec(spec);
  if(!Number.isSafeInteger(maxAdditionalProbes)||maxAdditionalProbes<1||maxAdditionalProbes>128)invalid('advance_limit');
  if(typeof oracle!=='function')invalid('oracle');
  const copied=JSON.parse(canonicalJson(spec)) as DiscoverySpec;
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS rgi_discovery_runs(id TEXT PRIMARY KEY,spec TEXT NOT NULL,status TEXT NOT NULL,owner TEXT,head TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rgi_discovery_events(run_id TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_id,sequence));`);
  const owner=randomUUID();let transcript:DiscoveryTranscript={version:1,spec:copied,events:[]};
  let engine:DiscoveryEngine;let head:string;let cached=false;
  database.exec('BEGIN IMMEDIATE');
  try {
    const row=database.prepare('SELECT spec,status,head FROM rgi_discovery_runs WHERE id=?').get(copied.id);
    if(row) {
      if(row.spec!==canonicalJson(copied))invalid('spec_mismatch');
      if(row.status==='running')invalid('uncertain_outcome');
      if(row.status!=='paused' && row.status!=='complete')invalid('run_status');
      const count=Number(database.prepare('SELECT count(*) n FROM rgi_discovery_events WHERE run_id=?').get(copied.id)!.n);
      if(count>256)invalid('events');
      const rows=database.prepare('SELECT body FROM rgi_discovery_events WHERE run_id=? ORDER BY sequence').all(copied.id);
      transcript.events=rows.map(record=>{
        if(typeof record.body!=='string'||Buffer.byteLength(record.body)>4096)invalid('event_size');
        return JSON.parse(record.body) as DiscoveryEvent;
      });
      const restored=rebuild(transcript);engine=restored.engine;head=restored.rootHash;
      if(head!==row.head || engine.state.status==='pending')invalid('checkpoint_integrity');
      cached=row.status==='complete';
      if(cached===['ready','pending'].includes(engine.state.status))invalid('checkpoint_status');
      if(!cached)database.prepare("UPDATE rgi_discovery_runs SET status='running',owner=? WHERE id=?").run(owner,copied.id);
    } else {
      engine=new DiscoveryEngine(copied.problem,copied.policy);head=initialHash(copied);
      database.prepare("INSERT INTO rgi_discovery_runs VALUES(?,?,'running',?,?)").run(copied.id,canonicalJson(copied),owner,head);
    }
    database.exec('COMMIT');
  } catch(error) {database.exec('ROLLBACK');throw error;}
  if(cached)return {transcript,replay:result(engine,head,copied.problem.queryIndices)};
  function persist(body:EventBody):void {
    const eventBody={...body,sequence:transcript.events.length+1,previousHash:head};
    const event={...eventBody,hash:hashValue(eventBody)} as DiscoveryEvent;
    database.exec('BEGIN IMMEDIATE');
    try {
      const changed=database.prepare("UPDATE rgi_discovery_runs SET head=? WHERE id=? AND owner=? AND head=? AND status='running'").run(event.hash,copied.id,owner,head);
      if(changed.changes!==1)invalid('ownership');
      database.prepare('INSERT INTO rgi_discovery_events VALUES(?,?,?)').run(copied.id,event.sequence,canonicalJson(event));
      database.exec('COMMIT');
    }catch(error){database.exec('ROLLBACK');throw error;}
    transcript.events.push(event);head=event.hash;
  }
  for(let step=0;step<maxAdditionalProbes;step++) {
    if(engine.state.status!=='ready')break;
    const decision=engine.reserve();if(!decision)break;
    persist({kind:'reserve',decision}); // Durable charge before any environment effect.
    let output:number|undefined;
    try {
      output=oracle(decision.inputIndex);
      if(!Number.isSafeInteger(output)||output<0||output>255)throw Error('invalid_observation');
    }catch {
      engine.fail();persist({kind:'fail'});break;
    }
    engine.observe(output);persist({kind:'observe',output});
  }
  const replay=result(engine,head,copied.problem.queryIndices);
  const updated=database.prepare("UPDATE rgi_discovery_runs SET status=?,owner=NULL WHERE id=? AND owner=? AND head=? AND status='running'")
    .run(replay.complete?'complete':'paused',copied.id,owner,head);
  if(updated.changes!==1)invalid('ownership');
  return {transcript,replay};
}
