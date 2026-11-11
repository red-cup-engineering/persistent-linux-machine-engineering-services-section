// Synthetic registry and existing synthetic host controls around genuine owner/tooling source.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync,lstatSync,realpathSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';

export const controllerName='@red-cup-engineering/guix-machine-release-service';
export const parserName='@red-cup-engineering/javascript-node-services-section';
const metroName='@red-cup-engineering/metroplat',hostName='@red-cup-engineering/feltos-enterprise-host';
const sourceRoot=fileURLToPath(new URL('../../',import.meta.url));
export function put(path,body){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof body==='string'?body:JSON.stringify(body,null,2)+'\n');}
function copyVerified(directory,receiptPath,target,name,version){
  const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
  assert.equal(receipt.name,name);assert.equal(receipt.version,version);
  const actual=[];
  const walk=(at,parts=[])=>{for(const entry of readdirSync(at,{withFileTypes:true})){
    assert.ok(!entry.isSymbolicLink(),'provider ancestry contains no links');
    const next=[...parts,entry.name];
    if(entry.isDirectory())walk(join(at,entry.name),next);
    else{assert.ok(entry.isFile(),'provider contains only regular files');actual.push(next.join('/'));}
  }};
  walk(directory);
  assert.deepEqual(actual.sort(),receipt.files.map(entry=>entry.path.slice(8)).sort(),'no unreviewed files may enter the isolated provider');
  for(const entry of receipt.files){
    assert.ok(entry.path.startsWith('package/'));const part=entry.path.slice(8);
    assert.ok(part&&!part.split('/').includes('..'));
    const path=join(directory,part),stat=lstatSync(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink());
    const bytes=readFileSync(path);assert.equal(bytes.length,entry.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256,entry.path);
  }
  cpSync(directory,target,{recursive:true,verbatimSymlinks:true});
  return receipt;
}
function inertArchive(){
  const files={
    'package/package.json':JSON.stringify({name:'drc3-inert',version:'1.0.0',main:'index.cjs',description:'Synthetic non-SQL qualification control'}),
    'package/index.cjs':"module.exports = 'synthetic-inert';\n",
  },chunks=[];
  for(const [name,text] of Object.entries(files)){
    const bytes=Buffer.from(text),header=Buffer.alloc(512);
    const field=(at,length,value)=>header.write(value,at,length,'ascii');
    field(0,100,name);field(100,8,'0000644\0');field(108,8,'0000000\0');field(116,8,'0000000\0');
    field(124,12,bytes.length.toString(8).padStart(11,'0')+'\0');field(136,12,'00000000000\0');
    field(148,8,'        ');field(156,1,'0');field(257,6,'ustar\0');field(263,2,'00');
    const checksum=header.reduce((sum,value)=>sum+value,0);field(148,8,checksum.toString(8).padStart(6,'0')+'\0 ');
    chunks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));
}
const sri=bytes=>'sha512-'+createHash('sha512').update(bytes).digest('base64');
const sorted=object=>Object.fromEntries(Object.entries(object).sort(([a],[b])=>a<b?-1:a>b?1:0));

