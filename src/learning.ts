import { confidence } from './policy.ts';

export interface Transition { state:number;action:number;next:number }
export interface CandidateEvidence {
  baselineError:number;candidateError:number;retentionRegression:number;
  samples:number;independent:boolean;capabilityViolations:number;
}
/** Small bounded online dynamics predictor. Not a multimodal foundation model. */
export class OnlineDynamics {
  private gain:number;
  private readonly rate:number;
  constructor(gain=0,rate=0.05) {
    if (!Number.isFinite(gain) || Math.abs(gain)>10) throw new Error('invalid_gain');
    confidence(rate); if (rate===0) throw new Error('invalid_rate');
    this.gain=gain;this.rate=rate;
  }
  predict(state:number,action:number):number {
    if (![state,action].every(Number.isFinite) || Math.abs(state)>1000 || Math.abs(action)>1)
      throw new Error('invalid_transition');
    return state + this.gain*action;
  }
  observe(sample:Transition):number {
    const prediction=this.predict(sample.state,sample.action);
    if (!Number.isFinite(sample.next) || Math.abs(sample.next)>1000) throw new Error('invalid_transition');
    const error=sample.next-prediction;
    this.gain=Math.max(-10,Math.min(10,this.gain+this.rate*Math.max(-1,Math.min(1,error))*sample.action));
    return error*error;
  }
  snapshot():{version:1;gain:number;rate:number} {return {version:1,gain:this.gain,rate:this.rate};}
  static restore(snapshot:{version:number;gain:number;rate:number}):OnlineDynamics {
    if (snapshot.version!==1) throw new Error('unknown_model_version');
    return new OnlineDynamics(snapshot.gain,snapshot.rate);
  }
}
/** Evaluation evidence must come from host-controlled holdouts, never model self-report. */
export function promotionGate(evidence:CandidateEvidence):{promote:boolean;reason:string} {
  if (![evidence.baselineError,evidence.candidateError,evidence.retentionRegression].every(v=>Number.isFinite(v)&&v>=0)
    || !Number.isSafeInteger(evidence.samples) || evidence.samples<100
    || evidence.independent!==true || evidence.capabilityViolations!==0)
    return {promote:false,reason:'insufficient_evidence'};
  if (evidence.retentionRegression>0.02) return {promote:false,reason:'retention_regression'};
  if (evidence.baselineError<=0 || evidence.candidateError>evidence.baselineError*0.85)
    return {promote:false,reason:'insufficient_improvement'};
  return {promote:true,reason:'gate_passed'};
}
