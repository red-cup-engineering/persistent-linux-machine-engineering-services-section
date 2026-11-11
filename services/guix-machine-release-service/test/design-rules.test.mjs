import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {closureRules,entryGuardReader,exportNames,exportedModules,legacyKept,oneOwner,ratchet,readDesignRules,sqlModule,wiringKey,wiringReader} from '../scripts/design-rules.mjs';

const big=label=>`// ${label}\n`+'export const filler = 1;\n'.repeat(60);
function repository(t,name,files){
  const root=mkdtempSync(join(tmpdir(),'design-rules-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=(...a)=>spawnSync('git',a,{cwd:root,encoding:'utf8'});
  git('init','-q');
  for(const [path,text] of Object.entries(files)){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),typeof text==='string'?text:JSON.stringify(text));}
  git('add','.');git('-c','user.name=f','-c','user.email=f@example.invalid','commit','-qm','f');
  return {directory:root,repository:name,commit:git('rev-parse','HEAD').stdout.trim(),git};
}

test('SQL modules are recognised by name and subpath', ()=>{
  assert.equal(sqlModule('node:sqlite'),'node:sqlite');assert.equal(sqlModule('drizzle-orm/sqlite-core'),'drizzle-orm');
  assert.equal(sqlModule('@libsql/client'),'@libsql');assert.equal(sqlModule('pgx'),null);assert.equal(sqlModule('postgres-sql'),null);
});

test('the deck reads one-owner, SQL and copied-file violations from committed sources', t=>{
  const a=repository(t,'a/one',{
    'package.json':{name:'@a/app',version:'1.0.0',dependencies:{'@a/lib':'workspace:*'},sqlAdmissionPaths:['src/import-old.mjs']},
    'src/store.mjs':"import {DatabaseSync} from 'node:sqlite';\nconst pg = await import('pg');\n",
    'src/import-old.mjs':"import {DatabaseSync} from 'node:sqlite';\n",
    'src/ledger.mjs':"const {DatabaseSync} = process.getBuiltinModule(\"node:sqlite\");\n",
    'src/notes.mjs':"// `getBuiltinModule('node:sqlite')` is read like an import.\n/**\n * An old store did `import {DatabaseSync} from 'node:sqlite'`.\n */\nexport const notes = 1;\n",
    'src/shared.mjs':big('shared'),
    'test/store.test.mjs':"import 'better-sqlite3';\n",
    'dup/package.json':{name:'@a/twice',version:'1.0.0'},
  });
  const b=repository(t,'a/two',{'package.json':{name:'@a/lib',version:'1.0.0'},'src/copy.mjs':big('other'),'twice/package.json':{name:'@a/twice',version:'1.0.0'}});
  const repositories=[a,b];
  assert.deepEqual(oneOwner(repositories).map(v=>v.key),['drc-2:@a/twice']);
  const closure=closureRules(repositories,{entries:['@a/app']});
  assert.deepEqual(closure.violations.filter(v=>v.rule==='drc-3').map(v=>v.key),['drc-3:@a/app:src/ledger.mjs:node:sqlite','drc-3:@a/app:src/store.mjs:node:sqlite','drc-3:@a/app:src/store.mjs:pg']);
  const copies=closure.violations.filter(v=>v.rule==='copy');
  assert.equal(copies.length,0,'different bytes are not a copy');
  assert.equal(closure.misfold,'unread','DRC-6 is not read without a misfold reader');
  assert.equal(closure.violations.filter(v=>v.rule==='drc-6').length,0);
  const c=repository(t,'a/three',{'package.json':{name:'@a/lib',version:'1.0.0'},'src/copy.mjs':big('shared')});
  const exact=closureRules([{...a},c],{entries:['@a/app']}).violations.filter(v=>v.rule==='copy');
  assert.equal(exact.length,1);assert.match(exact[0].key,/^copy:[0-9a-f]{40}$/);assert.deepEqual(exact[0].at,['@a/app:src/shared.mjs','@a/lib:src/copy.mjs']);
  const reading=readDesignRules({repositories:[a,c],entries:['@a/app']});
  assert.equal(reading.kind,'design-rule-reading');assert.ok(reading.violations.some(v=>v.rule==='copy'));
});

