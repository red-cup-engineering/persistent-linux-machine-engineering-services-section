// Receiving declarations select trusted, reviewed package code. This is not a
// sandbox: source ownership/admission and the immutable candidate remain the
// authority. No declaration may select a command, interpreter or environment.
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readlinkSync,realpathSync,readdirSync} from 'node:fs';
import {join,dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {createRequire} from 'node:module';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const manifestIdentity=manifest=>sha256(JSON.stringify(manifest));
export function gitBlobIdentity(bytes,oid) {
  if(typeof oid!=='string'||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
    throw new Error('invalid receiving Git blob identity');
  return createHash(oid.length===40?'sha1':'sha256')
    .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function receivingPackageNames(names=[]) {
  if(!Array.isArray(names)||names.some(name=>typeof name!=='string'||name.length>214||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))||
      new Set(names).size!==names.length)
    throw new Error('receivingPackages must contain unique package names');
  return names;
}

export function receivingTestPaths(manifest) {
  const paths=manifest?.receivingTests;
  if(!Array.isArray(paths)||!paths.length||new Set(paths).size!==paths.length||
      paths.some(path=>typeof path!=='string'||!path||
        !path.split('/').every(part=>/^[a-zA-Z0-9._-]+$/.test(part)&&part!=='.'&&part!=='..')))
    throw new Error(`invalid receivingTests declaration for ${manifest?.name}: expected unique explicit relative file paths`);
  return paths;
}

function exactKeys(value,keys) {
  return value&&typeof value==='object'&&!Array.isArray(value)&&
    Object.keys(value).sort().join(',')===[...keys].sort().join(',');
}

function regularFile(root,path) {
  const parts=path.split('/');
  let current=root;
  for(let index=0;index<parts.length;index++) {
    current=join(current,parts[index]);
    const stat=lstatSync(current);
    if(index===parts.length-1?!stat.isFile():!stat.isDirectory())
      throw new Error(`receiving path is not a regular file without symlinks: ${path}`);
  }
  return current;
}

export function admittedRuntimeRoot(artifact) {
  const root=realpathSync(artifact);
  const shared=lstatSync(join(root,'.software'),{throwIfNoEntry:false});
  if(shared)return admittedRuntimeCarriers(root).runtime;
  const metadataStat=lstatSync(join(root,'.metadata'),{throwIfNoEntry:false});
  const packagesStat=lstatSync(join(root,'packages'),{throwIfNoEntry:false});
  const modulesStat=lstatSync(join(root,'node_modules'),{throwIfNoEntry:false});
  if(packagesStat?.isDirectory()||modulesStat?.isDirectory()||(!metadataStat?.isSymbolicLink()&&!packagesStat?.isSymbolicLink())) {
    // A materialized closure has direct metadata/controller directories too.
    // Missing entries are allowed for prepare-only validation, but mixed
    // direct/linked carrier shapes must not select another metadata authority.
    for(const entry of ['.metadata','.controller']) {
      const stat=lstatSync(join(root,entry),{throwIfNoEntry:false});
      if(stat&&!stat.isDirectory())throw new Error(`invalid materialized runtime entry: ${entry}`);
      if(entry==='.metadata'&&stat)regularFile(root,'.metadata/sources.json');
    }
    return root;
  }
  // src/guix-deployment.scm links every top-level admitted-runtime entry into
  // the output. Resolve only that carrier boundary, not package-owned links.
  const metadata=join(root,'.metadata');
  if(!lstatSync(metadata).isSymbolicLink())throw new Error('invalid admitted-runtime carrier metadata');
  const runtime=dirname(readlinkSync(metadata));
  if(!isAbsolute(runtime)||realpathSync(runtime)!==runtime||!lstatSync(runtime).isDirectory())
    throw new Error('admitted-runtime carrier root is not canonical');
  const layout=lstatSync(join(runtime,'packages'),{throwIfNoEntry:false})?'packages':'node_modules';
  for(const entry of [layout,'.metadata','.controller']) {
    const link=join(root,entry),target=join(runtime,entry);
    if(!lstatSync(link).isSymbolicLink()||readlinkSync(link)!==target||!lstatSync(target).isDirectory())
      throw new Error(`admitted-runtime carrier entries disagree: ${entry}`);
  }
  regularFile(runtime,'.metadata/sources.json');
  return runtime;
}

// The native constructor copies the authenticated controller before adding its
// generated policy. Receive that exact representation, not any direct directory:
// source bytes, executable identity and the complete entry set remain owned by
// the envelope. Only the constructor's top-level machine.json is additional.
function receiveNativeController(outer,receiver,identity){
  const expected=join(receiver,'.controller'),actual=join(outer,'.controller');
  if(!/^\/gnu\/store\/[^/]+$/u.test(outer)||!lstatSync(actual).isDirectory()||realpathSync(actual)!==actual||
      !lstatSync(expected).isDirectory()||realpathSync(expected)!==expected)
    throw new Error('native controller must be a direct sealed source copy');
  if(lstatSync(join(expected,'machine.json'),{throwIfNoEntry:false}))
    throw new Error('authored machine manifests cannot supply native receiving policy');
  function compare(source,copy,top=false){
    const names=readdirSync(source).sort(),copied=readdirSync(copy).filter(name=>!top||name!=='machine.json').sort();
    if(JSON.stringify(names)!==JSON.stringify(copied))throw new Error('native controller source entries differ');
    for(const name of names){
      const from=join(source,name),to=join(copy,name),original=lstatSync(from),received=lstatSync(to);
      if(original.isDirectory()&&received.isDirectory())compare(from,to);
      else if(!original.isFile()||!received.isFile()||Boolean(original.mode&0o111)!==Boolean(received.mode&0o111)||
          !readFileSync(from).equals(readFileSync(to)))throw new Error('native controller differs from its authenticated source');
    }
  }
  compare(expected,actual,true);
  const policyFile=regularFile(actual,'machine.json'),stat=lstatSync(policyFile);
  if(stat.mode&0o111)throw new Error('native receiving policy is executable');
  const policy=JSON.parse(readFileSync(policyFile,'utf8'));
  if(!policy||typeof policy!=='object'||Array.isArray(policy)||typeof identity.machineRepository!=='string'||
      policy.repository!==identity.machineRepository||policy.stateCompatibility!=='preserve-existing')
    throw new Error('native receiving policy differs from its sealed target identity');
}

// The existing Guix enterprise-deployment constructor creates this reference
// from its actual #:runtime-release input. Target metadata must agree with it;
// neither target declarations nor a package alias may choose another carrier.
export function admittedRuntimeCarriers(artifact){
  const outer=realpathSync(artifact),link=join(outer,'.software');
  if(!lstatSync(link,{throwIfNoEntry:false})){
    const runtime=admittedRuntimeRoot(outer);return {runtime,receiver:runtime};
  }
  if(!lstatSync(link).isSymbolicLink())throw new Error('shared software binding is not a generated reference');
  const store=readlinkSync(link);
  if(!/^\/gnu\/store\/[^/]+$/u.test(store)||realpathSync(store)!==store)
    throw new Error('shared software binding is not an immutable canonical output');
  const runtime=realpathSync(join(store,'share/runtime'));
  if(!/^\/gnu\/store\/[^/]+$/u.test(runtime)||!lstatSync(runtime).isDirectory())
    throw new Error('shared runtime is not an immutable store-held input');
  const metadata=join(outer,'.metadata');
  if(!lstatSync(metadata).isSymbolicLink())throw new Error('target metadata is not an admitted envelope carrier');
  const receiver=dirname(readlinkSync(metadata));
  if(!/^\/gnu\/store\/[^/]+$/u.test(receiver)||realpathSync(receiver)!==receiver||runtime===receiver)
    throw new Error('target envelope must be distinct from shared software');
  for(const entry of ['.metadata','deployment']){
    const target=join(receiver,entry),alias=join(outer,entry);
    if(!lstatSync(alias).isSymbolicLink()||readlinkSync(alias)!==target||!lstatSync(target).isDirectory())
      throw new Error('target envelope entries disagree');
  }
  for(const entry of ['node_modules','package.json']){
    const target=join(runtime,entry),alias=join(outer,entry);
    if(!lstatSync(alias).isSymbolicLink()||readlinkSync(alias)!==join(store,'share/runtime',entry)||realpathSync(alias)!==realpathSync(target))
      throw new Error('shared software entries disagree');
  }
  regularFile(receiver,'.metadata/sources.json');
  const identity=JSON.parse(readFileSync(regularFile(receiver,'.metadata/release.json'),'utf8'));
  if(identity.software?.storePath!==store||!/^[a-f0-9]{64}$/u.test(identity.software?.narSha256??'')||
      !/^[a-f0-9]{40}$/u.test(identity.software?.sourceCommit??''))
    throw new Error('target release differs from its shared software receipt');
  receiveNativeController(outer,receiver,identity);
  return {runtime,receiver};
}

// Resolve one receiver entrance through the same admitted immutable carrier.
// Check each link hop, including the requested sealed top-level entry, before
// reading/importing bytes. Legitimate parent-relative declarations remain valid
// when their resolved file is still inside this admitted runtime.
function admittedRuntimePath(artifact,input,directory) {
  const outer=realpathSync(artifact),{runtime,receiver}=admittedRuntimeCarriers(artifact),absolute=resolve(input);
  const inside=(root,path)=>{const offset=relative(root,path);return !isAbsolute(offset)&&offset!=='..'&&!offset.startsWith('..'+sep);};
  let file=absolute,admitted=runtime;
  if(outer!==runtime&&inside(outer,absolute)) {
    const offset=relative(outer,absolute),entry=offset.split(sep)[0],link=join(outer,entry);
    const shared=lstatSync(join(outer,'.software'),{throwIfNoEntry:false});
    if(shared&&entry==='.controller'){
      // admittedRuntimeCarriers has received the complete constructor copy.
      // Its direct paths remain confined to that one controller subtree.
      admitted=join(outer,'.controller');
    }else{
      const target=lstatSync(link).isSymbolicLink()?readlinkSync(link):null;
      const roots=[...new Set([runtime,receiver])].filter(root=>{
        const expected=shared&&root===runtime?join(readlinkSync(join(outer,'.software')),'share/runtime',entry):join(root,entry);
        return target===expected;
      });
      if(!entry||roots.length!==1)
        throw new Error('requested carrier entry differs from admitted runtime');
      admitted=roots[0];file=join(admitted,offset);
    }
  }
  else if(inside(receiver,file))admitted=receiver;
  if(!inside(admitted,file))throw new Error('receiver file resolves outside its artifact admitted runtime');
  let parts=relative(admitted,file).split(sep).filter(Boolean),current=admitted,hops=0;
  while(parts.length){
    const next=join(current,parts.shift()),stat=lstatSync(next);
    if(stat.isSymbolicLink()){
      if(++hops>40)throw new Error('receiver file has a cyclic link chain');
      const target=resolve(dirname(next),readlinkSync(next));
      if(!inside(admitted,target))throw new Error('receiver file resolves outside its artifact admitted runtime');
      parts=[...relative(admitted,target).split(sep).filter(Boolean),...parts];current=admitted;
    }else{if(parts.length||directory?!stat.isDirectory():!stat.isFile())throw new Error('receiver entrance has the wrong file type');current=next;}
  }
  if(directory?!lstatSync(current).isDirectory():!lstatSync(current).isFile())throw new Error('receiver entrance has the wrong file type');
  return current;
}

export const admittedRuntimeFile=(artifact,input)=>admittedRuntimePath(artifact,input,false);
export const admittedRuntimeDirectory=(artifact,input)=>admittedRuntimePath(artifact,input,true);

export function resolveAdmittedRuntimeModule(artifact,specifier) {
  const require=createRequire(join(resolve(artifact),'deployment/host.json'));
  return admittedRuntimeFile(artifact,require.resolve(specifier));
}

// Generated installed location is distinct from the source-relative package path.
// Legacy prepared closures retain their original packages/<name> representation.
export function selectedPackageDirectory(artifact,source) {
  const runtime=admittedRuntimeRoot(artifact);
  const path=source.installationPath??join('packages',source.name.replaceAll('/','__'));
  if(typeof path!=='string'||!path||isAbsolute(path)||/[\\\0]/u.test(path)||
      (path!=='.'&&path.split('/').some(part=>!part||part==='.'||part==='..')))
    throw new Error('selected package installation path is not canonical');
  let directory=runtime;
  for(const part of path==='.'?[]:path.split('/')) {
    directory=join(directory,part);
    if(!lstatSync(directory).isDirectory())throw new Error('selected package installation path is redirected');
  }
  if(source.installationPath!==undefined) {
    receivingPackageNames([source.name]);
    const alias=source.installationPath==='.'?runtime:join(runtime,'node_modules',source.name);
    if(realpathSync(alias)!==directory)throw new Error('package alias differs from selected installation');
  }
  return directory;
}

export function selectedPackageFile(artifact,source,path) {
  if(typeof path!=='string'||!path||path.split('/').some(part=>!part||part==='.'||part==='..')||/[\\\0]/u.test(path))
    throw new Error('selected package file must be canonical relative');
  return regularFile(selectedPackageDirectory(artifact,source),path);
}

// Validate the complete selected set before the caller executes ANY checks.
// The original manifest is retained because preparation rewrites dependencies.
// Its existing pre-rewrite identity binds the declaration; each entry also binds
// the exact committed test blob and the bytes in the sealed candidate.
export function packageReceivingChecks(artifact,sources) {
  const names=receivingPackageNames(sources.receivingPackages);
  const runtime=names.length?admittedRuntimeRoot(artifact):artifact;
  return names.map(name=>{
    const matches=sources.packages.filter(p=>p.name===name);
    if(matches.length!==1)throw new Error(`receiving package is not uniquely admitted: ${name}`);
    const p=matches[0],receipt=p.receiving;
    if(!exactKeys(receipt,['version','manifest','tests'])||receipt.version!==1||
        receipt.manifest?.name!==name||receipt.manifest?.version!==p.version||
        manifestIdentity(receipt.manifest)!==p.sourceManifestSha256)
      throw new Error(`receiving manifest identity differs: ${name}`);
    const repositories=sources.repositories.filter(r=>r.repository===p.repository);
    if(repositories.length!==1||repositories[0].commit!==p.commit||
        !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(p.commit??''))
      throw new Error(`receiving package source is not admitted: ${name}`);
    const paths=receivingTestPaths(receipt.manifest);
    if(!Array.isArray(receipt.tests)||receipt.tests.length!==paths.length||
        receipt.tests.some((test,index)=>!exactKeys(test,['path','gitBlob','sha256'])||
          test.path!==paths[index]||!/^[a-f0-9]{64}$/.test(test.sha256??'')))
      throw new Error(`receiving test identities differ from declaration: ${name}`);
    const packagePath=relative(runtime,selectedPackageDirectory(artifact,p))||'.';
    const manifest=JSON.parse(readFileSync(regularFile(runtime,`${packagePath}/package.json`),'utf8'));
    if(manifest.name!==name||manifest.version!==p.version||
        JSON.stringify(manifest.receivingTests)!==JSON.stringify(paths))
      throw new Error(`materialized receiving declaration differs: ${name}`);
    const tests=receipt.tests.map(test=>{
      const path=regularFile(runtime,`${packagePath}/${test.path}`);
      const bytes=readFileSync(path);
      if(sha256(bytes)!==test.sha256||gitBlobIdentity(bytes,test.gitBlob)!==test.gitBlob)
        throw new Error(`receiving test bytes differ: ${name}:${test.path}`);
      return path;
    });
    return {name,directory:join(runtime,packagePath),tests};
  });
}

export function packageReceivingEnvironment(candidateNode,parent=process.env) {
  const environment={PATH:dirname(candidateNode)+':'+(parent.PATH??''),NODE_OPTIONS:'--max-old-space-size=384'};
  for(const key of ['TMPDIR','TMP','TEMP','LANG','LC_ALL','TZ'])
    if(parent[key]!==undefined)environment[key]=parent[key];
  return environment;
}
