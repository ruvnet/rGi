import {DatabaseSync} from 'node:sqlite';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {runMission} from '../src/mission.ts';
import {createIsolatedSession} from '../src/isolated-session.ts';
import {packEvidence,unpackEvidence,rvmEvidenceSegments,unpackRvmEvidence} from '../src/evidence-container.ts';
import {signProof,verifySignedProof,hashValue} from '../src/mission-proof.ts';
import type {SignedMissionProof} from '../src/mission-proof.ts';
import type {MissionSpec} from '../src/mission-contracts.ts';

const modulePath=resolve('examples/mission-agent.mjs'),agentSource=readFileSync(modulePath,'utf8');
const spec:MissionSpec={id:'public-sequential-v1',modulePath,artifactSha256:createHash('sha256').update(agentSource).digest('hex'),
  train:[{input:{kind:'affine',x:0},output:3},{input:{kind:'affine',x:1},output:5}],
  transfer:Array.from({length:24},(_,i)=>({input:{kind:'affine',x:10+i},output:2*(10+i)+3})),
  retention:Array.from({length:12},(_,i)=>({input:{kind:'square',x:40+i},output:(40+i)**2})),
  maxRequests:48,timeoutMs:3000,maxMessageBytes:65536};
const directory=mkdtempSync(join(tmpdir(),'rgi-mission-bench-'));const database=new DatabaseSync(join(directory,'audit.sqlite'));
try{
  const result=await runMission(spec,database);
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const privatePem=privateKey.export({type:'pkcs8',format:'pem'}).toString(),publicPem=publicKey.export({type:'spki',format:'pem'}).toString();
  const signed=signProof(result.proof,privatePem);
  const payload={format:'rgi.mission.evidence.v1',signed,agentSource,
    limitations:['Public deterministic scalar program fixture, not a neural model or unfamiliar domain test.',
      'Signature proves possession of the signing key and byte integrity, not honest execution or AGI.',
      'This generated demonstration key is not independent evaluator identity.',
      'RVM is the runtime; this RVF contains replay evidence, not a guest executable.']};
  const packStart=performance.now(),rvf=packEvidence(payload),packMs=performance.now()-packStart;
  const unpackStart=performance.now(),decoded=unpackEvidence(rvf) as typeof payload,unpackMs=performance.now()-unpackStart;
  const replay=verifySignedProof(decoded.signed as SignedMissionProof,publicPem);
  const rvmBytes=rvmEvidenceSegments(rvf),rvmPayload=unpackRvmEvidence(rvmBytes) as typeof payload;
  if(verifySignedProof(rvmPayload.signed,publicPem).rootHash!==replay.rootHash)throw Error('rvm_replay_mismatch');
  if(replay.rootHash!==result.replay.rootHash)throw Error('replay_mismatch');
  // Execute the embedded bundle again in fresh processes, not just rescore its receipts.
  const replayPath=join(directory,'replay-agent.mjs');writeFileSync(replayPath,decoded.agentSource);
  const secondDb=new DatabaseSync(':memory:');
  let repeated;try{repeated=await runMission({...spec,modulePath:replayPath},secondDb);}finally{secondDb.close();}
  if(repeated.replay.rootHash!==replay.rootHash)throw Error('execution_replay_mismatch');
  const options={modulePath,mode:'retained' as const,artifactSha256:spec.artifactSha256,timeoutMs:3000,maxMessageBytes:65536};
  const trials=12,state={version:1,scale:2,offset:3};
  const freshStart=performance.now();
  for(let i=0;i<trials;i++){const s=await createIsolatedSession(options);try{await s.request('restore',state);const y=await s.request('predict',{kind:'affine',x:i});if(y!==2*i+3)throw Error('benchmark_mismatch');}finally{await s.close();}}
  const freshMs=performance.now()-freshStart;
  const pooledStart=performance.now(),s=await createIsolatedSession(options);
  try{for(let i=0;i<trials;i++){await s.request('restore',state);const y=await s.request('predict',{kind:'affine',x:i});if(y!==2*i+3)throw Error('benchmark_mismatch');}}finally{await s.close();}
  const sessionMs=performance.now()-pooledStart;
  const report={generatedAt:new Date().toISOString(),replay,elapsedMs:result.elapsedMs,launches:result.launches,requests:result.requests,
    rvfBytes:rvf.length,packMs,unpackMs,executionReplayMatched:true,proofSha256:hashValue(result.proof),
    sessionComparison:{trials,requestsPerMode:trials*2,freshLaunches:trials,sessionLaunches:1,freshMs,sessionMs,speedup:freshMs/sessionMs},
    limitations:payload.limitations};
  mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/mission.rvf',rvf);
  writeFileSync('artifacts/mission.rvm.rvf',rvmBytes);
  writeFileSync('artifacts/mission.public.pem',publicPem);writeFileSync('artifacts/mission.json',JSON.stringify(report,null,2)+'\n');
  // The private demonstration signing key is never written to disk.
  console.log(JSON.stringify(report,null,2));
  if(!replay.retainedImproves||!replay.retentionPassed)process.exitCode=1;
}finally{database.close();rmSync(directory,{recursive:true,force:true});}