test('DRC-6 asks the misfold reader about each exported operation module, and only those', t=>{
  const a=repository(t,'a/one',{
    'package.json':{name:'@a/app',version:'1.0.0',exports:{'.':'./src/index.mjs','./op':{import:'./src/op.mjs'},'./data':'./data/x.json'},dependencies:{'@a/lib':'workspace:*'}},
    'src/index.mjs':"export { lift as op } from '@a/lib';\n",
    'src/op.mjs':"import { lift } from '@a/lib';\nexport const op = lift;\nexport function own(x) { return x + 1; }\n",
    'src/internal.mjs':"export { lift } from '@a/lib';\n",
    'test/op.test.mjs':"export { lift } from '@a/lib';\n",
  });
  const b=repository(t,'a/two',{'package.json':{name:'@a/lib',version:'1.0.0',exports:{'.':'./src/lib.mjs'}},'src/lib.mjs':'export const lift = (x) => x;\n'});
  const asked=[];
  // Stands in for misfoldsOfModule: an alias or re-export of a dependency binding is a misfold.
  const misfolds=(text,file)=>{asked.push(file);return [...text.matchAll(/export (?:\{ \w+ as (\w+) \} from|const (\w+) = lift)/gu)].map(m=>({export:m[1]??m[2],kind:m[1]?'re-export':'alias',dependency:'@a/lib'}));};
  const closure=closureRules([a,b],{entries:['@a/app'],misfolds});
  assert.equal(closure.misfold,'read');
  assert.deepEqual(asked.sort(),['src/index.mjs','src/lib.mjs','src/op.mjs']);
  assert.deepEqual(closure.violations.filter(v=>v.rule==='drc-6').map(v=>v.key),['drc-6:@a/app:src/index.mjs:op','drc-6:@a/app:src/op.mjs:op']);
  assert.equal(closure.violations.find(v=>v.key==='drc-6:@a/app:src/op.mjs:op').shape,'alias');
});

test('exported modules and export names are read from the manifest and the module tree', ()=>{
  assert.deepEqual([...exportedModules({exports:{'.':'./src/a.mjs','./b':{import:'./src/b.mjs',types:'./b.d.ts'},'./c/*':'./src/c/*.mjs','./p':'./package.json'}})].sort(),['src/a.mjs','src/b.mjs']);
  assert.deepEqual([...exportedModules({main:'index.js'})],['index.js']);
  const program={body:[
    {type:'ExportNamedDeclaration',specifiers:[{exported:{name:'a'}},{exported:{value:'b-c'}}]},
    {type:'ExportNamedDeclaration',specifiers:[],declaration:{type:'FunctionDeclaration',id:{name:'f'}}},
    {type:'ExportNamedDeclaration',specifiers:[],declaration:{type:'VariableDeclaration',declarations:[{id:{type:'Identifier',name:'v'}},{id:{type:'ObjectPattern'}}]}},
    {type:'ImportDeclaration'},
  ]};
  assert.deepEqual(exportNames(program),['a','b-c','f','v']);
});

test('a legacy deletion needs a migration-ledger entry naming it', t=>{
  const r=repository(t,'a/one',{'lib/legacy/old.mjs':'old\n','lib/legacy/kept.mjs':'kept\n','src/live.mjs':'live\n'});
  const from=r.commit;
  r.git('rm','-q','lib/legacy/old.mjs','lib/legacy/kept.mjs','src/live.mjs');
  mkdirSync(join(r.directory,'data'),{recursive:true});
  writeFileSync(join(r.directory,'data/migration-ledger.jsonl'),JSON.stringify({moved:'lib/legacy/kept.mjs',owner:'a/owner'})+'\n');
  r.git('add','.');r.git('-c','user.name=f','-c','user.email=f@example.invalid','commit','-qm','delete');
  const to=r.git('rev-parse','HEAD').stdout.trim();
  assert.deepEqual(legacyKept(r.directory,'a/one',from,to).map(v=>v.key),['drc-7:a/one:lib/legacy/old.mjs']);
});

