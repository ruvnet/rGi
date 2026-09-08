import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../src/runtime.ts';
import type { Action,ExecutionFeedback,Observation } from '../src/contracts.ts';
import { freshObservations } from '../src/context.ts';
import { ScalarFeedbackPlanner } from '../src/adaptive.ts';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const action=(id:string):Action=>({id,capability:'test.read',payload:{},confidence:1,estimatedCostMicros:1});
test('schema 1 migration preserves completed IDs and checkpoints without backfilling',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rgi-migrate-')),dbPath=join(directory,'db');
  const executor={async execute(){return {output:1,actualCostMicros:1};}};
  let runtime=new Runtime({dbPath,executor,config:{allowedCapabilities:['test.read'],budgetMicros:10}});
  try{
    runtime.enqueue(action('old'));await runtime.step();runtime.checkpoint('model',{gain:0.5});runtime.close();
    const old=new DatabaseSync(dbPath);old.exec('DROP TABLE feedback; PRAGMA user_version=1');old.close();
    runtime=new Runtime({dbPath,executor});
    assert.equal(runtime.enqueue(action('old')),false);assert.deepEqual(runtime.restore('model'),{gain:0.5});
    assert.equal(runtime.store.outcomes().length,0);assert.equal(runtime.status().jobs.succeeded,1);
    assert.equal(runtime.store.db.prepare('PRAGMA user_version').get()?.user_version,2);
  }finally{runtime.close();rmSync(directory,{recursive:true,force:true});}
});
test('failed planner cannot reuse uncommitted learned state',async()=>{
  let state=0;
  const runtime=new Runtime({dbPath:':memory:',plannerCheckpointKey:'model',
    planner:{snapshot(){return state;},restore(value){state=Number(value);},async plan(){state++;return [action('ok'),{...action('bad'),confidence:NaN}];}},
    executor:{async execute(){throw new Error('unexpected');}}});
  try{await assert.rejects(runtime.step());assert.equal(runtime.restore('model'),undefined);
    runtime.resume();await assert.rejects(runtime.step(),/planner_restart_required/);
  }finally{runtime.close();}
});
test('next planning cycle receives real execution outcomes and bounded history',async()=>{
  let observed:ExecutionFeedback[]=[];
  const runtime=new Runtime({dbPath:':memory:',config:{allowedCapabilities:['test.read'],budgetMicros:10,maxOutcomeContext:2},
    executor:{async execute(){return {output:{answer:42},actualCostMicros:1};}},
    planner:{async plan(context){observed=context.outcomes;return [];}}});
  try{
    for(let i=0;i<3;i++){runtime.enqueue(action(`job:${i}`));await runtime.step();}
    await runtime.step();assert.equal(observed.length,2);assert.equal(observed[1]!.actionId,'job:2');
    assert.deepEqual(observed[1]!.output,{answer:42});assert.equal(observed[1]!.actualCostMicros,1);
  }finally{runtime.close();}
});
test('freshness rejects future, expired and stale evidence at consumption',()=>{
  const base:Observation={id:'obs',source:'sensor',timestamp:100,modality:'scalar',data:1,confidence:1};
  assert.equal(freshObservations([base],110,20).length,1);
  for(const observation of [{...base,timestamp:111},{...base,timestamp:0},{...base,expiresAt:110},
    {...base,modality:'rufield',data:{issuedAt:100,expiresAt:109}}])
    assert.equal(freshObservations([observation],110,20).length,0);
});
test('runtime does not pass expired RuField records to planner',async()=>{
  let count=-1;const now=Date.now();
  const runtime=new Runtime({dbPath:':memory:',executor:{async execute(){throw new Error('unexpected');}},planner:{async plan(c){count=c.observations.length;return [];}}});
  try{runtime.observe({id:'expired',source:'sensor',timestamp:now-100,modality:'rufield',confidence:1,data:{issuedAt:now-100,expiresAt:now-1}});
    await runtime.step();assert.equal(count,0);
  }finally{runtime.close();}
});
test('planner snapshots persist learned dynamics and reject invalid restoration',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rgi-feedback-'));const dbPath=join(directory,'db');
  let planner=new ScalarFeedbackPlanner();
  const executor={async execute(a:Action){return {output:{previous:0,control:a.payload.control,next:-0.5},actualCostMicros:1};}};
  let runtime=new Runtime({dbPath,planner,plannerCheckpointKey:'planner:scalar',executor,config:{allowedCapabilities:['simulation.control'],budgetMicros:100}});
  try{
    runtime.observe({id:'calibrate',source:'sim',timestamp:Date.now(),modality:'scalar-control',data:{state:0,goal:0,calibrationAction:1},confidence:1});
    await runtime.step();await runtime.step();const expected=planner.snapshot();runtime.close();
    planner=new ScalarFeedbackPlanner();runtime=new Runtime({dbPath,planner,plannerCheckpointKey:'planner:scalar',executor});
    assert.deepEqual(planner.snapshot(),expected);assert.equal(runtime.store.outcomes().length,2);
    assert.throws(()=>planner.restore({version:99}),/invalid_planner_snapshot/);
  }finally{runtime.close();rmSync(directory,{recursive:true,force:true});}
});
test('combined oversized feedback is omitted without corrupting execution status',async()=>{
  const runtime=new Runtime({dbPath:':memory:',config:{allowedCapabilities:['test.read'],budgetMicros:2,maxRecordBytes:1024},
    executor:{async execute(){return {output:'x'.repeat(800),actualCostMicros:1};}}});
  try{runtime.enqueue({...action('large'),payload:{value:'x'.repeat(700)}});await runtime.step();
    assert.equal(runtime.status().jobs.succeeded,1);assert.equal(runtime.store.outcomes()[0]?.omitted,true);
  }finally{runtime.close();}
});
