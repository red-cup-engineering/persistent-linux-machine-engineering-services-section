import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

test('installed instance receiving executes through the Guix controller carrier and remains inert on import',t=>{
  const root=mkdtempSync(join(tmpdir(),'instance-receiving-carrier-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  symlinkSync(fileURLToPath(new URL('../',import.meta.url)),join(root,'.controller'));
  const script=join(root,'.controller/scripts/receive-instance.mjs');
  const run=args=>spawnSync(process.execPath,args,{cwd:root,env:{PATH:''},encoding:'utf8',timeout:15000});
  const missing=run([script]);
  assert.equal(missing.status,1,missing.stderr);
  assert.match(missing.stderr,/ERR_INVALID_ARG_TYPE/);
  assert.equal(missing.stdout,'');
  const imported=run(['--input-type=module','--eval',`await import(${JSON.stringify(pathToFileURL(script).href)});`]);
  assert.equal(imported.status,0,imported.stderr);
  assert.equal(imported.stdout,'');assert.equal(imported.stderr,'');
});
