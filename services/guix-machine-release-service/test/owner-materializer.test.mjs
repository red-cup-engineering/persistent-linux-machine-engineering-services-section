import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,lstatSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {join,resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {materializeOwnerSources} from '../scripts/materialize-sources.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'lspace-owner-materializer-'));
  const servers=join(root,'servers');mkdirSync(servers);
  const commands=[];
  const environment={PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:'file',GIT_OPTIONAL_LOCKS:'0'};
  const native=(directory,args,{input,offline=false,check=true}={})=>{
    const result=spawnSync('git',['-c','core.hooksPath=/dev/null','-C',directory,...args],{cwd:root,env:{...environment,...offline?{GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:''}:{}},encoding:'utf8',input,maxBuffer:16*1024*1024});
    if(check&&result.status!==0)throw new Error(`synthetic git ${args[0]} failed: ${result.stderr}`,{cause:result.error});
    return check?result.stdout.trim():result;
  };
  let serial=0;
  const source=(repository,{files={'content/read.md':'# Synthetic admitted document\n','private/denied.md':'synthetic excluded body\n'},mounts=[]}={})=>{
    const directory=join(root,`carrier-${++serial}`);mkdirSync(directory);
    native(directory,['init','-q']);native(directory,['config','user.name','Fixture']);native(directory,['config','user.email','fixture@example.invalid']);
    for(const [path,body]of Object.entries(files)){mkdirSync(dirname(join(directory,path)),{recursive:true});writeFileSync(join(directory,path),body);}
    if(mounts.length)writeFileSync(join(directory,'.gitmodules'),mounts.map(({path,repository:owner})=>`[submodule "${path}"]\n\tpath = ${path}\n\turl = https://github.com/${owner}.git\n`).join(''));
    native(directory,['add','.']);
    for(const {path,commit}of mounts)native(directory,['update-index','--add','--cacheinfo',`160000,${commit},${path}`]);
    native(directory,['commit','-qm','synthetic committed owner source']);
    const commit=native(directory,['rev-parse','HEAD']),tree=native(directory,['rev-parse','HEAD^{tree}']);
    const server=join(servers,repository+'.git');mkdirSync(dirname(server),{recursive:true});
    native(directory,['clone','--bare','--no-hardlinks',directory,server]);
    native(server,['config','uploadpack.allowFilter','true']);native(server,['config','uploadpack.allowAnySHA1InWant','true']);
    const blobs=native(directory,['ls-tree','-r',commit]).split('\n').filter(line=>line.includes(' blob ')).map(line=>{const [head,path]=line.split('\t');return {path,oid:head.split(' ')[2]};});
    return {repository,directory,commit,tree,blobs,server};
  };
  const run=(program,args,input)=>{
    assert.equal(program,'git');commands.push({program,args:[...args]});
    const result=spawnSync(program,['-c','core.hooksPath=/dev/null','-c',`url.${pathToFileURL(servers).href}/.insteadOf=https://github.com/`,...args],{cwd:root,env:environment,encoding:'utf8',input,maxBuffer:16*1024*1024});
    if(result.status!==0)throw new Error(`synthetic acquisition ${args.join(' ')} failed: ${result.stderr}`,{cause:result.error});
    assert.doesNotMatch(result.stderr,/filtering not recognized|filter.*ignored/iu);
    return result.stdout.trim();
  };
  return {root,source,native,run,commands,close:()=>rmSync(root,{recursive:true,force:true})};
}
function inventory(directory){
  const result=[];
  function walk(path){for(const name of readdirSync(path).sort()){const file=join(path,name),stat=lstatSync(file);assert.ok(!stat.isSymbolicLink());if(stat.isDirectory())walk(file);else result.push({path:relative(directory,file),mode:stat.mode,sha256:hash(readFileSync(file))});}}
  walk(directory);return result;
}
function checkReceived(f,result,sources){
  assert.equal(result.graph.kind,'guix.resolved-source-graph.v1');assert.equal(result.graph.machine,null);
  assert.equal(result.graphSha256,hash(JSON.stringify(result.graph)));
  for(const source of sources){
    const received=result.repositories.find(row=>row.repository===source.repository);assert.ok(received);
    assert.notEqual(received.directory,source.directory);assert.equal(received.commit,source.commit);assert.equal(received.tree,source.tree);
    assert.deepEqual(readdirSync(received.directory),['.git']);
    assert.equal(f.native(received.directory,['config','--get','remote.origin.partialclonefilter']),'blob:none');
    assert.equal(f.native(received.directory,['config','--get','remote.origin.promisor']),'true');
    assert.equal(f.native(received.directory,['config','--get','remote.origin.url']),`https://github.com/${source.repository}.git`);
    const physical=f.native(received.directory,['cat-file','--batch-all-objects','--batch-check=%(objectname) %(objecttype)'],{offline:true}).split('\n').filter(row=>row.endsWith(' blob')).map(row=>row.split(' ')[0]).sort();
    const metadata=source.blobs.filter(row=>row.path==='.gitmodules').map(row=>row.oid).sort();
    assert.deepEqual(physical,metadata,`only committed mount metadata blobs received for ${source.repository}`);
    for(const row of source.blobs.filter(row=>row.path!=='.gitmodules'))assert.notEqual(f.native(received.directory,['cat-file','-e',row.oid],{offline:true,check:false}).status,0,`${row.path} must not be hydrated`);
  }
  assert.ok(!f.commands.some(({args})=>args.includes('checkout')||args.includes('sparse-checkout')||args.includes('--batch-check')));
  for(const {args}of f.commands.filter(({args})=>args.includes('fetch')))assert.ok(args.includes('--filter=blob:none'));
}

