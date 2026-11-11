import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {machineSources,mountedSourceClosure,directMountsOnly} from '../../scripts/source-pins.mjs';
import {projectLspaceCorpus} from '../../scripts/lspace-corpus.mjs';

const SCIENCE='lenticule-science/science-services-section',CHILD='lenticule-science/math-services-section';
const ROOT='sources/lenticule-science',OCCURRENCE=ROOT+'/science-services-section';
const CHILD_PATH='services/math-services-section';
const hash=graph=>createHash('sha256').update(JSON.stringify(graph)).digest('hex');
function git(directory,...args){
  const result=spawnSync('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:directory});
  if(result.status!==0)throw new Error(result.stderr.toString());
  return result.stdout;
}
function repository(root,name,files){
  const directory=join(root,name);mkdirSync(directory);
  git(directory,'init','-q','--initial-branch=main');
  for(const [path,bytes] of Object.entries(files)){const file=join(directory,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes);}
  return directory;
}
function commit(directory){git(directory,'add','--ignore-removal','.');git(directory,'commit','-qm','synthetic committed source');return git(directory,'rev-parse','HEAD').toString().trim();}
function mount(directory,path,commit){git(directory,'update-index','--add','--cacheinfo',`160000,${commit},${path}`);}
function modules(entries){return entries.map(([repository,path])=>`[submodule "${path}"]\n path = ${path}\n url = https://github.com/${repository}.git\n branch = main\n`).join('');}
const protectedText='---\nvisibility: protected\n---\n# Protected\n\n![kept](../media/kept.png)\n';

// Self-contained source-contract fixtures. The genuine Science policy and Markdown parser
// are additionally exercised by the producer's source-bound receiving qualification.
const fixturePolicy=({sciencePrefix,excludes=[]})=>({
  excludes:['legacy','triage','private','dev','test','fixtures','dist','sites','lib',...excludes],
  admitPath:path=>path.startsWith(sciencePrefix+'/'),
});
const fixtureParser=markdown=>({blocks:[...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/gu)].map(match=>({kind:'image',src:match[1]}))});

export function corpusFixture(t,{readerPolicy=fixturePolicy,parseDocumentBody=fixtureParser,extraFiles={}}={}){
  const root=mkdtempSync(join(tmpdir(),'lspace-source-projection-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const child=repository(root,'child',{'content/math.MARKDOWN':'# Mathematics\n','private/hidden.md':'secret child fixture\n'}),childCommit=commit(child);
  const science=repository(root,'science',{
    '.gitmodules':modules([[CHILD,CHILD_PATH]]),
    'sites/l-space.561.group/package.json':JSON.stringify({name:'@lenticule-science/l-space'}),
    'content/public.md':'---\nvisibility: public\n---\n# Public\n\n![kept](../media/kept.png)\n',
    'content/protected.md':protectedText,
    'content/unsafe.md':'# Invalid references\n\n![private](../private/hidden.png)\n![outside](../../../sibling/leak.png)\n![link](../media/link.png)\n![remote](https://example.invalid/image.png)\n',
    'media/kept.png':Buffer.from([0,1,2,3]),'media/unreferenced.png':'unused fixture',
    'private/hidden.md':'excluded fixture','private/hidden.png':'excluded asset',
    'dev/working.md':'working fixture','legacy/old.md':'legacy fixture',
    'sites/not-corpus.md':'package fixture','lib/not-corpus.md':'library fixture',...extraFiles,
  });
  symlinkSync('../private/hidden.png',join(science,'media/link.png'));mount(science,CHILD_PATH,childCommit);const scienceCommit=commit(science);
  const sibling=repository(root,'sibling',{'leak.md':'sibling fixture','leak.png':'sibling asset'}),siblingCommit=commit(sibling);
  const machine=repository(root,'machine',{
    '.gitmodules':modules([[SCIENCE,OCCURRENCE],['fixture/sibling','sources/sibling']]),
    'machine.json':JSON.stringify({repository:'fixture/machine',run:{entries:['@lenticule-science/l-space']}}),
  });
  mount(machine,OCCURRENCE,scienceCommit);mount(machine,'sources/sibling',siblingCommit);commit(machine);
  const directories=new Map([['fixture/machine',machine],[SCIENCE,science],[CHILD,child],['fixture/sibling',sibling]]);
  const prepared=mountedSourceClosure(machineSources(machine,'HEAD',{mounts:directMountsOnly}),source=>directories.get(source.repository));
  const reads=[],lists=[],written=new Map();
  const options={graph:prepared.graph,graphSha256:prepared.graphSha256,
    packageSource:{name:'@lenticule-science/l-space',repository:SCIENCE,commit:scienceCommit,path:'sites/l-space.561.group'},
    configuration:{root:ROOT,sciencePrefix:'science-services-section'},readerPolicy,parseDocumentBody,
    listTree:source=>{
      lists.push(source.repository);
      return git(directories.get(source.repository),'ls-tree','-rz',source.commit).toString().split('\0').filter(Boolean).map(record=>{
        const [header,file]=record.split('\t'),[mode,type,oid]=header.split(' ');return {file,mode,type,oid};
      });
    },
    readBlobs:(source,rows)=>rows.map(row=>{
      reads.push({repository:source.repository,commit:source.commit,path:row.file});
      return git(directories.get(source.repository),'cat-file','blob',row.oid);
    }),
    writeBlob:row=>{assert.equal(written.has(row.path),false);written.set(row.path,row);},
  };
  return {options,reads,lists,written,prepared,directories};
}


export {OCCURRENCE,CHILD,protectedText,hash};
