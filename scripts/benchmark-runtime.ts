import { mkdtempSync,rmSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir,cpus } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.ts';

const directory=mkdtempSync(join(tmpdir(),'rgi-bench-'));
const iterations=1000;
const runtime=new Runtime({dbPath:join(directory,'runtime.db'),config:{allowedCapabilities:['bench.noop'],budgetMicros:iterations},
  executor:{async execute(){return {output:null,actualCostMicros:1};}}});
try{
  const times:number[]=[];const started=performance.now();
  for(let i=0;i<iterations;i++){
    const start=performance.now();
    runtime.enqueue({id:`bench:${i}`,capability:'bench.noop',payload:{},estimatedCostMicros:1,confidence:1});
    await runtime.step();times.push(performance.now()-start);
  }
  const elapsed=performance.now()-started;const state=runtime.status();
  if(state.jobs.succeeded!==iterations||state.spentMicros!==iterations||state.reservedMicros!==0)throw new Error('benchmark_invariant_failed');
  times.sort((a,b)=>a-b);
  const report={schemaVersion:1,generatedAt:new Date().toISOString(),benchmark:'sqlite-durable-noop-dispatch',iterations,
    elapsedMs:elapsed,operationsPerSecond:iterations*1000/elapsed,medianMs:times[499],p95Ms:times[949],p99Ms:times[989],
    durability:'SQLite WAL synchronous=FULL',environment:{node:process.version,cpu:cpus()[0]?.model},
    limitations:['Local shared host and filesystem only. No model, sensor, network or real task inference.','Includes validation, queue, policy, reservation and receipts. No production throughput guarantee.']};
  mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/runtime-benchmark.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{runtime.close();rmSync(directory,{recursive:true,force:true});}
