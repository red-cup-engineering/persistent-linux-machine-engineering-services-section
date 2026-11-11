import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

import {machineSources,gitlinks} from '../scripts/source-pins.mjs';
import {packageSources} from '../scripts/prepare-sources.mjs';
import {packageManifests,changedSourcePackages} from '../scripts/test-change.mjs';
import {sourceGraphDelta} from '../scripts/materialize-sources.mjs';

for(const layout of ['mixed','excluded','live'])for(const reversed of [false,true]){
  const excludedOnly=layout==='excluded';
  test(`${layout} coordinates retain ownership with ${reversed?'reversed':'archive-first'} mounts`,t=>{
    const root=mkdtempSync(join(tmpdir(),'mounted-coordinate-review-'));
    t.after(()=>rmSync(root,{recursive:true,force:true}));
    const env={PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ALLOW_PROTOCOL:'',GIT_TERMINAL_PROMPT:'0',
      GIT_AUTHOR_DATE:'2026-10-12T00:00:00Z',GIT_COMMITTER_DATE:'2026-10-12T00:00:00Z',GIT_AUTHOR_NAME:'Source Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Source Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
    const git=(directory,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-C',directory,...args],{env,encoding:'utf8'}).trim();
    const sources=new Map();
    const repo=(repository,files={},mounts=[])=>{
      const directory=join(root,repository.replace('/','-'));mkdirSync(directory);
      git(directory,'init','-q');
      for(const [path,bytes] of Object.entries(files)){mkdirSync(dirname(join(directory,path)),{recursive:true});writeFileSync(join(directory,path),bytes);}
      if(mounts.length)writeFileSync(join(directory,'.gitmodules'),mounts.map(m=>`[submodule "${m.path}"]\n path = ${m.path}\n url = https://github.com/${m.repository}.git\n branch = main\n`).join(''));
      git(directory,'add','.');
      for(const m of mounts)git(directory,'update-index','--add','--cacheinfo',`160000,${m.commit},${m.path}`);
      git(directory,'-c','commit.gpgsign=false','commit','-q','--allow-empty','-m','fixture');
      const source={repository,directory,commit:git(directory,'rev-parse','HEAD')};sources.set(repository,source);return source;
    };
    const leaf=repo('fixture/leaf',{'package.json':JSON.stringify({name:'@fixture/leaf',version:'1.0.0'})});
    const shared=repo('fixture/shared',{'package.json':JSON.stringify({name:'@fixture/shared',version:'1.0.0'})},[{...leaf,path:'nested/leaf'}]);
    const archive=repo('fixture/archive',{},[{...shared,path:'child'}]);
    const live=repo('fixture/live',{},[{...shared,path:'child'}]);
    const mounts=[{...archive,path:layout==='live'?'services/first':'history/archive'},{...live,path:excludedOnly?'data/records/live':'services/live'}];
    if(reversed)mounts.reverse();
    const machine=repo('fixture/machine',{'machine.json':JSON.stringify({repository:'fixture/machine',run:{entries:['@fixture/shared']}})},mounts);
    const graph=machineSources(machine.directory,'HEAD',{mounts:source=>{
      const local=sources.get(source.repository);assert.equal(local.commit,source.commit);
      return gitlinks(local.directory,source.commit,{requireAll:true});
    }});
    const repositories=graph.repositories.map(source=>({...source,directory:sources.get(source.repository).directory}));
    const actual=[...packageSources(repositories).keys()].sort();
    const attributed=repositories.flatMap(source=>[...packageManifests(source.directory,source.commit,source.paths??source.path).values()]).sort();
    const expected=excludedOnly?[]:['@fixture/leaf','@fixture/shared'];
    t.diagnostic(JSON.stringify({reversed,excludedOnly,selected:actual,attributed,rows:repositories.map(({repository,commit,path,paths})=>({repository,commit,path,...paths?{paths}: {}}))}));
    assert.deepEqual(actual,expected,'all authenticated mount coordinates must be considered, including the shared child\'s descendants');
    assert.deepEqual(attributed,expected,'changed-package attribution must share the same mounted-coordinate ownership');
    for(const repository of ['fixture/shared','fixture/leaf'])assert.equal(repositories.find(row=>row.repository===repository).paths.length,2,'all coordinates and descendant coordinates stay visible');
    assert.equal(graph.graphSha256,undefined,'declaration-only injected reads do not claim authenticated graph identity');
    if(layout==='mixed'){
      const base={repositories:repositories.map(source=>({...source,paths:source.paths.filter(path=>path.startsWith('history/'))}))};
      // Keep the root and parent rows intact: only compare the shared owner's
      // admissibility through the actual attribution function used by testChange.
      base.repositories=base.repositories.map((source,index)=>['fixture/shared','fixture/leaf'].includes(source.repository)?source:repositories[index]);
      const head={repositories};const delta=sourceGraphDelta(base,head);
      for(const owner of ['fixture/shared','fixture/leaf']){
        const row=delta.find(row=>row.repository===owner);assert.equal(row.baseline.commit,row.candidate.commit);
        assert.notDeepEqual(row.baseline.paths,row.candidate.paths);
      }
      const admitted=changedSourcePackages(base.repositories,head.repositories,delta);
      assert.deepEqual(admitted.changed.map(row=>row.name).sort(),['@fixture/leaf','@fixture/shared']);
      const retired=changedSourcePackages(head.repositories,base.repositories,sourceGraphDelta(head,base));
      assert.deepEqual([...retired.atPins.keys()].filter(name=>!retired.headNames.has(name)).sort(),['@fixture/leaf','@fixture/shared']);
    }
  });
}
