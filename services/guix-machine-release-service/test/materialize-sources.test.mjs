import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {materializeSources} from '../scripts/materialize-sources.mjs';

const env={...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@t',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@t'};
const git=(cwd,...args)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',env:{...env,...gitRemotes}});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
let gitRemotes={};

// A repository named `name`, at `root/name`, holding `files` and mounting each of `mounts` ({repository, commit, path}).
function repository(root,name,{files={},mounts=[]}={}){
  const path=join(root,Buffer.from(name).toString('hex'));mkdirSync(path,{recursive:true});
  git(path,'init','-q','-b','main');git(path,'config','uploadpack.allowAnySHA1InWant','true');git(path,'config','uploadpack.allowFilter','true');
  for(const [file,text] of Object.entries(files)){mkdirSync(join(path,file,'..'),{recursive:true});writeFileSync(join(path,file),text);}
  if(mounts.length)writeFileSync(join(path,'.gitmodules'),mounts.map(m=>`[submodule "${m.path}"]\n\tpath = ${m.path}\n\turl = https://github.com/${m.repository}.git\n`).join(''));
  git(path,'add','-A');
  for(const m of mounts)git(path,'update-index','--add','--cacheinfo',`160000,${m.commit},${m.path}`);
  git(path,'commit','-q','--allow-empty','-m',name);
  return {path,commit:git(path,'rev-parse','HEAD')};
}
// Point each GitHub URL at its local fixture, as git's own url.insteadOf does: cloning and fetching stay real Git.
function remotes(map){
  const entries=Object.entries(map);
  gitRemotes={GIT_CONFIG_COUNT:String(entries.length+1),GIT_CONFIG_KEY_0:'protocol.file.allow',GIT_CONFIG_VALUE_0:'always'};
  entries.forEach(([repository,path],i)=>{gitRemotes[`GIT_CONFIG_KEY_${i+1}`]=`url.file://${path}.insteadOf`;gitRemotes[`GIT_CONFIG_VALUE_${i+1}`]=`https://github.com/${repository}.git`;});
  Object.assign(process.env,gitRemotes);
}
function cleanup(){for(const key of Object.keys(gitRemotes))delete process.env[key];gitRemotes={};}

test('a machine\'s sources are its repository in place and every repository mounted, recursively, at its gitlink',t=>{
  const root=mkdtempSync(join(tmpdir(),'materialize-sources-'));t.after(()=>{cleanup();rmSync(root,{recursive:true,force:true});});
  const b=repository(root,'o/b',{files:{'package.json':'{"name":"@o/b","version":"1.0.0"}'}});
  const a=repository(root,'o/a',{files:{'package.json':'{"name":"@o/a","version":"1.0.0"}'},mounts:[{repository:'o/b',commit:b.commit,path:'vendor/b'}]});
  const controller=repository(root,'red-cup-engineering/guix-machine-release-service',{files:{'package.json':'{"name":"@red-cup-engineering/guix-machine-release-service","version":"0.1.0"}'}});
  const machine=repository(root,'o/machine',{files:{'site/machine.json':JSON.stringify({repository:'o/machine',run:{entries:['@o/a']}})},
    mounts:[{repository:'o/a',commit:a.commit,path:'lib/a'},{repository:'red-cup-engineering/guix-machine-release-service',commit:controller.commit,path:'lib/controller'}]});
  remotes({'o/a':a.path,'o/b':b.path,'red-cup-engineering/guix-machine-release-service':controller.path});
  const work=join(root,'work');
  const sources=materializeSources(join(machine.path,'site'),work);
  assert.deepEqual(sources.repositories.map(s=>[s.repository,s.commit,s.path]),[
    ['o/machine',machine.commit,'.'],['o/a',a.commit,'lib/a'],
    ['red-cup-engineering/guix-machine-release-service',controller.commit,'lib/controller'],['o/b',b.commit,'lib/a/vendor/b']]);
  assert.equal(sources.repositories[0].directory,machine.path);
  for(const s of sources.repositories.slice(1))assert.equal(git(s.directory,'rev-parse','HEAD'),s.commit);
  // Only the controller has a working tree; every other mounted source is read from its blobs.
  assert.deepEqual(readdirSync(sources.repositories[1].directory).filter(name=>name!=='.git'),[]);
  assert.ok(existsSync(join(sources.repositories[2].directory,'package.json')));
  assert.deepEqual(sources.entries,['@o/a']);
});

