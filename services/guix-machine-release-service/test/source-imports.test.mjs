import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {readSelectedSourceImports} from '../scripts/source-imports.mjs';
import {prepare,command,decodeGitBlobBatch} from '../scripts/prepare-sources.mjs';

// These are explicit AST boundary fixtures, not a substitute JavaScript grammar.
// The real house reader is separately qualified against immutable provider code.
const walk=(node,visit)=>{if(!node||typeof node!=='object')return;if(node.type&&visit(node)===false)return;for(const [key,value] of Object.entries(node))if(key!=='shadowed')if(Array.isArray(value))value.forEach(child=>walk(child,visit));else if(value&&typeof value==='object')walk(value,visit);};
const parser={parseJavaScript:JSON.parse,walkJavaScript:walk,bindJavaScript:program=>{const references=new Map();walk(program,node=>{if(node.type==='CallExpression'&&node.shadowed)references.set(node.callee,{});});return {references};}};
const ast=(...body)=>JSON.stringify({type:'Program',body});
const literal=value=>({type:'Literal',value});
const imported=specifier=>({type:'ImportDeclaration',source:literal(specifier)});
const dynamic=specifier=>({type:'ImportExpression',source:specifier===null?{type:'Identifier',name:'computed'}:literal(specifier)});
const required=(specifier,shadowed=false)=>({type:'CallExpression',callee:{type:'Identifier',name:'require'},arguments:[literal(specifier)],shadowed});
const manifest=(name,exports='./src/index.mjs',dependencies={})=>({name,version:'1.0.0',type:'module',exports,dependencies});
function reading(sources,files,extra={}){
  const selected=new Map(sources.map(([path,manifest])=>[manifest.name,{path,manifest,repository:'example/source',commit:'a'.repeat(40)}]));
  const material={...Object.fromEntries(sources.map(([path,manifest])=>[(path==='.'?'':path+'/')+'package.json',JSON.stringify(manifest)])),...files};
  const entries=Object.entries(material).map(([file,text])=>({file,type:'blob',mode:'100644',oid:createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex')}));
  return readSelectedSourceImports({selected,trees:new Map([['example/source',entries]]),readBlob:(_repo,entry)=>Buffer.from(material[entry.file]),parser,...extra});
}

test('selected runtime exports follow relative cycles and selected provider subpaths without crawling tests',()=>{
  const result=reading([['a',manifest('a','./src/main.mjs',{b:'workspace:*'})],['b',manifest('b',{'./part':'./src/part.mjs'})]],{
    'a/src/main.mjs':ast(imported('./cycle.mjs'),imported('b/part')),'a/src/cycle.mjs':ast(imported('./main.mjs')),
    'a/test/ignored.mjs':ast(imported('unrelated-test-supplier')),'b/src/part.mjs':ast(imported('missing/sub')),
  });
  assert.equal(result.modules.length,3);assert.deepEqual(result.declarationFindings.map(row=>[row.package,row.supplier]),[['b','missing']]);
});

test('unconditional native provider requests refuse absent or explicitly hidden exports',()=>{
  const result=reading([['a',manifest('a','./index.mjs',{b:'workspace:*'})],
    ['b',manifest('b',{'./*':'./src/*.mjs','./hidden':null})]],{
    'a/index.mjs':ast(imported('b/missing/deep'),imported('b/hidden'),imported('b/present')),
    'b/src/present.mjs':ast(),
  });
  assert.deepEqual(result.resolutionFindings.map(row=>row.specifier),['b/hidden']);
  assert.equal(result.resolutionFindings[0].provider.commit,'a'.repeat(40));
  assert.equal(result.resolutionFindings[0].provider.repository,'example/source');
  // A selected wildcard target with absent bytes is a distinct source finding;
  // it is not misreported as an absent export-map entry.
  assert.ok(result.diagnostics.some(row=>row.reason==='runtime-target-not-in-committed-source'));
  const missing=reading([['a',manifest('a','./index.mjs',{b:'workspace:*'})],['b',manifest('b',{'./present':'./index.mjs'})]],{
    'a/index.mjs':ast(imported('b/absent')),'b/index.mjs':ast(),
  });
  assert.deepEqual(missing.resolutionFindings.map(row=>row.specifier),['b/absent']);
});

test('conditional missing provider exports remain diagnostics with their source custody',()=>{
  const result=reading([['a',manifest('a','./index.mjs',{b:'workspace:*'})],['b',manifest('b')]],{
    'a/index.mjs':ast(dynamic('b/optional')),'b/src/index.mjs':ast(),
  });
  assert.deepEqual(result.resolutionFindings,[]);
  assert.ok(result.diagnostics.some(row=>row.reason==='selected-source-export-unavailable'&&row.specifier==='b/optional'&&row.provider.commit==='a'.repeat(40)));
});

test('valid Node array exports are unresolved by the static reader, never false absence',async()=>{
  const result=reading([['a',manifest('a','./index.mjs',{b:'workspace:*'})],
    ['b',manifest('b',{'./part':['./part.mjs']})]],{
    'a/index.mjs':ast(imported('b/part')),'b/part.mjs':ast(),
  });
  assert.deepEqual(result.resolutionFindings,[]);
  assert.ok(result.diagnostics.some(row=>row.reason==='selected-source-export-selection-unresolved'&&row.specifier==='b/part'));
  const root=mkdtempSync(resolve(tmpdir(),'node-array-export-'));
  try{
    mkdirSync(resolve(root,'node_modules/b'),{recursive:true});
    writeFileSync(resolve(root,'node_modules/b/package.json'),JSON.stringify(manifest('b',{'./part':['./part.mjs']})));
    writeFileSync(resolve(root,'node_modules/b/part.mjs'),'export const value=7;');
    writeFileSync(resolve(root,'entry.mjs'),'export {value} from "b/part";');
    assert.equal((await import(new URL('file://'+resolve(root,'entry.mjs')))).value,7);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('nearest nameless and unselected package membranes stop selected ancestor attribution',()=>{
  const result=reading([['.',manifest('outer','./a/index.mjs')]],{'a/package.json':'{}','a/index.mjs':ast(imported('missing'))});
  assert.deepEqual(result.declarationFindings,[]);assert.equal(result.diagnostics[0].reason,'unselected-package-membrane');assert.equal(result.diagnostics[0].membrane,'a');
});

test('a selected nested membrane keeps its original declarations',()=>{
  const result=reading([['.',manifest('outer','./a/index.mjs',{supplier:'1.0.0'})],['a',manifest('inner','./index.mjs')]],{'a/index.mjs':ast(imported('supplier'))});
  assert.deepEqual(result.declarationFindings.map(row=>[row.package,row.supplier]),[['inner','supplier']]);
});

test('active export conditions preserve authored order and ignore browser/types and hidden main',()=>{
  const p={...manifest('a',{'.':{types:'./types.d.mts',browser:'./browser.mjs',default:'./default.mjs',node:'./node.mjs'}}),main:'./main.mjs'};
  const result=reading([['a',p]],Object.fromEntries(['browser','main','node','default'].map(name=>[`a/${name}.mjs`,ast(imported(name+'-supplier'))])));
  assert.deepEqual(result.declarationFindings.map(row=>row.supplier),['default-supplier']);
});

test('wildcard exports and explicit bins seed only declared runtime carriers',()=>{
  const p={...manifest('a',{'./*':'./src/*.mjs'}),bin:{command:'./bin/command.mjs'}};
  const result=reading([['a',p]],{'a/src/a.mjs':ast(),'a/src/b.mjs':ast(),'a/bin/command.mjs':ast(),'a/test/unused.mjs':ast(imported('test-only'))});
  assert.equal(result.modules.length,3);assert.deepEqual(result.declarationFindings,[]);
});

test('exact null and more-specific export patterns shadow wildcard runtime roots',()=>{
  const p=manifest('a',{'./*':'./*.mjs','./private':null,'./hidden/*':null,'./specific/*':'./public/*.mjs'});
  const result=reading([['a',p]],{'a/private.mjs':ast(imported('private-missing')),'a/hidden/file.mjs':ast(imported('hidden-missing')),
    'a/specific/file.mjs':ast(imported('shadowed-missing')),'a/public/file.mjs':ast(),'a/visible.mjs':ast(imported('visible-missing'))});
  assert.deepEqual(result.declarationFindings.map(row=>row.supplier),['visible-missing']);
  assert.ok(!result.modules.some(row=>['private.mjs','hidden/file.mjs','specific/file.mjs'].includes(row.file)));
});

test('a wildcard-only carrier outside declared files is read diagnostically without weakening explicit reachability',()=>{
  const p={...manifest('a',{'./*':'./*'}),files:['src']};
  const files={'a/src/index.mjs':ast(),'a/test/proof.mjs':ast(imported('test-supplier'))};
  const wildcard=reading([['a',p]],files);
  assert.equal(wildcard.modules.length,3);assert.deepEqual(wildcard.declarationFindings,[]);
  assert.ok(wildcard.diagnostics.some(row=>row.reason==='wildcard-only-undeclared-module-request'&&row.supplier==='test-supplier'));
  p.exports['./proof']='./test/proof.mjs';
  assert.ok(reading([['a',p]],files).declarationFindings.some(row=>row.supplier==='test-supplier'));
});

test('dynamic, computed, unproven require, maps, generated output and unsupported syntax stay diagnostic',()=>{
  const p=manifest('a',{'.':'./index.mjs','./generated':'./dist/index.js','./typescript':'./src/index.ts'});
  const result=reading([['a',p]],{'a/index.mjs':ast(dynamic('optional'),dynamic(null),required('unbound'),imported('#local')),'a/src/index.ts':'export const value: number = 1;'});
  assert.deepEqual(result.declarationFindings,[]);
  assert.ok(['conditional-undeclared-module-request','computed-module-request','unbound-esm-require','package-import-map-needs-resolution','runtime-target-not-in-committed-source','unsupported-runtime-source-language'].every(reason=>result.diagnostics.some(row=>row.reason===reason)));
  assert.equal(result.provesCompleteRuntimeClosure,false);
});

test('shadowed require is not a module demand, and CJS requests are not unconditional proof',()=>{
  const result=reading([['a',{...manifest('a','./index.cjs'),type:'commonjs'}]],{'a/index.cjs':ast(required('ordinary-function-argument',true),required('optional'))});
  assert.deepEqual(result.declarationFindings,[]);assert.deepEqual(result.demands.map(row=>row.supplier),['optional']);
});

test('ESM extensionless edges and invalid encoded separators are diagnostics, while URL suffixes retain the source identity',()=>{
  const result=reading([['a',manifest('a')]],{'a/src/index.mjs':ast(imported('./exact.mjs?version=1#part'),imported('./extensionless'),imported('./nested%2ffile.mjs')),'a/src/exact.mjs':ast(imported('real-missing')),'a/src/extensionless.js':ast(imported('not-reached'))});
  assert.deepEqual(result.declarationFindings.map(row=>row.supplier),['real-missing']);
  assert.ok(result.diagnostics.some(row=>row.reason==='runtime-target-not-in-committed-source'));
  assert.ok(result.diagnostics.some(row=>row.reason==='relative-module-url-invalid'));
});

test('selected ambient suppliers do not forgive missing declarations; declared external/source availability remains separate',()=>{
  const p=manifest('a','./index.mjs',{declared:'2.3.0',unavailable:'workspace:*'});
  const result=reading([['a',p],['b',manifest('ambient','./index.mjs')]],{'a/index.mjs':ast(imported('ambient'),imported('declared'),imported('unavailable')),'b/index.mjs':ast()});
  assert.deepEqual(result.declarationFindings.map(row=>row.supplier),['ambient']);
  assert.deepEqual(result.demands.filter(row=>row.declared).map(row=>[row.supplier,row.availability]),[['declared','registry-unchecked'],['unavailable','source-unavailable']]);
});

test('preparation audits committed bytes in manifests-only mode and retains the reading before refusal',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'guix-import-preparation-'));
  try{
    const repo=resolve(root,'repo');mkdirSync(repo);command('git',['init','-q'],repo);
    const write=(path,text)=>{mkdirSync(dirname(resolve(repo,path)),{recursive:true});writeFileSync(resolve(repo,path),text);};
    const parserName='@red-cup-engineering/javascript-node-services-section';
    write('app/package.json',JSON.stringify(manifest('app','./src/index.mjs',{[parserName]:'workspace:*'})));
    write('app/src/index.mjs',ast(imported('missing')));
    write('reader/package.json',JSON.stringify(manifest(parserName,{'./javascript-parser':'./parser.mjs'})));
    write('reader/parser.mjs',`export const parseJavaScript=JSON.parse; export const bindJavaScript=()=>({references:new Map()}); const walk=${walk.toString()}; export const walkJavaScript=walk;`);
    command('git',['add','.'],repo);command('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','immutable fixture'],repo);
    const commit=command('git',['rev-parse','HEAD'],repo);write('app/src/index.mjs',ast());
    const output=resolve(root,'out');
    assert.throws(()=>prepare({repositories:[{directory:repo,repository:'example/source',commit}],entries:['app'],output,manifestsOnly:true}),/Selected runtime imports lack declarations.*missing/);
    const report=JSON.parse(readFileSync(resolve(output,'source-imports.json')));
    assert.equal(report.declarationFindings[0].supplier,'missing');assert.equal(report.reader.commit,commit);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('preparation refuses an absent selected interface before manifest installation, retaining exact evidence',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'guix-interface-preparation-'));
  try{
    const repo=resolve(root,'repo');mkdirSync(repo);command('git',['init','-q'],repo);
    const write=(path,text)=>{mkdirSync(dirname(resolve(repo,path)),{recursive:true});writeFileSync(resolve(repo,path),text);};
    const parserName='@red-cup-engineering/javascript-node-services-section';
    write('app/package.json',JSON.stringify(manifest('app','./index.mjs',{[parserName]:'workspace:*',model:'workspace:*'})));
    write('app/index.mjs',ast(imported('model/type-system')));
    write('model/package.json',JSON.stringify(manifest('model',{'.':'./index.mjs'})));
    write('model/index.mjs',ast());
    write('reader/package.json',JSON.stringify(manifest(parserName,{'./javascript-parser':'./parser.mjs'})));
    write('reader/parser.mjs',`export const parseJavaScript=JSON.parse; export const bindJavaScript=()=>({references:new Map()}); const walk=${walk.toString()}; export const walkJavaScript=walk;`);
    command('git',['add','.'],repo);command('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','immutable fixture'],repo);
    const commit=command('git',['rev-parse','HEAD'],repo),output=resolve(root,'out');
    // An uncommitted repair cannot supply the reviewed interface.
    write('model/package.json',JSON.stringify(manifest('model',{'./type-system':'./index.mjs'})));
    assert.throws(()=>prepare({repositories:[{directory:repo,repository:'example/source',commit}],entries:['app'],output,manifestsOnly:true}),/Selected runtime imports have no exported interface.*model\/type-system/);
    const report=JSON.parse(readFileSync(resolve(output,'source-imports.json')));
    assert.equal(report.resolutionFindings[0].provider.commit,commit);
    assert.equal(report.resolutionFindings[0].provider.path,'model');
    assert.equal(existsSync(resolve(output,'pnpm-workspace.yaml')),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Git batch framing admits exact empty/nonempty blobs and rejects malformed framing',()=>{
  const bytes=Buffer.from('source\n'),oid=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const emptyOid=createHash('sha1').update('blob 0\0').digest('hex');
  const entry={oid,file:'source.mjs'},empty={oid:emptyOid,file:'empty.mjs'};
  const frame=Buffer.concat([Buffer.from(`${oid} blob ${bytes.length}\n`),bytes,Buffer.from('\n')]);
  const emptyFrame=Buffer.from(`${emptyOid} blob 0\n\n`);
  assert.deepEqual(decodeGitBlobBatch(Buffer.concat([frame,emptyFrame]),[entry,empty]).map(row=>row.bytes),[bytes,Buffer.alloc(0)]);
  for(const length of ['-1','1.5','NaN','Infinity','9007199254740992','00','1e1'])
    assert.throws(()=>decodeGitBlobBatch(Buffer.from(`${emptyOid} blob ${length}\n\n`),[empty]),/invalid source blob batch header/);
  assert.throws(()=>decodeGitBlobBatch(Buffer.from(`${emptyOid} blob 0\n`),[empty]),/batch body/);
  assert.throws(()=>decodeGitBlobBatch(Buffer.from(`${emptyOid} blob 0`),[empty]),/batch header/);
  assert.throws(()=>decodeGitBlobBatch(Buffer.concat([emptyFrame,Buffer.from('junk')]),[empty]),/unexpected bytes/);
  assert.throws(()=>decodeGitBlobBatch(frame.subarray(0,-1),[entry]),/batch body/);
  assert.throws(()=>decodeGitBlobBatch(Buffer.from(`${emptyOid} tree 0\n\n`),[empty]),/batch header/);
  assert.throws(()=>decodeGitBlobBatch(Buffer.from(`${emptyOid} blob 1\nx\n`),[empty]),/identity differs/);
});

test('literal runtime vendor closure retains exact carriers and local map without admitting vendor packages',()=>{
  const p=manifest('a','./src/index.mjs');
  const files={
    'a/src/index.mjs':ast(imported('../vendor/house.mjs')),
    'a/vendor/house.mjs':JSON.stringify({type:'Program',body:[imported('./palette.mjs'),dynamic('./lazy.mjs'),imported('./nested/index.mjs')],comments:[{value:'# sourceMappingURL=house.mjs.map'}]}),
    'a/vendor/palette.mjs':ast(imported('./house.mjs')),
    'a/vendor/lazy.mjs':ast(),
    'a/vendor/house.mjs.map':'{"version":3}',
    'a/vendor/unreached.mjs':ast(imported('unrelated')),
    'a/vendor/nested/package.json':'{}',
    'a/vendor/nested/index.mjs':ast(imported('unselected')),
  };
  const result=reading([['a',p]],files);
  assert.deepEqual(result.materializedFiles.map(row=>row.file).sort(),['src/index.mjs','vendor/house.mjs','vendor/house.mjs.map','vendor/lazy.mjs','vendor/palette.mjs']);
  assert.ok(result.materializedFiles.every(row=>/^[a-f0-9]{40}$/u.test(row.gitBlob)));
  assert.deepEqual(result.declarationFindings,[]);
  assert.ok(result.diagnostics.some(row=>row.reason==='unselected-package-membrane'&&row.file==='vendor/nested/index.mjs'));
});

test('vendor parse gaps retain reached bytes and diagnostics but wildcard-only files do not become runtime carriers',()=>{
  const p={...manifest('a',{'./*':'./*','.':'./src/index.mjs'}),files:['src']};
  const result=reading([['a',p]],{
    'a/src/index.mjs':ast(imported('../vendor/reached.mjs')),
    'a/vendor/reached.mjs':'not valid fixture AST',
    'a/vendor/unreached.mjs':ast(),
  });
  assert.ok(result.materializedFiles.some(row=>row.file==='vendor/reached.mjs'));
  assert.ok(!result.materializedFiles.some(row=>row.file==='vendor/unreached.mjs'));
  assert.ok(result.diagnostics.some(row=>row.reason==='source-not-parsed'&&row.file==='vendor/reached.mjs'));
});

test('vendor runtime declaration audit preserves forbidden paths',()=>{
  const result=reading([['a',manifest('a','./index.mjs')]],{
    'a/index.mjs':ast(imported('./vendor/house.mjs'),imported('./node_modules/hidden.mjs'),imported('./legacy/old.mjs')),
    'a/vendor/house.mjs':ast(imported('undeclared-vendor-supplier')),
    'a/node_modules/hidden.mjs':ast(imported('ignored')),
    'a/legacy/old.mjs':ast(imported('ignored')),
  });
  assert.deepEqual(result.declarationFindings.map(row=>row.supplier),['undeclared-vendor-supplier']);
  assert.ok(!result.materializedFiles.some(row=>row.file.startsWith('node_modules/')||row.file.startsWith('legacy/')));
});


test('preparation carries only exact reached vendor files, preserving dirty, untracked and excluded boundaries',()=>{
  const root=mkdtempSync(resolve(tmpdir(),'guix-vendor-preparation-'));
  try{
    const repo=resolve(root,'repo');mkdirSync(repo);command('git',['init','-q'],repo);
    const write=(path,text)=>{mkdirSync(dirname(resolve(repo,path)),{recursive:true});writeFileSync(resolve(repo,path),text);};
    const parserName='@red-cup-engineering/javascript-node-services-section';
    write('app/package.json',JSON.stringify(manifest('app','./src/index.mjs',{[parserName]:'workspace:*'})));
    const entry=ast(imported('../vendor/house.mjs'),imported('../vendor/link.mjs'),imported('../vendor/nested/index.mjs'));
    const house=JSON.stringify({type:'Program',body:[imported('./nested.mjs')],comments:[{value:'# sourceMappingURL=house.mjs.map'}]});
    write('app/src/index.mjs',entry);write('app/vendor/house.mjs',house);
    write('app/vendor/nested.mjs',ast());write('app/vendor/house.mjs.map','{"version":3}');
    write('app/vendor/unreached.mjs',ast());write('app/vendor/nested/package.json','{}');write('app/vendor/nested/index.mjs',ast());
    write('app/node_modules/cache.mjs',ast());write('app/legacy/old.mjs',ast());
    symlinkSync('nested.mjs',resolve(repo,'app/vendor/link.mjs'));
    write('reader/package.json',JSON.stringify(manifest(parserName,{'./javascript-parser':'./parser.mjs'})));
    write('reader/parser.mjs',`export const parseJavaScript=JSON.parse; export const bindJavaScript=()=>({references:new Map()}); const walk=${walk.toString()}; export const walkJavaScript=walk;`);
    command('git',['add','.'],repo);command('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','immutable fixture'],repo);
    const commit=command('git',['rev-parse','HEAD'],repo);
    write('app/vendor/house.mjs','unreviewed checkout bytes');write('app/vendor/untracked.mjs',ast());
    const spec={repositories:[{directory:repo,repository:'example/source',commit}],entries:['app']};
    const output=resolve(root,'out');prepare({...spec,output});
    const target=resolve(output,'packages/app');
    assert.equal(readFileSync(resolve(target,'src/index.mjs'),'utf8'),entry);
    assert.equal(readFileSync(resolve(target,'vendor/house.mjs'),'utf8'),house);
    assert.equal(readFileSync(resolve(target,'vendor/nested.mjs'),'utf8'),ast());
    assert.equal(readFileSync(resolve(target,'vendor/house.mjs.map'),'utf8'),'{"version":3}');
    for(const path of ['vendor/unreached.mjs','vendor/untracked.mjs','vendor/link.mjs','vendor/nested/index.mjs','node_modules/cache.mjs','legacy/old.mjs'])
      assert.equal(existsSync(resolve(target,path)),false,path);
    const lockOutput=resolve(root,'lock');prepare({...spec,output:lockOutput,manifestsOnly:true});
    assert.equal(existsSync(resolve(lockOutput,'packages/app/vendor/house.mjs')),false);
    const evidence=JSON.parse(readFileSync(resolve(lockOutput,'source-imports.json')));
    assert.ok(evidence.materializedFiles.some(row=>row.file==='vendor/house.mjs'));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('source-map provenance admits only committed adjacent regular basename maps',()=>{
  const p=manifest('a','./vendor/house.mjs');
  const source=sourceMappingURL=>JSON.stringify({type:'Program',body:[],comments:[{value:'# sourceMappingURL='+sourceMappingURL}]});
  for(const specifier of ['https://example.invalid/remote.map','../outside.map','nested/inside.map','data:application/json;base64,e30=','bad%2fpath.map','file.map extra']){
    const result=reading([['a',p]],{
      'a/vendor/house.mjs':source(specifier),
      'a/outside.map':'{}','a/vendor/nested/inside.map':'{}','a/vendor/remote.map':'{}','a/vendor/file.map':'{}',
    });
    assert.deepEqual(result.materializedFiles.map(row=>row.file),['vendor/house.mjs'],specifier);
  }
  const missing=reading([['a',p]],{'a/vendor/house.mjs':source('missing.map')});
  assert.deepEqual(missing.materializedFiles.map(row=>row.file),['vendor/house.mjs']);
});


test('proved relative imports cannot cross an independently materialized package boundary',()=>{
  const result=reading([['a',manifest('a','./index.mjs')],['b',manifest('b','./index.mjs')]],{
    'a/index.mjs':ast(imported('../b/index.mjs')),'b/index.mjs':ast(),
  });
  assert.equal(result.resolutionFindings.length,1);
  assert.equal(result.resolutionFindings[0].reason,'relative-module-outside-materialized-package');
  assert.equal(result.resolutionFindings[0].package,'a');
  assert.equal(result.resolutionFindings[0].specifier,'../b/index.mjs');
  assert.equal(result.resolutionFindings[0].proven,true);
  assert.ok(!result.diagnostics.some(row=>row.reason==='relative-module-outside-materialized-package'));
});

test('conditional cross-package relative imports retain uncertainty rather than claiming a proved edge',()=>{
  const result=reading([['a',manifest('a','./index.mjs')],['b',manifest('b','./index.mjs')]],{
    'a/index.mjs':ast(dynamic('../b/index.mjs')),'b/index.mjs':ast(),
  });
  assert.deepEqual(result.resolutionFindings,[]);
  assert.ok(result.diagnostics.some(row=>row.reason==='relative-module-outside-materialized-package'&&row.proven===false));
});
