import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync,existsSync,copyFileSync,readdirSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {command,prepare} from '../scripts/prepare-sources.mjs';
import {runDeclaredReceiving} from '../scripts/test-change.mjs';
import {packageReceivingChecks,packageReceivingEnvironment,manifestIdentity,sha256,gitBlobIdentity} from '../scripts/package-receiving.mjs';

const name='@example/consumer';
const testPath='test/receiving.test.mjs';
const testBytes=Buffer.from('import test from "node:test";\ntest("committed receiving case", () => {});\n');

function put(root,path,content) {
  mkdirSync(dirname(join(root,path)),{recursive:true});
  writeFileSync(join(root,path),content);
}

function fixture(t,manifest={name,version:'1.0.0',type:'module',receivingTests:[testPath]},prefix='') {
  const root=mkdtempSync(join(tmpdir(),'guix-package-receiving-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const repo=join(root,'repo');mkdirSync(repo);
  command('git',['init','-q'],repo);
  const packageRoot=join(repo,prefix);
  put(packageRoot,'package.json',JSON.stringify(manifest,null,2)+'\n');
  put(packageRoot,testPath,testBytes);
  const commit=()=>{
    command('git',['add','.'],repo);
    command('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture'],repo);
    return command('git',['rev-parse','HEAD'],repo);
  };
  const source={directory:repo,repository:'example/consumer',commit:commit()};
  const output=join(root,'output');
  const prepareSource=(extra={})=>{
    prepare({repositories:[source],entries:[name],receivingPackages:[name],output,...extra});
    const sources=JSON.parse(readFileSync(join(output,'sources.json'),'utf8'));
    return {sources,packageDirectory:join(output,'packages','@example__consumer')};
  };
  return {root,repo,packageRoot,output,source,commit,prepareSource};
}

function carrier(f,sources) {
  put(f.output,'.metadata/sources.json',JSON.stringify(sources));
  mkdirSync(join(f.output,'.controller'));
  const artifact=join(f.root,'guix-output');mkdirSync(artifact);
  // Mirror src/guix-deployment.scm: every top-level entry is a direct absolute
  // link to the same admitted runtime, including packages and metadata.
  for(const entry of readdirSync(f.output))symlinkSync(join(f.output,entry),join(artifact,entry));
  return artifact;
}

test('qualification binds committed tests to the original manifest before dependency rewriting',t=>{
  const manifest={name,version:'1.0.0',type:'module',receivingTests:[testPath],
    dependencies:{registry:'1.2.3'},devDependencies:{'test-only':'9.9.9'}};
  const f=fixture(t,manifest,'services/consumer');
  put(f.packageRoot,testPath,'throw new Error("mutable test must not be materialized");\n');
  put(f.packageRoot,'test/untracked.mjs','throw new Error("untracked");\n');
  put(f.packageRoot,'package.json',JSON.stringify({...manifest,receivingTests:['test/untracked.mjs']}));
  const {sources,packageDirectory}=f.prepareSource();
  const p=sources.packages[0],receipt=p.receiving;
  assert.equal(p.path,'services/consumer');
  assert.deepEqual(receipt.manifest,manifest);
  assert.equal(p.sourceManifestSha256,manifestIdentity(manifest));
  const blob=command('git',['rev-parse',`${f.source.commit}:services/consumer/${testPath}`],f.repo);
  assert.deepEqual(receipt.tests,[{path:testPath,gitBlob:blob,sha256:sha256(testBytes)}]);
  assert.equal(gitBlobIdentity(testBytes,blob),blob);
  assert.deepEqual(readFileSync(join(packageDirectory,testPath)),testBytes);
  const rewritten=JSON.parse(readFileSync(join(packageDirectory,'package.json')));
  assert.deepEqual(rewritten.dependencies,{registry:'1.2.3'});
  assert.equal(rewritten.devDependencies,undefined);
  assert.notEqual(manifestIdentity(rewritten),p.sourceManifestSha256);
  assert.deepEqual(packageReceivingChecks(f.output,sources),[{name,directory:packageDirectory,tests:[join(packageDirectory,testPath)]}]);
});

test('manifest-only lock resolution still qualifies committed declarations and exact test identities',t=>{
  const f=fixture(t),{sources,packageDirectory}=f.prepareSource({manifestsOnly:true});
  assert.deepEqual(sources.receivingPackages,[name]);
  assert.equal(sources.packages[0].receiving.tests[0].sha256,sha256(testBytes));
  assert.equal(existsSync(join(packageDirectory,testPath)),false);
  assert.throws(()=>packageReceivingChecks(f.output,sources),/ENOENT/,'manifest-only output cannot pass receiving');
});

test('later admitted source commits carry their own changed selection without a controller catalog edit',t=>{
  const f=fixture(t),first=f.prepareSource().sources;
  const manifest=JSON.parse(readFileSync(join(f.packageRoot,'package.json'),'utf8'));
  manifest.receivingTests.push('test/new-case.mjs');
  put(f.packageRoot,'package.json',JSON.stringify(manifest));
  put(f.packageRoot,'test/new-case.mjs','import test from "node:test"; test("new source-owned case",()=>{});\n');
  f.source.commit=f.commit();
  const second=f.prepareSource().sources;
  assert.deepEqual(second.receivingPackages,first.receivingPackages);
  assert.notEqual(second.packages[0].sourceManifestSha256,first.packages[0].sourceManifestSha256);
  assert.notEqual(second.packages[0].commit,first.packages[0].commit);
  assert.deepEqual(second.packages[0].receiving.tests.map(x=>x.path),[testPath,'test/new-case.mjs']);
  assert.equal(packageReceivingChecks(f.output,second)[0].tests.length,2);
});

test('malformed selected declarations are refused, including command objects and all path escapes',async t=>{
  const declarations=[undefined,null,'node --test',{},[],[testPath,testPath],[12],[''],['/tmp/test.mjs'],
    ['../outside.mjs'],['test/../../outside.mjs'],['test/./one.mjs'],['test//one.mjs'],['test/'],
    ['C:/test.mjs'],['C:\\test.mjs'],['test\\one.mjs'],['test/*.mjs'],['test/?.mjs'],['test/[ab].mjs'],
    ['test/{a,b}.mjs'],['test/one\nmjs'],['test/one\0mjs'],[{command:'node',args:['--test']}]];
  for(const declaration of declarations)await t.test(JSON.stringify(declaration)??'missing',t=>{
    const f=fixture(t,{name,version:'1.0.0',receivingTests:declaration});
    assert.throws(()=>f.prepareSource(),/invalid receivingTests/);
    assert.equal(existsSync(join(f.output,'sources.json')),false);
  });
});

test('selected paths must be tracked regular files from the exact admitted commit',async t=>{
  for(const kind of ['missing','untracked','directory','symlink','symlink-directory','excluded'])await t.test(kind,t=>{
    const path=kind==='excluded'?'vendor/one.mjs':'test/other.mjs';
    const f=fixture(t,{name,version:'1.0.0',receivingTests:[path]});
    if(kind==='untracked')put(f.packageRoot,path,testBytes);
    if(kind==='directory')mkdirSync(join(f.packageRoot,path));
    if(kind==='symlink')symlinkSync('receiving.test.mjs',join(f.packageRoot,path));
    if(kind==='symlink-directory'){
      rmSync(join(f.packageRoot,'test'),{recursive:true});
      put(f.packageRoot,'actual/other.mjs',testBytes);
      symlinkSync('actual',join(f.packageRoot,'test'));
    }
    if(kind==='excluded')put(f.packageRoot,path,testBytes);
    if(['symlink','symlink-directory','excluded'].includes(kind))f.source.commit=f.commit();
    assert.throws(()=>f.prepareSource(),/not a materialized committed regular file/);
  });
});

test('empty or omitted allowlists do not run or validate unselected declarations',t=>{
  const f=fixture(t,{name,version:'1.0.0',receivingTests:{command:'arbitrary runner'}});
  const {sources}=f.prepareSource({receivingPackages:[]});
  assert.equal(sources.packages[0].receiving,undefined);
  assert.deepEqual(packageReceivingChecks(f.output,sources),[]);
  delete sources.receivingPackages;
  assert.deepEqual(packageReceivingChecks(f.output,sources),[],'old metadata retains legacy-only behavior');
  prepare({repositories:[f.source],entries:[name],output:join(f.root,'default')});
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'default/sources.json'))).receivingPackages,[]);
});