test('one repository mounted at two commits is refused',t=>{
  const root=mkdtempSync(join(tmpdir(),'materialize-sources-'));t.after(()=>{cleanup();rmSync(root,{recursive:true,force:true});});
  const b1=repository(root,'o/b',{files:{'x':'1'}});
  writeFileSync(join(b1.path,'x'),'2');git(b1.path,'commit','-qam','second');const b2=git(b1.path,'rev-parse','HEAD');
  const a=repository(root,'o/a',{mounts:[{repository:'o/b',commit:b1.commit,path:'b'}]});
  const machine=repository(root,'o/machine',{files:{'machine.json':JSON.stringify({repository:'o/machine',run:{entries:['@o/a']}})},
    mounts:[{repository:'o/a',commit:a.commit,path:'a'},{repository:'o/b',commit:b2,path:'b'}]});
  remotes({'o/a':a.path,'o/b':b1.path});
  assert.throws(()=>materializeSources(machine.path,join(root,'work')),/o\/b is mounted at .* and at .*one repository has one commit in a release/u);
});

test('different owners with formerly colliding source directory names retain independent exact commits',t=>{
  const root=mkdtempSync(join(tmpdir(),'materialize-distinct-'));t.after(()=>{cleanup();rmSync(root,{recursive:true,force:true});});
  const a=repository(root,'o/a_b',{files:{'a':'owner a'}}),b=repository(root,'o_a/b',{files:{'b':'owner b'}});
  const machine=repository(root,'o/machine',{files:{'machine.json':JSON.stringify({repository:'o/machine',run:{entries:['@o/a']}})},
    mounts:[{repository:'o/a_b',commit:a.commit,path:'a'},{repository:'o_a/b',commit:b.commit,path:'b'}]});
  remotes({'o/a_b':a.path,'o_a/b':b.path});
  const sources=materializeSources(machine.path,join(root,'work')).repositories;
  assert.notEqual(sources[1].directory,sources[2].directory);
  assert.equal(git(sources[1].directory,'rev-parse','HEAD'),a.commit);
  assert.equal(git(sources[2].directory,'rev-parse','HEAD'),b.commit);
});

test('an existing source from another owner is refused before fetch or working-tree removal',t=>{
  const root=mkdtempSync(join(tmpdir(),'materialize-origin-'));t.after(()=>{cleanup();rmSync(root,{recursive:true,force:true});});
  const a=repository(root,'o/a'),b=repository(root,'o/b',{files:{'preserve':'unique work'}});
  const machine=repository(root,'o/machine',{files:{'machine.json':JSON.stringify({repository:'o/machine',run:{entries:['@o/a']}})},
    mounts:[{repository:'o/a',commit:a.commit,path:'a'}]});
  remotes({'o/a':a.path,'o/b':b.path});
  const work=join(root,'work'),destination=join(work,'sources',encodeURIComponent('o/a'));
  mkdirSync(dirname(destination),{recursive:true});git(root,'clone','-q','https://github.com/o/b.git',destination);
  const calls=[],run=(program,args)=>{
    calls.push(args);const r=spawnSync(program,args,{encoding:'utf8',env:{...env,...gitRemotes}});
    assert.equal(r.status,0,r.stderr);return r.stdout.trim();
  };
  assert.throws(()=>materializeSources(machine.path,work,{run}),/source origin differs/u);
  assert.equal(calls.some(args=>args.includes('fetch')||args.includes('clean')||args.includes('read-tree')),false);
  assert.ok(existsSync(join(destination,'preserve')));
  assert.equal(git(destination,'rev-parse','HEAD'),b.commit);
});

test('a reported mounted-source cycle is refused instead of treating deduplication as complete receiving',t=>{
  const root=mkdtempSync(join(tmpdir(),'materialize-cycle-'));t.after(()=>{cleanup();rmSync(root,{recursive:true,force:true});});
  const a=repository(root,'o/a');
  const machine=repository(root,'o/machine',{files:{'machine.json':JSON.stringify({repository:'o/machine',run:{entries:['@o/a']}})},
    mounts:[{repository:'o/a',commit:a.commit,path:'a'}]});
  remotes({'o/a':a.path});
  // The explicit fixture link reader reports a cycle; this does not claim such a
  // same-hash cycle was produced by real immutable Git objects.
  const link=()=>new Map([['o/machine',{commit:machine.commit,path:'parent',ref:'main'}]]);
  assert.throws(()=>materializeSources(machine.path,join(root,'work'),{link}),/mounted source cycle: o\/machine/u);
});

