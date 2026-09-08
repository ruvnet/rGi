import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('CLI runs, restarts, reports and durably stops end to end',()=>{
  const directory=mkdtempSync(join(tmpdir(),'rgi-cli-'));const db=join(directory,'state.db');
  const invoke=(args:string[])=>{
    const result=spawnSync(process.execPath,['src/cli.ts',...args,'--db',db],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  try{
    assert.equal(invoke(['demo','--cycles','3']).jobs.succeeded,3);
    assert.equal(invoke(['demo','--cycles','2']).jobs.succeeded,5);
    assert.equal(invoke(['status']).spentMicros,5);
    assert.equal(invoke(['stop']).stopped,true);
    assert.equal(invoke(['demo','--cycles','2']).jobs.succeeded,5);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
