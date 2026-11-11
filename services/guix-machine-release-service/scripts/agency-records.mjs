// The house agency a machine declares (`agency.root` in machine.json, relative to the machine
// repository) is carried into the release as `agency/`. The node reads it in place, immutable
// (METROPLAT_AGENCY_ROOT={release}/agency), and journals its acts in AGENCY_ACTS_LOG, so each
// release reads its own records and no machine reads a hand-filled copy.
import {cpSync,existsSync,lstatSync,mkdirSync,readdirSync,writeFileSync} from 'node:fs';
import {join,relative,resolve,sep,basename} from 'node:path';

// The same directories organizing's agency walk passes over (services/organizing/src/agency/index.mjs).
const SKIP=new Set(['node_modules','.git','legacy','_archive','vendor','dist','.cache','.tmp','coverage']);
const POOL_PARENT=/(?:^|\/)lib\/agency$/u;
const SECTION_DIR=/-(?:section|service)$/u;
export const AGENCY_MARKER='.agency.json';

/** Each directory under ROOT that organizing reads pools from, relative to ROOT: a section's
 *  `lib/agency`, or `skills` directly in a section. Symbolic links are never followed. */
export function agencyDirectories(root){
  const found=[],stack=[root];
  while(stack.length){
    const dir=stack.pop();
    for(const entry of readdirSync(dir,{withFileTypes:true})){
      if(!entry.isDirectory()||SKIP.has(entry.name))continue;
      const path=join(dir,entry.name),rel=relative(root,path).split(sep).join('/');
      if(POOL_PARENT.test(rel)||(entry.name==='skills'&&SECTION_DIR.test(basename(dir))))found.push(rel);
      else stack.push(path);
    }
  }
  return found.sort();
}

/** Copy ROOT's agency directories into INTO with their relative paths, without symbolic links or
 *  skipped directories, and write the marker that names what was carried. */
export function carryAgency(root,into,provenance={}){
  if(!existsSync(root)||!lstatSync(root).isDirectory())throw new Error(`declared agency root is not a directory: ${root}`);
  const directories=agencyDirectories(root);
  if(!directories.length)throw new Error(`declared agency root holds no agency: ${root}`);
  let files=0;
  for(const rel of directories)cpSync(join(root,rel),join(into,rel),{recursive:true,filter:source=>{
    const stat=lstatSync(source);
    if(stat.isSymbolicLink()||(stat.isDirectory()&&SKIP.has(basename(source))))return false;
    if(stat.isFile())files++;
    return true;
  }});
  mkdirSync(into,{recursive:true});
  const marker={...provenance,directories:directories.length,files};
  writeFileSync(join(into,AGENCY_MARKER),JSON.stringify(marker,null,2)+'\n');
  return marker;
}

/** The agency root a machine declares, resolved inside its repository, or null when it declares none. */
export function declaredAgencyRoot(machine,repository){
  const declared=machine?.agency?.root;
  if(declared===undefined)return null;
  if(typeof declared!=='string'||!declared)throw new Error('machine.json agency.root must be a non-empty path');
  const root=resolve(repository,declared),rel=relative(repository,root);
  if(rel.startsWith('..')||resolve(repository,rel)!==root)throw new Error(`machine.json agency.root leaves the machine repository: ${declared}`);
  return root;
}
