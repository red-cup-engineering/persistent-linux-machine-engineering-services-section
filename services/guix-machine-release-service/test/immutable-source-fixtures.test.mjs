import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,chmodSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,lstatSync,readlinkSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyWritableSource} from './helpers/writable-source-copy.mjs';
import {packageReceivingEnvironment} from '../scripts/package-receiving.mjs';

// These are controller self-checks, including its real Scheme resolver. Keep
// the admitted Guix interpreter's module closure without forwarding Node test
// context, loaders, credentials or package-owned environment controls.
const controllerEnvironment=()=>{
  const environment=packageReceivingEnvironment(process.execPath);
  for(const key of ['GUILE_LOAD_PATH','GUILE_LOAD_COMPILED_PATH','GUILE_AUTO_COMPILE'])
    if(process.env[key]!==undefined)environment[key]=process.env[key];
  return environment;
};

function walk(path,visit){
  const status=lstatSync(path);visit(path,status);
  if(status.isDirectory())for(const name of readdirSync(path))walk(join(path,name),visit);
}
function fingerprint(root){
  const result=[];walk(root,(path,status)=>result.push([path.slice(root.length),status.mode&0o777,
    status.isSymbolicLink()?readlinkSync(path):status.isFile()?createHash('sha256').update(readFileSync(path)).digest('hex'):'directory']));
  return result;
}
// This changes only the disposable read-only fixture created by this test,
// after its unchanged-input assertion, so ordinary cleanup can remove it.
function discardFixture(root){
  walk(root,(path,status)=>{if(status.isDirectory())chmodSync(path,status.mode|0o700);});
  rmSync(root,{recursive:true,force:true});
}

test('mutable fixture copies preserve immutable source bytes/modes and never chmod through symlinks',()=>{
  const root=mkdtempSync(join(tmpdir(),'writable-copy-boundary-'));
  try{
    const source=join(root,'source'),destination=join(root,'copy'),outside=join(root,'outside');
    mkdirSync(join(source,'nested'),{recursive:true});mkdirSync(outside);
    const original=join(source,'nested/file.mjs'),target=join(outside,'held.mjs');
    writeFileSync(original,'export const original=true;\n');writeFileSync(target,'held target\n');
    symlinkSync(outside,join(source,'external-link'));
    walk(source,(path,status)=>{if(!status.isSymbolicLink())chmodSync(path,status.isDirectory()?0o555:0o444);});
    chmodSync(target,0o444);chmodSync(outside,0o555);
    const before=fingerprint(source),held=fingerprint(outside);
    copyWritableSource(source,destination);
    writeFileSync(join(destination,'nested/file.mjs'),'fixture-only replacement\n');
    writeFileSync(join(destination,'nested/new.mjs'),'new fixture\n');
    assert.deepEqual(fingerprint(source),before);assert.deepEqual(fingerprint(outside),held);
    assert.equal(lstatSync(join(destination,'external-link')).isSymbolicLink(),true);
    assert.equal(lstatSync(join(destination,'nested/file.mjs')).mode&0o200,0o200);
  }finally{discardFixture(root);}
});

test('the controller bootstrap and source reading execute from a read-only source tree without mutating it',()=>{
  const root=mkdtempSync(join(tmpdir(),'readonly-handoff-regression-'));
  try{
    const sealed=join(root,'sealed-controller');
    cpSync(fileURLToPath(new URL('../',import.meta.url)),sealed,{recursive:true});
    walk(sealed,(path,status)=>{if(!status.isSymbolicLink())chmodSync(path,status.mode&~0o222);});
    const before=fingerprint(sealed);
    const result=spawnSync(process.execPath,['--test','--test-reporter=tap',
      join(sealed,'test/controller-owner.test.mjs'),join(sealed,'test/source-pins.test.mjs')],
      {cwd:root,env:controllerEnvironment(),encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
    assert.equal(result.status,0,(result.stderr??'')+(result.stdout??''));
    for(const line of ['fail 0','cancelled 0','skipped 0','todo 0'])assert.ok(result.stdout.split('\n').includes('# '+line),line);
    // This boundary owes bootstrap execution and immutable source reads, not a
    // fixed aggregate count that changes when either child suite adds coverage.
    const passed=new Set([...result.stdout.matchAll(/^ok \d+ - (.+)$/gmu)].map(match=>match[1]));
    const required=[
      ...['mounted once by the machine','not mounted','mounted twice','no sources'].map(name=>'bootstrap owner: '+name),
      'bootstrap materializes the exact commit the machine mounts, using Git',
      'raw bootstrap is a refused template even with an ambient weaker gate',
      ...['clean reuse','clean filtered reuse','dirty tracked bytes','untracked module','ignored module',
        'assume-unchanged bytes','skip-worktree bytes','hidden executable mode','hidden verifier replacement',
        'dirty cache fsmonitor','dirty clean filter','dirty process filter','staged-only edit','nested git directory']
        .map(name=>'projected owner bootstrap gates reused cache: '+name),
      'the sources are read at the commit named, not the checkout',
      'actual source closure refuses a mounted URL that cannot name its owner',
      'an unexplained committed gitlink cannot silently disappear from the source closure',
      "a machine's sources include the repositories its mounted repositories mount, each once",
      'one repository at two commits anywhere in the mounted graph is refused',
      'a mounted repository that mounts the machine repository back is a cycle',
    ];
    for(const name of required)assert.ok(passed.has(name),'required read-only receiving case: '+name);
    assert.deepEqual(fingerprint(sealed),before,'admitted source bytes and permissions remain unchanged');
  }finally{discardFixture(root);}
});
