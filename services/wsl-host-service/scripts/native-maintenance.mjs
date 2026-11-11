#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { prepareNativeCompactionFiles,launchNativeCompactionFile,readNativeCompactionOutcome,transferNativeCompactionOutcome,observeNativeCompactionCustody,prepareNativeCompactionCustody,observeNativeCompactionPrerequisites } from '../src/native-maintenance-caller.mjs';
const [action,...args]=process.argv.slice(2);const option=name=>{const values=args.filter(x=>x.startsWith('--'+name+'='));if(values.length!==1)throw Error('one --'+name+'= path required');return values[0].slice(name.length+3)};
const parameters=readFileSync(option('parameters'),'utf8'),admission=['observe-prerequisites','observe-custody','prepare-custody'].includes(action)?null:readFileSync(option('admission'),'utf8');
let result;
if(action==='observe-prerequisites')result=observeNativeCompactionPrerequisites(parameters);
else if(action==='observe-custody')result=observeNativeCompactionCustody(parameters);
else if(action==='prepare-custody')result=prepareNativeCompactionCustody(parameters,readFileSync(option('receiving'),'utf8'));
else if(action==='prepare')result=prepareNativeCompactionFiles(parameters,admission,JSON.parse(readFileSync(option('resources'),'utf8')));
else if(action==='launch')result=launchNativeCompactionFile(parameters,admission,readFileSync(option('receiving'),'utf8'));
else if(action==='read')result=readNativeCompactionOutcome(parameters,admission);
else if(action==='transfer'){const {bundle}=readNativeCompactionOutcome(parameters,admission);result=transferNativeCompactionOutcome(parameters,admission,bundle,readFileSync(option('reentry'),'utf8'),JSON.parse(readFileSync(option('resources'),'utf8')))}
else throw Error('Select observe-prerequisites, observe-custody, prepare-custody, prepare, launch, read or separately admitted transfer');
console.log(JSON.stringify(result));