test('the ratchet refuses only what the change adds', ()=>{
  const v=key=>({key});
  assert.deepEqual(ratchet([v('x'),v('y')],[v('y'),v('z')]),{added:[v('z')],removed:['x']});
});

test('every violation names the design-kit rule it enforces, and the kit adds law, wiring and assertion checks', async t=>{
  const {PDK,PDK_RULES,assertedFacts,unpinnedLawReads}=await import('../scripts/design-rules.mjs');
  for(const rules of Object.values(PDK))for(const n of rules)assert.ok(PDK_RULES[n],`PDK rule ${n} is cited`);
  assert.deepEqual(unpinnedLawReads("const law = readFileSync(fileURLToPath(import.meta.resolve('@red-cup-engineering/x/law.json')));"),['@red-cup-engineering/x/law.json']);
  assert.deepEqual(unpinnedLawReads("import law from '@red-cup-engineering/x/law.json' with {type:'json'};"),['@red-cup-engineering/x/law.json']);
  assert.deepEqual(unpinnedLawReads("const p = import.meta.resolve('@red-cup-engineering/x/law.json'); if (createHash('sha256').update(read(p)).digest('hex') !== PIN) throw refuse();"),[]);
  assert.deepEqual(unpinnedLawReads("import.meta.resolve('lodash/x.json')"),[]);
  assert.deepEqual(assertedFacts({status:'healthy',health:{ok:true},value:3}),['health','status']);
  assert.deepEqual(assertedFacts({status:'draft',kind:'record'}),[]);
  const r=repository(t,'red-cup-engineering/one',{
    'package.json':{name:'@red-cup-engineering/app',version:'1.0.0',dependencies:{'@red-cup-engineering/used':'workspace:*','@red-cup-engineering/declared-only':'workspace:*'}},
    'src/index.mjs':"import {x} from '@red-cup-engineering/used/x';\nimport law from '@red-cup-engineering/used/law.json' with {type:'json'};\n",
    'data/records/latest.json':{status:'ok',checkedAt:'2026-10-10'},
    'test/fixtures/status.json':{status:'ok'},
    'used/package.json':{name:'@red-cup-engineering/used',version:'1.0.0',exports:{'./x':'./x.mjs'}},'used/x.mjs':'export const x=1;\n',
    'declared/package.json':{name:'@red-cup-engineering/declared-only',version:'1.0.0'},
  });
  const v=closureRules([r],{entries:['@red-cup-engineering/app']}).violations.filter(v=>v.rule.startsWith('pdk-'));
  assert.deepEqual(v.map(x=>[x.key,x.pdk[0]]),[
    ['pdk-3:@red-cup-engineering/app:src/index.mjs:@red-cup-engineering/used/law.json',3],
    ['pdk-4:@red-cup-engineering/app:@red-cup-engineering/declared-only',4],
    ['pdk-7:@red-cup-engineering/app:data/records/latest.json:status',7]]);
});

