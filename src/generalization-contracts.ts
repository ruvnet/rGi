export type Split='development'|'selection'|'transfer'|'retention';
export interface Example {input:unknown;output:unknown}
export interface TransferTask {
  id:string;family:string;split:Split;seed:number;
  support:Example[];queries:Example[];
}
export interface AgentReply {output:unknown;costMicros:number;modelCalls:number;humanInterventions:number}
/** Trusted host plugin contract. The host owns metering and agent lifecycle. */
export interface TransferAgent {
  predict(input:unknown,signal:AbortSignal):Promise<AgentReply>;
  learn?(examples:readonly Example[],signal:AbortSignal):Promise<Omit<AgentReply,'output'>>;
  close?():void;
}
export interface AgentFactory {id:string;artifactSha256:string;create():TransferAgent}
export interface GeneralizationProtocol {
  id:string;developmentFamilies:string[];selectionFamilies:string[];
  tasks:TransferTask[];baseline:AgentFactory;candidate:AgentFactory;
  supportLimit:number;maxCostMicros:number;maxModelCalls:number;timeoutMs:number;
}
