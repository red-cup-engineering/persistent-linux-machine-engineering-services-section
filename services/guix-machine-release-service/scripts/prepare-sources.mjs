#!/usr/bin/env node
import {isCliEntry} from './cli-entry.mjs';
import {gitlinks,machineSources,directMountsOnly,mountedSourceClosure} from './source-pins.mjs';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, mkdtempSync, rmSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, dirname, relative, posix } from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {receivingPackageNames,receivingTestPaths,manifestIdentity,sha256,gitBlobIdentity} from './package-receiving.mjs';
import {readSelectedSourceImports} from './source-imports.mjs';
import {classifyBreak,classOfImportDiagnostic} from './assembly-breaks.mjs';
import {missingWorkspaceSources,ambiguousRequiredSources} from './closure-diagnostics.mjs';
import {assertNoSqliteSources} from './design-rules.mjs';
import {materializeSources,sourceGraphDelta} from './materialize-sources.mjs';
import {machineDirectory,verifyMachineDirectory} from './machine-directory.mjs';

export function command(program, args, cwd) {
  const r = spawnSync(program, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw r.error ?? new Error(`${program} failed (${r.status}): ${r.stderr.slice(-4000)}`);
  return r.stdout.trim();
}

// Both source materialization and its import reader consume this exact Git
// framing. Empty blobs still need a full header, body terminator and identity.
export function decodeGitBlobBatch(buffer,entries){
  let offset=0;const decoded=[];
  for(const entry of entries){
    const end=buffer.indexOf(10,offset);
    if(end<0)throw new Error(`invalid source blob batch header: ${entry.file}`);
    const header=buffer.subarray(offset,end).toString().split(' '),length=Number(header[2]);
    if(header.length!==3||header[0]!==entry.oid||header[1]!=='blob'||!/^(0|[1-9]\d*)$/u.test(header[2])||!Number.isSafeInteger(length)||length<0)
      throw new Error(`invalid source blob batch header: ${entry.file}`);
    const stop=end+1+length;
    if(stop>=buffer.length||buffer[stop]!==10)throw new Error(`invalid source blob batch body: ${entry.file}`);
    const bytes=buffer.subarray(end+1,stop);
    const actual=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if(actual!==entry.oid)throw new Error(`source blob identity differs: ${entry.file}`);
    decoded.push({entry,bytes});offset=stop+1;
  }
  if(offset!==buffer.length)throw new Error('unexpected bytes after source blob batch');
  return decoded;
}

// A file belongs to its nearest enclosing package root. A package nested inside another is its own
// membrane: it is materialized once, under its own name when selected, never again inside its parents.
export function ownedBy(roots,owner,file){
  for(let directory=dirname(file);directory!==owner;directory=dirname(directory)){
    if(roots?.has(directory))return false;
    if(directory==='.'||directory==='/')return owner==='.';
  }
  return true;
}

// A parent that reaches into a nested package by a relative path (an import, a require, a URL or a manifest
// export such as './services/child/src/x.mjs') keeps that package's files: its own code depends on them
// at that location. Read from the parent's own source, manifests and TypeScript configurations, transitively.
const REACHING=/(?:^|\/)(?:package\.json|tsconfig[^/]*\.json)$|\.(?:[cm]?[jt]s|[jt]sx)$/u;
const RELATIVE=/['"`](\.{1,2}\/[^'"`\s]*)['"`]/gu;
export function nestedMembranes(files,roots,owner,read){
  const nested=[...roots??[]].filter(root=>root!==owner&&(owner==='.'||root.startsWith(owner+'/')));
  const membranes=new Set(roots??[]),scanned=new Set();
  for(;;){
    const pending=files.filter(({file})=>REACHING.test(file)&&!scanned.has(file)&&ownedBy(membranes,owner,file));
    if(!pending.length)return membranes;
    const texts=read(pending);
    pending.forEach(({file},index)=>{
      scanned.add(file);
      for(const [,specifier] of texts[index].matchAll(RELATIVE)){
        const target=posix.normalize(posix.join(posix.dirname(file),specifier.split(/[?#]/u)[0]));
        for(const root of nested)if(target===root||target.startsWith(root+'/'))membranes.delete(root);
      }
    });
  }
}

const absentBlobs=new Map();
export function treeFiles(directory,commit,path){
  return command('git',['ls-tree','-rz',commit,...(path?['--',path]:[])],directory).split('\0').filter(Boolean).map(record=>{
    const tab=record.indexOf('\t');const [mode,type,oid]=record.slice(0,tab).split(' ');
    return {mode,type,oid,file:record.slice(tab+1)};
  });
}
export function prefetch(directory,commit,oids){
  const key=directory+'@'+commit;
  if(!absentBlobs.has(key))absentBlobs.set(key,new Set(command('git',['rev-list','--objects','--missing=print','--no-object-names',commit],directory).split('\n').filter(x=>x.startsWith('?')).map(x=>x.slice(1))));
  const absent=absentBlobs.get(key),wanted=[...new Set(oids)].filter(oid=>absent.has(oid));
  if(!wanted.length)return;
  const result=spawnSync('git',['-c','fetch.negotiationAlgorithm=noop','fetch','--quiet','--no-tags','--no-write-fetch-head','--recurse-submodules=no','--filter=blob:none','origin','--stdin'],{cwd:directory,input:wanted.join('\n')+'\n',encoding:'utf8',maxBuffer:8*1024*1024});
  if(result.error||result.status!==0)throw result.error??new Error(`immutable source prefetch failed: ${result.stderr.slice(-2000)}`);
  for(const oid of wanted)absent.delete(oid);
}

/** Directory names under which no package.json is a sourced package: preserved history, vendored or copied
 *  material, tests and fixtures. One list, read by prepare-sources and by the change test, so they cannot drift. */
export const UNSOURCED_DIRECTORIES = Object.freeze(['legacy','vendor','vendored','material','test','tests','examples','repository-bootstrap','history']);

// The capital preserves package-shaped research and machine records as evidence.
// Their bytes remain materializable, but they are not executable package owners.
// Both preparation and change attribution use this same coordinate boundary.
// A Gitlink boundary does not erase its mount's position under history or data/records.
export function sourcedPackageManifest(file,mountedPath='.'){
  if(Array.isArray(mountedPath))return mountedPath.some(path=>sourcedPackageManifest(file,path));
  const parts=posix.join(mountedPath,file).split('/');
  if(parts.at(-1)!=='package.json'||parts.some(part=>part==='node_modules'||UNSOURCED_DIRECTORIES.includes(part)))return false;
  return !parts.some((part,index)=>(part==='content'&&parts[index+1]==='text')||(part==='data'&&parts[index+1]==='records'));
}

/** The repositories a package's own repository mounts inside the package directory, each at the commit its gitlink
 *  records, recursively: [{repository, commit, path (relative to the package), directory}]. A mounted repository is a
 *  source of the machine, so each is found among `repositories`; one that is not is refused. */
export function packageMounts(repositories,repository,commit,packagePath,link=gitlinks,graph){
  const owner=repositories.find(r=>r.repository===repository),found=[];
  const walk=(directory,at,base,parent)=>{
    for(const [mounted,{path,commit:pinned}] of link(directory,at,{requireAll:true})){
      const full=base?base+'/'+path:path;
      if(packagePath!=='.'&&!full.startsWith(packagePath+'/'))continue;
      const edges=graph?.edges.filter(edge=>edge.from===parent&&edge.to===mounted&&edge.path===path&&edge.commit===pinned);
      if(graph&&edges.length!==1)throw new Error(`mounted edge differs from the authenticated source graph: ${parent}:${path}`);
      const selected=graph?edges[0].selectedCommit:pinned;
      const source=repositories.find(r=>r.repository===mounted&&r.commit===selected);
      if(!source)throw new Error(`mounted repository is not among the machine's sources at its gitlink commit: ${mounted}@${pinned}`);
      found.push({repository:mounted,commit:selected,...selected===pinned?{}:{authoredCommit:pinned},path:packagePath==='.'?full:full.slice(packagePath.length+1),directory:source.directory});
      walk(source.directory,selected,full,mounted);
    }
  };
  walk(owner.directory,commit,'',repository);
  return found;
}

