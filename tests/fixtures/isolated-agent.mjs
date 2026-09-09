import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
export function createAgent(mode){
  let count=0;
  return {
    async learn(value){count+=value;return {count};},
    async predict(value){
      if(value?.op==='hang')while(true){}
      if(value?.op==='wait')await new Promise(resolve=>setTimeout(resolve,50));
      if(value?.op==='flood'){process.stdout.write('x'.repeat(65536));return null;}
      if(value?.op==='stderr'){process.stderr.write('x'.repeat(65536));return null;}
      if(value?.op==='wrong-id'){process.stdout.write('{"id":999,"ok":true,"result":null}\n');return null;}
      if(value?.op==='invalid-output')return {number:NaN};
      if(value?.op==='oversized-output')return 'x'.repeat(65536);
      if(value?.op==='context')return {mode,cwd:process.cwd(),env:{...process.env},pid:process.pid};
      if(value?.op==='read'){
        try{return {data:readFileSync(value.path,'utf8')};}catch(error){return {code:error.code};}
      }
      if(value?.op==='write'){
        try{writeFileSync(value.path,'modified');return {written:true};}catch(error){return {code:error.code};}
      }
      if(value?.op==='spawn'){
        try{spawnSync(process.execPath,['-e','process.exit(0)']);return {spawned:true};}catch(error){return {code:error.code};}
      }
      return {count};
    },
    async snapshot(){return {count};},
    async restore(snapshot){
      if(!snapshot||!Number.isSafeInteger(snapshot.count)||snapshot.count<0)throw new Error('invalid_snapshot');
      count=snapshot.count;return {restored:true};
    },
  };
}
