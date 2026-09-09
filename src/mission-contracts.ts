export interface MissionExample {input:unknown;output:unknown}
export type MissionArm='baseline'|'reset'|'retained';
export interface IsolatedSession {
  request(method:'learn'|'predict'|'snapshot'|'restore',payload:unknown):Promise<unknown>;
  close():Promise<void>;
}
export interface IsolatedOptions {
  modulePath:string;mode:MissionArm;timeoutMs:number;maxMessageBytes:number;
  artifactSha256?:string;
}
export interface MissionSpec {
  id:string;modulePath:string;artifactSha256:string;train:MissionExample[];
  transfer:MissionExample[];retention:MissionExample[];
  maxRequests:number;timeoutMs:number;maxMessageBytes:number;
}
export type EvidenceSpec=Omit<MissionSpec,'modulePath'>;
export interface MissionEvent {
  sequence:number;previousHash:string;hash:string;arm:MissionArm;
  kind:'begin'|'learn'|'snapshot'|'restart'|'restore'|'predict'|'end';payload:unknown;
}
export interface MissionProof {version:1;spec:EvidenceSpec;events:MissionEvent[]}
export interface ReplayResult {
  valid:true;rootHash:string;arms:{arm:MissionArm;requests:number;transferCorrect:number;transferTotal:number;retentionCorrect:number;retentionTotal:number}[];
  retainedImproves:boolean;retentionPassed:boolean;
}
