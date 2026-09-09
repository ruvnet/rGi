import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {runMission} from '../src/mission.ts';
import type {MissionSpec} from '../src/mission-contracts.ts';

function spec():MissionSpec{
 const modulePath=resolve('examples/mission-agent.mjs');
 return {id:'test-mission',modulePath,artifactSha256:createHash('sha256').update(readFileSync(modulePath)).digest('hex'),
 train:[{input:{kind:'affine',x:0},output:3},{input:{kind:'affine',x:1},output:5}],
 transfer:[{input:{kind:'affine',x:4},output:11},{input:{kind:'affine',x:8},output:19}],
 retention:[{input:{kind:'square',x:5},output:25}],maxRequests:16,timeoutMs:3000,maxMessageBytes:65536};
}
test('actual child restart retains learned state only in retained arm and yields replayable receipts',async()=>{
 const db=new DatabaseSync(':memory:');try{const result=await runMission(spec(),db);
 assert.equal(result.launches,6);assert.equal(result.requests,16);
 assert.equal(result.replay.retainedImproves,true);assert.equal(result.replay.retentionPassed,true);
 assert.deepEqual(result.replay.arms.map(a=>a.transferCorrect),[0,0,2]);
 assert.deepEqual(result.replay.arms.map(a=>a.retentionCorrect),[1,1,1]);
 assert.equal(db.prepare('SELECT status FROM rgi_missions').get()?.status,'complete');
 }finally{db.close();}
});
test('durable audit survives producer restart and denies query reuse before agent launch',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mission-audit-'));let db=new DatabaseSync(join(dir,'audit.sqlite'));
 try{await runMission(spec(),db);db.close();db=new DatabaseSync(join(dir,'audit.sqlite'));
 const again=spec();again.id='different-id';await assert.rejects(runMission(again,db),/audit_reused/);
 again.transfer.forEach(e=>{e.output=0;});again.retention.forEach(e=>{e.output=0;});
 await assert.rejects(runMission(again,db),/audit_reused/);
 const exposed=spec();exposed.id='trained-input';exposed.train=[{input:{kind:'affine',x:100},output:203},{input:{kind:'affine',x:101},output:205}];
 exposed.transfer=[{input:{kind:'affine',x:0},output:3}];exposed.retention=[{input:{kind:'square',x:99},output:9801}];
 await assert.rejects(runMission(exposed,db),/training_exposure/);
 assert.equal(db.prepare('SELECT count(*) n FROM rgi_missions').get()?.n,1);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('cumulative evidence is stopped before it exceeds eight MiB',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mission-cap-')),file=join(dir,'agent.mjs');
 writeFileSync(file,'export function createAgent(){return {learn(){return null},snapshot(){return null},restore(){return null},predict(){return "x".repeat(120000)}}}');
 const db=new DatabaseSync(':memory:');try{const p=spec();p.modulePath=file;p.artifactSha256=createHash('sha256').update(readFileSync(file)).digest('hex');
 p.train=[{input:0,output:null}];p.transfer=Array.from({length:90},(_,i)=>({input:i+1,output:null}));p.retention=[{input:1000,output:null}];p.maxRequests=100;p.maxMessageBytes=131072;
 await assert.rejects(runMission(p,db),/mission_evidence_limit/);
 assert.ok(Number(db.prepare('SELECT sum(length(body)) n FROM rgi_mission_events').get()?.n)<8*1024*1024);
 assert.equal(db.prepare('SELECT status FROM rgi_missions').get()?.status,'failed');
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('corrupted durable snapshot is rejected before restore',async()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec(`CREATE TABLE rgi_mission_events(mission_id TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(mission_id,sequence));
 CREATE TRIGGER corrupt_snapshot AFTER INSERT ON rgi_mission_events
 WHEN json_extract(NEW.body,'$.kind')='snapshot' AND json_extract(NEW.body,'$.arm')='retained'
 BEGIN UPDATE rgi_mission_events SET body=json_set(NEW.body,'$.payload.state.scale',999) WHERE mission_id=NEW.mission_id AND sequence=NEW.sequence; END;`);
 await assert.rejects(runMission(spec(),db),/checkpoint_integrity_mismatch/);
 assert.equal(db.prepare("SELECT count(*) n FROM rgi_mission_events WHERE json_extract(body,'$.kind')='restore'").get()?.n,0);
 }finally{db.close();}
});
test('source mismatch and overlapping training inputs fail before execution',async()=>{
 const db=new DatabaseSync(':memory:');try{const p=spec();p.artifactSha256='0'.repeat(64);
 await assert.rejects(runMission(p,db),/artifact_hash_mismatch/);
 const overlap=spec();overlap.train[0]!.input=overlap.transfer[0]!.input;await assert.rejects(runMission(overlap,db));
 }finally{db.close();}
});
test('failed child leaves consumed audit and durable partial receipts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mission-failure-')),file=join(dir,'agent.mjs');
 writeFileSync(file,'export function createAgent(){return {learn(){throw Error("fail")}}}');
 const db=new DatabaseSync(':memory:');try{const p=spec();p.modulePath=file;p.artifactSha256=createHash('sha256').update(readFileSync(file)).digest('hex');
 await assert.rejects(runMission(p,db));assert.equal(db.prepare('SELECT status FROM rgi_missions').get()?.status,'failed');
 assert.equal(JSON.parse(String(db.prepare('SELECT spec FROM rgi_missions').get()?.spec)).id,p.id);
 assert.equal(db.prepare('SELECT count(*) n FROM rgi_mission_events').get()?.n,1);
 p.id='retry';await assert.rejects(runMission(p,db),/audit_reused/);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
