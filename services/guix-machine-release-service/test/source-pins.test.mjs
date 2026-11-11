import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gitlinks,machineSources as sourcesOf,directMountsOnly,machineSourceIdentity} from '../scripts/source-pins.mjs';
// These fixtures mount repositories that do not exist; what a mounted repository mounts is read by the test.
const machineSources=(snapshot,ref='HEAD',mounts=directMountsOnly)=>sourcesOf(snapshot,ref,{mounts});

const A='a'.repeat(40),B='b'.repeat(40);
const git=(cwd,...args)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@t',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@t'}});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
const MACHINE={repository:'o/machine',run:{entries:['@o/app'],buildEntries:['@o/build']}};

// A machine repository: its definition under `machine`, and the repositories it mounts by gitlink.
function superrepo(modules,{machine='site',definition=MACHINE}={}){
  const root=mkdtempSync(join(tmpdir(),'source-pins-'));
  git(root,'init','-q','-b','main');
  writeFileSync(join(root,'.gitmodules'),modules.map(({path,url,branch='main'})=>`[submodule "${path}"]\n\tpath = ${path}\n\turl = ${url}\n\tbranch = ${branch}\n`).join(''));
  for(const {path,commit} of modules)git(root,'update-index','--add','--cacheinfo',`160000,${commit},${path}`);
  mkdirSync(join(root,machine));
  writeFileSync(join(root,machine,'machine.json'),JSON.stringify(definition));
  git(root,'add','.gitmodules',machine);git(root,'commit','-q','-m','fixture');
  return root;
}

