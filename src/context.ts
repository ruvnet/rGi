import type { Observation } from './contracts.ts';
import { money,validateObservation } from './policy.ts';

/** Recheck freshness at use, not only at ingestion. Source authentication is host-owned. */
export function freshObservations(observations:Observation[],now:number,maxAgeMs:number):Observation[]{
  money(now);money(maxAgeMs);
  return observations.filter(observation=>{
    try{validateObservation(observation,1048576);}catch{return false;}
    if(observation.timestamp>now||now-observation.timestamp>maxAgeMs)return false;
    if(observation.expiresAt!==undefined&&observation.expiresAt<=now)return false;
    if(observation.modality==='rufield'){
      const data=observation.data as {issuedAt?:unknown;expiresAt?:unknown}|null;
      if(!data||!Number.isSafeInteger(data.issuedAt)||!Number.isSafeInteger(data.expiresAt)
        || (data.issuedAt as number)>now || (data.expiresAt as number)<=now)return false;
    }
    return true;
  });
}
