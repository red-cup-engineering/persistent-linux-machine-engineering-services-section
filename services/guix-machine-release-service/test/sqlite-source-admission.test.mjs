import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {sqliteModule,assertNoSqliteManifest,assertNoSqliteSources,closureRules} from '../scripts/design-rules.mjs';

const refused = error => Array.isArray(error.violations) && error.violations.some(v => v.rule === 'drc-3' && v.pdk.includes(1));
const temp = t => {const root=mkdtempSync(join(tmpdir(),'drc3-admission-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;};
const git = (root,...args) => {const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim();};

test('SQLite identities include builtins, subpaths, aliases and peer-qualified snapshots',()=>{
  for(const value of ['node:sqlite','node:sqlite/subpath','sqlite3','npm:sqlite3@^5','@fedify/sqlite@2.3.1',
    'npm:@fedify/sqlite@2.3.1','safe@1.0.0(@fedify/sqlite@2.3.1)','@libsql/client','sql.js@1.0.0'])
    assert.ok(sqliteModule(value),value);
  for(const value of ['safe','sqlite3-helper','@fedify/vocab@2.3.1','postgres-sql',undefined])assert.equal(sqliteModule(value),null);
});

test('direct, optional, required or optional peer declarations and npm aliases are refused',()=>{
  for(const field of ['dependencies','optionalDependencies','peerDependencies']){
    assert.throws(()=>assertNoSqliteManifest({name:'safe',[field]:{'sqlite3':'5.0.0'}}),refused);
    assert.throws(()=>assertNoSqliteManifest({name:'safe',[field]:{storage:'npm:@fedify/sqlite@2.3.1'}}),refused);
  }
  const ordinary={name:'safe',dependencies:{'@fedify/vocab':'2.3.1'},devDependencies:{sqlite3:'5.0.0'}};
  assert.equal(assertNoSqliteManifest(ordinary),ordinary,'registry package development dependencies are not installed');
  for(const field of ['bundledDependencies','bundleDependencies']){
    assert.throws(()=>assertNoSqliteManifest({name:'safe',[field]:['sqlite3']}),refused);
    assert.doesNotThrow(()=>assertNoSqliteManifest({name:'safe',[field]:['ordinary']}));
  }
});

test("shared closure reading takes a workspace provider only from the machine's sources",t=>{
  const root=temp(t);
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'@fixture/app',version:'1.0.0',exports:'./index.mjs',
    dependencies:{'@fixture/provider':'workspace:*'}}));
  writeFileSync(join(root,'index.mjs'),'export const ready = true;\n');
  git(root,'init','-q');git(root,'add','.');git(root,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  const spec={repositories:[{repository:'fixture/app',directory:root,commit:git(root,'rev-parse','HEAD')}],
    entries:['@fixture/app']};
  const missing=/workspace dependency has no home among the machine's sources: @fixture\/app -> @fixture\/provider/;
  assert.throws(()=>closureRules(spec.repositories,spec),missing);
  assert.throws(()=>assertNoSqliteSources(spec),missing);
});

test('strict source admission rejects builtin migration exemptions while retaining dead historical bytes',t=>{
  const root=temp(t);
  const put=(p,v)=>{mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),typeof v==='string'?v:JSON.stringify(v));};
  put('package.json',{name:'@fixture/app',version:'1.0.0',exports:'./index.mjs',sqlAdmissionPaths:['index.mjs']});
  put('index.mjs',"import {DatabaseSync} from 'node:sqlite';\n");
  put('lib/legacy/kept/package.json',{name:'@fixture/app',version:'1.0.0',dependencies:{sqlite3:'5.0.0'}});
  put('lib/legacy/kept/old.mjs',"import 'sqlite3';\n");
  git(root,'init','-q');git(root,'add','.');git(root,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  const spec=()=>({repositories:[{repository:'fixture/app',directory:root,commit:git(root,'rev-parse','HEAD')}],entries:['@fixture/app']});
  assert.throws(()=>assertNoSqliteSources(spec()),refused);
  put('index.mjs','export const value = 1;\n');git(root,'add','index.mjs');git(root,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','native source');
  assert.doesNotThrow(()=>assertNoSqliteSources(spec()));
  assert.match(readFileSync(join(root,'lib/legacy/kept/old.mjs'),'utf8'),/sqlite3/,'retained evidence is neither erased nor executed');
});

