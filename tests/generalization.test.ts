import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GeneralizationHarness} from '../src/generalization.ts';
import type {GeneralizationProtocol,AgentFactory,AgentReply} from '../src/generalization-contracts.ts';
const meter={costMicros:1,modelCalls:1,humanInterventions:0};
test('audit consumption survives closing and reopening its SQLite file',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rgi-generalization-')),path=join(dir,'audit.sqlite');let db=new DatabaseSync(path);
 try{await new GeneralizationHarness(db).run(protocol());db.close();db=new DatabaseSync(path);
 const p=protocol();p.id='after-restart';await assert.rejects(new GeneralizationHarness(db).run(p),/audit_example_reused/);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
const factory=(id:string,output=1):AgentFactory=>({id,artifactSha256:'a'.repeat(64),create(){return {async learn(){return meter;},async predict(){return {...meter,output};}};}});
const protocol=():GeneralizationProtocol=>({id:'run',developmentFamilies:['old'],selectionFamilies:['selected'],
 baseline:factory('base',0),candidate:factory('candidate'),supportLimit:2,maxCostMicros:10,maxModelCalls:10,timeoutMs:100,
 tasks:[{id:'transfer:1',family:'new',split:'transfer',seed:1,support:[{input:1,output:1}],queries:[{input:2,output:1}]},
 {id:'retention:1',family:'old',split:'retention',seed:2,support:[{input:3,output:1}],queries:[{input:4,output:1}]}]});
test('strict JSON prevents NaN null and object prototype scoring collisions',async()=>{
 for(const output of [NaN,Infinity,new Date(),new Map(),undefined]){
 const db=new DatabaseSync(':memory:');try{const p=protocol();p.tasks[0]!.queries[0]!.output=null;
 p.candidate.create=()=>({async learn(){return meter;},async predict(){return {...meter,output};}});
 const r=await new GeneralizationHarness(db).run(p);assert.equal(r.valid,false);
 const bad=protocol();bad.tasks[0]!.support[0]!.input=new Date();await assert.rejects(new GeneralizationHarness(db).run(bad),/invalid_json/);
 }finally{db.close();}}
});
test('changed support cannot regain prior queries and prior answers cannot become support',async()=>{
 const db=new DatabaseSync(':memory:');try{const h=new GeneralizationHarness(db);await h.run(protocol());
 const p=protocol();p.id='changed';p.tasks.forEach(t=>{t.id+='new';t.support[0]!.input=99;});
 await assert.rejects(h.run(p),/audit_example_reused/);
 p.tasks[0]!.support=[{input:2,output:1}];p.tasks[0]!.queries=[{input:88,output:1}];
 await assert.rejects(h.run(p),/audit_example_reused/);
 }finally{db.close();}
});
test('finite synchronous deadline overrun is invalid even before timer fires',async()=>{
 const db=new DatabaseSync(':memory:');try{const p=protocol();p.timeoutMs=2;
 p.candidate.create=()=>({async learn(){return meter;},async predict(){const end=performance.now()+4;while(performance.now()<end){}return {...meter,output:1};}});
 const r=await new GeneralizationHarness(db).run(p);assert.equal(r.valid,false);assert.ok(r.results.some(x=>x.error==='episode_timeout'));
 }finally{db.close();}
});
test('separates zero support, fixed support and retention with host scoring',async()=>{
 const db=new DatabaseSync(':memory:');try{const r=await new GeneralizationHarness(db).run(protocol());
 assert.equal(r.results.length,8);assert.equal(r.transferImproved,true);assert.equal(r.retentionPassed,true);
 assert.equal(r.results.find(x=>x.mode==='zero')?.modelCalls,1);assert.equal(r.results.find(x=>x.mode==='support')?.modelCalls,2);
 }finally{db.close();}
});
test('family contamination, input overlap and missing retention fail before audit consumption',async()=>{
 const db=new DatabaseSync(':memory:');try{const h=new GeneralizationHarness(db);
 const p=protocol();p.developmentFamilies.push('new');await assert.rejects(h.run(p),/family_contamination/);
 const q=protocol();q.tasks[0]!.queries[0]!.input=1;await assert.rejects(h.run(q),/example_overlap/);
 const x=protocol();x.tasks.pop();await assert.rejects(h.run(x),/missing_evaluation_split/);
 assert.equal(db.prepare('SELECT count(*) n FROM rgi_generalization_runs').get()?.n,0);
 }finally{db.close();}
});
test('audit IDs and content remain consumed across harness recreation and renamed runs',async()=>{
 const db=new DatabaseSync(':memory:');try{await new GeneralizationHarness(db).run(protocol());
 const p=protocol();p.id='run2';await assert.rejects(new GeneralizationHarness(db).run(p),/UNIQUE|audit_example_reused/);
 p.tasks.forEach(t=>{t.id+='renamed';t.family+='renamed';});p.developmentFamilies=['oldrenamed'];
 await assert.rejects(new GeneralizationHarness(db).run(p),/UNIQUE|audit_example_reused/);
 assert.equal(db.prepare('SELECT count(*) n FROM rgi_generalization_runs').get()?.n,1);
 }finally{db.close();}
});
test('failed and timed out agents consume audits and cannot produce improvement verdict',async()=>{
 const db=new DatabaseSync(':memory:');try{const p=protocol();p.timeoutMs=5;
 p.candidate.create=()=>({async predict(){return new Promise<AgentReply>(()=>{});}});
 const h=new GeneralizationHarness(db),r=await h.run(p);assert.equal(r.valid,false);assert.equal(r.transferImproved,false);
 assert.ok(r.results.some(x=>x.error==='episode_timeout'));p.id='retry';await assert.rejects(h.run(p),/UNIQUE|audit_example_reused/);
 }finally{db.close();}
});
test('support cost, bad accounting and human intervention cannot bypass budget',async()=>{
 for(const bad of [{...meter,costMicros:11},{...meter,modelCalls:NaN},{...meter,humanInterventions:1}]){
 const db=new DatabaseSync(':memory:');try{const p=protocol();p.candidate.create=()=>({async learn(){return bad;},async predict(){return {...meter,output:1};}});
 const r=await new GeneralizationHarness(db).run(p);assert.equal(r.valid,false);assert.equal(r.retentionPassed,false);
 assert.equal(r.results.find(x=>x.agentId==='candidate'&&x.mode==='support')?.correct,0);
 }finally{db.close();}}
});
test('predict receives only copied query inputs and distinct instances per mode and task',async()=>{
 const db=new DatabaseSync(':memory:');try{const p=protocol();let created=0;const received:unknown[]=[];
 p.candidate.create=()=>{created++;return {async learn(examples){assert.ok(Object.isFrozen(examples));return meter;},async predict(input){received.push(input);return {...meter,output:1};}};};
 await new GeneralizationHarness(db).run(p);assert.equal(created,4);assert.deepEqual(received,[2,2,4,4]);
 }finally{db.close();}
});
test('shared instances fail closed and retention regression blocks retention verdict',async()=>{
 const db=new DatabaseSync(':memory:');try{const p=protocol();p.baseline=factory('base',1);p.candidate=factory('candidate',0);
 const r=await new GeneralizationHarness(db).run(p);assert.equal(r.retentionPassed,false);
 }finally{db.close();}
 const db2=new DatabaseSync(':memory:');try{const p=protocol(),shared=p.candidate.create();p.candidate.create=()=>shared;
 const r=await new GeneralizationHarness(db2).run(p);assert.equal(r.valid,false);assert.ok(r.results.some(x=>x.error==='invalid_agent_instance'));
 }finally{db2.close();}
});