test('selection cannot add a package to the source graph, and unknown or duplicate names are refused',t=>{
  const f=fixture(t);
  for(const receivingPackages of [[name,name],null,name,['../escape'],['@scope/a/b']])
    assert.throws(()=>f.prepareSource({receivingPackages}),/receivingPackages/);
  assert.throws(()=>f.prepareSource({receivingPackages:['@example/missing']}),/no admitted source/);
  put(f.repo,'unused/package.json',JSON.stringify({name:'@example/unused',version:'1.0.0',receivingTests:['test.mjs']}));
  put(f.repo,'unused/test.mjs',testBytes);f.source.commit=f.commit();
  assert.throws(()=>f.prepareSource({receivingPackages:['@example/unused']}),/no admitted source/);
  const {sources}=f.prepareSource();
  assert.throws(()=>packageReceivingChecks(f.output,{...sources,receivingPackages:['@example/missing']}),/not uniquely admitted/);
  assert.throws(()=>packageReceivingChecks(f.output,{...sources,packages:[...sources.packages,...sources.packages]}),/not uniquely admitted/);
});

test('metadata must bind the original declaration, admitted repository and exact test identities',t=>{
  const f=fixture(t),{sources}=f.prepareSource();
  const changes=[
    p=>{delete p.receiving;},
    p=>{p.receiving.version=2;},
    p=>{p.receiving.runner='npm';},
    p=>{p.receiving.manifest.receivingTests=['test/other.mjs'];},
    p=>{p.sourceManifestSha256='0'.repeat(64);},
    p=>{p.commit='0'.repeat(40);},
    p=>{p.receiving.tests=[];},
    p=>{p.receiving.tests.push(p.receiving.tests[0]);},
    p=>{p.receiving.tests[0].path='test/other.mjs';},
    p=>{p.receiving.tests[0].sha256='0'.repeat(64);},
    p=>{p.receiving.tests[0].gitBlob='0'.repeat(40);},
    p=>{p.receiving.tests[0].gitBlob='invalid';},
    p=>{p.receiving.tests[0].command='node';},
  ];
  for(const change of changes){
    const altered=structuredClone(sources);change(altered.packages[0]);
    assert.throws(()=>packageReceivingChecks(f.output,altered));
  }
  assert.throws(()=>packageReceivingChecks(f.output,{...sources,repositories:[]}),/not admitted/);
  const changedDeclaration=structuredClone(sources);
  changedDeclaration.packages[0].receiving.manifest.receivingTests=[];
  changedDeclaration.packages[0].sourceManifestSha256=manifestIdentity(changedDeclaration.packages[0].receiving.manifest);
  assert.throws(()=>packageReceivingChecks(f.output,changedDeclaration),/invalid receivingTests/);
});

