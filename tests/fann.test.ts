import test from 'node:test';
import assert from 'node:assert/strict';
import type { DenseModel } from 'ruv-fann';
import type { Action } from '../src/contracts.ts';
import { createFannDynamics } from '../src/adapters/fann.ts';
import { planPredictively } from '../src/planning.ts';
const fixture = (): DenseModel => ({schema:'ruv-fann.dense-layers/1',layers:[
  {inputs:2,outputs:1,weights:[1,2],bias:[0],activation:'Linear',steepness:1}]});
const action = (a=1): Action => ({id:'step',capability:'move',payload:{features:[a]},
  estimatedCostMicros:1,confidence:1});
test('real scalar WASM agrees with independent affine arithmetic', async () => {
  const m=await createFannDynamics(fixture(),1,1);
  try {
    assert.equal(m.backend,'wasm'); assert.equal(m.eligibleForPromotion,false);
    assert.match(m.modelSha256,/^[a-f0-9]{64}$/);
    for(const [s,a] of [[0,0],[1,1],[-2,-1],[3.5,.25],[-7,.75],[999,-1]]) {
      assert.deepEqual(m.predict([s!],action(a)),{state:[s!+2*a!],uncertainty:1});
    }
  } finally {m.dispose();}
});
test('rejects nonfinite, sparse, missing and oversized inputs; lifecycle bounded', async () => {
  const m=await createFannDynamics(fixture(),1,1);
  try {
    for(const s of [[],[1,2],[NaN],[Infinity],[1e6+1],Array(1)])
      assert.throws(()=>m.predict(s,action()));
    for(const a of [NaN,Infinity,1e6+1]) assert.throws(()=>m.predict([0],action(a)));
    assert.throws(()=>m.predict([0],{...action(),payload:{}}));
    assert.throws(()=>m.predict([0],{...action(),payload:{features:Array(1)}}));
    assert.throws(()=>m.predict([1e6],action(1e6)));
  } finally {m.dispose();m.dispose();}
  assert.throws(()=>m.predict([0],action()),/disposed/);
});
test('snapshots source before async initialization and preserves caller inputs', async () => {
  const source=fixture(); const pending=createFannDynamics(source,1,1);
  (source.layers[0]!.weights as number[])[0]=50;
  const m=await pending;
  try {
    const state=[2], a=action(1), before=structuredClone(a);
    assert.deepEqual(m.predict(state,a).state,[4]);
    assert.deepEqual(state,[2]); assert.deepEqual(a,before);
  } finally {m.dispose();}
});
test('rejects malformed models and resource budgets', async () => {
  await assert.rejects(createFannDynamics(fixture(),0,1));
  await assert.rejects(createFannDynamics(fixture(),2,1));
  const wrong=fixture(); (wrong.layers[0] as {outputs:number}).outputs=2;
  await assert.rejects(createFannDynamics(wrong,1,1));
  const huge=fixture(); (huge.layers[0] as unknown as {weights:number[]}).weights=Array(65537).fill(0);
  await assert.rejects(createFannDynamics(huge,1,1),/budget/);
  const invalid=fixture(); (invalid.layers[0]!.weights as number[])[0]=NaN;
  await assert.rejects(createFannDynamics(invalid,1,1));
});
test('planner retains capability, cost, uncertainty and expansion controls', async () => {
  const m=await createFannDynamics(fixture(),1,1);
  try {
    const o={state:[0],goal:[2],actions:[action()],model:m,horizon:1,beamWidth:1,
      maxExpansions:1,budgetMicros:1,allowedCapabilities:['move'],uncertaintyPenalty:0,maxUncertainty:1};
    const result=planPredictively(o);
    assert.equal(result.action?.id,'step'); assert.deepEqual(result.predictedState,[2]);
    assert.ok(result.expansions<=1);
    for(const change of [{allowedCapabilities:[]},{budgetMicros:0},{maxUncertainty:.99}])
      assert.equal(planPredictively({...o,...change}).action,undefined);
  } finally {m.dispose();}
});
