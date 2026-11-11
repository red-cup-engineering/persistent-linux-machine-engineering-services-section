import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {prepare} from '../scripts/prepare-sources.mjs';

for (const [label,manifest,source] of [
  ['direct SQLite dependency',{dependencies:{sqlite3:'5.0.0'}},'export const ready = true;\n'],
  ['waived builtin SQLite importer',{sqlAdmissionPaths:['index.mjs']},"import {DatabaseSync} from 'node:sqlite';\n"],
]) test('prepare refuses '+label+' before admitting manifests for acquisition',t=>{
  const root=mkdtempSync(join(tmpdir(),'drc3-original-regression-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const put=(file,body)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),typeof body==='string'?body:JSON.stringify(body));};
  const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim();};
  put('package.json',{name:'@fixture/app',version:'1.0.0',exports:'./index.mjs',...manifest});
  put('index.mjs',source);
  git('init','-q');git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  const options={repositories:[{repository:'fixture/app',directory:root,commit:git('rev-parse','HEAD')}],
    entries:['@fixture/app'],output:join(root,'prepared'),manifestsOnly:true};
  assert.throws(()=>prepare(options),/DRC-3 SQLite admission refused/);
  assert.equal(existsSync(options.output),false,'refusal must precede output directory or manifest materialization');
});