test('the gitlinks of a superrepo are read by repository, through its .gitmodules URLs, with their branch',()=>{
  const root=superrepo([{path:'lib/a',url:'https://github.com/o/a.git',commit:A},{path:'lib/b',url:'https://github.com/o/b',commit:B,branch:'release/x'}]);
  try{
    const links=gitlinks(join(root,'site'));
    assert.deepEqual([...links],[['o/a',{path:'lib/a',commit:A,ref:'main'}],['o/b',{path:'lib/b',commit:B,ref:'release/x'}]]);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('a machine releases from its own repository at the commit and every repository it mounts, and runs its definition\'s entries',()=>{
  const root=superrepo([{path:'lib/a',url:'https://github.com/o/a.git',commit:A}]);
  try{
    const commit=git(root,'rev-parse','HEAD');
    assert.deepEqual(machineSources(join(root,'site')),{
      declarationOnly:true,machine:machineSourceIdentity(join(root,'site')),
      repositories:[{repository:'o/machine',commit,path:'.'},{repository:'o/a',commit:A,path:'lib/a',ref:'main'}],
      entries:['@o/app'],buildEntries:['@o/build'],receivingPackages:[]});
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('the sources are read at the commit named, not the checkout',()=>{
  const root=superrepo([{path:'lib/a',url:'https://github.com/o/a.git',commit:A}]);
  try{
    const first=git(root,'rev-parse','HEAD');
    git(root,'update-index','--cacheinfo',`160000,${B},lib/a`);git(root,'commit','-q','-m','advance');
    assert.equal(machineSources(join(root,'site'),first).repositories[1].commit,A);
    assert.equal(machineSources(join(root,'site')).repositories[1].commit,B);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('a definition with no entries, no repository, or a malformed run is refused',()=>{
  for(const [definition,pattern] of [
    [{repository:'o/machine'},/names no entries to run/u],
    [{run:{entries:['@o/app']}},/names no repository/u],
    [{repository:'o/machine',run:{entries:'@o/app'}},/run\.entries must be a list/u]]){
    const root=superrepo([],{definition});
    try{assert.throws(()=>machineSources(join(root,'site')),pattern);}finally{rmSync(root,{recursive:true,force:true});}
  }
});

test('a machine repository that mounts itself is refused',()=>{
  const root=superrepo([{path:'lib/self',url:'https://github.com/o/machine.git',commit:A}]);
  try{assert.throws(()=>machineSources(join(root,'site')),/mounts itself/u);}finally{rmSync(root,{recursive:true,force:true});}
});

test('the command prints the machine\'s sources and refuses an unreadable definition with status 1',()=>{
  const root=superrepo([]);
  const script=fileURLToPath(new URL('../scripts/source-pins.mjs',import.meta.url));
  try{
    const ok=spawnSync(process.execPath,[script,join(root,'site')],{encoding:'utf8'});
    assert.equal(ok.status,0,ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout).repositories.map(s=>s.repository),['o/machine']);
    assert.deepEqual(JSON.parse(ok.stdout).entries,['@o/app']);
    writeFileSync(join(root,'site','machine.json'),JSON.stringify({repository:'o/machine'}));
    git(root,'add','site');git(root,'commit','-q','-m','no entries');
    const bad=spawnSync(process.execPath,[script,join(root,'site')],{encoding:'utf8'});
    assert.equal(bad.status,1);
    assert.match(bad.stderr,/names no entries/u);
  }finally{rmSync(root,{recursive:true,force:true});}
});

for(const url of ['git@github.com:o/a.git','git@github.com:o/a','ssh://git@github.com/o/a.git','ssh://git@github.com/o/a']) {
  test(`SSH mount ${url} is a source like any other`,()=>{
    const root=superrepo([{path:'lib/a',url,commit:A}]);
    try{
      assert.deepEqual([...gitlinks(root)],[['o/a',{path:'lib/a',commit:A,ref:'main'}]]);
      assert.equal(machineSources(join(root,'site')).repositories[1].commit,A);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
}
test('HTTPS and SSH copies of one owner cannot evade duplicate-mount refusal',()=>{
  const root=superrepo([{path:'lib/a',url:'https://github.com/o/a.git',commit:A},{path:'lib/duplicate',url:'git@github.com:o/a.git',commit:A}]);
  try{assert.throws(()=>gitlinks(root),/mounted at two paths/u);}finally{rmSync(root,{recursive:true,force:true});}
});
test('lookalike hosts and extra URL components never identify a GitHub owner',()=>{
  for(const url of ['git@github.com.evil:o/a.git','ssh://git@github.com.evil/o/a.git','https://github.com/o/a/extra','git@github.com:o/a.git?ref=main']){
    const root=superrepo([{path:'lib/a',url,commit:A}]);
    try{assert.equal(gitlinks(root).size,0);}finally{rmSync(root,{recursive:true,force:true});}
  }
});

test('actual source closure refuses a mounted URL that cannot name its owner',()=>{
  for(const url of ['https://github.com.evil/o/a.git','https://github.com/o/a/extra']){
    const root=superrepo([{path:'lib/a',url,commit:A}]);
    try{assert.throws(()=>machineSources(join(root,'site')),/unsupported URL or path/u);}
    finally{rmSync(root,{recursive:true,force:true});}
  }
});

test('an unexplained committed gitlink cannot silently disappear from the source closure',()=>{
  const root=superrepo([{path:'lib/a',url:'https://github.com/o/a.git',commit:A}]);
  try{
    writeFileSync(join(root,'.gitmodules'),'');git(root,'add','.gitmodules');git(root,'commit','-q','-m','lost source custody');
    assert.throws(()=>machineSources(join(root,'site')),/gitlink has no declared source URL: lib\/a/u);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('a machine\'s sources include the repositories its mounted repositories mount, each once',()=>{
  const root=superrepo([{path:'lib/a',url:'https://github.com/o/a.git',commit:A},{path:'lib/b',url:'https://github.com/o/b.git',commit:B}]);
  try{
    const commit=git(root,'rev-parse','HEAD'),C='c'.repeat(40);
    const below={'o/a':new Map([['o/c',{path:'vendor/c',commit:C,ref:'main'}],['o/b',{path:'b',commit:B,ref:'main'}]]),'o/b':new Map([['o/c',{path:'c',commit:C,ref:'main'}]])};
    const read=[];
    const sources=machineSources(join(root,'site'),'HEAD',source=>{read.push(source.repository);return below[source.repository]??new Map();});
    assert.deepEqual(sources.repositories.map(s=>[s.repository,s.commit,s.path]),[
      ['o/machine',commit,'.'],['o/a',A,'lib/a'],['o/b',B,'lib/b'],['o/c',C,'lib/a/vendor/c']]);
    assert.deepEqual(read,['o/a','o/b','o/c']);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('one repository at two commits anywhere in the mounted graph is refused',()=>{
  const root=superrepo([{path:'lib/a',url:'https://github.com/o/a.git',commit:A},{path:'lib/c',url:'https://github.com/o/c.git',commit:A}]);
  try{
    assert.throws(()=>machineSources(join(root,'site'),'HEAD',source=>source.repository==='o/a'?new Map([['o/c',{path:'c',commit:B,ref:'main'}]]):new Map()),
      /o\/c is mounted at lib\/c \(a+\) and at lib\/a\/c \(b+\); one repository has one commit in a release/u);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('a mounted repository that mounts the machine repository back is a cycle',()=>{
  const root=superrepo([{path:'lib/a',url:'https://github.com/o/a.git',commit:A}]);
  try{
    const commit=git(root,'rev-parse','HEAD');
    assert.throws(()=>machineSources(join(root,'site'),'HEAD',source=>source.repository==='o/a'?new Map([['o/machine',{path:'m',commit,ref:'main'}]]):new Map()),/mounted source cycle: o\/machine/u);
  }finally{rmSync(root,{recursive:true,force:true});}
});
