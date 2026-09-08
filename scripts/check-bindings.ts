import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { evaluatePolicy } from '../src/policy.ts';
import type { PolicyInput } from '../src/contracts.ts';
import { Runtime } from '../src/runtime.ts';
import { nativePolicy } from '../src/bindings.ts';

const nativeName = process.platform === 'darwin' ? 'librgi_napi.dylib' : process.platform === 'win32' ? 'rgi_napi.dll' : 'librgi_napi.so';
mkdirSync('artifacts/wasm',{recursive:true});
copyFileSync(`target/release/${nativeName}`,'artifacts/rgi.node');
const binding = spawnSync('wasm-bindgen',['--target','nodejs','--out-dir','artifacts/wasm','target/wasm32-unknown-unknown/release/rgi_wasm.wasm'],{encoding:'utf8',shell:false});
if (binding.error || binding.status !== 0) throw new Error(`wasm_binding_generation_failed:${binding.error?.message ?? binding.stderr}`);
writeFileSync('artifacts/wasm/package.json',JSON.stringify({type:'commonjs'}));
const require = createRequire(import.meta.url);
const native = require(resolve('artifacts/rgi.node')) as {evaluateJson:(json:string)=>string};
const wasm = require(resolve('artifacts/wasm/rgi_wasm.js')) as {evaluate_json:(json:string)=>string};
let checks = 0;
for (const allowed of [false,true]) for (const stopped of [false,true])
  for (const confidence of [0,0.8,1]) for (const requestedMicros of [0,30,31,Number.MAX_SAFE_INTEGER]) {
    const input:PolicyInput = {capability:'simulation.step',allowedCapabilities:allowed?['simulation.step']:[],
      spentMicros:10,reservedMicros:20,requestedMicros,budgetMicros:60,confidence,minConfidence:0.8,stopped};
    const expected = evaluatePolicy(input);
    assert.deepEqual(JSON.parse(native.evaluateJson(JSON.stringify(input))),expected);
    assert.deepEqual(JSON.parse(wasm.evaluate_json(JSON.stringify(input))),expected);
    checks++;
  }
for (const json of ['{}','null','{','{"stopped":false,"stopped":true}']) {
  assert.throws(()=>native.evaluateJson(json));assert.throws(()=>wasm.evaluate_json(json));checks++;
}
console.log(JSON.stringify({native:true,wasm:true,parityCases:checks,claim:'binding decision parity only'}));
const runtime = new Runtime({dbPath:':memory:',policy:nativePolicy('artifacts/rgi.node'),
  config:{allowedCapabilities:['simulation.step'],budgetMicros:10},
  executor:{async execute(){return {output:{nativeGuard:true},actualCostMicros:1};}}});
try{
  runtime.enqueue({id:'native:e2e',capability:'simulation.step',payload:{},estimatedCostMicros:1,confidence:1});
  await runtime.step();assert.equal(runtime.status().jobs.succeeded,1);
}finally{runtime.close();}
console.log('Native guarded supervisor execution: passed');
