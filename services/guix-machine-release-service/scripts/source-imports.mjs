import {isBuiltin} from 'node:module';
import {posix as path} from 'node:path';

const JS=/\.[cm]?js$/u;
const within=(root,file)=>root==='.'||file===root||file.startsWith(root+'/');
const sourceKey=p=>`${p.repository}@${p.commit}:${p.path}`;
const supplierOf=s=>s.startsWith('@')?s.split('/').slice(0,2).join('/'):s.split('/')[0];

// Follow the same literal import/re-export/dynamic-import forms as the house
// module-closure service, using its dependency-free parser. Its installed-tree
// traversal cannot operate before installation and silently drops parse gaps.
function moduleRequests(text,file,manifest,parser){
  const commonjs=file.endsWith('.cjs')||(file.endsWith('.js')&&manifest.type!=='module');
  const program=parser.parseJavaScript(text,{sourceType:commonjs?'script':'module'});
  const requests=[];let binding;
  parser.walkJavaScript(program,node=>{
    if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source)
      requests.push({kind:'static-import',specifier:node.source.value,mode:'import',proven:true});
    else if(node.type==='ImportExpression')
      requests.push({kind:'dynamic-import',specifier:node.source?.type==='Literal'?node.source.value:null,mode:'import',proven:false});
    else if(node.type==='CallExpression'&&node.callee?.type==='Identifier'&&node.callee.name==='require'){
      binding??=parser.bindJavaScript(program);
      // An ordinary shadowed function named require is not a Node request.
      if(binding.references.get(node.callee))return;
      requests.push({kind:'require',specifier:node.arguments[0]?.type==='Literal'?node.arguments[0].value:null,mode:'require',proven:false,
        ...(commonjs?{}:{diagnostic:'unbound-esm-require'})});
    }
  });
  return {requests,sourceMaps:(program.comments??[]).flatMap(comment=>{
    const match=/^\s*[#@]\s*sourceMappingURL=(\S+)\s*$/u.exec(comment.value);
    return match?[match[1]]:[];
  })};
}

function targetOf(value,mode,diagnostic){
  if(value===null||typeof value==='string')return value;
  if(Array.isArray(value)){
    diagnostic('export-array-fallback');return null;
  }
  if(!value||typeof value!=='object'){diagnostic('invalid-runtime-export');return null;}
  // Node chooses the first matching condition in authored key order.
  for(const [condition,target] of Object.entries(value)){
    if(['node','node-addons',mode,'default'].includes(condition))return targetOf(target,mode,diagnostic);
    if(!['types','browser','import','require'].includes(condition))diagnostic('custom-export-condition',{condition});
  }
  return null;
}

function exportMap(manifest){
  const value=manifest.exports;
  return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).some(key=>key.startsWith('.'))?value:{'.':value};
}

function exportTarget(manifest,subpath,mode,diagnostic){
  if(manifest.exports===undefined)return subpath==='.'?manifest.main??'./index.js':subpath;
  const map=exportMap(manifest);
  if(Object.hasOwn(map,subpath))return targetOf(map[subpath],mode,diagnostic);
  const patterns=Object.keys(map).filter(key=>key.includes('*')).sort((a,b)=>b.indexOf('*')-a.indexOf('*')||b.length-a.length);
  for(const key of patterns){
    const [prefix,suffix]=key.split('*');
    if(!subpath.startsWith(prefix)||!subpath.endsWith(suffix)||subpath.length<prefix.length+suffix.length)continue;
    const target=targetOf(map[key],mode,diagnostic);
    return typeof target==='string'?target.replaceAll('*',subpath.slice(prefix.length,subpath.length-suffix.length)):null;
  }
  return null;
}

/** Read only advertised Node runtime carriers and the literal modules they
 * reach in the selected immutable source graph. No source code is evaluated,
 * no ambient node_modules is consulted, and registry availability is separate. */
