import type { Action,Planner,PlanningContext } from './contracts.ts';
import { OnlineDynamics } from './learning.ts';
import { planPredictively } from './planning.ts';
import { identifier } from './policy.ts';

interface ScalarState {state:number;goal:number;calibrationAction?:number}
/** Reference simulation planner showing feedback -> adaptation -> prediction -> action.
 * It is NOT a generalist trained policy or a physical controller. */
export class ScalarFeedbackPlanner implements Planner {
  private model:OnlineDynamics;
  private seen:string[]=[];
  private readonly learn:boolean;
  readonly namespace:string;
  expansions=0;
  constructor(options:{learn?:boolean;gain?:number;namespace?:string}={}){
    this.learn=options.learn??true;this.model=new OnlineDynamics(options.gain??1);
    this.namespace=options.namespace??'scalar';identifier(this.namespace);
  }
  snapshot():unknown{return {version:1,model:this.model.snapshot(),seen:[...this.seen]};}
  restore(raw:unknown):void{
    const state=raw as {version:number;model:ReturnType<OnlineDynamics['snapshot']>;seen:string[]};
    if(!state||state.version!==1||!Array.isArray(state.seen)||state.seen.length>256)throw new Error('invalid_planner_snapshot');
    state.seen.forEach(identifier);
    const model=OnlineDynamics.restore(state.model);
    this.model=model;this.seen=[...state.seen];
  }
  async plan(context:PlanningContext):Promise<Action[]>{
    context.signal.throwIfAborted();
    for(const outcome of context.outcomes){
      if(this.seen.includes(outcome.actionId))continue;
      if(outcome.capability!=='simulation.control')continue;
      this.seen.push(outcome.actionId);this.seen=this.seen.slice(-256);
      if(!this.learn||outcome.status!=='succeeded'||outcome.omitted)continue;
      const row=outcome.output as {previous?:unknown;control?:unknown;next?:unknown}|null;
      if(!row||![row.previous,row.control,row.next].every(v=>typeof v==='number'&&Number.isFinite(v)))continue;
      // Output is transport feedback, not verified task reward. Bounded updates only.
      try{this.model.observe({state:row.previous as number,action:row.control as number,next:row.next as number});}catch{continue;}
    }
    const observation=[...context.observations].reverse().find(o=>o.modality==='scalar-control');
    if(!observation)return [];
    const value=observation.data as ScalarState;
    if(!value||![value.state,value.goal].every(v=>Number.isFinite(v)&&Math.abs(v)<=1000))throw new Error('invalid_scalar_observation');
    const make=(control:number):Action=>({id:`${this.namespace}:${context.sequence}`,capability:'simulation.control',payload:{control},estimatedCostMicros:1,confidence:1});
    if(value.calibrationAction!==undefined){
      if(!Number.isFinite(value.calibrationAction)||Math.abs(value.calibrationAction)>1)throw new Error('invalid_calibration');
      return context.remainingBudgetMicros>=1?[make(value.calibrationAction)]:[];
    }
    if(Math.abs(value.state-value.goal)<=0.13)return [];
    const result=planPredictively({state:[value.state],goal:[value.goal],
      actions:[-1,-0.5,-0.25,0,0.25,0.5,1].map((v,i)=>({...make(v),id:`candidate:${i}`})),
      model:{predict:(state,action)=>({state:[this.model.predict(state[0]!,Number(action.payload.control))],uncertainty:0})},
      horizon:3,beamWidth:8,maxExpansions:96,budgetMicros:context.remainingBudgetMicros,
      allowedCapabilities:['simulation.control'],uncertaintyPenalty:1,maxUncertainty:0.5});
    this.expansions+=result.expansions;
    return result.action?[{...result.action,id:`${this.namespace}:${context.sequence}`}]:[];
  }
}
