import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync,symlinkSync,realpathSync,lstatSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const source=fileURLToPath(new URL('../',import.meta.url));
const commands=[
  ['release-storage.mjs',[],1,/usage: release-storage/],
  ['credential-unit-receiving.mjs',[],1,/immutable-candidate-required/],
  ['media-dependency-observation.mjs',['unrequested.service'],2,/accepts no unit or command arguments/],
  ['github-reads.mjs',[],1,/GitHub quota observation unavailable/],
  ['prepare-sources.mjs',[],1,/ERR_INVALID_ARG_TYPE/],
  ['project-controller-bootstrap.mjs',[],1,/usage: project-controller-bootstrap/],
  ['test-controller.mjs',[],1,/usage: test-controller/],
  ['prepare-build-swap.mjs',[],1,/ERR_INVALID_ARG_TYPE/],
];
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'controller-cli-carrier-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const runtime=join(root,'admitted runtime #%'),carrier=join(root,'carrier'),bin=join(root,'closed-bin');
  mkdirSync(runtime);mkdirSync(carrier);mkdirSync(bin);
  cpSync(source,join(runtime,'.controller'),{recursive:true});
  for(const name of ['packages','node_modules','.metadata'])mkdirSync(join(runtime,name));
  // src/guix-deployment.scm links each admitted-runtime top-level entry into
  // the carrier. Keep .controller as that directory symlink, not a copied file.
  for(const name of ['.controller','packages','node_modules','.metadata'])symlinkSync(join(runtime,name),join(carrier,name));
  assert.equal(lstatSync(join(carrier,'.controller')).isSymbolicLink(),true);
  assert.equal(realpathSync(join(carrier,'.controller')),join(runtime,'.controller'));
  const effects=join(root,'effects');
  for(const program of ['systemctl','git','gh','guix','sudo','fallocate','npm','ssh','scp'])
    writeFileSync(join(bin,program),`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(effects)},${JSON.stringify(program+'\n')});process.exit(99);\n`,{mode:0o755});
  const env={PATH:bin,HOME:root,TMPDIR:root};
  const run=(args)=>spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',timeout:15_000});
  return {root,runtime,carrier,bin,effects,run};
}

test('carrier fixture matches the actual top-level symlink builder',()=>{
  const builder=readFileSync(join(source,'src/guix-deployment.scm'),'utf8');
  assert.match(builder,/\(symlink \(string-append tree "\/" file\) \(string-append out "\/" file\)\)/);
  assert.match(builder,/\(scandir tree\)/);
});
for(const [script,args,status,message] of commands)test(`CLI entry is retained through the Guix carrier: ${script}`,t=>{
  const f=fixture(t);
  for(const entry of [join(f.runtime,'.controller/scripts',script),join(f.carrier,'.controller/scripts',script)]){
    const result=f.run([entry,...args]);
    assert.equal(result.status,status,`${entry}: ${result.stderr}`);
    assert.equal(result.stdout,'');assert.match(result.stderr,message);
  }
  assert.equal(existsSync(f.effects),false,'invalid arguments must not invoke an effect');
});

test('ordinary imports through direct and carrier paths never run their CLI blocks',t=>{
  const f=fixture(t);
  for(const directory of [f.runtime,f.carrier]){
    const imports=commands.map(([script])=>`await import(${JSON.stringify(pathToFileURL(join(directory,'.controller/scripts',script)).href)});`).join('\n');
    const importer=join(f.root,'ordinary-import.mjs');writeFileSync(importer,imports+'\nconsole.log("imported");\n');
    const ordinary=f.run([importer]);assert.equal(ordinary.status,0,ordinary.stderr);assert.equal(ordinary.stdout,'imported\n');assert.equal(ordinary.stderr,'');
    for(const prefix of ['',`process.argv[1]=${JSON.stringify(join(f.root,'missing-main.mjs'))};\n`]){
      const evaluated=f.run(['--input-type=module','--eval',prefix+imports+'\nconsole.log("imported");']);
      assert.equal(evaluated.status,0,evaluated.stderr);assert.equal(evaluated.stdout,'imported\n');assert.equal(evaluated.stderr,'');
    }
  }
  assert.equal(existsSync(f.effects),false,'imports must not start commands or observations');
});

test('credential CLI runs through a script symlink and relative carrier path with value-free refusal',t=>{
  const f=fixture(t),program=join(f.carrier,'.controller/scripts/credential-unit-receiving.mjs');
  const alias=join(f.root,'credential alias #%');symlinkSync(program,alias);
  for(const entry of [alias,relative(f.root,program)]){
    const r=f.run([entry,'/not-store/INERT_PRIVATE_ARGUMENT','verify','INERT_PRIVATE_BASELINE']);
    assert.equal(r.status,1,r.stderr);assert.equal(r.stdout,'');
    assert.deepEqual(JSON.parse(r.stderr),{kind:'credential-unit-receiving',status:'refused',reason:'immutable-candidate-required'});
    assert.doesNotMatch(r.stderr,/INERT_PRIVATE/);
  }
  assert.equal(existsSync(f.effects),false);
});

test('carrier media CLI makes only its three fixed read-only observations through closed subprocesses',t=>{
  const f=fixture(t);
  writeFileSync(join(f.bin,'systemctl'),`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
const units=['561-group-credentials.service','media-studio-display.service','media-studio-browser.service'];
const properties='--property=Id,LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus';
if(args.length!==5||JSON.stringify(args.slice(0,4))!==JSON.stringify(['--user','show','--all',properties])||!units.includes(args[4]))process.exit(99);
fs.appendFileSync(${JSON.stringify(f.effects)},JSON.stringify(args)+'\\n');
console.log('Id='+args[4]+'\\nLoadState=loaded\\nActiveState=active\\nSubState=running\\nResult=success\\nExecMainCode=0\\nExecMainStatus=0');
`,{mode:0o755});
  const r=f.run([join(f.carrier,'.controller/scripts/media-dependency-observation.mjs')]);
  assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
  const result=JSON.parse(r.stdout);
  assert.equal(result.kind,'media-dependency-observation');
  assert.deepEqual(result.units.map(x=>x.unit),['561-group-credentials.service','media-studio-display.service','media-studio-browser.service']);
  assert.equal(result.units.every(x=>x.observation==='observed'&&x.Result==='success'),true);
  assert.equal(readFileSync(f.effects,'utf8').trim().split('\n').length,3);
});

test('canonical entry helper fails closed for imports, absent entries and URL suffixes',async t=>{
  const {isCliEntry}=await import('../scripts/cli-entry.mjs');
  const f=fixture(t),target=join(f.runtime,'.controller/scripts/credential-unit-receiving.mjs');
  const invoked=join(f.carrier,'.controller/scripts/credential-unit-receiving.mjs');
  const moduleUrl=pathToFileURL(target).href;
  assert.equal(isCliEntry(moduleUrl,target),true);
  assert.equal(isCliEntry(moduleUrl,invoked),true);
  for(const entry of ['',null,{},join(f.root,'missing.mjs'),'-',pathToFileURL(target).href])
    assert.equal(isCliEntry(moduleUrl,entry),false);
  assert.equal(isCliEntry(moduleUrl+'?ordinary-import',invoked),false);
  assert.equal(isCliEntry(moduleUrl+'#ordinary-import',invoked),false);
  assert.equal(isCliEntry(pathToFileURL(join(f.runtime,'.controller/scripts/github-reads.mjs')).href,invoked),false);
});
