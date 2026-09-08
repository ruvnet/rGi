import { createHash } from 'node:crypto';
import { mkdirSync,writeFileSync } from 'node:fs';
import { Runtime } from '../src/runtime.ts';
import { ScalarFeedbackPlanner } from '../src/adaptive.ts';
import { evaluateCandidate,type EvaluationPair } from '../src/evaluation.ts';

// Fixed protocol: 128 calibration interactions, 40 held-out instances per gain,
// frozen parameters at audit, 12 actions per episode, identical planning limits.
const started=performance.now();
const gains=[-0.75,0.5,1];
const pairs:EvaluationPair[]=[];
const models:unknown[]=[];
let expansions=0;
async function episode(gain:number,learn:boolean,initial:number,goal:number,snapshot?:unknown,calibrate=false){
  const planner=new ScalarFeedbackPlanner({learn});if(snapshot)planner.restore(snapshot);
  let state=initial,actions=0;
  const runtime=new Runtime({dbPath:':memory:',planner,plannerCheckpointKey:'scalar',
    config:{allowedCapabilities:['simulation.control'],budgetMicros:calibrate?128:12},
    executor:{async execute(action){const previous=state,control=Number(action.payload.control);state+=gain*control;actions++;
      return {output:{previous,control,next:state},actualCostMicros:1};}}});
  try{
    const steps=calibrate?128:12;
    for(let i=0;i<steps;i++){
      runtime.observe({id:`obs:${i}`,source:'simulation',timestamp:Date.now(),modality:'scalar-control',confidence:1,
        data:{state,goal,...(calibrate?{calibrationAction:i%2===0?1:-1}:{})}});
      await runtime.step();
      if(!calibrate&&Math.abs(state-goal)<=0.13)break;
    }
    if(calibrate){runtime.observe({id:'flush',source:'simulation',timestamp:Date.now(),modality:'scalar-control',confidence:1,data:{state,goal:state}});await runtime.step();}
    expansions+=planner.expansions;
    return {success:Math.abs(state-goal)<=0.13,actions,snapshot:planner.snapshot()};
  }finally{runtime.close();}
}
let seed=20260908;
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
for(const gain of gains){
  const baseline=await episode(gain,false,0,0,undefined,true);
  const candidate=await episode(gain,true,0,0,undefined,true);
  models.push({gain,baseline:baseline.snapshot,candidate:candidate.snapshot});
  for(let i=0;i<40;i++){
    const initial=random()*2-1,goal=random()*2-1;
    const a=await episode(gain,false,initial,goal,baseline.snapshot);
    const b=await episode(gain,false,initial,goal,candidate.snapshot);
    pairs.push({taskId:`audit:${gain}:${i}`,domain:`regime:${gain}`,baselineSuccess:a.success,candidateSuccess:b.success,
      baselineCostMicros:a.actions+128,candidateCostMicros:b.actions+128,capabilityViolations:0});
  }
}
const decision=evaluateCandidate({candidateId:'scalar-adaptive-v1',baselineId:'scalar-frozen-v1',
  trainIds:gains.flatMap(g=>Array.from({length:128},(_,i)=>`train:${g}:${i}`)),selectionIds:[],
  auditIds:pairs.map(p=>p.taskId),pairs,alpha:0.05,familySize:1,minPairs:120,maxCostRatio:1});
const report={protocol:'scalar-adaptation-v1',seed:20260908,generatedAt:new Date().toISOString(),
  durationMs:performance.now()-started,expansions,decision,models,
  modelSha256:createHash('sha256').update(JSON.stringify(models)).digest('hex'),
  regimes:gains.map(g=>{const rows=pairs.filter(p=>p.domain===`regime:${g}`);return {gain:g,n:rows.length,
    baselineSuccesses:rows.filter(p=>p.baselineSuccess).length,candidateSuccesses:rows.filter(p=>p.candidateSuccess).length};}),pairs,
  limitations:['Synthetic scalar dynamics only; not AGI or unseen-domain generalization.',
    'Shared fitted models can correlate task outcomes; nominal p-value is diagnostic, not deployment evidence.',
    '128 calibration actions charged per episode conservatively; cost units are synthetic, not money or compute.',
    'No model learns from audit outcomes. Uncertainty is zero only for this deterministic simulation.',
    'Gate decision does not automatically promote any deployed model.']};
mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/adaptation.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({decision,regimes:report.regimes,expansions,durationMs:report.durationMs},null,2));
// Regression gate, not a demand that every research experiment be significant.
if(report.regimes.some(r=>r.candidateSuccesses<r.baselineSuccesses))process.exitCode=1;
