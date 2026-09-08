import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {AgentFactory,AgentReply,GeneralizationProtocol,TransferTask} from './generalization-contracts.ts';
import {deepFreeze,boundedJson} from './policy.ts';

const canonical=(value:unknown):string=>{
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
};
const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function strictJson(value:unknown,depth=0):void{
  if(depth>32)throw new Error('invalid_json');
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'&&Number.isFinite(value))return;
  if(typeof value!=='object'||!value)throw new Error('invalid_json');
  const prototype=Object.getPrototypeOf(value);
  if(Array.isArray(value)){
    if(prototype!==Array.prototype||Object.keys(value).length!==value.length)throw new Error('invalid_json');
  }else if(prototype!==Object.prototype&&prototype!==null)throw new Error('invalid_json');
  if(Object.getOwnPropertySymbols(value).length)throw new Error('invalid_json');
  for(const [key,d] of Object.entries(Object.getOwnPropertyDescriptors(value))){
    if(Array.isArray(value)&&key==='length')continue;
    if(!('value' in d)||!d.enumerable)throw new Error('invalid_json');strictJson(d.value,depth+1);
  }
}
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$/.test(v);
const integer=(v:number,min=0,max=1e9)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
export interface EpisodeResult {taskId:string;family:string;split:string;agentId:string;mode:'zero'|'support';
  correct:number;total:number;costMicros:number;modelCalls:number;humanInterventions:number;elapsedMs:number;error:string|null}
export interface GeneralizationReport {protocolId:string;manifestSha256:string;results:EpisodeResult[];
  summary:{family:string;split:string;mode:string;baselineAccuracy:number;candidateAccuracy:number;delta:number}[];
  valid:boolean;retentionPassed:boolean;transferImproved:boolean;limitations:string[]}

/** Host controlled evaluation. Factories and accounting are trusted; use isolated
 * workers and independent provider receipts for hostile or remote agents. */
