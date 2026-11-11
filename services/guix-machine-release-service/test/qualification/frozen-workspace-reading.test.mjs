// Data-only qualification. This suite never invokes pnpm, Guix, package imports, install or network APIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,readdirSync,lstatSync,realpathSync,existsSync,writeFileSync,cpSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,dirname,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseFrozenYaml,readFrozenWorkspace} from '../../scripts/design-rules.mjs';

const provider=process.env.DRC3_YAML_PACKAGE,output=process.env.ASSAY_OUTPUT;
assert.ok(provider&&output,'explicit DRC3_YAML_PACKAGE and fresh ASSAY_OUTPUT are required');
assert.equal(existsSync(output),false,'qualification needs a fresh output directory');mkdirSync(output,{recursive:true});
const receipt=JSON.parse(readFileSync(new URL('../../specifications/dependency-toolchain.json',import.meta.url),'utf8')).find(r=>r.name==='yaml');
assert.equal(receipt.version,'2.9.0');
const observed=[];
const walk=at=>{for(const entry of readdirSync(resolve(provider,at),{withFileTypes:true})){
  const part=at?at+'/'+entry.name:entry.name;
  assert.equal(entry.isSymbolicLink(),false);if(entry.isDirectory())walk(part);else{assert.ok(entry.isFile());observed.push('package/'+part);}
}};
walk('');assert.deepEqual(observed.sort(),receipt.files.map(row=>row.path).sort());
for(const row of receipt.files){
  const file=resolve(provider,row.path.slice(8));assert.equal(realpathSync(file),file);assert.ok(lstatSync(file).isFile());
  const bytes=readFileSync(file);assert.equal(bytes.length,row.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256);
}
const environment={HOME:output,PATH:dirname(process.execPath),NODE_OPTIONS:process.env.NODE_OPTIONS??''};
const parser=fileURLToPath(new URL('../../scripts/parse-frozen-yaml.mjs',import.meta.url));
const options={yamlCli:join(provider,'bin.mjs'),environment,execute:(program,args,opts)=>{
  assert.equal(program,process.execPath);assert.deepEqual(args,[parser,join(provider,'dist/index.js')]);
  assert.equal(opts.env,environment);return spawnSync(program,args,opts);
}};

test('single-buffer genuine YAML2.9.0 reads a large complete document without pipe-chunk semantics',()=>{
  const entries=Array.from({length:16000},(_,i)=>`  package-${i}:\n    version: '1.0.${i}'\n`),source='importers:\n'+entries.join('');
  assert.ok(Buffer.byteLength(source)>514823);
  const parsed=parseFrozenYaml(source,options);assert.equal(Object.keys(parsed.importers).length,16000);
  assert.deepEqual(parsed.importers['package-15999'],{version:'1.0.15999'});
  writeFileSync(join(output,'large-parser-control.json'),JSON.stringify({bytes:Buffer.byteLength(source),sha256:createHash('sha256').update(source).digest('hex'),entries:16000,node:process.version}));
});

for(const [label,source] of [
  ['empty',''],['comment-only','# no document\n'],['multiple documents','a: 1\n---\nb: 2\n'],
  ['duplicate mapping keys','a: 1\na: 2\n'],['malformed flow','a: [1, 2\n'],['unresolved alias','a: *missing\n'],
])test('strict single-document parser refuses '+label,()=>assert.throws(()=>parseFrozenYaml(source,options),/genuine YAML parser failed/));

test('ordinary valid YAML, anchors and Unicode retain provider semantics',()=>{
  assert.deepEqual(parseFrozenYaml('base: &base {answer: 42}\ncopy: *base\nlabel: "café 🌱"\n',options),
    {base:{answer:42},copy:{answer:42},label:'café 🌱'});
});

test('genuine parser feeds the frozen workspace reader with importer and snapshot source identities',()=>{
  const workspace=join(output,'workspace'),providerName='@fixture/provider',at='packages/@fixture__provider';
  mkdirSync(join(workspace,at),{recursive:true});
  const put=(file,data)=>writeFileSync(join(workspace,file),JSON.stringify(data));
  put('package.json',{private:true,packageManager:'pnpm@10.34.6',dependencies:{registry:'1.0.0'}});
  put(at+'/package.json',{name:providerName,version:'1.0.0'});
  put('pnpm-workspace.yaml',{packages:['packages/*'],overrides:{[providerName]:'workspace:*'}});
  put('pnpm-lock.yaml',{lockfileVersion:'9.0',overrides:{[providerName]:'workspace:*'},
    importers:{'.':{dependencies:{registry:{specifier:'1.0.0',version:'1.0.0'}}},[at]:{}},
    packages:{'registry@1.0.0':{resolution:{integrity:'sha512-'+Buffer.alloc(64).toString('base64')}}},
    snapshots:{'registry@1.0.0':{dependencies:{[providerName]:'link:'+at}}}});
  const before=readFileSync(join(workspace,'pnpm-lock.yaml'),'utf8');
  assert.equal(readFrozenWorkspace({...options,workspace}).lockText,before);
  assert.equal(existsSync(join(workspace,'node_modules')),false);
  assert.equal(readFileSync(join(workspace,'pnpm-lock.yaml'),'utf8'),before);
});


test('existing provider subprocess boundary receives only the exact new parser route',()=>{
  const root=join(output,'boundary-reading'),tooling=join(root,'tooling'),owner=join(tooling,'controller');
  mkdirSync(tooling,{recursive:true});
  cpSync(fileURLToPath(new URL('../../scripts',import.meta.url)),join(owner,'scripts'),{recursive:true});
  cpSync(provider,join(tooling,'yaml'),{recursive:true});
  const boundary=join(tooling,'frozen-provider-boundary.cjs');
  cpSync(fileURLToPath(new URL('../fixtures/frozen-provider-boundary.cjs',import.meta.url)),boundary);
  const env={...environment,NODE_OPTIONS:`--no-addons --no-global-search-paths --require=${boundary}`,
    DRC3_FIXTURE_ROOT:root,DRC3_FIXTURE_PORT:'1',DRC3_FIXTURE_ROLE:'controller',
    DRC3_PNPM_CLI:join(tooling,'unused-pnpm/bin/pnpm.cjs'),DRC3_YAML_CLI:join(tooling,'yaml/bin.mjs'),
    DRC3_GENERATOR:join(tooling,'unused-generator.mjs')};
  const code=`import {parseFrozenYaml} from ${JSON.stringify(pathToFileURL(join(owner,'scripts/design-rules.mjs')).href)};
const data=parseFrozenYaml('answer: 42\\n',{yamlCli:process.env.DRC3_YAML_CLI,environment:process.env});
if(data.answer!==42)throw new Error('wrong parsed value');`;
  const run=source=>spawnSync(process.execPath,['--input-type=module','--eval',source],{env,encoding:'utf8'});
  const good=run(code);assert.equal(good.status,0,good.stderr);
  const events=readFileSync(join(root,'boundary-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e=>e.role==='parser'&&e.event==='initialized').length,1);
  for(const args of [[join(owner,'scripts/parse-frozen-yaml.mjs'),join(tooling,'wrong/index.js')],
    [join(owner,'scripts/parse-frozen-yaml.mjs'),join(tooling,'yaml/dist/index.js'),'unexpected'],
    [join(tooling,'wrong-parser.mjs'),join(tooling,'yaml/dist/index.js')]]){
    const bad=run(`import {spawnSync} from 'node:child_process';spawnSync(process.execPath,${JSON.stringify(args)},{env:process.env});`);
    assert.notEqual(bad.status,0);assert.match(bad.stderr,/unexpected subprocess/);
  }
});