export function packageSources(repositories, trees, roots) {
  const packages = new Map();
  for (const source of repositories) {
    const {directory,repository,commit}=source;
    if (command('git', ['rev-parse', 'HEAD'], directory) !== commit) throw new Error(`source commit differs: ${repository}`);
    const files=treeFiles(directory,commit);
    trees?.set(repository,files);
    const manifests=files.filter(({file,type})=>type==='blob'&&sourcedPackageManifest(file,source.paths??source.path));
    prefetch(directory,commit,manifests.map(f=>f.oid));
    for (const {file:path} of manifests) {
      const manifest = JSON.parse(command('git', ['show', `${commit}:${path}`], directory));
      if (!manifest.name || !manifest.version) continue;
      // Every discovered package root is a membrane, whichever owner the machine admits.
      if (roots) { if (!roots.has(repository)) roots.set(repository, new Set()); roots.get(repository).add(dirname(path)); }
      const candidate = { manifest, directory: resolve(directory, dirname(path)), repository, commit, path: dirname(path) };
      const previous = packages.get(manifest.name);
      packages.set(manifest.name, previous ? [...(Array.isArray(previous) ? previous : [previous]), candidate] : candidate);
    }
  }
  return packages;
}

export function selectedSources(packages, entries) {
  const selected = new Map();
  const queue = [...entries];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const name = queue[cursor];
    if (selected.has(name)) continue;
    const p = packages.get(name);
    if (Array.isArray(p)) throw new Error(`ambiguous source owner for required package ${name}: ${p.map(source => `${source.repository}:${source.path}`).join(", ")}; each package has exactly one home among the machine's sources`);
    if (!p) throw new Error(`entry or workspace dependency has no home among the machine's sources: ${name}`);
    selected.set(name, p);
    const peers = Object.fromEntries(Object.entries(p.manifest.peerDependencies ?? {}).filter(([name]) => !p.manifest.peerDependenciesMeta?.[name]?.optional));
    const dependencies = { ...p.manifest.dependencies, ...p.manifest.optionalDependencies, ...peers };
    for (const [dependency, requested] of Object.entries(dependencies)) {
      if (packages.has(dependency)) queue.push(dependency);
      else if (requested.startsWith('workspace:')) throw new Error(`workspace dependency has no home among the machine's sources: ${name} -> ${dependency}`);
    }
  }
  return selected;
}

