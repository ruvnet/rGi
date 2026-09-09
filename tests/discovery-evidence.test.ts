import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync} from 'node:crypto';
import {advanceDiscovery} from '../src/discovery-run.ts';
import {addDiscoveryTrial,replayDiscoveryStudy,signDiscoveryStudy,verifyDiscoveryStudy} from '../src/discovery-evidence.ts';
import type {DiscoveryStudy,SignedDiscoveryStudy} from '../src/discovery-evidence.ts';
import {packEvidence,unpackEvidence,rvmEvidenceSegments,unpackRvmEvidence} from '../src/evidence-container.ts';

function fixture():DiscoveryStudy {
  const study:DiscoveryStudy={version:1,models:[],trials:[]},db=new DatabaseSync(':memory:');
  try {
    for(const strategy of ['information','fixed','random'] as const){
      const {transcript}=advanceDiscovery({id:`task:${strategy}`,problem:{version:1,inputs:['a','b','q'],costs:[1,1,1],
        hypotheses:[[0,0,0],[0,1,1],[1,0,2],[1,1,3]],probeIndices:[0,1],queryIndices:[2]},
        policy:{strategy,seed:1,maxProbes:2,maxCost:2}},db,()=>1);
      addDiscoveryTrial(study,'task','public',3,transcript);
    }
  }finally{db.close();}
  return study;
}
test('shared model evidence replays all paired arms from RVF and RVM transport',()=>{
  const study=fixture(),{privateKey,publicKey}=generateKeyPairSync('ed25519');
  assert.equal(study.models.length,1);
  const pem=publicKey.export({format:'pem',type:'spki'}).toString();
  const signed=signDiscoveryStudy(study,privateKey.export({format:'pem',type:'pkcs8'}).toString());
  const bytes=packEvidence(signed),rvf=verifyDiscoveryStudy(unpackEvidence(bytes) as SignedDiscoveryStudy,pem);
  assert.deepEqual(verifyDiscoveryStudy(unpackRvmEvidence(rvmEvidenceSegments(bytes)) as SignedDiscoveryStudy,pem),rvf);
  assert.deepEqual(rvf.arms.map(arm=>arm.correct),[1,1,1]);
  assert.deepEqual(rvf.arms.map(arm=>arm.spentCost),[2,2,2]);
});
test('replay rejects incomplete or duplicated controls and model tampering',()=>{
  const missing=fixture();missing.trials.pop();assert.throws(()=>replayDiscoveryStudy(missing),/bounds|pairing/);
  const duplicate=fixture();duplicate.trials.push(structuredClone(duplicate.trials[0]!));
  assert.throws(()=>replayDiscoveryStudy(duplicate),/unpaired/);
  const changed=fixture();changed.models[0]!.model.hypotheses[0]![0]=100;
  assert.throws(()=>replayDiscoveryStudy(changed),/model_identity/);
});
test('retrospective target labels must agree with observed outputs',()=>{
  const changed=fixture();for(const trial of changed.trials)trial.target=0;
  assert.throws(()=>replayDiscoveryStudy(changed),/oracle_mismatch/);
});
test('artifact cannot choose its own signing authority and any changed study invalidates its signature',()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),other=generateKeyPairSync('ed25519');
  const signed=signDiscoveryStudy(fixture(),privateKey.export({format:'pem',type:'pkcs8'}).toString());
  assert.throws(()=>verifyDiscoveryStudy(signed,other.publicKey.export({format:'pem',type:'spki'}).toString()),/signature/);
  signed.study.trials[0]!.family='rewritten';
  assert.throws(()=>verifyDiscoveryStudy(signed,publicKey.export({format:'pem',type:'spki'}).toString()),/signature/);
});
test('trial helper rejects incompatible run identities before mutating a study',()=>{
  const study:DiscoveryStudy={version:1,models:[],trials:[]},db=new DatabaseSync(':memory:');
  try {
    const {transcript}=advanceDiscovery({id:'different-run',problem:{version:1,inputs:['probe','query'],costs:[1,1],
      hypotheses:[[0,0]],probeIndices:[0],queryIndices:[1]},policy:{strategy:'information',seed:1,maxProbes:1,maxCost:1}},db,()=>0);
    assert.throws(()=>addDiscoveryTrial(study,'task','public',0,transcript),/trial_id_mismatch/);
    assert.equal(study.models.length,0);assert.equal(study.trials.length,0);
  }finally{db.close();}
});
