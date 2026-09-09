import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createIsolatedSession} from '../src/isolated-session.ts';
import type {IsolatedOptions} from '../src/mission-contracts.ts';

const fixture=fileURLToPath(new URL('./fixtures/isolated-agent.mjs',import.meta.url));
const options=(changes:Partial<IsolatedOptions>={}):IsolatedOptions=>({modulePath:fixture,mode:'retained',timeoutMs:2000,maxMessageBytes:4096,...changes});

test('persistent child retains state; a fresh child resets and explicit restore survives restart',async()=>{
  const first=await createIsolatedSession(options());
  let saved:unknown,cwd:string;
  try{
    assert.deepEqual(await first.request('learn',7),{count:7});
    assert.deepEqual(await first.request('predict',null),{count:7});
    saved=await first.request('snapshot',null);
    cwd=(await first.request('predict',{op:'context'}) as {cwd:string}).cwd;
  }finally{await first.close();}
  await assert.rejects(stat(cwd!),{code:'ENOENT'});
  const second=await createIsolatedSession(options({mode:'reset'}));
  try{
    assert.deepEqual(await second.request('predict',null),{count:0});
    await second.request('restore',saved);
    assert.deepEqual(await second.request('predict',null),{count:7});
  }finally{await second.close();await second.close();}
});

test('child cannot read scorer files, write files, spawn processes, or inherit host secrets',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rgi-scorer-')),path=join(dir,'answers.json');
  await writeFile(path,'{"answer":"private"}');
  const prior=process.env.RGI_TEST_SECRET;process.env.RGI_TEST_SECRET='host-only';
  const session=await createIsolatedSession(options());
  try{
    const context=await session.request('predict',{op:'context'}) as {mode:string;cwd:string;env:Record<string,string>};
    assert.equal(context.mode,'retained');
    assert.equal(context.env.RGI_TEST_SECRET,undefined);
    assert.equal(context.env.HOME,undefined);assert.equal(context.env.NODE_OPTIONS,undefined);
    assert.deepEqual(Object.keys(context.env).sort(),['LANG','NODE_NO_WARNINGS','TZ']);
    assert.notEqual(context.cwd,process.cwd());
    for(const op of ['read','write'])assert.deepEqual(await session.request('predict',{op,path}),{code:'ERR_ACCESS_DENIED'});
    assert.deepEqual(await session.request('predict',{op:'write',path:join(context.cwd,'new.txt')}),{code:'ERR_ACCESS_DENIED'});
    assert.deepEqual(await session.request('predict',{op:'spawn'}),{code:'ERR_ACCESS_DENIED'});
    assert.equal(await readFile(path,'utf8'),'{"answer":"private"}');
  }finally{
    await session.close();await rm(dir,{recursive:true,force:true});
    if(prior===undefined)delete process.env.RGI_TEST_SECRET;else process.env.RGI_TEST_SECRET=prior;
  }
});

test('parent kills synchronous infinite loops and session cannot continue after deadline',async()=>{
  const session=await createIsolatedSession(options({timeoutMs:500}));
  const started=performance.now();
  try{
    await assert.rejects(session.request('predict',{op:'hang'}),/isolated_request_timeout/);
    assert.ok(performance.now()-started<3000);
    await assert.rejects(session.request('snapshot',null),/isolated_request_timeout/);
  }finally{await session.close();}
});

test('module initialization also has a hard deadline',async()=>{
  const started=performance.now();
  await assert.rejects(createIsolatedSession(options({timeoutMs:500,
    modulePath:fileURLToPath(new URL('./fixtures/isolated-startup-hang.mjs',import.meta.url))})),/isolated_startup_timeout/);
  assert.ok(performance.now()-started<3000);
});

test('message floods, mismatched reply IDs and invalid numeric outputs terminate sessions',async()=>{
  for(const [op,error] of [
    ['flood','isolated_output_limit'],['stderr','isolated_output_limit'],['wrong-id','isolated_protocol_error'],
    ['invalid-output','isolated_agent_error'],['oversized-output','isolated_output_limit'],
  ]){
    const session=await createIsolatedSession(options());
    try{await assert.rejects(session.request('predict',{op}),new RegExp(error!));}
    finally{await session.close();}
  }
});

test('only one request may be outstanding and invalid host data does not mutate agent state',async()=>{
  const session=await createIsolatedSession(options());
  try{
    const pending=session.request('predict',{op:'wait'});
    await assert.rejects(session.request('snapshot',null),/isolated_request_in_progress/);
    assert.deepEqual(await pending,{count:0});
    for(const payload of [NaN,undefined,new Date(),{value:Infinity},Object.assign(new Array(1),{extra:1})]){
      await assert.rejects(session.request('learn',payload),/isolated_invalid_json/);
    }
    await assert.rejects(session.request('learn','x'.repeat(4096)),/isolated_input_limit/);
    assert.deepEqual(await session.request('snapshot',null),{count:0});
  }finally{await session.close();}
});

test('close aborts an in flight call, removes its private directory and remains idempotent',async()=>{
  const session=await createIsolatedSession(options());
  const context=await session.request('predict',{op:'context'}) as {cwd:string};
  const request=session.request('predict',{op:'hang'});
  const rejected=assert.rejects(request,/isolated_session_closed/);
  await session.close();await rejected;await session.close();
  await assert.rejects(stat(context.cwd),{code:'ENOENT'});
  await assert.rejects(session.request('snapshot',null),/isolated_session_closed/);
});

test('invalid configuration and nonfile or oversized module bundles are rejected before spawn',async()=>{
  for(const changes of [{timeoutMs:0},{timeoutMs:Infinity},{maxMessageBytes:255},{maxMessageBytes:1_048_577}]){
    await assert.rejects(createIsolatedSession(options(changes)),/isolated_invalid_options/);
  }
  const dir=await mkdtemp(join(tmpdir(),'rgi-module-test-'));
  try{
    await assert.rejects(createIsolatedSession(options({modulePath:dir})),/isolated_invalid_module/);
    const path=join(dir,'oversize.mjs');await writeFile(path,'x'.repeat(1_048_577));
    await assert.rejects(createIsolatedSession(options({modulePath:path})),/isolated_invalid_module/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('the actual copied bundle must match its frozen artifact digest',async()=>{
  await assert.rejects(createIsolatedSession(options({artifactSha256:'0'.repeat(64)})),/isolated_artifact_mismatch/);
  const artifactSha256=createHash('sha256').update(await readFile(fixture)).digest('hex');
  const session=await createIsolatedSession(options({artifactSha256}));
  try{assert.deepEqual(await session.request('snapshot',null),{count:0});}finally{await session.close();}
});
