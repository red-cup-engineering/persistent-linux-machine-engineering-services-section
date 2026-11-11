import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {releaseOutcome} from '../scripts/release-outcome.mjs';

// Enrolled by the existing package's test/*.test.mjs command and test-change's
// recursive *.test.mjs selection. A missing Guile/guile-json is a failure, never
// a skipped or synthetic Scheme pass. No release entry point is executed.
test('actual Scheme producer and receipt forms feed attributable outcome evidence',t=>{
  const root=mkdtempSync(join(tmpdir(),'release-outcome-scheme-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const modes=['build','deploy','check-failure'],cases=['matched','missing','invalid','mismatch'];
  const outcomes=['staged','success','failure','recovery-failure'];
  for(const mode of modes)for(const name of cases)for(const outcome of outcomes)
    mkdirSync(join(root,`${mode}-${name}`,outcome),{recursive:true});
  for(const mode of ['resolve','rollback'])mkdirSync(join(root,`${mode}-invocation`));
  for(const mode of [...modes,'rollback'])mkdirSync(join(root,`native-${mode}`));
  const result=spawnSync('guile',['--no-auto-compile',fileURLToPath(new URL('./release-outcome-scheme.scm',import.meta.url)),root],
    {encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH??'',GUILE_LOAD_PATH:process.env.GUILE_LOAD_PATH??'',GUILE_LOAD_COMPILED_PATH:process.env.GUILE_LOAD_COMPILED_PATH??'',GUILE_AUTO_COMPILE:'0'}});
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/receipt serialization passed/);
  const run={repository:'test/machine',id:'123',attempt:'2'};
  for(const mode of modes)for(const name of cases){
    const work=join(root,`${mode}-${name}`),invocationText=readFileSync(join(work,'release-invocation.json'));
    const candidateText=readFileSync(join(work,'candidate.json'));
    const invocation=JSON.parse(invocationText),candidate=JSON.parse(candidateText);
    const attempt=name==='missing'?false:name==='invalid'?'0':'2';
    assert.deepEqual(invocation,{repository:run.repository,revision:'a'.repeat(40),run:`https://github.com/${run.repository}/actions/runs/123`,runAttempt:attempt,mode});
    assert.deepEqual(candidate,{storePath:'/gnu/store/inert-release',root:'/inert/candidate-root',narSha256:'b'.repeat(64),...invocation});
    for(const outcome of outcomes){
      const directory=join(work,outcome),receiptText=readFileSync(join(directory,'latest.json'));
      const receipt=JSON.parse(receiptText),files=readdirSync(directory).filter(name=>name!=='latest.json');
      assert.deepEqual(files,[`1234-${outcome}.json`]);
      assert.deepEqual(readFileSync(join(directory,files[0])),receiptText,'latest preserves actual serialized receipt bytes');
      assert.equal((receiptText.toString().match(/"runAttempt"/g)??[]).length,1);
      const stage=outcome==='staged'?'pre-switch-check':outcome==='success'?'live-check':outcome==='failure'?'staging':'restore-generation';
      assert.deepEqual(receipt,{runAttempt:name==='mismatch'?'3':attempt,machine:'machine',repository:invocation.repository,
        revision:invocation.revision,run:invocation.run,storePath:candidate.storePath,outcome,stage,
        at:'2026-10-10T00:00:00Z',originalStage:'staging',retained:'/gnu/store/held-release'});
      const projected=releaseOutcome({run,machine:'machine',jobOutcome:'failure',invocationText,candidateText,receiptText});
      assert.equal(projected.invocation.attributed,['matched','mismatch'].includes(name));
      assert.equal(projected.candidate.attributed,['matched','mismatch'].includes(name));
      const modeMatches=outcome==='staged'?mode==='build':outcome==='success'?mode==='deploy':true;
      assert.equal(projected.receipt.attributed,name==='matched'&&modeMatches,`${mode}/${name}/${outcome}`);
      assert.equal(projected.receipt.bytesBase64,receiptText.toString('base64'));
      if(name==='mismatch')assert.equal(projected.receipt.reason,'receipt-binding-mismatch');
    }
  }
  for(const mode of [...modes,'rollback']){
    const work=join(root,`native-${mode}`),invocationText=readFileSync(join(work,'release-invocation.json'));
    const invocation=JSON.parse(invocationText),rollback=mode==='rollback';
    const file=rollback?'prepared-target.json':'candidate.json',prepared=JSON.parse(readFileSync(join(work,file)));
    assert.deepEqual(invocation,{repository:run.repository,revision:'a'.repeat(40),run:`https://github.com/${run.repository}/actions/runs/123`,runAttempt:'2',mode});
    assert.deepEqual(prepared,{storePath:'/gnu/store/inert-release',root:'/inert/candidate-root',narSha256:'b'.repeat(64),...invocation});
    assert.equal(existsSync(join(work,rollback?'candidate.json':'prepared-target.json')),false);
    const projected=releaseOutcome({run,machine:'machine',invocationText,
      ...(rollback?{preparedTargetText:readFileSync(join(work,file))}:{candidateText:readFileSync(join(work,file))})});
    assert.equal(projected.invocation.attributed,true);
    assert.equal(projected.candidate.attributed,!rollback,'prepared policy does not claim retained selection');
    assert.equal(projected.receipt.attributed,false);
    if(rollback)assert.deepEqual(projected.preparedTarget.value,prepared);
  }
  for(const mode of ['resolve','rollback']){
    const work=join(root,`${mode}-invocation`);
    const projected=releaseOutcome({run,machine:'machine',invocationText:readFileSync(join(work,'release-invocation.json'))});
    assert.equal(projected.invocation.attributed,true);assert.equal(projected.invocation.value.mode,mode);
    assert.equal(existsSync(join(work,'candidate.json')),false);assert.equal(projected.candidate.attributed,false);
  }
});