export function selectedSourcesWithDiagnostics(packages, entries) {
  try {
    return selectedSources(packages, entries);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error.message.includes('ambiguous source owner for required package')) {
      const ambiguities = ambiguousRequiredSources(packages, entries);
      if (ambiguities.length <= 1) throw error;
      // Preserve the original first failed requirement for existing break
      // classification. Extra names describe possible, not chosen, closure.
      const maximumShown = 32;
      const extra = ambiguities.slice(0, maximumShown).map(({name,sources}) =>
        name + ' => ' + sources.join(', ')).join('; ');
      throw new Error(error.message + '; all ambiguities in possible required closure (' +
        ambiguities.length + ', showing ' + Math.min(ambiguities.length, maximumShown) + '): ' + extra, {cause:error});
    }
    if (!error.message.includes("workspace dependency has no home among the machine's sources")) throw error;
    const failures = missingWorkspaceSources(packages, entries);
    if (failures.length <= 1) throw error;
    throw new Error(error.message + '; all missing workspace sources (' + failures.length + '): ' +
      failures.map(({consumer, dependency}) => consumer + ' -> ' + dependency).join('; '), {cause:error});
  }
}

/** Re-derive a supplied exact graph from committed carriers before package bytes
 * are prepared. Comparative substitutions require a typed side/plan binding;
 * ordinary preparation always re-reads authored pins without replacements. The
 * external exact receiver remains responsible for reviewed-request authority. */