test('STD-ONE-LOG: raw journal rows and hand-appended JSONL outside the owners are violations, keyed per file', t=>{
  const app=repository(t,'a/app',{
    'package.json':{name:'@a/app',version:'1.0.0'},
    'src/rows.mjs':"import {appendSeavtEntries} from '@red-cup-engineering/semiotic-eavt-services-section/append-seavt-entries';\nappendSeavtEntries({root, feed, entries, at});\n",
    'src/log.mjs':"import {appendSeavt} from '@red-cup-engineering/witness-journal-log-service';\nexport const keep = (root, rows) => appendSeavt(root, 'feed', rows, 'now');\n",
    'src/receipts.mjs':"import {appendFileSync} from 'node:fs';\nappendFileSync(join(root, 'receipts.jsonl'), line);\n",
    'src/recorded.mjs':"import {recordSemanticRecord} from '@red-cup-engineering/semiotic-eavt-services-section/record-semantic-record';\n// an older release called appendSeavt(root, feed, rows) here\nrecordSemanticRecord({root, objectKind, category, record, recordedAt, told});\n",
    'test/rows.test.mjs':"appendSeavtEntries({root});\n",
    'lib/legacy/old.mjs':"appendSeavt(root, 'feed', rows, 'now');\n",
  });
  const owner=repository(t,'red-cup-engineering/computer-data-services-section',{
    'package.json':{name:'@red-cup-engineering/semiotic-eavt-services-section',version:'0.1.0'},
    'src/append-seavt-entries.mjs':"export function appendSeavtEntries(){ return appendSeavt(root, feed, rows, at); }\n",
  });
  const adjacent=repository(t,'red-cup-engineering/semiotic-software-services-section',{
    'services/witness-journal-services-section/services/witness-journal-record-service/package.json':{name:'@red-cup-engineering/witness-journal-record-service',version:'0.1.0'},
    'services/witness-journal-services-section/services/witness-journal-record-service/src/index.mjs':"import {appendSeavt} from '@red-cup-engineering/witness-journal-log-service';\n",
  });
  const repositories=[app,owner,adjacent];
  const keys=closureRules(repositories,{entries:['@a/app','@red-cup-engineering/semiotic-eavt-services-section','@red-cup-engineering/witness-journal-record-service']}).violations
    .filter(v=>v.rule==='one-log'||v.rule==='journal-hand-append').map(v=>v.key);
  assert.deepEqual(keys,[
    'journal-hand-append:@a/app:src/receipts.mjs',
    'one-log:@a/app:src/log.mjs:appendSeavt',
    'one-log:@a/app:src/log.mjs:witness-journal-log-service',
    'one-log:@a/app:src/rows.mjs:appendSeavt',
  ]);
  const base=closureRules(repositories,{entries:['@a/app']}).violations;
  const head=[...base,{rule:'one-log',key:'one-log:@a/app:src/new.mjs:appendSeavt'}];
  assert.deepEqual(ratchet(base,head).added.map(v=>v.key),['one-log:@a/app:src/new.mjs:appendSeavt']);
  assert.deepEqual(ratchet(head,base.filter(v=>v.key!=='one-log:@a/app:src/rows.mjs:appendSeavt')).removed.includes('one-log:@a/app:src/rows.mjs:appendSeavt'),true);
});

