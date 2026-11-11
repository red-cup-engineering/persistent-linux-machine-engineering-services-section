import {spawnSync} from 'node:child_process';
import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {isCliEntry} from './cli-entry.mjs';
export function machineDirectory(directory){
 const path=realpathSync(resolve(directory));
 const git=(...args)=>{const r=spawnSync('git',['-C',path,...args],{encoding:'utf8',maxBuffer:8*1024*1024});if(r.error||r.status!==0)throw r.error??new Error(`Machine directory Git read failed: ${r.stderr}`);return r.stdout;};
 const root=realpathSync(git('rev-parse','--show-toplevel').trim());
 const prefix=git('rev-parse','--show-prefix').trim();
 if(path!==resolve(root,prefix))throw new Error('Machine definition must be an actual repository directory');
 const revision=git('rev-parse','HEAD').trim();
 const tree=prefix?`${revision}:${prefix.slice(0,-1)}`:revision;
 return {path,root,prefix,revision,tree,git};
}
export function verifyMachineDirectory(directory){
 const scope=machineDirectory(directory);
 // A machine whose definition is its repository's root mounts the repositories it releases by gitlink: the gitlinks and
 // the .gitmodules naming them are the definition of what it mounts, not application source of its own.
 const allowed=new Set(['README.md','channels.scm','dependencies.lock.yaml','machine.json','machine.scm','release-consumer.json','.github/workflows/release.yml','.gitmodules']);
 const rows=scope.git('ls-tree','--full-tree','-r','-z',scope.tree).split('\0').filter(Boolean);
 for(const row of rows){
  const tab=row.indexOf('\t'),[mode,type,hash]=row.slice(0,tab).split(' '),name=row.slice(tab+1);
  if(mode==='160000'&&type==='commit'){
   if(scope.prefix)throw new Error(`Machine definition mounts a repository inside a larger repository: ${name}`);
   continue;
  }
  if(!allowed.has(name)&&!(/^(deployment|deployments)\/.+\.json$/u.test(name)||/^deployment\/[^/]+\.conf$/u.test(name)))throw new Error(`Machine definition contains undeclared application source: ${name}`);
  if(type!=='blob'||!['100644','100755'].includes(mode)||(name==='release-consumer.json'&&mode!=='100644'))throw new Error(`Unsupported machine definition carrier: ${name}`);
  const file=join(scope.path,name),stat=lstatSync(file);
  if(!stat.isFile()||stat.size>2*1024*1024)throw new Error(`Invalid machine definition file: ${name}`);
  const bytes=readFileSync(file),actual=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if(actual!==hash||Boolean(stat.mode&0o111)!==(mode==='100755'))throw new Error(`Machine definition differs from committed source: ${name}`);
 }
 for(const name of ['machine.scm','channels.scm'])if(!rows.some(row=>row.endsWith('\t'+name)))throw new Error(`Missing machine definition: ${name}`);
 return scope;
}
if(isCliEntry(import.meta.url)){const scope=verifyMachineDirectory(process.argv[2]);console.log(JSON.stringify({revision:scope.revision,prefix:scope.prefix}));}
