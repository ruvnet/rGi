import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,writeFileSync} from 'node:fs';
import {GeneralizationHarness} from '../src/generalization.ts';
import {baselineFactory,candidateFactory,makeGeneralizationTasks} from '../src/generalization-fixtures.ts';

// Public mechanics fixture only. Real audits must use independently sealed data
// and a durable database that is preserved between generations.
const db=new DatabaseSync(':memory:');
try{
  const report=await new GeneralizationHarness(db).run({id:'known-prior-protocol-v2',
    developmentFamilies:['affine-integer'],selectionFamilies:[],tasks:makeGeneralizationTasks(),
    baseline:baselineFactory,candidate:candidateFactory,supportLimit:8,maxCostMicros:32,maxModelCalls:32,timeoutMs:1000});
  mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/generalization.json',JSON.stringify({...report,
    demonstrationOnly:true,generatedAt:new Date().toISOString(),
    fixtureLimitations:['All program families are present in both agents priors; transfer labels reflect declared development splits only.',
      'Support is selected by an oracle knowing the finite program library; this does not measure autonomous exploration.',
      'Program variants repeat; cases are not independent samples for a significance test.',
      'Meters count synthetic operations, not actual provider money or neural inference.',
      'In-memory audit ledger permits reproducible public fixture runs, never sealed evaluation.']},null,2)+'\n');
  console.log(JSON.stringify({valid:report.valid,retentionPassed:report.retentionPassed,transferImproved:report.transferImproved,summary:report.summary},null,2));
  if(!report.valid||!report.retentionPassed)process.exitCode=1;
}finally{db.close();}