export function readSelectedSourceImports({selected,trees,readBlob,prefetchSources=()=>{},parser}){
  const diagnostics=[],findings=[],resolutionFindings=[],demands=[],modules=[],materializedFiles=[],pending=[],seen=new Set();
  const selectedOwners=new Map([...selected.values()].map(p=>[sourceKey(p),p]));
  const indices=new Map([...trees].map(([repo,files])=>[repo,new Map(files.filter(f=>f.type==='blob').map(f=>[f.file,f]))]));
  const membranes=new Map([...indices].map(([repo,files])=>[repo,[...files.keys()].filter(file=>path.basename(file)==='package.json').map(file=>path.dirname(file)).sort((a,b)=>a==='.'?1:b==='.'?-1:b.length-a.length)]));
  const note=(reason,detail={})=>diagnostics.push({...detail,reason});
  const coordinate=(p,file)=>({repository:p.repository,commit:p.commit,package:p.manifest.name,file:path.relative(p.path,file)});
  function enqueue(p,target,basis,mode='import',proven=true,rootKind='export',rootBasis=basis,runtimeRole=true){
    if(typeof target!=='string'){note('runtime-export-not-selected',{...coordinate(p,p.path),basis});return;}
    if(target.startsWith('/')||target.startsWith('../')||/^[a-z][a-z\d+.-]*:/iu.test(target)){note('runtime-target-outside-package',{...coordinate(p,target),basis});return;}
    const file=path.normalize(path.join(p.path,target));
    if(!within(p.path,file)){note('runtime-target-outside-package',{...coordinate(p,file),basis});return;}
    pending.push({source:p,file,basis,mode,proven,rootKind,rootBasis,runtimeRole});
  }
  // This is the selected packages' Node export surface, not a claim that every
  // advertised export executes at machine startup. Tests/scripts are not walked.
  for(const p of selected.values()){
    let roots=0;
    const diagnostic=(reason,detail)=>note(reason,{...coordinate(p,p.path),...detail});
    const targets=p.manifest.exports===undefined?{'.':p.manifest.main??'./index.js'}:exportMap(p.manifest);
    for(const [subpath,value] of Object.entries(targets)){
      const target=targetOf(value,'import',diagnostic);
      if(target===null)continue;
      if(typeof target==='string'&&target.includes('*')){
        const [prefix,suffix,...extra]=target.split('*');
        if(extra.length||subpath.split('*').length!==2){diagnostic('unsupported-export-pattern',{subpath,target});continue;}
        for(const file of indices.get(p.repository).keys()){
          const relative=path.relative(p.path,file);
          const start=prefix.replace(/^\.\//u,'');
          if(within(p.path,file)&&relative.startsWith(start)&&relative.endsWith(suffix)&&relative.length>=start.length+suffix.length){
            const match=relative.slice(start.length,relative.length-suffix.length);
            const publicSubpath=subpath.replace('*',match);
            const admitted=exportTarget(p.manifest,publicSubpath,'import',diagnostic);
            // An exact null or a more specific pattern can shadow this match.
            // Only the target Node actually exposes may become a runtime root.
            if(typeof admitted==='string'&&path.normalize(admitted)===path.normalize(relative)){
              const carriers=p.manifest.files;
              // files does not control Guix source materialization. A blanket
              // wildcard over a carrier the package explicitly leaves outside
              // that publication surface is not enough proof of runtime role.
              // Keep reading its bytes, but retain omissions as diagnostics.
              const simple=Array.isArray(carriers)&&carriers.every(value=>typeof value==='string'&&!/[!*?\[\]{}]/u.test(value));
              const carried=!simple||carriers.some(value=>{
                const carrier=path.normalize(value.replace(/^\.\//u,'')).replace(/\/$/u,'');
                return relative===carrier||relative.startsWith(carrier+'/');
              });
              if(!carried)diagnostic('wildcard-runtime-role-unproven',{file:relative,subpath:publicSubpath});
              enqueue(p,relative,`export:${publicSubpath}`,'import',carried,'export-pattern',`export:${publicSubpath}`,carried);roots++;
            }
          }
        }
      }else{enqueue(p,target,`export:${subpath}`);roots++;}
    }
    const bins=typeof p.manifest.bin==='string'?{[p.manifest.name]:p.manifest.bin}:p.manifest.bin??{};
    for(const [name,target] of Object.entries(bins)){enqueue(p,target,`bin:${name}`,'import',true,'bin');roots++;}
    if(!roots)diagnostic('no-node-runtime-entry');
  }
  let prefetchedThrough=0;
  for(let cursor=0;cursor<pending.length;cursor++){
    if(cursor===prefetchedThrough){
      prefetchedThrough=pending.length;
      // Keep cold partial clones bounded by repository/graph wave, rather than
      // fetching and spawning one Git request for every reached module.
      prefetchSources(pending.slice(cursor,prefetchedThrough).flatMap(item=>{
        const entry=indices.get(item.source.repository).get(item.file);
        if(!entry||!JS.test(item.file)||!['100644','100755'].includes(entry.mode)||item.file.split('/').some(part=>['node_modules','.git','legacy'].includes(part)))return [];
        const membrane=membranes.get(item.source.repository).find(root=>within(root,item.file));
        return selectedOwners.has(`${item.source.repository}@${item.source.commit}:${membrane}`)?[{repository:item.source.repository,entry}]:[];
      }));
    }
    const item=pending[cursor],p=item.source,location=coordinate(p,item.file);
    const key=`${sourceKey(p)}:${item.file}:${item.mode}:${item.proven}:${item.runtimeRole}`;
    if(seen.has(key))continue;seen.add(key);
    const entry=indices.get(p.repository).get(item.file);
    if(!entry||!['100644','100755'].includes(entry.mode)){
      note('runtime-target-not-in-committed-source',{...location,basis:item.basis,mode:item.mode});continue;
    }
    if(item.file.split('/').some(part=>['node_modules','.git','legacy'].includes(part))){
      note('runtime-target-not-materialized',{...location,basis:item.basis});continue;
    }
    const membrane=membranes.get(p.repository).find(root=>within(root,item.file));
    const owner=selectedOwners.get(`${p.repository}@${p.commit}:${membrane}`);
    if(!owner){note('unselected-package-membrane',{...location,membrane,basis:item.basis});continue;}
    const owned=coordinate(owner,item.file);
    // A literal runtime edge can reach a committed package-owned carrier in
    // vendor. Keep its byte identity even when parsing remains diagnostic; do
    // not promote wildcard-only or unselected nested packages into the closure.
    if(item.runtimeRole)materializedFiles.push({...owned,gitBlob:entry.oid});
    if(item.file.endsWith('.json')){modules.push({...owned,gitBlob:entry.oid,format:'json'});continue;}
    if(!JS.test(item.file)){note('unsupported-runtime-source-language',{...owned,basis:item.basis});continue;}
    let text,requests,sourceMaps;
    try{text=readBlob(p.repository,entry).toString('utf8');}
    catch(error){note('source-read-unavailable',{...owned,diagnostic:error.message});continue;}
    try{({requests,sourceMaps}=moduleRequests(text,item.file,owner.manifest,parser));}
    catch(error){note('source-not-parsed',{...owned,diagnostic:error.message});continue;}
    modules.push({...owned,gitBlob:entry.oid,format:'javascript'});
    // Preserve an exact, package-owned local source map with its runtime carrier.
    // URLs, traversal and unselected nested package provenance are not admitted.
    if(item.runtimeRole)for(const specifier of sourceMaps){
      if(!/^[a-zA-Z0-9_.-]+\.map$/u.test(specifier))continue;
      const file=path.join(path.dirname(item.file),specifier),map=indices.get(p.repository).get(file);
      const membrane=membranes.get(p.repository).find(root=>within(root,file));
      if(map&&['100644','100755'].includes(map.mode)&&membrane===owner.path)
        materializedFiles.push({...coordinate(owner,file),gitBlob:map.oid});
    }
    const declared={...owner.manifest.peerDependencies,...owner.manifest.dependencies,...owner.manifest.optionalDependencies};
    for(const request of requests){
      const demand={...owned,kind:request.kind,specifier:request.specifier,entryKind:item.rootKind,entryBasis:item.rootBasis};
      if(typeof request.specifier!=='string'){note('computed-module-request',demand);continue;}
      const specifier=request.specifier;
      if(request.diagnostic){note(request.diagnostic,demand);continue;}
      if(isBuiltin(specifier))continue;
      if(specifier.startsWith('#')){note('package-import-map-needs-resolution',demand);continue;}
      if(specifier.startsWith('.')||specifier.startsWith('/')){
        let file;
        if(/%2f|%5c/iu.test(specifier)){note('relative-module-url-invalid',demand);continue;}
        try{file=new URL(specifier,`file:///${item.file}`).pathname.slice(1);file=decodeURIComponent(file);}
        catch{note('relative-module-url-invalid',demand);continue;}
        if(!within(owner.path,file)){
          const finding={...demand,proven:item.proven&&request.proven,reason:'relative-module-outside-materialized-package'};
          // Packages are independently materialized. A proved literal edge
          // cannot acquire its supplier by walking a different owner's folder.
          if(finding.proven)resolutionFindings.push(finding);else note(finding.reason,finding);
          continue;
        }
        pending.push({...item,file,basis:`${owned.file}:${request.kind}`,mode:request.mode,proven:item.proven&&request.proven});continue;
      }
      if(/^[a-z][a-z\d+.-]*:/iu.test(specifier)){note('external-module-url',demand);continue;}
      const supplier=supplierOf(specifier),self=supplier===owner.manifest.name;
      const declaredHere=self||Object.hasOwn(declared,supplier);
      const detail={...demand,supplier,proven:item.proven&&request.proven};
      if(!declaredHere){
        const finding={...detail,reason:Object.hasOwn(owner.manifest.devDependencies??{},supplier)?'runtime-import-only-dev-declared':'runtime-import-undeclared'};
        if(detail.proven)findings.push(finding);else note(!item.proven&&item.rootKind==='export-pattern'?'wildcard-only-undeclared-module-request':'conditional-undeclared-module-request',finding);
      }
      const provider=self?owner:selected.get(supplier);
      const requested=declared[supplier];
      const availability=provider?'selected-source':requested?.startsWith('workspace:')?'source-unavailable':'registry-unchecked';
      demands.push({...detail,declared:declaredHere,requested:requested??null,availability});
      if(!provider)continue;
      const subpath=specifier===supplier?'.':'./'+specifier.slice(supplier.length+1);
      const selectionDiagnostics=[];
      const target=exportTarget(provider.manifest,subpath,request.mode,(reason,extra)=>{
        selectionDiagnostics.push(reason);note(reason,{...detail,...extra});
      });
      if(target===null){
        const finding={...detail,reason:'selected-source-export-unavailable',provider:{repository:provider.repository,commit:provider.commit,path:provider.path}};
        // A literal unconditional request from an admitted runtime carrier must
        // exist in the selected provider. Conditional and wildcard-only demand
        // still does not establish that the machine will execute this edge.
        // The reader does not resolve arrays or custom conditions. Unknown
        // selection cannot prove absence, even for an unconditional request.
        if(detail.proven&&selectionDiagnostics.length===0)resolutionFindings.push(finding);
        else note(selectionDiagnostics.length?'selected-source-export-selection-unresolved':finding.reason,finding);
        continue;
      }
      enqueue(provider,target,`${owner.manifest.name}:${owned.file}:${specifier}`,request.mode,item.proven&&request.proven,item.rootKind,item.rootBasis,item.runtimeRole);
    }
  }
  const unique=rows=>[...new Map(rows.map(row=>[JSON.stringify(row),row])).values()];
  return {kind:'guix.selected-source-imports.v1',scope:'selected-node-runtime-export-surface',
    packages:[...selected.values()].map(p=>({name:p.manifest.name,repository:p.repository,commit:p.commit,path:p.path})),
    modules:unique(modules),materializedFiles:unique(materializedFiles),declarationFindings:unique(findings),resolutionFindings:unique(resolutionFindings),demands:unique(demands),diagnostics:unique(diagnostics),
    provesCompleteRuntimeClosure:false};
}