export async function providerFixture(t){
  const required=['DRC3_PNPM_PACKAGE','DRC3_PNPM_RECEIPT','DRC3_YAML_PACKAGE','DRC3_YAML_RECEIPT','DRC3_YAML_ARCHIVE'];
  const inputs=Object.fromEntries(required.map(name=>{assert.ok(process.env[name],`${name} is required`);return[name,process.env[name]];}));
  const root=mkdtempSync(join(tmpdir(),'guix-frozen-provider-')),tooling=join(root,'tooling');
  const pnpmRoot=join(tooling,'pnpm'),yamlRoot=join(tooling,'yaml'),owner=join(tooling,'controller');
  const groups=new Set(),requests=[],unexpected=[];
  const stopGroup=pid=>{try{process.kill(-pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}groups.delete(pid);};
  t.after(()=>{for(const pid of groups)stopGroup(pid);rmSync(root,{recursive:true,force:true});});
  copyVerified(inputs.DRC3_PNPM_PACKAGE,inputs.DRC3_PNPM_RECEIPT,pnpmRoot,'pnpm','10.34.6');
  const yamlReceipt=copyVerified(inputs.DRC3_YAML_PACKAGE,inputs.DRC3_YAML_RECEIPT,yamlRoot,'yaml','2.9.0');
  cpSync(join(sourceRoot,'scripts'),join(owner,'scripts'),{recursive:true,verbatimSymlinks:true});
  const boundary=join(tooling,'frozen-provider-boundary.cjs');
  cpSync(new URL('./frozen-provider-boundary.cjs',import.meta.url),boundary);
  const pnpmCli=join(pnpmRoot,'bin/pnpm.cjs'),yamlCli=join(yamlRoot,'bin.mjs');
  const synthetic=inertArchive(),yamlBytes=readFileSync(inputs.DRC3_YAML_ARCHIVE);
  assert.equal(sri(yamlBytes),yamlReceipt.integrity,'the installed parser archive is the exact inspected official artifact');
  const archives=new Map([['/-/drc3-inert-1.0.0.tgz',synthetic],['/-/yaml-2.9.0.tgz',yamlBytes]]);
  const server=createServer((req,res)=>{
    requests.push({method:req.method,path:req.url});
    if(req.method!=='GET'||!archives.has(req.url)){unexpected.push(req.url);res.writeHead(410);res.end('fixture route refused');return;}
    res.setHeader('content-type','application/octet-stream');res.end(archives.get(req.url));
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const port=server.address().port,base=`http://127.0.0.1:${port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));console.log(JSON.stringify({fixture:t.name,requests,unexpected}));});
  let serial=0;
  function workspace(){
    const caseRoot=join(root,`case-${++serial}`),work=join(caseRoot,'workspace');
    const providers=Object.fromEntries([controllerName,parserName,metroName,hostName].map(name=>[name,join(work,'packages',name.replaceAll('/','__'))]));
    const manifests={'.':{name:'drc3-fixture-root',private:true,packageManager:'pnpm@10.34.6',dependencies:{'drc3-inert':'1.0.0',yaml:'2.9.0'}}};
    for(const [name,path] of Object.entries(providers)){
      const key=relative(work,path);manifests[key]={name,version:'0.0.0-fixture',type:'module',
        ...(name===parserName?{exports:{'./javascript-parser':'./parser.mjs'}}:{}),
        ...(name===controllerName?{dependencies:{[parserName]:'workspace:*'}}:{})};
    }
    for(const [at,manifest] of Object.entries(manifests))put(join(work,at,'package.json'),manifest);
    put(join(providers[parserName],'parser.mjs'),'export const parseJavaScript=source=>({source,fixture:true});\n');
    put(join(providers[controllerName],'src/receiver.mjs'),`import {parseJavaScript} from '${parserName}/javascript-parser';\nimport inert from 'drc3-inert';\nexport const reading={...parseJavaScript('relocated'),inert};\n`);
    put(join(providers[metroName],'scripts/generate-operation-family-descriptors.mjs'),'// Existing synthetic assembler control: generates no catalog or runtime bytes.\n');
    put(join(providers[hostName],'index.mjs'),'export const fixture=true;\n');
    const config={packages:['packages/*'],linkWorkspacePackages:true,preferWorkspacePackages:true,autoInstallPeers:false,ignoreScripts:true};
    put(join(work,'pnpm-workspace.yaml'),config);
    const importers={};
    for(const [at,manifest] of Object.entries(sorted(manifests))){
      const node={};
      if(manifest.dependencies)node.dependencies=sorted(Object.fromEntries(Object.entries(manifest.dependencies).map(([name,specifier])=>[name,{specifier,
        version:specifier==='workspace:*'?'link:'+relative(resolve(work,at),providers[name]):specifier}])));
      importers[at]=node;
    }
    const lock={lockfileVersion:'9.0',settings:{autoInstallPeers:false,excludeLinksFromLockfile:false},importers,
      packages:{'drc3-inert@1.0.0':{resolution:{integrity:sri(synthetic),tarball:base+'/-/drc3-inert-1.0.0.tgz'}},
        'yaml@2.9.0':{resolution:{integrity:sri(yamlBytes),tarball:base+'/-/yaml-2.9.0.tgz'}}},snapshots:{'drc3-inert@1.0.0':{},'yaml@2.9.0':{}}};
    put(join(work,'pnpm-lock.yaml'),lock);
    const home=join(caseRoot,'home');mkdirSync(home,{recursive:true});
    put(join(home,'empty-npmrc'),'');
    const env={PATH:dirname(process.execPath)+':/usr/bin:/bin',HOME:home,TMPDIR:caseRoot,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',
      XDG_CONFIG_HOME:join(home,'config'),XDG_CACHE_HOME:join(home,'cache'),XDG_DATA_HOME:join(home,'data'),XDG_STATE_HOME:join(home,'state'),
      npm_config_userconfig:join(home,'empty-npmrc'),npm_config_globalconfig:join(home,'empty-npmrc'),
      npm_config_manage_package_manager_versions:'false',NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS:'false',
      npm_config_update_notifier:'false',NO_UPDATE_NOTIFIER:'1',DO_NOT_TRACK:'1',CI:'true',NODE_DISABLE_COMPILE_CACHE:'1',
      NODE_OPTIONS:`--no-addons --no-global-search-paths --require=${boundary}`,
      DRC3_FIXTURE_ROOT:root,DRC3_FIXTURE_PORT:String(port),DRC3_FIXTURE_ROLE:'controller',
      DRC3_PNPM_CLI:pnpmCli,DRC3_YAML_CLI:yamlCli,DRC3_GENERATOR:join(providers[metroName],'scripts/generate-operation-family-descriptors.mjs')};
    return {caseRoot,work,providers,manifests,config,lock,env,cache:join(caseRoot,'cache'),store:join(caseRoot,'store')};
  }
  function runNode(args,env,cwd){return new Promise((done,reject)=>{
    const child=spawn(process.execPath,args,{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});
    if(child.pid)groups.add(child.pid);let stdout='',stderr='';
    child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
    const timer=setTimeout(()=>{if(child.pid)stopGroup(child.pid);reject(new Error('bounded provider assay exceeded 90 seconds'));},90000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',status=>{clearTimeout(timer);if(child.pid)stopGroup(child.pid);done({status,stdout,stderr});});
  });}
  const acquire=(f,mode='frozen')=>{
    const options={workspace:f.work,cache:f.cache,store:f.store,pnpmCli,yamlCli,environment:f.env,mode};
    const code=`import {acquireFrozenDependencies} from ${JSON.stringify(pathToFileURL(join(owner,'scripts/design-rules.mjs')).href)}; console.log(JSON.stringify(acquireFrozenDependencies(${JSON.stringify(options)})));`;
    return runNode(['--input-type=module','--eval',code],f.env,f.caseRoot);
  };
  return {root,owner,pnpmRoot,yamlRoot,workspace,acquire,runNode,requests,unexpected};
}