export function validatePreparationGraph({repositories,graph,graphSha256,comparison}){
  if(!graph){if(comparison)throw new Error('comparison preparation requires an exact side graph');return undefined;}
  const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  if(graph.kind!=='guix.resolved-source-graph.v1'||hash(graph)!==graphSha256)throw new Error('preparation graph identity differs');
  let replacements=new Map(),baseline=new Map();
  if(comparison){
    if(comparison.kind!=='guix.comparison-preparation.v1'||!['baseline','candidate'].includes(comparison.side)
      ||Object.keys(comparison).sort().join(',')!=='baselineGraph,candidateGraph,kind,plan,planSha256,side'
      ||comparison.plan.kind!=='guix.comparison-source-plan.v1'||comparison.plan.scope!=='comparison-only'
      ||hash(comparison.plan)!==comparison.planSha256||hash(comparison.baselineGraph)!==comparison.plan.baseline
      ||hash(comparison.candidateGraph)!==comparison.plan.candidate||comparison.plan[comparison.side]!==graphSha256
      ||JSON.stringify(sourceGraphDelta(comparison.baselineGraph,comparison.candidateGraph))!==JSON.stringify(comparison.plan.delta))
      throw new Error('comparison preparation differs from its graph pair and plan');
    if(comparison.side==='candidate'){
      replacements=new Map(comparison.plan.requested.map(source=>[source.repository,source.commit]));
      baseline=new Map(comparison.baselineGraph.repositories.map(source=>[source.repository,source.commit]));
    }
  }
  const machine=graph.machine,root=repositories.find(source=>source.repository===machine?.repository);
  if(!root||root.commit!==machine.commit)throw new Error('preparation graph has no matching machine root');
  const declaration=machineSources(resolve(root.directory,machine.definition),machine.commit,{mounts:directMountsOnly});
  const reading=mountedSourceClosure(declaration,selected=>{
    const found=repositories.filter(source=>source.repository===selected.repository&&source.commit===selected.commit);
    if(found.length!==1)throw new Error(`preparation graph source differs: ${selected.repository}`);
    return found[0].directory;
  },{replacements,baseline});
  if(reading.graphSha256!==graphSha256||JSON.stringify(reading.graph)!==JSON.stringify(graph)
    ||repositories.length!==reading.repositories.length)throw new Error('prepared carriers do not re-derive the exact source graph');
  for(const source of repositories){
    const exact=reading.repositories.find(row=>row.repository===source.repository);
    if(JSON.stringify(source.paths??[source.path])!==JSON.stringify(exact.paths))throw new Error('prepared source coordinates differ');
  }
  return reading.graph;
}