test('PDK-4 reads the wiring owner\'s sync over runtime and test code, keeping the imports-only key for an unused declaration', t=>{
  const R='@red-cup-engineering/';
  const r=repository(t,'red-cup-engineering/one',{
    'package.json':{name:`${R}app`,version:'1.0.0',dependencies:{[`${R}used`]:'workspace:*',[`${R}unused`]:'workspace:*',[`${R}tested`]:'workspace:*'}},
    'src/index.mjs':`import '${R}used';\n`,
    'test/index.test.mjs':`import '${R}tested';\n`,
    ...Object.fromEntries(['used','unused','tested'].map(n=>[`${n}/package.json`,{name:`${R}${n}`,version:'1.0.0'}])),
  });
  const seen=[];
  // A minimal owner reader: runtime imports stay, test-only ones move, the rest are removed.
  const wiring={
    importsOfFiles:(code)=>{seen.push(...code.map(c=>c.path).sort());const of=(test)=>new Map(code.filter(c=>c.path.startsWith('test/')===test).flatMap(c=>[...c.text.matchAll(/'(@[^']+)'/g)].map(m=>[m[1],[c.path]])));return {runtime:of(false),test:of(true)};},
    syncPackageManifest:(manifest,{runtime,test})=>({changes:Object.keys(manifest.dependencies).filter(d=>!runtime.has(d)).map(d=>test.has(d)?{dependency:d,action:'moved-to-devDependencies',from:'dependencies'}:{dependency:d,action:'removed',from:'dependencies'})}),
  };
  const v=closureRules([r],{entries:[`${R}app`],wiring}).violations.filter(x=>x.rule==='pdk-4');
  assert.deepEqual(seen,['src/index.mjs','test/index.test.mjs']);
  assert.deepEqual(v.map(x=>[x.key,x.action]),[[`pdk-4:${R}app:${R}tested`,'moved-to-devDependencies'],[`pdk-4:${R}app:${R}unused`,'removed']]);
  assert.equal(wiringKey('p',{dependency:'d',action:'removed',from:'devDependencies'}),'pdk-4:p:d:dev-unused');
  assert.equal(wiringKey('p',{dependency:'d',action:'added',to:'dependencies'}),'pdk-4:p:d:undeclared');
  assert.equal(wiringKey('p',{dependency:'d',action:'moved-to-dependencies',from:'devDependencies'}),'pdk-4:p:d:runtime-in-dev');
});

test('the wiring reader is the owner\'s committed modules, or nothing when the owner predates them', async t=>{
  const owner='@red-cup-engineering/jsnode-package-services-section';
  const withReader=repository(t,'red-cup-engineering/coding',{
    'services/jsnode/package.json':{name:owner,version:'1.0.0'},
    'services/jsnode/src/package-imports.mjs':'export const importsOfFiles = () => "owner imports";\n',
    'services/jsnode/src/sync-package-manifest.mjs':'import "./package-imports.mjs";\nexport const syncPackageManifest = () => "owner sync";\n',
  });
  const wiring=await wiringReader([withReader]);
  assert.equal(wiring.importsOfFiles(),'owner imports');
  assert.equal(wiring.syncPackageManifest(),'owner sync');
  assert.equal(wiring.owner,`red-cup-engineering/coding@${withReader.commit}`);
  const older=repository(t,'red-cup-engineering/coding',{'services/jsnode/package.json':{name:owner,version:'1.0.0'},'services/jsnode/src/misfold.mjs':'export {};\n'});
  assert.equal(await wiringReader([older]),null);
});

test('one wiring reader for base and head: an unchanged tree adds and removes no PDK-4 key, whichever deck reads it', t=>{
  const R='@red-cup-engineering/';
  const r=repository(t,'red-cup-engineering/one',{
    'package.json':{name:`${R}app`,version:'1.0.0',dependencies:{[`${R}used`]:'workspace:*',[`${R}unused`]:'workspace:*'}},
    'src/index.mjs':`import '${R}used';\n`,'test/index.test.mjs':`import '${R}also-tested';\n`,
    ...Object.fromEntries(['used','unused'].map(n=>[`${n}/package.json`,{name:`${R}${n}`,version:'1.0.0'}])),
  });
  const wiring={
    importsOfFiles:(code)=>({runtime:new Map(code.filter(c=>c.path.startsWith('src/')).map(c=>[`${R}used`,[c.path]])),test:new Map([[`${R}also-tested`,['test/index.test.mjs']]])}),
    syncPackageManifest:(manifest)=>({changes:[{dependency:`${R}unused`,action:'removed',from:'dependencies'},{dependency:`${R}also-tested`,action:'added',to:'devDependencies'}]}),
  };
  const read=(w)=>closureRules([r],{entries:[`${R}app`],wiring:w}).violations;
  // The change test reads base and head with the same reader, so the deck change itself is never `added`.
  for(const w of [undefined,wiring]) assert.deepEqual(ratchet(read(w),read(w)),{added:[],removed:[]});
  assert.ok(read(wiring).some(v=>v.key===`pdk-4:${R}app:${R}also-tested:test-undeclared`));
});

test('STD-ENTRY asks the entry-guard reader about runtime code that reads argv[1], outside the owner and tests', t=>{
  const a=repository(t,'a/one',{
    'package.json':{name:'@a/app',version:'1.0.0',dependencies:{'@red-cup-engineering/node-process-services-section':'workspace:*'}},
    'scripts/run.mjs':"if (import.meta.url === `file://${process.argv[1]}`) main();\n",
    'scripts/fixed.mjs':"import { isEntryModule } from '@red-cup-engineering/node-process-services-section/entrypoint';\nif (isEntryModule(import.meta.url)) main();\n",
    'scripts/dispatch.mjs':"const op = process.argv[1].split('/').pop();\n",
    'test/run.test.mjs':"if (import.meta.url === `file://${process.argv[1]}`) main();\n",
  });
  const owner=repository(t,'r/coding',{'package.json':{name:'@red-cup-engineering/node-process-services-section',version:'1.0.0'},
    'src/entrypoint.mjs':"export const isEntryModule = (url, argv1 = process.argv[1]) => argv1 === url;\n"});
  const asked=[];
  // Stands in for findEntryGuards: a template-literal comparison of argv[1] with import.meta.url is a guard.
  const entryGuards=(text,file)=>{asked.push(file);return /import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`/u.test(text)?[{symlinkBlind:true}]:[];};
  const closure=closureRules([a,owner],{entries:['@a/app'],entryGuards});
  assert.equal(closure.stdEntry,'read');
  assert.deepEqual(asked.sort(),['scripts/dispatch.mjs','scripts/run.mjs'],'only runtime files reading argv[1], never the owner or a test');
  assert.deepEqual(closure.violations.filter(v=>v.rule==='std-entry').map(v=>[v.key,v.symlinkBlind]),[['std-entry:@a/app:scripts/run.mjs',1]]);
  assert.equal(closureRules([a,owner],{entries:['@a/app']}).stdEntry,'unread');
  // A founder-held package's guard stays counted and keyed, marked held.
  const held=repository(t,'r/money',{'package.json':{name:'@red-cup-engineering/brokerage-control-api-federation',version:'1.0.0'},
    'src/loop.mjs':"if (import.meta.url === `file://${process.argv[1]}`) trade();\n"});
  const withHeld=closureRules([held],{entries:['@red-cup-engineering/brokerage-control-api-federation'],entryGuards}).violations.filter(v=>v.rule==='std-entry');
  assert.deepEqual(withHeld.map(v=>[v.key,v.held]),[['std-entry:@red-cup-engineering/brokerage-control-api-federation:src/loop.mjs','founder']]);
  // Rewriting a guard removes its violation; adding one is what the ratchet refuses.
  const keys=closure.violations.map(v=>({key:v.key}));
  assert.deepEqual(ratchet(keys,[]),{added:[],removed:['std-entry:@a/app:scripts/run.mjs']});
});

test('the entry-guard reader is the owner codemod\'s findEntryGuards, from the composed workspace, or null', async t=>{
  const root=mkdtempSync(join(tmpdir(),'std-entry-reader-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'node/src'),{recursive:true});
  writeFileSync(join(root,'node/package.json'),JSON.stringify({name:'@red-cup-engineering/javascript-node-services-section',exports:{'./std-entry':'./src/std-entry.mjs'}}));
  writeFileSync(join(root,'node/src/std-entry.mjs'),"export const findEntryGuards = (text) => { if (text.includes('(')) throw new SyntaxError('x'); return { guards: text.includes('argv') ? [{ symlinkBlind: true }] : [] }; };\n");
  const reader=await entryGuardReader(name=>name==='@red-cup-engineering/javascript-node-services-section'?join(root,'node'):null);
  assert.deepEqual(reader('process.argv'),[{symlinkBlind:true}]);
  assert.deepEqual(reader('plain'),[]);
  assert.deepEqual(reader('unparsable ('),[{symlinkBlind:true,unparsed:true}],'a module the parser cannot read is never passed over');
  assert.equal(await entryGuardReader(()=>join(root,'missing')),null);
});