test('receiving checks revalidate materialized declaration and bytes and reject symlink paths',async t=>{
  for(const kind of ['manifest','bytes','file-symlink','directory-symlink','package-symlink','packages-symlink','missing'])await t.test(kind,t=>{
    const f=fixture(t),{sources,packageDirectory}=f.prepareSource();
    const path=join(packageDirectory,testPath);
    if(kind==='manifest')put(packageDirectory,'package.json',JSON.stringify({name,version:'1.0.0',receivingTests:['other.mjs']}));
    if(kind==='bytes')writeFileSync(path,Buffer.concat([testBytes,Buffer.from(' ')]));
    if(kind==='missing')rmSync(path);
    if(kind==='file-symlink'){
      copyFileSync(path,join(f.root,'outside.mjs'));rmSync(path);symlinkSync(join(f.root,'outside.mjs'),path);
    }
    if(kind==='directory-symlink'){
      put(f.root,'outside/receiving.test.mjs',testBytes);
      rmSync(join(packageDirectory,'test'),{recursive:true});symlinkSync(join(f.root,'outside'),join(packageDirectory,'test'));
    }
    if(kind==='package-symlink'||kind==='packages-symlink'){
      const target=kind==='package-symlink'?packageDirectory:join(f.output,'packages');
      rmSync(target,{recursive:true});symlinkSync(f.packageRoot,target);
    }
    assert.throws(()=>packageReceivingChecks(f.output,sources));
  });
});

