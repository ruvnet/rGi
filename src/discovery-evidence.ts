import {createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';
import {canonicalJson,hashValue} from './mission-proof.ts';
import {exactFields,replayDiscovery} from './discovery-run.ts';
import type {DiscoveryTranscript,DiscoveryEvent} from './discovery-run.ts';
import type {DiscoveryProblem,DiscoveryPolicy} from './discovery.ts';

type SharedModel=Omit<DiscoveryProblem,'probeIndices'>;
export interface DiscoveryTrial {
  taskId:string;family:string;target:number;modelSha256:string;probeIndices:number[];
  policy:DiscoveryPolicy;events:DiscoveryEvent[];
}
export interface DiscoveryStudy {
  version:1;models:{sha256:string;model:SharedModel}[];trials:DiscoveryTrial[];
}
export interface DiscoveryScore {
  taskId:string;family:string;strategy:DiscoveryPolicy['strategy'];
  correct:number;wrong:number;abstentions:number;total:number;success:boolean;
  spentCost:number;probes:number;status:string;
}
const STRATEGIES:DiscoveryPolicy['strategy'][]=['information','fixed','random'];
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/.test(value);
function invalid(reason:string):never {throw Error(`invalid_discovery_study:${reason}`);}

/** Store a model once; target labels enter the host study only after trial execution. */
export function addDiscoveryTrial(study:DiscoveryStudy,taskId:string,family:string,target:number,transcript:DiscoveryTranscript):void {
  replayDiscovery(transcript);
  if(transcript.spec.id!==`${taskId}:${transcript.spec.policy.strategy}`)invalid('trial_id_mismatch');
  const {probeIndices,...model}=transcript.spec.problem;
  const modelSha256=hashValue(model);
  if(!study.models.some(entry=>entry.sha256===modelSha256))study.models.push({sha256:modelSha256,model:structuredClone(model)});
  study.trials.push({taskId,family,target,modelSha256,probeIndices:[...probeIndices],
    policy:structuredClone(transcript.spec.policy),events:structuredClone(transcript.events)});
}

/** Descriptive paired evidence over public finite priors. No independence assumption
 * or automatic promotion claim is made for these correlated exhaustive targets. */
export function replayDiscoveryStudy(study:DiscoveryStudy) {
  canonicalJson(study);exactFields(study,['version','models','trials']);
  if(study.version!==1||!Array.isArray(study.models)||study.models.length<1||study.models.length>8||
    !Array.isArray(study.trials)||study.trials.length<3||study.trials.length>768)invalid('bounds');
  const models=new Map<string,SharedModel>();
  for(const entry of study.models) {
    exactFields(entry,['sha256','model']);
    exactFields(entry.model,['version','inputs','hypotheses','costs','queryIndices']);
    if(hashValue(entry.model)!==entry.sha256||models.has(entry.sha256))invalid('model_identity');
    models.set(entry.sha256,entry.model);
  }
  const groups=new Map<string,{declaration:string;strategies:Set<string>}>(),usedModels=new Set<string>();
  const scores:DiscoveryScore[]=[];
  for(const trial of study.trials) {
    exactFields(trial,['taskId','family','target','modelSha256','probeIndices','policy','events']);
    if(!identifier(trial.taskId)||!identifier(trial.family))invalid('id');
    const model=models.get(trial.modelSha256);if(!model)invalid('model_reference');
    usedModels.add(trial.modelSha256);
    const transcript:DiscoveryTranscript={version:1,spec:{id:`${trial.taskId}:${trial.policy.strategy}`,
      problem:{...model,probeIndices:trial.probeIndices},policy:trial.policy},events:trial.events};
    const replay=replayDiscovery(transcript);
    if(!Number.isSafeInteger(trial.target)||trial.target<0||trial.target>=model.hypotheses.length)invalid('target');
    // Answer access is retrospective here, after all probe decisions have been recorded.
    let reserved=-1;
    for(const event of trial.events) {
      if(event.kind==='reserve')reserved=event.decision.inputIndex;
      if(event.kind==='observe'&&event.output!==model.hypotheses[trial.target]![reserved])invalid('oracle_mismatch');
    }
    const {strategy,...budgetAndSeed}=trial.policy;
    const declaration=canonicalJson({family:trial.family,target:trial.target,modelSha256:trial.modelSha256,
      probeIndices:trial.probeIndices,budgetAndSeed});
    const group=groups.get(trial.taskId)??{declaration,strategies:new Set<string>()};
    if(group.declaration!==declaration||group.strategies.has(strategy))invalid('unpaired_trial');
    group.strategies.add(strategy);groups.set(trial.taskId,group);
    let correct=0,wrong=0,abstentions=0;
    for(const prediction of replay.predictions) {
      if(prediction.output===null)abstentions++;
      else if(prediction.output===model.hypotheses[trial.target]![prediction.inputIndex])correct++;
      else wrong++;
    }
    scores.push({taskId:trial.taskId,family:trial.family,strategy,correct,wrong,abstentions,total:replay.predictions.length,
      success:correct===replay.predictions.length,spentCost:replay.state.spentCost,probes:replay.state.probes,status:replay.state.status});
  }
  if(usedModels.size!==models.size||[...groups.values()].some(group=>STRATEGIES.some(strategy=>!group.strategies.has(strategy))))invalid('incomplete_pairing');
  function totals(rows:DiscoveryScore[]) {
    return STRATEGIES.map(strategy=>{
      const arm=rows.filter(row=>row.strategy===strategy);
      return {strategy,tasks:arm.length,successes:arm.filter(row=>row.success).length,
        correct:arm.reduce((n,row)=>n+row.correct,0),wrong:arm.reduce((n,row)=>n+row.wrong,0),
        abstentions:arm.reduce((n,row)=>n+row.abstentions,0),total:arm.reduce((n,row)=>n+row.total,0),
        spentCost:arm.reduce((n,row)=>n+row.spentCost,0),probes:arm.reduce((n,row)=>n+row.probes,0)};
    });
  }
  const pairs=(['fixed','random'] as const).map(control=>{
    let wins=0,losses=0,ties=0;
    for(const taskId of groups.keys()) {
      const candidate=scores.find(row=>row.taskId===taskId&&row.strategy==='information')!;
      const baseline=scores.find(row=>row.taskId===taskId&&row.strategy===control)!;
      if(candidate.success&&!baseline.success)wins++;else if(baseline.success&&!candidate.success)losses++;else ties++;
    }
    return {control,wins,losses,ties};
  });
  return {studySha256:hashValue(study),tasks:groups.size,trials:scores.length,arms:totals(scores),
    families:[...new Set(scores.map(row=>row.family))].sort().map(family=>({family,arms:totals(scores.filter(row=>row.family===family))})),pairs};
}
export interface SignedDiscoveryStudy {version:1;algorithm:'Ed25519';study:DiscoveryStudy;signature:string}
const signingBytes=(study:DiscoveryStudy)=>Buffer.from(`rgi.discovery-study.v1\n${hashValue(study)}`);
export function signDiscoveryStudy(study:DiscoveryStudy,privateKeyPEM:string):SignedDiscoveryStudy {
  replayDiscoveryStudy(study);
  const key=createPrivateKey(privateKeyPEM);if(key.asymmetricKeyType!=='ed25519')invalid('key');
  const copy=JSON.parse(canonicalJson(study)) as DiscoveryStudy;
  return {version:1,algorithm:'Ed25519',study:copy,signature:sign(null,signingBytes(copy),key).toString('base64')};
}
export function verifyDiscoveryStudy(envelope:SignedDiscoveryStudy,expectedPublicKeyPEM:string) {
  canonicalJson(envelope);exactFields(envelope,['version','algorithm','study','signature']);
  if(envelope.version!==1||envelope.algorithm!=='Ed25519'||typeof envelope.signature!=='string')invalid('envelope');
  const key=createPublicKey(expectedPublicKeyPEM),signature=Buffer.from(envelope.signature,'base64');
  if(key.asymmetricKeyType!=='ed25519'||signature.length!==64||signature.toString('base64')!==envelope.signature||
    !verify(null,signingBytes(envelope.study),key,signature))invalid('signature');
  return replayDiscoveryStudy(envelope.study);
}