test('receives root and no-package descendant closure as metadata-only isolated stores',()=>{
  const f=fixture();try{
    const leaf=f.source('lenticule-science/no-package-leaf');
    const child=f.source('lenticule-science/no-package-child',{mounts:[{...leaf,path:'services/leaf'}]});
    const root=f.source('lenticule-science/science-services-section',{mounts:[{...child,path:'services/child'}]});
    const before=inventory(root.directory),work=join(f.root,'work');
    const result=materializeOwnerSources(root,work,{run:f.run});
    checkReceived(f,result,[root,child,leaf]);assert.deepEqual(inventory(root.directory),before);
    assert.deepEqual(result.repositories.find(row=>row.repository===root.repository).paths,['.']);
    assert.deepEqual(result.repositories.find(row=>row.repository===leaf.repository).paths,['services/child/services/leaf']);
    assert.deepEqual(result.entries,[]);assert.deepEqual(result.buildEntries,[]);assert.deepEqual(result.receivingPackages,[]);
  }finally{f.close();}
});
test('controller-named root receives no special checkout',()=>{
  const f=fixture();try{const root=f.source('red-cup-engineering/guix-machine-release-service');checkReceived(f,materializeOwnerSources(root,join(f.root,'work'),{run:f.run}),[root]);}finally{f.close();}
});
test('refuses wrong carrier HEAD before staging or acquisition',()=>{
  const f=fixture();try{const root=f.source('lenticule-science/root'),before=inventory(root.directory),work=join(f.root,'work');assert.throws(()=>materializeOwnerSources({...root,commit:'f'.repeat(40)},work,{run:f.run}),/carrier differs/);assert.ok(!existsSync(work));assert.ok(!f.commands.some(row=>row.args.includes('fetch')));assert.deepEqual(inventory(root.directory),before);}finally{f.close();}
});
test('refuses existing, overlapping and redirected staging without changing held files',()=>{
  const f=fixture();try{const root=f.source('lenticule-science/root'),held=join(f.root,'held');mkdirSync(held);writeFileSync(join(held,'keep'),'unchanged');const before=inventory(held);assert.throws(()=>materializeOwnerSources(root,held,{run:f.run}),/fresh canonical/);assert.deepEqual(inventory(held),before);assert.throws(()=>materializeOwnerSources(root,join(root.directory,'work'),{run:f.run}),/outside/);const alias=join(f.root,'alias');symlinkSync(held,alias);assert.throws(()=>materializeOwnerSources(root,join(alias,'work'),{run:f.run}),/fresh canonical/);assert.ok(!existsSync(join(held,'work')));}finally{f.close();}
});
test('missing child fails visibly and removes only owned partial staging',()=>{
  const f=fixture();try{const root=f.source('lenticule-science/root',{mounts:[{repository:'lenticule-science/missing',commit:'e'.repeat(40),path:'services/missing'}]}),before=inventory(root.directory),work=join(f.root,'work');const sibling=join(f.root,'keep');writeFileSync(sibling,'unchanged');assert.throws(()=>materializeOwnerSources(root,work,{run:f.run}),/synthetic acquisition/);assert.ok(!existsSync(work));assert.equal(readFileSync(sibling,'utf8'),'unchanged');assert.deepEqual(inventory(root.directory),before);}finally{f.close();}
});
test('conflicting revisions of one owner are rejected and partial staging removed',()=>{
  const f=fixture();try{const child=f.source('lenticule-science/child'),other=f.source('lenticule-science/other',{mounts:[{repository:child.repository,commit:'d'.repeat(40),path:'services/conflicting'}]}),root=f.source('lenticule-science/root',{mounts:[{...child,path:'services/child'},{...other,path:'services/other'}]}),work=join(f.root,'work');assert.throws(()=>materializeOwnerSources(root,work,{run:f.run}),/one repository has one commit/);assert.ok(!existsSync(work));}finally{f.close();}
});
test('carrier HEAD drift after acquisition is rejected with owned cleanup',()=>{
  const f=fixture();try{const root=f.source('lenticule-science/root'),before=inventory(root.directory),work=join(f.root,'work');let reads=0;const run=(program,args,input)=>{const answer=f.run(program,args,input);if(args[1]===root.directory&&args[2]==='rev-parse'&&args[3]==='HEAD'&&++reads===2)return 'c'.repeat(40);return answer;};assert.throws(()=>materializeOwnerSources(root,work,{run}),/differs from its authenticated carrier/);assert.ok(!existsSync(work));assert.deepEqual(inventory(root.directory),before);}finally{f.close();}
});
test('tree mismatch is rejected and fresh staging is removed',()=>{
  const f=fixture();try{const root=f.source('lenticule-science/root'),work=join(f.root,'work');const run=(program,args,input)=>{const answer=f.run(program,args,input);return args[1]===root.directory&&args[2]==='rev-parse'&&args[3]===`${root.commit}^{tree}`?'b'.repeat(40):answer;};assert.throws(()=>materializeOwnerSources(root,work,{run}),/differs from its authenticated carrier/);assert.ok(!existsSync(work));}finally{f.close();}
});
test('undeclared or unsupported direct mount fails before staging and acquisition',()=>{
  const f=fixture();try{const root=f.source('lenticule-science/root',{mounts:[{repository:'invalid owner/child',commit:'a'.repeat(40),path:'services/child'}]}),work=join(f.root,'work'),before=inventory(root.directory);assert.throws(()=>materializeOwnerSources(root,work,{run:f.run}),/unsupported URL or path/);assert.ok(!existsSync(work));assert.ok(!f.commands.some(row=>row.args.includes('fetch')));assert.deepEqual(inventory(root.directory),before);}finally{f.close();}
});