test('a linked source output cannot mutate another working tree or its index',t=>{
  const root=mkdtempSync(join(tmpdir(),'materialize-linked-'));t.after(()=>{cleanup();rmSync(root,{recursive:true,force:true});});
  const a=repository(root,'o/a',{files:{'preserve':'original source'}});
  git(a.path,'remote','add','origin','https://github.com/o/a.git');
  const machine=repository(root,'o/machine',{files:{'machine.json':JSON.stringify({repository:'o/machine',run:{entries:['@o/a']}})},
    mounts:[{repository:'o/a',commit:a.commit,path:'a'}]});
  const work=join(root,'work'),destination=join(work,'sources',encodeURIComponent('o/a'));
  mkdirSync(destination,{recursive:true});symlinkSync(join(a.path,'.git'),join(destination,'.git'));
  const tree=git(a.path,'write-tree');
  assert.throws(()=>materializeSources(machine.path,work),/source output shares foreign Git custody/u);
  assert.equal(git(a.path,'write-tree'),tree);
  assert.ok(existsSync(join(a.path,'preserve')));
});

test('exact source transfer omits other branches, history and unused blobs',t=>{
  const root=mkdtempSync(join(tmpdir(),'materialize-exact-'));t.after(()=>{cleanup();rmSync(root,{recursive:true,force:true});});
  const a=repository(root,'o/a',{files:{'old':'historical bytes'}}),old=a.commit;
  writeFileSync(join(a.path,'current'),'exact source');git(a.path,'add','current');git(a.path,'commit','-qm','selected revision');
  const wanted=git(a.path,'rev-parse','HEAD'),currentBlob=git(a.path,'rev-parse',`${wanted}:current`);
  git(a.path,'checkout','-qb','unrelated');writeFileSync(join(a.path,'unrelated'),'unused branch');git(a.path,'add','unrelated');git(a.path,'commit','-qm','other work');
  const unrelated=git(a.path,'rev-parse','HEAD');
  const machine=repository(root,'o/machine',{files:{'machine.json':JSON.stringify({repository:'o/machine',run:{entries:['@o/a']}})},
    mounts:[{repository:'o/a',commit:wanted,path:'a'}]});
  remotes({'o/a':a.path});
  const source=materializeSources(machine.path,join(root,'work')).repositories[1];
  assert.equal(git(source.directory,'rev-parse','HEAD'),wanted);
  assert.equal(git(source.directory,'rev-list','--count','HEAD'),'1');
  for(const object of [old,unrelated,currentBlob]){
    const r=spawnSync('git',['-C',source.directory,'cat-file','-e',object],{env:{...env,...gitRemotes,GIT_NO_LAZY_FETCH:'1'}});
    assert.notEqual(r.status,0,`unrequested object was transferred: ${object}`);
  }
  assert.equal(git(source.directory,'show',`${wanted}:current`),'exact source','a requested blob remains receivable through the declared promisor');
});

test('a received exact graph replays without fetching its earlier owners again',t=>{
  const root=mkdtempSync(join(tmpdir(),'materialize-replay-'));t.after(()=>{cleanup();rmSync(root,{recursive:true,force:true});});
  const b=repository(root,'o/b',{files:{'package.json':'{"name":"@o/b","version":"1.0.0"}'}});
  const a=repository(root,'o/a',{mounts:[{repository:'o/b',commit:b.commit,path:'b'}]});
  const machine=repository(root,'o/machine',{files:{'machine.json':JSON.stringify({repository:'o/machine',run:{entries:['@o/a']}})},mounts:[{repository:'o/a',commit:a.commit,path:'a'}]});
  remotes({'o/a':a.path,'o/b':b.path});
  const work=join(root,'work'),first=materializeSources(machine.path,work);
  const run=(program,args)=>{
    assert.equal(args.includes('fetch'),false,'retained immutable owners must not require another network fetch');
    const r=spawnSync(program,args,{encoding:'utf8',env:{...env,...gitRemotes}});
    assert.equal(r.status,0,r.stderr);return r.stdout.trim();
  };
  assert.deepEqual(materializeSources(machine.path,work,{run}),first);
});