export class GeneralizationHarness {
  private readonly db:DatabaseSync;
  constructor(db:DatabaseSync){
    this.db=db;
    db.exec(`CREATE TABLE IF NOT EXISTS rgi_generalization_runs(id TEXT PRIMARY KEY, manifest TEXT NOT NULL, report TEXT);
      CREATE TABLE IF NOT EXISTS rgi_generalization_audits(task_id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, run_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rgi_generalization_queries(fingerprint TEXT PRIMARY KEY, run_id TEXT NOT NULL);`);
  }
  async run(protocol:GeneralizationProtocol):Promise<GeneralizationReport>{
    const p=this.validate(protocol);
    const manifestSha256=hash({...p,baseline:{id:p.baseline.id,artifactSha256:p.baseline.artifactSha256},candidate:{id:p.candidate.id,artifactSha256:p.candidate.artifactSha256}});
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare('INSERT INTO rgi_generalization_runs(id,manifest) VALUES(?,?)').run(p.id,manifestSha256);
      const insert=this.db.prepare('INSERT INTO rgi_generalization_audits(task_id,fingerprint,run_id) VALUES(?,?,?)');
      const prior=this.db.prepare('SELECT run_id FROM rgi_generalization_queries WHERE fingerprint=?');
      for(const t of p.tasks)for(const e of [...t.support,...t.queries])if(prior.get(hash(e)))throw new Error('audit_example_reused');
      for(const t of p.tasks)insert.run(t.id,hash({support:t.support.map(canonical).sort(),queries:t.queries.map(canonical).sort()}),p.id);
      const queryInsert=this.db.prepare('INSERT OR IGNORE INTO rgi_generalization_queries(fingerprint,run_id) VALUES(?,?)');
      for(const t of p.tasks)for(const e of t.queries)queryInsert.run(hash(e),p.id);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    // Audit consumption commits before any plugin sees an input, including failed runs.
    const results:EpisodeResult[]=[];
    const instances=new WeakSet<object>();
    for(const task of p.tasks)for(const mode of ['zero','support'] as const){
      for(const factory of [p.baseline,p.candidate])results.push(await this.episode(p,task,factory,mode,instances));
    }
    const summary:GeneralizationReport['summary']=[];
    for(const family of new Set(p.tasks.map(t=>t.family)))for(const mode of ['zero','support']){
      const rows=results.filter(r=>r.family===family&&r.mode===mode);
      const accuracy=(id:string)=>{const a=rows.filter(r=>r.agentId===id);return a.reduce((n,r)=>n+r.correct,0)/a.reduce((n,r)=>n+r.total,0);};
      const baselineAccuracy=accuracy(p.baseline.id),candidateAccuracy=accuracy(p.candidate.id);
      summary.push({family,split:rows[0]!.split,mode,baselineAccuracy,candidateAccuracy,delta:candidateAccuracy-baselineAccuracy});
    }
    const valid=results.every(r=>r.error===null&&r.humanInterventions===0);
    const report:GeneralizationReport={protocolId:p.id,manifestSha256,results,summary,valid,
      retentionPassed:valid&&summary.filter(r=>r.split==='retention').every(r=>r.delta>=0),
      transferImproved:valid&&summary.filter(r=>r.split==='transfer').every(r=>r.delta>=0)&&summary.some(r=>r.split==='transfer'&&r.delta>0),
      limitations:['Family labels and source hashes do not prove semantic novelty or absence from pretraining.',
        'Fresh instances isolate audit tasks by contract, not process sandbox; factories must not share hidden state.',
        'Meters are supplied by trusted host adapters; provider accounting needs independent receipts.',
        'No statistical significance, general intelligence or automatic deployment promotion is claimed.',
        'Zero mode uses no task support; support mode learns only its fixed support set and receives no query feedback.',
        'Retention compares fixed agent artifacts on earlier families, not lifelong forgetting after training on audit tasks.']};
    this.db.prepare('UPDATE rgi_generalization_runs SET report=? WHERE id=?').run(JSON.stringify(report),p.id);
    return report;
  }
  private validate(p:GeneralizationProtocol):GeneralizationProtocol{
    if(!p||!validId(p.id)||!Array.isArray(p.tasks)||p.tasks.length<1||p.tasks.length>1000
      ||!integer(p.supportLimit,0,256)||!integer(p.maxCostMicros,1)||!integer(p.maxModelCalls,1)
      ||!integer(p.timeoutMs,1,60000))throw new Error('invalid_protocol');
    for(const f of [p.baseline,p.candidate])if(!f||!validId(f.id)||!/^[a-f0-9]{64}$/.test(f.artifactSha256)||typeof f.create!=='function')throw new Error('invalid_factory');
    if(p.baseline.id===p.candidate.id)throw new Error('identical_agents');
    for(const families of [p.developmentFamilies,p.selectionFamilies])if(!Array.isArray(families)||families.length>1000||!families.every(validId)||new Set(families).size!==families.length)throw new Error('invalid_families');
    const known=new Set([...p.developmentFamilies,...p.selectionFamilies]);
    const ids=new Set<string>(),familySplits=new Map<string,string>();let totalBytes=0;
    for(const t of p.tasks){
      if(!t||!validId(t.id)||!validId(t.family)||ids.has(t.id)||!integer(t.seed,0,0xffffffff)
        ||!['transfer','retention'].includes(t.split)||!Array.isArray(t.support)||t.support.length>p.supportLimit
        ||!Array.isArray(t.queries)||t.queries.length<1||t.queries.length>256)throw new Error('invalid_task');
      ids.add(t.id);
      if(t.split==='transfer'&&known.has(t.family))throw new Error('family_contamination');
      if(t.split==='retention'&&!p.developmentFamilies.includes(t.family))throw new Error('unknown_retention_family');
      if(familySplits.has(t.family)&&familySplits.get(t.family)!==t.split)throw new Error('family_split_conflict');
      familySplits.set(t.family,t.split);
      const inputs=new Set<string>();
      for(const e of [...t.support,...t.queries]){
        strictJson(e);
        if(!e||e.input===undefined||e.output===undefined)throw new Error('invalid_example');
        if(Object.keys(e).length!==2)throw new Error('invalid_example');
        totalBytes+=Buffer.byteLength(boundedJson(e,65536));if(totalBytes>16*1024*1024)throw new Error('protocol_too_large');const key=canonical(e.input);
        if(inputs.has(key))throw new Error('example_overlap');inputs.add(key);
      }
    }
    if(!p.tasks.some(t=>t.split==='retention')||!p.tasks.some(t=>t.split==='transfer'))throw new Error('missing_evaluation_split');
    // Capture all data before awaiting plugin code; retain only explicit factories.
    return {...structuredClone({...p,baseline:undefined,candidate:undefined}),
      baseline:{...p.baseline},candidate:{...p.candidate}};
  }
  private async episode(p:GeneralizationProtocol,t:TransferTask,f:AgentFactory,mode:'zero'|'support',instances:WeakSet<object>):Promise<EpisodeResult>{
    const start=performance.now(),controller=new AbortController();
    const result:EpisodeResult={taskId:t.id,family:t.family,split:t.split,agentId:f.id,mode,correct:0,total:t.queries.length,
      costMicros:0,modelCalls:0,humanInterventions:0,elapsedMs:0,error:null};
    let agent:ReturnType<AgentFactory['create']>|undefined;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('episode_timeout'));},p.timeoutMs);});
    const account=(r:Omit<AgentReply,'output'>)=>{
      if(performance.now()-start>=p.timeoutMs)throw new Error('episode_timeout');
      if(!r||![r.costMicros,r.modelCalls,r.humanInterventions].every(v=>integer(v)))throw new Error('invalid_meter');
      result.costMicros+=r.costMicros;result.modelCalls+=r.modelCalls;result.humanInterventions+=r.humanInterventions;
      if(result.costMicros>p.maxCostMicros||result.modelCalls>p.maxModelCalls)throw new Error('budget_exceeded');
      if(result.humanInterventions>0)throw new Error('human_intervention');
    };
    try{
      agent=f.create();if(!agent||typeof agent.predict!=='function'||instances.has(agent))throw new Error('invalid_agent_instance');instances.add(agent);
      if(mode==='support'&&t.support.length){
        if(!agent.learn)throw new Error('learning_unsupported');
        account(await Promise.race([Promise.resolve().then(()=>agent!.learn!(deepFreeze(structuredClone(t.support)),controller.signal)),timeout]));
      }
      for(const query of t.queries){
        if(result.costMicros>=p.maxCostMicros||result.modelCalls>=p.maxModelCalls)throw new Error('budget_exhausted');
        const reply=await Promise.race([Promise.resolve().then(()=>agent!.predict(deepFreeze(structuredClone(query.input)),controller.signal)),timeout]);
        account(reply);strictJson(reply.output);boundedJson(reply.output,65536);
        if(canonical(reply.output)===canonical(query.output))result.correct++;
      }
    }catch(error){result.error=error instanceof Error&&['episode_timeout','invalid_meter','budget_exceeded','budget_exhausted','human_intervention','learning_unsupported','invalid_agent_instance'].includes(error.message)?error.message:'agent_failed';
      // Partial success cannot authorize a candidate whose execution failed.
      result.correct=0;
    }finally{if(timer)clearTimeout(timer);controller.abort();try{agent?.close?.();}catch{result.error='close_failed';result.correct=0;}result.elapsedMs=performance.now()-start;
      if(result.elapsedMs>=p.timeoutMs){result.error='episode_timeout';result.correct=0;}}
    return result;
  }
}
