import {mkdirSync,realpathSync,statSync} from 'node:fs';
import {join,dirname} from 'node:path';

// Fixed, reviewed owner assays only. No caller-provided file, command or glob.
export const controllerSourceAssays=Object.freeze([
  'test/frozen-workspace-reading.test.mjs',
  'test/design-rules.test.mjs',
  'test/sqlite-source-admission.test.mjs',
  'test/sqlite-source-admission-regression.test.mjs',
  'test/dependency-toolchain.test.mjs',
  'test/change-frozen-acquisition.test.mjs',
  'test/typescript-build.test.mjs',
  'test/candidate-toolchain.test.mjs',
  'test/release-caller-projection.test.mjs',
  'test/ephemeral-boot.test.mjs',
  'test/exact-change-receiving.test.mjs',
  'test/controller-names-no-machine.test.mjs',
  'test/package-receiving.test.mjs',
  'test/mounted-owner-coordinates.test.mjs',
  'test/source-pins.test.mjs',
  'test/materialize-sources.test.mjs',
  'test/test-change.test.mjs',
  'test/nested-mounted-receiving.test.mjs',
  'test/comparison-source-graph.test.mjs',
  'test/comparison-receiving.test.mjs',
  'test/comparison-mounted-receiving.test.mjs',
  'test/release-caller-carriers.test.mjs',
  'test/test-controller.test.mjs',
  'test/controller-source-qualification.test.mjs',
]);

export function controllerTestEnvironment({tools,nodeExecutable,home,tmp}){
  if(!tools||Object.keys(tools).sort().join(',')!=='guile,json'||
     !/^\/gnu\/store\/[0-9a-z]{32}-guile-3\.0\.11$/u.test(tools.guile)||
     !/^\/gnu\/store\/[0-9a-z]{32}-guile-json-4\.7\.3$/u.test(tools.json)||
     !/^\/gnu\/store\/[0-9a-z]{32}-node-24\.18\.0\/bin\/node$/u.test(nodeExecutable))
    throw new Error('controller tests require exact installed pinned interpreter identities');
  return {HOME:home,TMPDIR:tmp,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',NODE_DISABLE_COMPILE_CACHE:'1',
    PATH:[dirname(nodeExecutable),join(tools.guile,'bin'),'/usr/bin','/bin'].join(':'),
    GUILE_AUTO_COMPILE:'0',GUILE_LOAD_PATH:join(tools.json,'share/guile/site/3.0'),
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'};
}

export function qualifyControllerSources({service,snapshot,configs,path,toolchain,query,execute,onStage,onReading=()=>{}}){
  onStage('controller-test-prerequisites');
  const home=join(configs,'controller-home'),tmp=join(configs,'controller-tmp');
  mkdirSync(home);mkdirSync(tmp);
  const tools=JSON.parse(query('guix',['repl','--',join(service,'scripts/pinned-guix.scm'),
    join(snapshot,'channels.scm'),'--require-installed','repl','--',
    join(service,'scripts/installed-controller-test-tools.scm')],snapshot,
    {HOME:home,PATH:path,LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}));
  const node=toolchain.nodeExecutable;
  const env=controllerTestEnvironment({tools,nodeExecutable:node,home,tmp});
  // Refuse missing paths; do not gain an interpreter through a profile fallback.
  for(const file of [node,join(dirname(node),'npm'),join(tools.guile,'bin/guile'),
    join(env.GUILE_LOAD_PATH,'json.scm')]){
    if(!statSync(file).isFile())throw new Error('installed controller test prerequisite is not a file');
  }
  if(realpathSync(node)!==node||realpathSync(join(tools.guile,'bin/guile'))!==join(tools.guile,'bin/guile'))
    throw new Error('installed controller interpreter is redirected');
  const reading={guileExecutable:join(tools.guile,'bin/guile'),jsonModule:join(env.GUILE_LOAD_PATH,'json.scm'),
    nodeExecutable:node,assays:[...controllerSourceAssays,'test/qualification/frozen-workspace-reading.test.mjs']};
  onReading(reading);
  onStage('controller-source-assays');
  execute(node,['--no-addons','--no-global-search-paths','--test','--test-concurrency=1',
    ...controllerSourceAssays.map(file=>join(service,file))],service,env);
  onStage('toolchain-workspace-reading');
  execute(node,['--no-addons','--no-global-search-paths','--test','--test-concurrency=1',
    join(service,'test/qualification/frozen-workspace-reading.test.mjs')],service,
    {...env,DRC3_YAML_PACKAGE:join(toolchain.storePath,'share/yaml/package'),
      ASSAY_OUTPUT:join(configs,'workspace-reading')});
  return reading;
}