test('the Guix top-level carrier resolves to the exact admitted runtime without relaxing package paths',t=>{
  const f=fixture(t),{sources,packageDirectory}=f.prepareSource();
  const artifact=carrier(f,sources);
  const plans=packageReceivingChecks(artifact,JSON.parse(readFileSync(join(artifact,'.metadata/sources.json'))));
  assert.deepEqual(plans,[{name,directory:packageDirectory,tests:[join(packageDirectory,testPath)]}]);
  assert.deepEqual(packageReceivingChecks(f.output,sources),plans,'a fully materialized closure uses the same identities');
  assert.deepEqual(readFileSync(plans[0].tests[0]),testBytes);
  const result=spawnSync(process.execPath,['--test',...plans[0].tests],{
    cwd:plans[0].directory,env:packageReceivingEnvironment(process.execPath),encoding:'utf8',
  });
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  assert.match(result.stdout,/committed receiving case/);
  assert.match(result.stdout,/(?:#|ℹ) pass 1/);
});

test('carrier linkage cannot admit a different root, indirect links or nested package symlinks',async t=>{
  for(const kind of ['different-packages','different-controller','split-runtime-packages','split-runtime-metadata','indirect-root','indirect-packages',
    'metadata-file-symlink','runtime-packages-symlink','package-symlink','test-parent-symlink','test-symlink','changed-bytes'])
    await t.test(kind,t=>{
      const f=fixture(t),{sources,packageDirectory}=f.prepareSource(),artifact=carrier(f,sources);
      const replace=(path,target)=>{rmSync(path,{recursive:true,force:true});symlinkSync(target,path);};
      if(kind==='different-packages')replace(join(artifact,'packages'),f.packageRoot);
      if(kind==='different-controller')replace(join(artifact,'.controller'),f.packageRoot);
      if(kind.startsWith('split-runtime-')){
        const other=join(f.root,'other-runtime');cpSync(f.output,other,{recursive:true});
        const entry=kind==='split-runtime-packages'?'packages':'.metadata';
        replace(join(artifact,entry),join(other,entry));
      }
      if(kind==='indirect-root'){
        symlinkSync(f.output,join(f.root,'runtime-alias'));
        for(const entry of ['packages','.metadata','.controller'])
          replace(join(artifact,entry),join(f.root,'runtime-alias',entry));
      }
      if(kind==='indirect-packages'){
        symlinkSync(join(f.output,'packages'),join(f.root,'packages-alias'));
        replace(join(artifact,'packages'),join(f.root,'packages-alias'));
      }
      if(kind==='metadata-file-symlink'){
        put(f.root,'outside-sources.json',JSON.stringify(sources));
        replace(join(f.output,'.metadata/sources.json'),join(f.root,'outside-sources.json'));
      }
      if(kind==='runtime-packages-symlink')replace(join(f.output,'packages'),f.packageRoot);
      if(kind==='package-symlink')replace(packageDirectory,f.packageRoot);
      if(kind==='test-parent-symlink')replace(join(packageDirectory,'test'),join(f.packageRoot,'test'));
      if(kind==='test-symlink')replace(join(packageDirectory,testPath),join(f.packageRoot,testPath));
      if(kind==='changed-bytes')writeFileSync(join(packageDirectory,testPath),Buffer.concat([testBytes,Buffer.from(' ')]));
      assert.throws(()=>packageReceivingChecks(artifact,sources));
    });
});

test('materialized packages refuse mixed-shape external metadata or controller links',async t=>{
  for(const entry of ['.metadata','.controller'])await t.test(entry,t=>{
    const f=fixture(t),{sources}=f.prepareSource();
    put(f.root,'outside/sources.json',JSON.stringify(sources));
    symlinkSync(join(f.root,'outside'),join(f.output,entry));
    assert.throws(()=>packageReceivingChecks(f.output,sources),/invalid materialized runtime entry/);
  });
  await t.test('sources.json symlink beneath direct metadata directory',t=>{
    const f=fixture(t),{sources}=f.prepareSource();
    put(f.root,'outside-sources.json',JSON.stringify(sources));
    mkdirSync(join(f.output,'.metadata'));
    symlinkSync(join(f.root,'outside-sources.json'),join(f.output,'.metadata/sources.json'));
    assert.throws(()=>packageReceivingChecks(f.output,sources),/regular file without symlinks/);
  });
});

test('engineering change receiving admits the entire selected set before execution',t=>{
  const f=fixture(t);
  put(f.repo,'second/package.json',JSON.stringify({name:'@example/second',version:'1.0.0',receivingTests:['test.mjs']}));
  put(f.repo,'second/test.mjs','throw new Error("must not execute");\n');f.source.commit=f.commit();
  f.prepareSource({entries:[name,'@example/second'],receivingPackages:[name,'@example/second']});
  const file=join(f.output,'packages/@example__second/test.mjs'),original=readFileSync(file);
  writeFileSync(file,'changed after qualification');
  let executions=0;
  const execute=(_directory,tests)=>{executions++;return new Map(tests.map(path=>[path,true]));};
  assert.throws(()=>runDeclaredReceiving(f.output,{},execute),/receiving test bytes differ.*@example\/second/);
  assert.equal(executions,0);
  writeFileSync(file,original);
  const received=runDeclaredReceiving(f.output,{},execute);
  assert.equal(executions,2);assert.equal(received.length,2);
});

test('selected test execution cannot inherit skip, loader, discovery or credential variables',t=>{
  const f=fixture(t);
  const marker=join(f.root,'test-ran');
  put(f.packageRoot,testPath,`import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
test('must execute without caller controls',()=>{
  for(const key of ['SKIP_TESTS','SKIP_RECEIVING','NODE_PATH','GITHUB_TOKEN','CUSTOM_SECRET'])assert.equal(process.env[key],undefined,key);
  assert.equal(process.env.NODE_OPTIONS,'--max-old-space-size=384');
  writeFileSync(${JSON.stringify(marker)},'executed');
});\n`);
  f.source.commit=f.commit();
  const {sources}=f.prepareSource(),[plan]=packageReceivingChecks(f.output,sources);
  const parent={...process.env,NODE_OPTIONS:'--import /nonexistent/loader.mjs',NODE_PATH:'/untrusted',
    NODE_TEST_CONTEXT:'child-v8',SKIP_TESTS:'1',SKIP_RECEIVING:'1',GITHUB_TOKEN:'fixture-only',CUSTOM_SECRET:'fixture-only'};
  const environment=packageReceivingEnvironment(process.execPath,parent);
  assert.equal(environment.NODE_TEST_CONTEXT,undefined);
  const result=spawnSync(process.execPath,['--test',...plan.tests],{cwd:plan.directory,env:environment,encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  assert.equal(readFileSync(marker,'utf8'),'executed');
  assert.match(result.stdout,/committed|must execute without caller controls/);
  assert.match(result.stdout,/(?:#|ℹ) pass 1/);
});

// What a receiving package's repository mounts is in place for its tests, generically, at the commits the gitlinks record.
function mountedFixture(t,{inside='content'}={}) {
  const f=fixture(t,{name,version:'1.0.0',type:'module',receivingTests:[testPath]},'services/consumer');
  const child=join(f.root,'child');mkdirSync(child);
  command('git',['init','-q'],child);
  put(child,'posts/one.md','one\n');put(child,'nested/two.md','two\n');
  command('git',['add','.'],child);
  command('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','child'],child);
  const childCommit=command('git',['rev-parse','HEAD'],child);
  const mount=inside.startsWith('..')?'services/elsewhere':`services/consumer/${inside}`;
  mkdirSync(join(f.repo,mount),{recursive:true});
  writeFileSync(join(f.repo,'.gitmodules'),`[submodule "${mount}"]\n\tpath = ${mount}\n\turl = https://github.com/example/child.git\n`);
  command('git',['add','.gitmodules'],f.repo);
  command('git',['update-index','--add','--cacheinfo',`160000,${childCommit},${mount}`],f.repo);
  const parent={...f.source,commit:f.commit()};
  return {...f,parent,child:{directory:child,repository:'example/child',commit:childCommit}};
}

test('a receiving package has its repository\'s mounted children in place at their gitlink commits',t=>{
  const f=mountedFixture(t);
  prepare({repositories:[f.parent,f.child],entries:[name],receivingPackages:[name],output:f.output});
  const directory=join(f.output,'packages','@example__consumer');
  assert.equal(readFileSync(join(directory,'content/posts/one.md'),'utf8'),'one\n');
  assert.equal(readFileSync(join(directory,'content/nested/two.md'),'utf8'),'two\n');
  const sources=JSON.parse(readFileSync(join(f.output,'sources.json'),'utf8'));
  assert.deepEqual(sources.packages[0].mounts,[{repository:'example/child',commit:f.child.commit,path:'content'}]);
});

test('a package that is not a receiving package gets nothing mounted into it', t=>{
  const f=mountedFixture(t);
  prepare({repositories:[f.parent,f.child],entries:[name],output:f.output});
  assert.equal(existsSync(join(f.output,'packages','@example__consumer','content')),false);
});

test('a mount outside the receiving package\'s directory is not part of it',t=>{
  const f=mountedFixture(t,{inside:'../elsewhere'});
  prepare({repositories:[f.parent,f.child],entries:[name],receivingPackages:[name],output:f.output});
  assert.equal(existsSync(join(f.output,'packages','@example__consumer','content')),false);
  assert.equal(JSON.parse(readFileSync(join(f.output,'sources.json'),'utf8')).packages[0].mounts,undefined);
});

test('a mounted child that is not among the machine\'s sources at its gitlink commit is refused',t=>{
  const f=mountedFixture(t);
  assert.throws(()=>prepare({repositories:[f.parent],entries:[name],receivingPackages:[name],output:f.output}),/not among the machine's sources/u);
  assert.throws(()=>prepare({repositories:[f.parent,{...f.child,commit:'1'.repeat(40)}],entries:[name],receivingPackages:[name],output:join(f.root,'second')}),/source commit differs|not among the machine's sources/u);
});

