// This file is copied beside exactly one reviewed, standalone ESM plugin.
import {createInterface} from 'node:readline';
const [, ,mode,rawLimit]=process.argv;
const limit=Number(rawLimit);
const write=process.stdout.write.bind(process.stdout);
const exit=process.exit.bind(process);
const stringify=JSON.stringify;
function send(value){
  const encoded=stringify(value)+'\n';
  if(Buffer.byteLength(encoded)>limit){
    write(stringify({id:value.id,ok:false,error:'output_limit'})+'\n');exit(1);
  }
  write(encoded);
}
function json(value,depth=0){
  if(depth>32)throw new Error('invalid_json');
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'&&Number.isFinite(value))return;
  if(!value||typeof value!=='object')throw new Error('invalid_json');
  const prototype=Object.getPrototypeOf(value);
  if(Array.isArray(value)){
    const keys=Object.keys(value);
    if(prototype!==Array.prototype||keys.length!==value.length||keys.some((key,index)=>key!==String(index)))throw new Error('invalid_json');
  }else if(prototype!==Object.prototype&&prototype!==null)throw new Error('invalid_json');
  if(Object.getOwnPropertySymbols(value).length)throw new Error('invalid_json');
  for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))){
    if(Array.isArray(value)&&key==='length')continue;
    if(!('value' in descriptor)||!descriptor.enumerable)throw new Error('invalid_json');
    json(descriptor.value,depth+1);
  }
}
try{
  const plugin=await import('./agent.mjs');
  if(typeof plugin.createAgent!=='function')throw new Error('invalid_agent');
  const agent=await plugin.createAgent(mode);
  if(!agent||['learn','predict','snapshot','restore'].some(method=>typeof agent[method]!=='function'))throw new Error('invalid_agent');
  send({type:'ready'});
  const input=createInterface({input:process.stdin,crlfDelay:Infinity});
  let previousId=0;
  for await(const line of input){
    let request;
    try{
      if(Buffer.byteLength(line)+1>limit)throw new Error('input_limit');
      request=JSON.parse(line);
      if(!request||Object.keys(request).length!==3||!Number.isSafeInteger(request.id)||request.id<=previousId||
        !['learn','predict','snapshot','restore'].includes(request.method)||!Object.hasOwn(request,'payload'))throw new Error('invalid_request');
      previousId=request.id;
      const result=await agent[request.method](request.payload);
      json(result);
      send({id:request.id,ok:true,result});
    }catch{send({id:request?.id??0,ok:false,error:'agent_error'});exit(1);}
  }
}catch{exit(1);}
