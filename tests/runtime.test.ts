import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.ts';
import type { Action, Executor } from '../src/contracts.ts';
import { OnlineDynamics,promotionGate } from '../src/learning.ts';

const action=(id='job:1',cost=10):Action=>({id,capability:'simulation.step',payload:{value:1},estimatedCostMicros:cost,confidence:1});
const executor:Executor={async execute(){return {output:{ok:true},actualCostMicros:7};}};
function fixture(config: Record<string,unknown> = {}, exec=executor) {
  const directory=mkdtempSync(join(tmpdir(),'rgi-test-'));
  const options={dbPath:join(directory,'runtime.db'),config:{allowedCapabilities:['simulation.step'],budgetMicros:100,idleMs:1,...config},executor:exec};
  const runtime=new Runtime(options);
  return {runtime,options,cleanup(){runtime.close();rmSync(directory,{recursive:true,force:true});}};
}
test('journal survives restart with no duplicate action execution',async()=>{
  const f=fixture();let second:Runtime|undefined;
  try {
    assert.equal(f.runtime.enqueue(action()),true);assert.equal(f.runtime.enqueue(action()),false);
    await f.runtime.step();assert.equal(f.runtime.status().spentMicros,7);assert.equal(f.runtime.status().reservedMicros,0);
    f.runtime.close();second=new Runtime(f.options);
    assert.equal(second.enqueue(action()),false);assert.equal(await second.step(),false);
    assert.equal(second.status().jobs.succeeded,1);
  } finally {second?.close();f.cleanup();}
});
test('conflicting ids and queue overflow are rejected atomically',()=>{
  const f=fixture({maxQueue:1});try {
    f.runtime.enqueue(action());assert.throws(()=>f.runtime.enqueue(action('job:1',11)),/idempotency_conflict/);
    assert.throws(()=>f.runtime.enqueue(action('job:2')),/queue_full/);assert.equal(f.runtime.status().jobs.queued,1);
  }finally{f.cleanup();}
});
test('budget denial happens before execution',async()=>{
  const f=fixture({budgetMicros:9});try {f.runtime.enqueue(action());await f.runtime.step();assert.equal(f.runtime.status().jobs.denied,1);assert.equal(f.runtime.status().spentMicros,0);}finally{f.cleanup();}
});
test('actual cost overrun records debt and stops further work',async()=>{
  const f=fixture({budgetMicros:10},{async execute(){return {output:null,actualCostMicros:20};}});
  try{f.runtime.enqueue(action());await f.runtime.step();assert.equal(f.runtime.status().spentMicros,20);assert.equal(f.runtime.status().stopped,true);assert.throws(()=>f.runtime.resume(),/unsafe_resume/);}finally{f.cleanup();}
});
test('unknown outcome holds reservation and requires explicit reconciliation',async()=>{
  const f=fixture({}, {async execute(){throw new Error('potential_remote_effect');}});
  try{f.runtime.enqueue(action());await f.runtime.step();assert.equal(f.runtime.status().jobs.uncertain,1);assert.equal(f.runtime.status().reservedMicros,10);assert.throws(()=>f.runtime.resume(),/unsafe_resume/);
    f.runtime.reconcile('job:1',8,{verified:true});f.runtime.resume();assert.equal(f.runtime.status().spentMicros,8);assert.equal(f.runtime.status().reservedMicros,0);
  }finally{f.cleanup();}
});
test('noncooperative timeout cannot silently retry an external effect',async()=>{
  const f=fixture({actionTimeoutMs:15,leaseMs:100}, {execute(){return new Promise(()=>{});}});
  try{f.runtime.enqueue(action());await f.runtime.step();assert.equal(f.runtime.status().jobs.uncertain,1);assert.equal(await f.runtime.step(),false);}finally{f.cleanup();}
});
test('two supervisors cannot own the same journal',()=>{
  const f=fixture();try{assert.throws(()=>new Runtime(f.options),/runtime_already_owned/);}finally{f.cleanup();}
});
test('crash recovery marks an in-flight action uncertain without replay',()=>{
  const f=fixture();let second:Runtime|undefined;
  try{f.runtime.enqueue(action());f.runtime.store.transaction(()=>f.runtime.store.reserve(action()));
    f.runtime.store.db.prepare('UPDATE control SET lease_until=0').run();
    second=new Runtime(f.options);assert.equal(second.status().jobs.uncertain,1);assert.equal(second.status().stopped,true);assert.equal(second.status().reservedMicros,10);
  }finally{second?.close();f.cleanup();}
});
test('observation history is bounded and conflicts cannot overwrite evidence',()=>{
  const f=fixture({maxObservations:2});try{
    for(let i=0;i<3;i++)f.runtime.observe({id:`obs:${i}`,source:'sensor',timestamp:i,modality:'scalar',data:i,confidence:1});
    assert.equal(f.runtime.store.observations().length,2);
    assert.throws(()=>f.runtime.observe({id:'obs:2',source:'sensor',timestamp:2,modality:'scalar',data:999,confidence:1}),/observation_conflict/);
  }finally{f.cleanup();}
});
test('planner batch validates atomically and restart preserves sequence',async()=>{
  const f=fixture();f.runtime.close();
  const runtime=new Runtime({...f.options,planner:{async plan(){return [action(),{...action('bad'),confidence:NaN}];}}});
  try{await assert.rejects(()=>runtime.step(),/invalid_confidence/);assert.equal(runtime.status().jobs.queued,undefined);assert.equal(runtime.status().sequence,0);}finally{runtime.close();f.cleanup();}
});
test('online dynamics adapts and restores with gated retention evidence',()=>{
  const model=new OnlineDynamics();const before=Math.abs(model.predict(0,1)-0.7);
  for(let i=0;i<200;i++)model.observe({state:0,action:1,next:0.7});
  assert.ok(Math.abs(model.predict(0,1)-0.7)<before/100);
  assert.equal(OnlineDynamics.restore(model.snapshot()).predict(0,1),model.predict(0,1));
  const evidence={baselineError:1,candidateError:0.8,retentionRegression:0.01,samples:100,independent:true,capabilityViolations:0};
  assert.equal(promotionGate(evidence).promote,true);
  assert.equal(promotionGate({...evidence,capabilityViolations:1}).promote,false);
  assert.equal(promotionGate({...evidence,retentionRegression:0.03}).promote,false);
  assert.equal(promotionGate({...evidence,candidateError:NaN}).promote,false);
});
test('learned state checkpoint survives a supervisor restart',()=>{
  const f=fixture();let second:Runtime|undefined;
  try{
    const model=new OnlineDynamics();model.observe({state:0,action:1,next:0.7});
    f.runtime.checkpoint('dynamics',model.snapshot());f.runtime.close();second=new Runtime(f.options);
    assert.equal(OnlineDynamics.restore(second.restore('dynamics') as ReturnType<OnlineDynamics['snapshot']>).predict(0,1),model.predict(0,1));
  }finally{second?.close();f.cleanup();}
});
test('idle period cannot outlive lease and configuration cannot mutate',()=>{
  assert.throws(()=>new Runtime({dbPath:':memory:',executor,config:{idleMs:1000,actionTimeoutMs:10,leaseMs:100}}),/idle_exceeds_lease/);
  const f=fixture();try{
    assert.throws(()=>f.runtime.config.allowedCapabilities.push('shell.exec'),TypeError);
    assert.throws(()=>{f.runtime.config.budgetMicros=999999;},TypeError);
  }finally{f.cleanup();}
});
test('journal admission reaches a bounded high-water mark without deleting completed IDs',async()=>{
  const f=fixture({maxDatabaseBytes:1048576,budgetMicros:100000});
  try{
    let bounded=false;
    for(let i=0;i<40;i++){
      try{f.runtime.enqueue({...action(`large:${i}`),payload:{data:'x'.repeat(60000)}});}
      catch(error){assert.match(String(error),/journal_capacity_reached/);bounded=true;break;}
      await f.runtime.step();
    }
    assert.equal(bounded,true);assert.ok((f.runtime.status().jobs.succeeded??0)>0);
    assert.equal(f.runtime.store.job('large:0')?.status,'succeeded');
  }finally{f.cleanup();}
});
