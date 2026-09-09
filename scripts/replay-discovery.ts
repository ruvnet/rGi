import {readFileSync,statSync} from 'node:fs';
import {verifyDiscoveryStudy} from '../src/discovery-evidence.ts';
import type {SignedDiscoveryStudy} from '../src/discovery-evidence.ts';
import {EVIDENCE_FORMAT,unpackEvidence,unpackRvmEvidence} from '../src/evidence-container.ts';

const [path,keyPath,...flags]=process.argv.slice(2);
if(!path||!keyPath||flags.length>1||(flags.length===1&&flags[0]!=='--rvm'))
  throw Error('usage: node scripts/replay-discovery.ts artifact.rvf trusted.public.pem [--rvm]');
if(statSync(path).size>EVIDENCE_FORMAT.maxContainerBytes||statSync(keyPath).size>16384)throw Error('replay_input_limit');
const bytes=readFileSync(path),key=readFileSync(keyPath,'utf8');
// Data only. This replay command never imports code from the evidence container.
const payload=(flags[0]==='--rvm'?unpackRvmEvidence(bytes):unpackEvidence(bytes)) as SignedDiscoveryStudy;
console.log(JSON.stringify(verifyDiscoveryStudy(payload,key),null,2));
