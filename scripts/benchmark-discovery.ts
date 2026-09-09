import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {discoveryFixtures} from '../src/discovery-fixtures.ts';
import {advanceDiscovery} from '../src/discovery-run.ts';
import {addDiscoveryTrial,signDiscoveryStudy,verifyDiscoveryStudy} from '../src/discovery-evidence.ts';
import type {DiscoveryStudy,SignedDiscoveryStudy} from '../src/discovery-evidence.ts';
import {hashValue} from '../src/mission-proof.ts';
import {packEvidence,unpackEvidence,rvmEvidenceSegments,unpackRvmEvidence} from '../src/evidence-container.ts';
import {benchmarkDiscoveryKernel} from './benchmark-discovery-kernel.ts';

const fixtures=discoveryFixtures(),study:DiscoveryStudy={version:1,models:[],trials:[]};
// Fix declarations before observing scores. This is reproducible development data,
// not an independent preregistration or a sealed final audit.
const declarationSha256=hashValue(fixtures.map(({problem,...task})=>({...task,problemSha256:hashValue(problem)})));
const db=new DatabaseSync(':memory:');let checkpoints=0;const start=performance.now();
try {
  for(const fixture of fixtures) {
    for(const strategy of ['information','fixed','random'] as const) {
      const spec={id:`${fixture.id}:${strategy}`,problem:fixture.problem,
        policy:{strategy,seed:0x13579bdf,...fixture.budget}};
      // The engine and runner receive no truth index or query answer. The trusted
      // host environment closes over the target and answers only reserved probes.
      const oracle=(inputIndex:number)=>fixture.problem.hypotheses[fixture.target]![inputIndex]!;
      let run=advanceDiscovery(spec,db,oracle,1);
      while(!run.replay.complete){checkpoints++;run=advanceDiscovery(spec,db,oracle,1);}
      const fresh=new DatabaseSync(':memory:');
      try {
        const uninterrupted=advanceDiscovery(spec,fresh,oracle);
        if(uninterrupted.replay.rootHash!==run.replay.rootHash)throw Error('checkpoint_replay_mismatch');
      }finally{fresh.close();}
      addDiscoveryTrial(study,fixture.id,fixture.family,fixture.target,run.transcript);
    }
    if(study.trials.length%48===0)console.error(`discovery: ${study.trials.length} paired trials recorded`);
  }
}finally{db.close();}
const executionMs=performance.now()-start;
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const publicPem=publicKey.export({type:'spki',format:'pem'}).toString();
const signed=signDiscoveryStudy(study,privateKey.export({type:'pkcs8',format:'pem'}).toString());
const rvf=packEvidence(signed),stream=rvmEvidenceSegments(rvf);
const summary=verifyDiscoveryStudy(unpackEvidence(rvf) as SignedDiscoveryStudy,publicPem);
const rvmSummary=verifyDiscoveryStudy(unpackRvmEvidence(stream) as SignedDiscoveryStudy,publicPem);
if(hashValue(summary)!==hashValue(rvmSummary))throw Error('transport_replay_mismatch');
if(summary.arms.some(arm=>arm.wrong!==0))throw Error('closed_prior_wrong_answer');
const report={generatedAt:new Date().toISOString(),declarationSha256,
  fixtureSourceSha256:createHash('sha256').update(readFileSync('src/discovery-fixtures.ts')).digest('hex'),
  ...summary,executionMs,checkpointResumes:checkpoints,checkpointReplayMatched:true,rvfBytes:rvf.length,
  rvfSha256:createHash('sha256').update(rvf).digest('hex'),kernel:benchmarkDiscoveryKernel(),
  limitations:[
    'Public exhaustive targets from three known finite priors; this does not measure unfamiliar domain generalization.',
    'Probe costs are synthetic units. Timing excludes remote model inference and real provider billing.',
    'All arms use the same priors, budgets and unanimity rule. Abstentions count as unanswered; no selective accuracy denominator.',
    'Paired counts are descriptive. Targets within a family are correlated; no independent statistical promotion claim.',
    'Random control uses one fixed seed across all targets. Its outcome is a schedule diagnostic, not a seed-averaged estimate.',
    'SQLite pause/resume replays trusted synchronous callbacks. There is no callback deadline or network sandbox.',
    'Self-generated demonstration Ed25519 key authenticates bytes, not an independent evaluator or honest external execution.',
    'RVF segment compatibility does not imply RVM guest execution. No SOTA ranking or AGI claim.'
  ]};
mkdirSync('artifacts',{recursive:true});
writeFileSync('artifacts/discovery.rvf',rvf);writeFileSync('artifacts/discovery.rvm.rvf',stream);
writeFileSync('artifacts/discovery.public.pem',publicPem);
writeFileSync('artifacts/discovery.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
