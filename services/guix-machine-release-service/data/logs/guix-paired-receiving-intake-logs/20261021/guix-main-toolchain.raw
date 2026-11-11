import {mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';

// The same exact installed-channel and prerequisite path supplies both the
// fixed assay and ordinary frozen composition. It has no installation fallback.
export function realizeToolchain({service,snapshot,home,path,query}) {
  mkdirSync(home);
  const environment={HOME:home,PATH:path,LANG:'C.UTF-8',LC_ALL:'C.UTF-8'};
  const toolchain=query('guix',['repl','--',join(service,'scripts/pinned-guix.scm'),join(snapshot,'channels.scm'),
    '--require-installed','build','--no-grafts','-L',join(service,'src'),'-e','((@ (guix-deployment) dependency-toolchain))'],snapshot,environment);
  if(!/^\/gnu\/store\/[0-9a-z]{32}-[^/\s]+$/u.test(toolchain))throw new Error('Guix returned no unique toolchain store path');
  return toolchain;
}

// Shared fixed tooling assay. Callers authenticate their respective source
// authority first; this function grants neither release admission nor promotion.
export function qualifyToolchain({service,snapshot,configs,path,query,execute,onStage,onReading=()=>{}}) {
      onStage('toolchain-realization');
      const toolchain=realizeToolchain({service,snapshot,home:join(configs,'guix-home'),path,query});
      const node=join(toolchain,'bin/node');
      const isolated={HOME:join(configs,'home'),PATH:join(toolchain,'bin'),LANG:'C.UTF-8',LC_ALL:'C.UTF-8',
        TMPDIR:join(configs,'tmp'),NODE_DISABLE_COMPILE_CACHE:'1'};
      mkdirSync(isolated.HOME);mkdirSync(isolated.TMPDIR);
      onStage('toolchain-inventory');
      const toolchainReading={storePath:toolchain,...JSON.parse(query(node,['--no-addons','--no-global-search-paths',join(service,'scripts/design-rules.mjs'),'--verify-guix-toolchain',toolchain],service,isolated))};
      onReading(toolchainReading);
      if(toolchainReading.nodeVersion!=='24.18.0'||toolchainReading.nodeExecutable!==realpathSync(node))throw new Error('realized Node identity differs from the reviewed channel runtime');
      const inventories=JSON.parse(readFileSync(join(service,'specifications/dependency-toolchain.json'),'utf8'));
      for(const provider of inventories){
        const receipt=join(configs,provider.name+'-inventory.json');writeFileSync(receipt,JSON.stringify(provider));
        isolated['DRC3_'+provider.name.toUpperCase()+'_PACKAGE']=join(toolchain,'share',provider.name,'package');
        isolated['DRC3_'+provider.name.toUpperCase()+'_RECEIPT']=receipt;
      }
      isolated.DRC3_YAML_ARCHIVE=join(toolchain,'share/archives/yaml-2.9.0.tgz');
      onStage('toolchain-frozen-provider');
      execute(node,['--no-addons','--no-global-search-paths','--test','--test-concurrency=1',
        join(service,'test/qualification/frozen-acquisition-provider.test.mjs')],service,isolated);
  return toolchainReading;
}