export function prepare({ repositories, entries, buildEntries = [], receivingPackages = [], output, manifestsOnly = false,graph,graphSha256,comparison,declarationOnly }) {
  if(declarationOnly)throw new Error('declaration-only source reading is not preparation authority');
  const selectedGraph=validatePreparationGraph({repositories,graph,graphSha256,comparison});
  if(selectedGraph&&(JSON.stringify(entries)!==JSON.stringify(selectedGraph.entries)||JSON.stringify(receivingPackages)!==JSON.stringify(selectedGraph.receivingPackages)))
    throw new Error('preparation entries or receiving enrollment differs from its exact side graph');
  const trees=new Map(),roots=new Map(),packages=packageSources(repositories,trees,roots);
  if(selectedGraph){
    const authored=selectedGraph.buildEntries;
    if(!comparison&&JSON.stringify(buildEntries)!==JSON.stringify(authored))throw new Error('ordinary build entries differ from the source graph');
    if(comparison){
      const available=selectedSourcesWithDiagnostics(packages,[...entries,...authored]);
      if(new Set(buildEntries).size!==buildEntries.length||authored.some(name=>!buildEntries.includes(name))||buildEntries.some(name=>!available.has(name)))
        throw new Error('comparative build entries exceed the authored machine closure');
    }
  }
  const selected = selectedSourcesWithDiagnostics(packages, [...entries,...buildEntries]);
  assertNoSqliteSources({repositories,entries,buildEntries});
  const receiving=new Map(receivingPackageNames(receivingPackages).map(name=>{
    if(!selected.has(name))throw new Error(`receiving package has no admitted source in the dependency closure: ${name}`);
    return [name,receivingTestPaths(selected.get(name).manifest)];
  }));
  const root = resolve(output);
  mkdirSync(root, { recursive: true });
  // Cross-reference the original manifests and exact runtime source demand
  // before admission resolves a lock. A checked declaration graph alone cannot
  // reveal an omitted supplier. The same check runs for full materialization.
  const parserSource=selected.get('@red-cup-engineering/javascript-node-services-section');
  const runtime=selectedSourcesWithDiagnostics(packages,entries),blobCache=new Map();
  const prefetchSources=records=>{
    const grouped=new Map();
    for(const {repository,entry} of records){
      if(blobCache.has(repository+':'+entry.oid))continue;
      if(!grouped.has(repository))grouped.set(repository,new Map());
      grouped.get(repository).set(entry.oid,entry);
    }
    for(const [repository,entries] of grouped){
      const source=repositories.find(r=>r.repository===repository);
      prefetch(source.directory,source.commit,[...entries.keys()]);
      const read=spawnSync('git',['cat-file','--batch'],{cwd:source.directory,input:[...entries.keys()].join('\n')+'\n',maxBuffer:256*1024*1024});
      if(read.error||read.status!==0)throw read.error??new Error(`cannot read committed source blobs: ${repository}`);
      for(const {entry,bytes} of decodeGitBlobBatch(read.stdout,[...entries.values()])){
        blobCache.set(repository+':'+entry.oid,bytes);
      }
    }
  };
  const readBlob=(repository,entry)=>{
    prefetchSources([{repository,entry}]);return blobCache.get(repository+':'+entry.oid);
  };
  let importReading;
  if(parserSource){
    const target=parserSource.manifest.exports?.['./javascript-parser'];
    if(typeof target!=='string'||!target.startsWith('./')||target.split('/').includes('..'))throw new Error('selected house parser has no bounded source export');
    const file=resolve(parserSource.path,target),base=resolve('.');
    const parserFile=relative(base,file).split('\\').join('/');
    const entry=trees.get(parserSource.repository).find(row=>row.file===parserFile&&row.type==='blob'&&['100644','100755'].includes(row.mode));
    if(!entry)throw new Error('selected house parser export has no committed regular source');
    const temporary=mkdtempSync(resolve(root,'.source-import-reader-'));
    try{
      const path=resolve(temporary,'javascript-parser.mjs');writeFileSync(path,readBlob(parserSource.repository,entry));
      const parser=createRequire(import.meta.url)(path);
      importReading=readSelectedSourceImports({selected:runtime,trees,readBlob,prefetchSources,parser});
      importReading.reader={repository:parserSource.repository,commit:parserSource.commit,path:entry.file,gitBlob:entry.oid};
    }finally{rmSync(temporary,{recursive:true,force:true});}
  }else importReading={kind:'guix.selected-source-imports.v1',scope:'selected-node-runtime-export-surface',packages:[...runtime.keys()],
    modules:[],declarationFindings:[],resolutionFindings:[],demands:[],diagnostics:[{reason:'selected-house-parser-unavailable'}],provesCompleteRuntimeClosure:false};
  // A diagnostic that names a package-interface break carries its class, the one check-package-interfaces reports.
  importReading.diagnostics=importReading.diagnostics.map(row=>{const found=classOfImportDiagnostic(row);return found?{...row,class:found}:row;});
  writeFileSync(resolve(root,'source-imports.json'),JSON.stringify(importReading,null,2)+'\n');
  if(importReading.declarationFindings.length)throw new Error('Selected runtime imports lack declarations: '+importReading.declarationFindings.map(row=>`${row.package}:${row.file} -> ${row.supplier}`).join('; '));
  if(importReading.resolutionFindings.length){
    const missingExports=importReading.resolutionFindings.every(row=>row.reason==='selected-source-export-unavailable');
    const message=missingExports?'Selected runtime imports have no exported interface: ':'Selected runtime imports cannot be materialized: ';
    throw new Error(message+importReading.resolutionFindings.map(row=>`${row.package}:${row.file} -> ${row.specifier} [${row.reason}] (${row.provider?.repository??row.repository}@${row.provider?.commit??row.commit})`).join('; '));
  }
  // Retain only tracked vendor carriers reached by the admitted runtime graph.
  // Discovery still excludes vendor package manifests, and the reader refuses
  // unselected nested package membranes. This is not a directory-copy exception.
  const runtimeFiles=new Set((importReading.materializedFiles??[]).map(row=>
    JSON.stringify([row.repository,row.commit,row.package,row.file,row.gitBlob])));
  const sources = [];
  const selectedFiles=new Map(),receivingFiles=new Map(),requests=new Map();
  for(const [name,p] of selected){
    const repo=repositories.find(r=>r.repository===p.repository);
    const candidates=manifestsOnly&&!receiving.has(name)?[]:treeFiles(repo.directory,p.commit,p.path).filter(({mode,file,oid})=>{
      const parts=file.split('/');
      return ['100644','100755'].includes(mode)&&!parts.some(x=>['node_modules','.git','legacy'].includes(x))&&
        (!parts.includes('vendor')||runtimeFiles.has(JSON.stringify([p.repository,p.commit,name,relative(p.path,file).split('\\').join('/'),oid])));
    });
    const membranes=nestedMembranes(candidates,roots.get(p.repository),p.path,entries=>{
      prefetchSources(entries.map(entry=>({repository:p.repository,entry})));
      return entries.map(entry=>blobCache.get(p.repository+':'+entry.oid).toString('utf8'));
    });
    const files=candidates.filter(({file})=>ownedBy(membranes,p.path,file));
    const tests=(receiving.get(name)??[]).map(path=>{
      const file=files.find(f=>f.file===(p.path==='.'?path:`${p.path}/${path}`));
      if(!file)throw new Error(`receiving test is not a materialized committed regular file: ${name}:${path}`);
      return {...file,path};
    });
    receivingFiles.set(name,tests);
    const material=manifestsOnly?tests:files;
    selectedFiles.set(name,material);
    if(!requests.has(p.repository))requests.set(p.repository,{repo,oids:[]});
    requests.get(p.repository).oids.push(...material.map(f=>f.oid));
  }
  for(const {repo,oids} of requests.values())if(oids.length)prefetch(repo.directory,repo.commit,oids);
  for (const [name, p] of selected) {
    const target = resolve(root, 'packages', name.replaceAll('/', '__'));
    mkdirSync(target, { recursive: true });
    const sourceRepository = repositories.find(r => r.repository === p.repository).directory;
    const files=selectedFiles.get(name);
    // Read the immutable object set in one batch rather than one process per file.
    const batch=files.length?spawnSync('git',['cat-file','--batch'],{cwd:sourceRepository,input:files.map(f=>f.oid+'\n').join(''),maxBuffer:256*1024*1024}):{status:0,stdout:Buffer.alloc(0)};
    if(batch.error||batch.status!==0)throw batch.error??new Error('cannot read source object batch');
    const testIdentities=new Map();
    for(const {entry:{mode,oid,file},bytes:blob} of decodeGitBlobBatch(batch.stdout,files)){
      if(receivingFiles.get(name).some(test=>test.oid===oid))testIdentities.set(oid,sha256(blob));
      if(manifestsOnly)continue;
      const path=relative(p.directory,resolve(sourceRepository,file));
      if(!path||path.startsWith('..'))throw new Error(`source path escapes package: ${p.repository}:${p.path} -> ${file}`);
      const destination=resolve(target,path);mkdirSync(dirname(destination),{recursive:true});
      writeFileSync(destination,blob);chmodSync(destination,mode==='100755'?0o755:0o644);
    }
    // A receiving package's test sees the repository as committed: what that repository mounts is in place.
    const mounts=manifestsOnly||!receiving.has(name)?[]:packageMounts(repositories,p.repository,p.commit,p.path,gitlinks,selectedGraph);
    for(const mount of mounts){
      const rows=treeFiles(mount.directory,mount.commit).filter(({mode,file})=>['100644','100755'].includes(mode)&&!file.split('/').some(x=>['node_modules','.git'].includes(x)));
      prefetch(mount.directory,mount.commit,rows.map(row=>row.oid));
      const read=rows.length?spawnSync('git',['cat-file','--batch'],{cwd:mount.directory,input:rows.map(row=>row.oid+'\n').join(''),maxBuffer:1024*1024*1024}):{status:0,stdout:Buffer.alloc(0)};
      if(read.error||read.status!==0)throw read.error??new Error(`cannot read mounted source objects: ${mount.repository}`);
      for(const {entry:{mode,file},bytes} of decodeGitBlobBatch(read.stdout,rows)){
        const destination=resolve(target,mount.path,file);
        if(!destination.startsWith(resolve(target)+'/'))throw new Error(`mounted source path escapes package: ${mount.repository}:${file}`);
        mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,bytes);chmodSync(destination,mode==='100755'?0o755:0o644);
      }
    }
    const manifest = structuredClone(p.manifest);
    delete manifest.devDependencies;
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependency, requested] of Object.entries(manifest[field] ?? {})) {
        if (selected.has(dependency)) manifest[field][dependency] = 'workspace:*';
        else if (requested.startsWith('workspace:')) throw new Error(`unresolved workspace provider: ${name} -> ${dependency}`);
      }
    }
    // Machine entries are already selected and exposed in the release's root
    // package namespace. Do not manufacture business dependencies in its driver.

    writeFileSync(resolve(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    sources.push({ name, version: manifest.version, repository: p.repository, commit: p.commit, path: p.path,
      sourceManifestSha256: manifestIdentity(p.manifest),
      ...(mounts.length?{mounts:mounts.map(({repository,commit,path,authoredCommit})=>({repository,commit,path,...authoredCommit?{authoredCommit}:{}}))}:{}),
      ...(receiving.has(name)?{receiving:{version:1,manifest:p.manifest,
        tests:receivingFiles.get(name).map(({path,oid})=>({path,gitBlob:oid,sha256:testIdentities.get(oid)}))}}:{}) });
  }
  // Source providers also bind transitive registry consumers to that same source.
  // The lockfile records the resulting singleton dependency graph.
  writeFileSync(resolve(root, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@10.34.6', devDependencies: {yaml:'2.8.1',typescript:'5.9.3','@types/node':'24.9.1'}, scripts: {} }, null, 2) + '\n');
  writeFileSync(resolve(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\nlinkWorkspacePackages: true\npreferWorkspacePackages: true\nautoInstallPeers: false\nignoreScripts: true\noverrides:\n" + [...selected.keys()].map(name => `  ${JSON.stringify(name)}: 'workspace:*'\n`).join(''));
  writeFileSync(resolve(root, 'sources.json'), JSON.stringify({ repositories: repositories.map(({ directory, ...r }) => r), packages: sources, receivingPackages,...selectedGraph?{sourceGraphSha256:graphSha256}:{},...comparison?{comparison:{kind:comparison.kind,side:comparison.side,sourcePlanSha256:comparison.planSha256,runtimeAcceptance:false}}:{} }, null, 2) + '\n');
  return { root, selected: sources.map(p => p.name) };
}

/** A source-reading phase of the existing release preparation, before Guix,
 * dependency acquisition, assembly, tests or receiving. Its input is the actual
 * committed machine and recursively mounted source graph, never a second pin
 * declaration. A missing/changed formation returns its exact refusal carrier.
 * The retained lock is input evidence, not a newly resolved or admitted lock. */
export function previewSources(snapshot,work) {
  const scope=machineDirectory(snapshot),controller=machineDirectory(fileURLToPath(new URL('../',import.meta.url))),root=resolve(work);
  for(const source of [scope.root,controller.root])if(root===source||root.startsWith(source+'/')||source.startsWith(root+'/'))
    throw new Error('source preview must be outside its machine and controller source repositories');
  command('git',['diff','--quiet','HEAD'],controller.root);
  const program=controller.prefix+'scripts/prepare-sources.mjs',programBlob=controller.git('rev-parse',controller.revision+':'+program).trim();
  const programBytes=readFileSync(fileURLToPath(import.meta.url));
  if(gitBlobIdentity(programBytes,programBlob)!==programBlob)throw new Error('source preview program differs from committed controller');
  if(existsSync(root))throw new Error('source preview needs a fresh output directory');
  for(let path=dirname(root);;path=dirname(path)){
    if(existsSync(path)&&(!lstatSync(path).isDirectory()||lstatSync(path).isSymbolicLink()))
      throw new Error('source preview ancestor is redirected or not a directory');
    if(path===dirname(path))break;
  }
  mkdirSync(root,{recursive:true});
  if(realpathSync(root)!==root)throw new Error('source preview output is redirected');
  const treeOf=reading=>reading.git('rev-parse',reading.prefix?reading.tree:reading.revision+'^{tree}').trim();
  const receipt={kind:'guix.source-preparation.v1',state:'not-prepared',
    snapshot:{revision:scope.revision,prefix:scope.prefix,tree:treeOf(scope)},
    controller:{revision:controller.revision,prefix:controller.prefix,tree:treeOf(controller),program,programBlob,programSha256:sha256(programBytes)},
    sourceAdmission:false,runtimeAcceptance:false,lockReading:{state:'unread',reason:'no qualified frozen reader bound; metadata resolution remains held'},
    generatedResources:[]};
  const retain=(path,role)=>{
    const bytes=readFileSync(path);
    receipt.generatedResources.push({role,path:relative(root,path),bytes:bytes.length,sha256:sha256(bytes)});
  };
  try {
    const lock=resolve(snapshot,'dependencies.lock.yaml');
    if(!lstatSync(lock).isFile()||realpathSync(lock)!==lock)
      throw new Error('source preview lock is not a committed regular carrier');
    const bytes=readFileSync(lock);
    const gitBlob=scope.git('rev-parse',scope.revision+':'+scope.prefix+'dependencies.lock.yaml').trim();
    if(gitBlobIdentity(bytes,gitBlob)!==gitBlob)
      throw new Error('source preview lock differs from its committed regular carrier');
    receipt.inputLock={path:relative(scope.root,lock),gitBlob,bytes:bytes.length,sha256:sha256(bytes)};
    writeFileSync(resolve(root,'input.lock.yaml'),bytes);retain(resolve(root,'input.lock.yaml'),'unchanged-input-lock');
    verifyMachineDirectory(snapshot);
    receipt.machineSourceVerified=true;
    const spec=materializeSources(snapshot,root);
    receipt.sources=spec.repositories.map(({directory,...source})=>({...source,tree:command('git',['rev-parse',source.commit+'^{tree}'],directory)}));
    const plan={...spec,output:resolve(root,'workspace'),manifestsOnly:true};
    writeFileSync(resolve(root,'prepare.json'),JSON.stringify(plan,null,2)+'\n');retain(resolve(root,'prepare.json'),'preparation-plan');
    const manifests=packageSources(spec.repositories),sourceManifests=[];
    for(const [name,found] of manifests)for(const source of Array.isArray(found)?found:[found]){
      const repository=spec.repositories.find(row=>row.repository===source.repository);
      const path=source.path==='.'?'package.json':source.path+'/package.json';
      sourceManifests.push({name,repository:source.repository,commit:source.commit,path,
        gitBlob:command('git',['rev-parse',source.commit+':'+path],repository.directory),
        sourceManifestSha256:manifestIdentity(source.manifest),manifest:source.manifest});
    }
    writeFileSync(resolve(root,'source-manifests.json'),JSON.stringify({kind:'guix.source-manifest-reading.v1',packages:sourceManifests},null,2)+'\n');
    retain(resolve(root,'source-manifests.json'),'committed-source-manifests');
    const prepared=prepare(plan);
    writeFileSync(resolve(plan.output,'pnpm-lock.yaml'),bytes);
    retain(resolve(plan.output,'pnpm-lock.yaml'),'unchanged-input-lock');
    for(const file of ['package.json','pnpm-workspace.yaml','sources.json','source-imports.json'])retain(resolve(plan.output,file),'prepared-'+file);
    for(const name of prepared.selected)retain(resolve(plan.output,'packages',name.replaceAll('/','__'),'package.json'),'selected-manifest');
    receipt.state='source-prepared';
    receipt.selected=prepared.selected;
    receipt.importReading=JSON.parse(readFileSync(resolve(plan.output,'source-imports.json'),'utf8'));
    // No success here can establish full lock compatibility, acquisition,
    // executable closure, source admission, toolchain qualification or receipt.
  } catch(error) {
    receipt.refusal={message:error.message,...classifyBreak(error.message)?{break:classifyBreak(error.message)}:{}};
    const imports=resolve(root,'workspace','source-imports.json');
    if(existsSync(imports)){retain(imports,'refused-source-imports');receipt.importReading=JSON.parse(readFileSync(imports,'utf8'));}
  }
  const after=machineDirectory(snapshot);
  if(after.revision!==scope.revision||treeOf(after)!==receipt.snapshot.tree)
    throw new Error('machine source identity changed during source preview');
  if(machineDirectory(controller.path).revision!==controller.revision)throw new Error('controller source identity changed during source preview');
  command('git',['diff','--quiet','HEAD'],controller.root);
  if(receipt.machineSourceVerified)verifyMachineDirectory(snapshot);
  writeFileSync(resolve(root,'source-preparation.json'),JSON.stringify(receipt,null,2)+'\n');
  return receipt;
}

if (isCliEntry(import.meta.url)&&process.argv[2]==='--source-only') {
  if(process.argv.length!==5)throw new Error('usage: prepare-sources.mjs --source-only SNAPSHOT WORK');
  const receipt=previewSources(process.argv[3],process.argv[4]);
  process.stdout.write(JSON.stringify(receipt)+'\n');
  if(receipt.state!=='source-prepared')process.exitCode=1;
} else if (isCliEntry(import.meta.url)) {
  const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  // The plan's bytes may be bound by its graph digest, so the output directory is an argument rather than a plan field.
  const outputArgument = process.argv.find(argument => argument.startsWith('--output='));
  if (outputArgument) spec.output = outputArgument.slice('--output='.length);
  try {
    process.stdout.write(JSON.stringify(prepare({...spec,manifestsOnly:process.argv.includes('--manifests-only')})) + '\n');
  } catch (error) {
    // Name the break class beside the workspace, where the run's outcome summary reads it.
    const found = classifyBreak(error.message, { formerNames: new Set(spec.formerNames ?? []) });
    if (found && spec.output) { mkdirSync(resolve(spec.output), { recursive: true }); writeFileSync(resolve(spec.output, 'assembly-break.json'), JSON.stringify(found, null, 2) + '\n'); }
    if (found) process.stderr.write(`assembly-break: ${found.class}\n`);
    throw error;
  }
}
