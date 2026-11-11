import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,cpSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

test('local deployment checks the actual invalid sealed candidate before any media activation',()=>{
  const root=mkdtempSync(join(tmpdir(),'media-host-preflight-'));
  try{
    const artifact=join(root,'candidate');
    for(const path of [join(artifact,'bin'),join(artifact,'.metadata')])mkdirSync(path,{recursive:true});
    cpSync(fileURLToPath(new URL('../',import.meta.url)),join(artifact,'.controller'),{recursive:true});
    symlinkSync(process.execPath,join(artifact,'bin/node'));
    writeFileSync(join(artifact,'.metadata/sources.json'),'{}\n');
    const result=spawnSync('guile',['--no-auto-compile',fileURLToPath(new URL('./media-host-preflight.scm',import.meta.url)),artifact],{encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/actual invalid candidate passed/);
    assert.match(result.stderr,/Cannot find module '@red-cup-engineering\/feltos\/package.json'/,'the real host-check reaches sealed driver admission');
    assert.doesNotMatch(result.stderr,/unknown structural receiving argument/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('main receiving retains its later host-check and remote media routing is unchanged',()=>{
  const receiver=readFileSync(new URL('../scripts/receive.scm',import.meta.url),'utf8');
  assert.match(receiver,/\(set! stage "host-check"\)\s*\(run \(string-append store "\/bin\/node"\)\s*\(string-append store "\/\.controller\/scripts\/check-host\.mjs"\) store\)/);
  const source=readFileSync(new URL('../scripts/github-machine-release.scm',import.meta.url),'utf8');
  assert.match(source,/\(when \(and \(not \(equal\? mode "rollback"\)\) \(assoc-ref config "mediaReceipt"\)\)\s*\(receive-media config store mode\)\)\s*\(remote-receive/);
  assert.equal(source.match(/\(receive-local-media config store mode snapshot\)/g).length,2,'definition and the one guarded local call site');
  assert.equal(source.match(/\(receive-media config store mode\)/g).length,3,'the existing remote call and preserving media wrapper remain');
  const constructor=readFileSync(new URL('../src/guix-deployment.scm',import.meta.url),'utf8');
  assert.match(constructor,/\(invoke runtime \(string-append out "\/\.controller\/scripts\/check-host\.mjs"\)\s*out "--build-only"\)/);
});
