import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdtemp,open,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {IsolatedOptions,IsolatedSession} from './mission-contracts.ts';

const MODULE_LIMIT=1_048_576;
const methods=new Set(['learn','predict','snapshot','restore']);

/** Accept data only: serialization must not silently erase invalid values. */
function checkJson(value:unknown,depth=0):void{
  if(depth>32)throw new Error('isolated_invalid_json');
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'&&Number.isFinite(value))return;
  if(!value||typeof value!=='object')throw new Error('isolated_invalid_json');
  const prototype=Object.getPrototypeOf(value);
  if(Array.isArray(value)){
    const keys=Object.keys(value);
    if(prototype!==Array.prototype||keys.length!==value.length||keys.some((key,index)=>key!==String(index)))
      throw new Error('isolated_invalid_json');
  }else if(prototype!==Object.prototype&&prototype!==null)throw new Error('isolated_invalid_json');
  if(Object.getOwnPropertySymbols(value).length)throw new Error('isolated_invalid_json');
  for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))){
    if(Array.isArray(value)&&key==='length')continue;
    if(!('value' in descriptor)||!descriptor.enumerable)throw new Error('isolated_invalid_json');
    checkJson(descriptor.value,depth+1);
  }
}

/** Process and file isolation for reviewed plugins. This is not a network or OS sandbox. */
export async function createIsolatedSession(options:IsolatedOptions):Promise<IsolatedSession>{
  if(!options||typeof options.modulePath!=='string'||!['baseline','reset','retained'].includes(options.mode)||
    !Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>300_000||
    !Number.isSafeInteger(options.maxMessageBytes)||options.maxMessageBytes<256||options.maxMessageBytes>MODULE_LIMIT||
    (options.artifactSha256!==undefined&&!/^[a-f0-9]{64}$/.test(options.artifactSha256)))
    throw new Error('isolated_invalid_options');
  const modulePath=await realpath(options.modulePath);
  const handle=await open(modulePath,constants.O_RDONLY|constants.O_NOFOLLOW);
  let module:Buffer;
  try{
    const info=await handle.stat();
    if(!info.isFile()||info.size>MODULE_LIMIT)throw new Error('isolated_invalid_module');
    // Read at most the cap plus one even if a file grows after stat.
    const buffer=Buffer.alloc(MODULE_LIMIT+1);
    let bytes=0;
    while(bytes<buffer.length){
      const read=await handle.read(buffer,bytes,buffer.length-bytes,bytes);
      if(read.bytesRead===0)break;
      bytes+=read.bytesRead;
    }
    if(bytes>MODULE_LIMIT)throw new Error('isolated_invalid_module');
    module=buffer.subarray(0,bytes);
  }finally{await handle.close();}
  if(options.artifactSha256!==undefined&&createHash('sha256').update(module).digest('hex')!==options.artifactSha256)
    throw new Error('isolated_artifact_mismatch');
  const directory=await mkdtemp(join(tmpdir(),'rgi-session-'));
  try{
    const worker=join(directory,'worker.mjs'),plugin=join(directory,'agent.mjs');
    await writeFile(worker,await readFile(new URL('./isolated-worker.mjs',import.meta.url)),{mode:0o400});
    await writeFile(plugin,module,{mode:0o400});
    const child=spawn(process.execPath,[
      '--permission',`--allow-fs-read=${worker}`,`--allow-fs-read=${plugin}`,
      worker,options.mode,String(options.maxMessageBytes),
    ],{cwd:directory,env:{LANG:'C',TZ:'UTC',NODE_NO_WARNINGS:'1'},stdio:['pipe','pipe','pipe']});
    let terminal:Error|null=null,ready=false,nextId=0,buffer=Buffer.alloc(0),stderrBytes=0;
    let pending:{id:number;deadline:number;resolve:(result:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}|undefined;
    let startupResolve!:()=>void,startupReject!:(error:Error)=>void;
    const startup=new Promise<void>((resolve,reject)=>{startupResolve=resolve;startupReject=reject;});
    const started=performance.now();
    const exited=new Promise<void>(resolve=>child.once('close',()=>resolve()));
    let cleanup:Promise<void>|undefined;
    const dispose=():Promise<void>=>cleanup??=(async()=>{await exited;await rm(directory,{recursive:true,force:true});})();
    const fail=(error:Error):void=>{
      if(terminal)return;
      terminal=error;clearTimeout(startupTimer);
      if(pending){clearTimeout(pending.timer);pending.reject(error);pending=undefined;}
      if(!ready)startupReject(error);
      child.kill('SIGKILL');
      void dispose().catch(()=>{});
    };
    const startupTimer=setTimeout(()=>fail(new Error('isolated_startup_timeout')),options.timeoutMs);
    child.on('error',()=>fail(new Error('isolated_process_error')));
    child.on('close',()=>fail(new Error('isolated_process_exited')));
    child.stdin.on('error',()=>fail(new Error('isolated_input_error')));
    child.stderr.on('data',(chunk:Buffer)=>{
      stderrBytes+=chunk.length;
      if(stderrBytes>options.maxMessageBytes)fail(new Error('isolated_output_limit'));
    });
    child.stdout.on('data',(chunk:Buffer)=>{
      if(terminal)return;
      if(buffer.length+chunk.length>options.maxMessageBytes){fail(new Error('isolated_output_limit'));return;}
      buffer=Buffer.concat([buffer,chunk]);
      while(buffer.includes(10)){
        const end=buffer.indexOf(10),line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);
        let value:Record<string,unknown>;
        try{
          value=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(line));
          if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();
          checkJson(value);
        }catch{fail(new Error('isolated_protocol_error'));return;}
        if(!ready){
          if(Object.keys(value).length!==1||value.type!=='ready'){fail(new Error('isolated_protocol_error'));return;}
          if(performance.now()-started>=options.timeoutMs){fail(new Error('isolated_startup_timeout'));return;}
          ready=true;clearTimeout(startupTimer);startupResolve();continue;
        }
        if(!pending||value.id!==pending.id||typeof value.ok!=='boolean'||Object.keys(value).length!==3||
          (value.ok?!Object.hasOwn(value,'result'):typeof value.error!=='string')){
          fail(new Error('isolated_protocol_error'));return;
        }
        if(performance.now()>=pending.deadline){fail(new Error('isolated_request_timeout'));return;}
        if(!value.ok){fail(new Error(value.error==='output_limit'?'isolated_output_limit':'isolated_agent_error'));return;}
        const request=pending;pending=undefined;clearTimeout(request.timer);request.resolve(value.result);
      }
    });
    try{await startup;}catch(error){await dispose();throw error;}
    return {
      async request(method,payload){
        if(terminal)throw terminal;
        if(pending)throw new Error('isolated_request_in_progress');
        if(!methods.has(method))throw new Error('isolated_invalid_method');
        checkJson(payload);
        const id=++nextId,encoded=JSON.stringify({id,method,payload})+'\n';
        if(Buffer.byteLength(encoded)>options.maxMessageBytes)throw new Error('isolated_input_limit');
        return new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>fail(new Error('isolated_request_timeout')),options.timeoutMs);
          pending={id,deadline:performance.now()+options.timeoutMs,resolve,reject,timer};
          child.stdin.write(encoded,error=>{if(error)fail(new Error('isolated_input_error'));});
        });
      },
      async close(){fail(new Error('isolated_session_closed'));await dispose();},
    };
  }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}
