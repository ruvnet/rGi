import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {advanceDiscovery,replayDiscovery} from '../src/discovery-run.ts';
import type {DiscoverySpec} from '../src/discovery-run.ts';
import {hashValue} from '../src/mission-proof.ts';

function spec():DiscoverySpec {
  return {id:'checkpoint-test',problem:{version:1,inputs:['a','b','q'],costs:[1,1,1],probeIndices:[0,1],queryIndices:[2],
    hypotheses:[[0,0,0],[0,1,1],[1,0,2],[1,1,3]]},policy:{strategy:'information',seed:1,maxCost:2,maxProbes:2}};
}
test('reservation is durable before callback; a reopened database resumes without repeated experiments',()=>{
  const dir=mkdtempSync(join(tmpdir(),'rgi-discovery-'));let db=new DatabaseSync(join(dir,'state.sqlite'));
  const calls:number[]=[];const s=spec();
  const oracle=(index:number)=>{
    calls.push(index);
    const event=JSON.parse(String(db.prepare('SELECT body FROM rgi_discovery_events ORDER BY sequence DESC LIMIT 1').get()!.body));
    assert.equal(event.kind,'reserve');assert.equal(event.decision.inputIndex,index);
    return s.problem.hypotheses[3]![index]!;
  };
  try {
    const first=advanceDiscovery(s,db,oracle,1);assert.equal(first.replay.complete,false);
    assert.equal(first.replay.state.spentCost,1);assert.throws(()=>replayDiscovery(first.transcript),/incomplete/);
    db.close();db=new DatabaseSync(join(dir,'state.sqlite'));
    const second=advanceDiscovery(s,db,oracle,1);assert.deepEqual(calls,[0,1]);
    assert.equal(second.replay.complete,true);assert.deepEqual(second.replay.predictions,[{inputIndex:2,output:3}]);
    assert.deepEqual(replayDiscovery(second.transcript),second.replay);
    assert.deepEqual(advanceDiscovery(s,db,()=>{throw Error('must_not_call');}).replay,second.replay);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('callback failures and invalid outputs remain charged and expose no exception text',()=>{
  for(const oracle of [()=>{throw Error('sensitive detail');},()=>NaN,()=>256,()=>Promise.resolve(1) as unknown as number]){
    const db=new DatabaseSync(':memory:');try {
      const {transcript,replay}=advanceDiscovery(spec(),db,oracle);
      assert.equal(replay.state.status,'failed');assert.equal(replay.state.spentCost,1);
      assert.equal(replay.predictions[0]!.output,null);assert.equal(JSON.stringify(transcript).includes('sensitive'),false);
      assert.deepEqual(replayDiscovery(transcript),replay);
    }finally{db.close();}
  }
});
test('an outcome storage failure leaves an uncertain reservation that cannot be retried',()=>{
  const db=new DatabaseSync(':memory:');let effects=0;try {
    db.exec(`CREATE TABLE rgi_discovery_events(run_id TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run_id,sequence));
      CREATE TRIGGER crash AFTER INSERT ON rgi_discovery_events WHEN json_extract(NEW.body,'$.kind')='observe'
      BEGIN SELECT RAISE(ABORT,'simulated_crash'); END;`);
    assert.throws(()=>advanceDiscovery(spec(),db,()=>{effects++;return 1;}),/simulated_crash/);
    assert.equal(effects,1);
    assert.equal(db.prepare('SELECT count(*) n FROM rgi_discovery_events').get()!.n,1);
    db.exec('DROP TRIGGER crash');
    assert.throws(()=>advanceDiscovery(spec(),db,()=>{effects++;return 1;}),/uncertain_outcome/);
    assert.equal(effects,1);
  }finally{db.close();}
});
test('replay rejects a forged choice even when the attacker recomputes the event chain',()=>{
  const db=new DatabaseSync(':memory:');try {
    const {transcript}=advanceDiscovery(spec(),db,()=>1);
    const changed=structuredClone(transcript);const first=changed.events[0]!;
    assert.equal(first.kind,'reserve');if(first.kind==='reserve')first.decision.inputIndex=1;
    let previousHash=hashValue({version:1,spec:changed.spec});
    for(const event of changed.events){event.previousHash=previousHash;const {hash,...body}=event;event.hash=hashValue(body);previousHash=event.hash;}
    assert.throws(()=>replayDiscovery(changed),/selection/);
  }finally{db.close();}
});
test('changed specifications and corrupt checkpoints fail before additional callbacks',()=>{
  const db=new DatabaseSync(':memory:');let calls=0;try {
    advanceDiscovery(spec(),db,()=>{calls++;return 1;},1);
    const modified=spec();modified.policy.maxCost=1;
    assert.throws(()=>advanceDiscovery(modified,db,()=>{calls++;return 1;}),/spec_mismatch/);
    db.prepare("UPDATE rgi_discovery_events SET body=json_set(body,'$.output',0) WHERE sequence=2").run();
    assert.throws(()=>advanceDiscovery(spec(),db,()=>{calls++;return 1;}),/chain/);
    assert.equal(calls,1);
  }finally{db.close();}
});
test('contradictory observations stop discovery and prevent confident query outputs',()=>{
  const db=new DatabaseSync(':memory:');try {
    const {transcript,replay}=advanceDiscovery(spec(),db,()=>200);
    assert.equal(replay.state.status,'inconsistent');assert.equal(replay.state.probes,1);
    assert.deepEqual(replayDiscovery(transcript).predictions,[{inputIndex:2,output:null}]);
  }finally{db.close();}
});
