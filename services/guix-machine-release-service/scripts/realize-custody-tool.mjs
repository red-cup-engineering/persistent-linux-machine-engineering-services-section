#!/usr/bin/env node
// Fabricate a branch-only receiving tool from authenticated original Git bytes.
// This is a controller input, never selected runtime software or a legacy reader.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const names=['convert-settlement.mjs','conversion-main-world.mjs','conversion-buckets.mjs'];
const git=(root,args)=>{const result=spawnSync('git',['-C',root,...args],{maxBuffer:1024*1024,env:{PATH:process.env.PATH,LANG:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'}});assert.equal(result.status,0,'exact tool source object is unavailable');return result.stdout;};
export function verifyCustodyTool(directory){
 const root=fs.realpathSync(directory),receipt=JSON.parse(fs.readFileSync(path.join(root,'source.json'),'utf8'));
 assert.equal(receipt.type,'OneTimeCustodyToolSource');assert.equal(receipt.repository,'red-cup-engineering/computer-data-engineering-services-section');assert.ok(/^[a-f0-9]{40}$/u.test(receipt.commit)&&/^[a-f0-9]{40}$/u.test(receipt.tree));assert.equal(receipt.files.length,names.length);
 for(const name of names){const entries=receipt.files.filter(file=>file.path==='scripts/'+name);assert.equal(entries.length,1);const entry=entries[0],file=path.join(root,entry.path);assert.ok(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink());assert.equal(sha(fs.readFileSync(file)),entry.sha256);assert.equal(Boolean(fs.statSync(file).mode&0o111),entry.executable);}
 return {type:receipt.type,repository:receipt.repository,commit:receipt.commit,receiptSha256:sha(fs.readFileSync(path.join(root,'source.json'),'utf8'))};
}
export function realizeCustodyTool({source,repository,commit,service,output}){
 assert.equal(repository,'red-cup-engineering/computer-data-engineering-services-section');assert.ok(/^[a-f0-9]{40}$/u.test(commit));
 const root=fs.realpathSync(source);assert.equal(git(root,['rev-parse','--show-toplevel']).toString().trim(),root);
 const origin=git(root,['remote','get-url','origin']).toString().trim().replace(/^https:\/\/github.com\//u,'').replace(/^git@github.com:/u,'').replace(/\.git$/u,'');assert.equal(origin,repository);
 assert.equal(git(root,['rev-parse',commit+'^{commit}']).toString().trim(),commit);
 assert.ok(typeof service==='string'&&!path.isAbsolute(service)&&!service.split('/').includes('..'));
 assert.ok(!fs.existsSync(output));fs.mkdirSync(output,{mode:0o700});fs.mkdirSync(path.join(output,'scripts'),{mode:0o700});
 const receipt={type:'OneTimeCustodyToolSource',repository,commit,tree:git(root,['rev-parse',commit+'^{tree}']).toString().trim(),files:[]};
 for(const name of names){const originalPath=path.posix.join(service,'scripts',name),bytes=git(root,['show',commit+':'+originalPath]),destination='scripts/'+name;
  const treeEntry=git(root,['ls-tree',commit,'--',originalPath]).toString().split('\t')[0].split(' ');assert.ok(['100644','100755'].includes(treeEntry[0])&&treeEntry[1]==='blob');const executable=treeEntry[0]==='100755';
  fs.writeFileSync(path.join(output,destination),bytes,{flag:'wx',mode:executable?0o700:0o600});receipt.files.push({path:destination,originalPath,executable,blob:git(root,['rev-parse',commit+':'+originalPath]).toString().trim(),sha256:sha(bytes)});}
 fs.writeFileSync(path.join(output,'source.json'),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});return verifyCustodyTool(output);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const [mode,...values]=process.argv.slice(2);const result=mode==='verify'?verifyCustodyTool(values[0]):mode==='realize'?realizeCustodyTool({source:values[0],repository:values[1],commit:values[2],service:values[3],output:values[4]}):assert.fail('realize or verify exact source required');console.log(JSON.stringify(result));}
 catch{console.error(JSON.stringify({type:'OneTimeCustodyToolSource',qualified:false}));process.exitCode=1;}
}
