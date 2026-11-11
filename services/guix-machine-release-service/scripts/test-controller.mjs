import {qualifyToolchain} from './qualify-toolchain.mjs';
import {machineDirectory} from './machine-directory.mjs';
import {machineSources,directMountsOnly,CONTROLLER_REPOSITORY} from './source-pins.mjs';
import {isCliEntry} from './cli-entry.mjs';
import {readFileSync,mkdirSync,mkdtempSync,writeFileSync,realpathSync,lstatSync,existsSync,renameSync,rmSync} from 'node:fs';
import {resolve,join,dirname,basename,relative,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const packageName='@red-cup-engineering/guix-machine-release-service';
const service=realpathSync(fileURLToPath(new URL('../',import.meta.url)));
function query(program,args,cwd,env=process.env){
  const result=spawnSync(program,args,{cwd,env,encoding:'utf8',maxBuffer:32*1024*1024});
  if(result.error||result.status!==0)throw result.error??new Error(`${program} test admission failed: ${result.stderr.slice(-1500)}`);
  return result.stdout.trim();
}
function execute(program,args,cwd,env){
  const result=spawnSync(program,args,{cwd,env,encoding:'utf8',maxBuffer:32*1024*1024});
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
  if(result.error||result.status!==0)throw result.error??new Error(`${program} controller test failed (${result.status})`);
}

/** Fixed test mode for the controller already admitted by this machine snapshot.
 * No repository, ref, executable or test command is accepted from the caller.
 * This entry point must itself come from the trusted workflow/controller. These
 * checks bind its test input; they are not a sandbox or self-authentication. */
export function testController(snapshotArg,workArg,testScope='controller'){
  if(!['controller','toolchain'].includes(testScope))throw new Error('unsupported controller test scope');
  const snapshot=resolve(snapshotArg),work=resolve(workArg);
  const receiptName=testScope==='toolchain'?'controller-toolchain-test.json':'controller-test.json';
  const git=(directory,...args)=>query('git',['-C',directory,...args],snapshot);
  const requireClean=(directory,label,prefix='')=>{
    if(git(directory,'status','--porcelain','--untracked-files=all','--ignored=matching',...prefix?['--',prefix]:[]))
      throw new Error(`${label} is not clean, including ignored files`);
  };
  const requireExact=(directory,commit,prefix='')=>{
    // Compare working bytes to committed blobs directly: Git index flags can
    // hide changed files from status/diff. Scope nested owners to their package.
    const records=git(directory,'ls-tree','-r','-z',commit,...prefix?['--',prefix]:[]).split('\0').filter(Boolean);
    for(const record of records){
      const tab=record.indexOf('\t'),[mode,type,sha]=record.slice(0,tab).split(' '),path=record.slice(tab+1);
      // A mounted repository is exact by its recorded commit, which the machine's sources verify; it holds no bytes here.
      if(mode==='160000'&&type==='commit')continue;
      const file=join(directory,path),stat=lstatSync(file);
      if(type!=='blob'||!['100644','100755'].includes(mode)||!stat.isFile())throw new Error(`unsupported source carrier: ${path}`);
      const bytes=readFileSync(file),actual=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if(actual!==sha||Boolean(stat.mode&0o111)!==(mode==='100755'))throw new Error(`working source differs from committed blob: ${path}`);
    }
  };
  const revision=git(snapshot,'rev-parse','HEAD');
  if(process.env.GITHUB_REF!=='refs/heads/main'||!/^[0-9a-f]{40}$/.test(revision)
    ||process.env.GITHUB_SHA!==revision)throw new Error('controller tests require the exact admitted main snapshot');
  const scope=machineDirectory(snapshot);
  requireClean(scope.root,'machine definition',scope.prefix);
  requireExact(scope.root,revision,scope.prefix);
  const config=JSON.parse(git(snapshot,'show',`${revision}:${scope.prefix}machine.json`));
  if(typeof config.repository!=='string'||!config.repository.includes('/')
    ||process.env.GITHUB_REPOSITORY!==config.repository)throw new Error('machine repository identity differs');
  const sourceRoot=realpathSync(git(service,'rev-parse','--show-toplevel'));
  const commit=git(service,'rev-parse','HEAD');
  const controllerPrefix=relative(sourceRoot,service);
  requireClean(sourceRoot,'controller source',controllerPrefix);
  requireExact(sourceRoot,commit,controllerPrefix);
  // Establish the exact declaration before executing even the selected helper.
  // The machine's repository mounts the controller at exactly the commit under test.
  const mounted=machineSources(snapshot,revision,{mounts:directMountsOnly}).repositories.filter(source=>source.repository===CONTROLLER_REPOSITORY);
  if((controllerPrefix||'.')!=='.'||mounted.length!==1||mounted[0].commit!==commit)
    throw new Error(`controller identity differs from the commit the machine mounts: ${JSON.stringify({prefix:controllerPrefix,commit,mounted})}`);
  const manifest=JSON.parse(readFileSync(join(service,'package.json'),'utf8'));
  if(manifest.name!==packageName||manifest.scripts?.test!=='node --test test/*.test.mjs')
    throw new Error('controller test command differs from the bounded package contract');
  const owner={repository:CONTROLLER_REPOSITORY,path:'.'};

  let ancestor=work;const remainder=[];
  while(!existsSync(ancestor)){remainder.unshift(basename(ancestor));ancestor=dirname(ancestor);}
  const canonicalWork=join(realpathSync(ancestor),...remainder);
  for(const input of [realpathSync(snapshot),sourceRoot])if(canonicalWork===input||canonicalWork.startsWith(input+sep))
    throw new Error('controller test results must remain outside source inputs');
  for(const [path,directory] of [[work,true],[join(work,receiptName),false]]){
    try{const stat=lstatSync(path);if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile()))throw new Error('invalid controller test result path');}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }

  const identity={kind:testScope==='toolchain'?'guix-controller-toolchain-test.v1':'guix-controller-test.v1',machineRepository:config.repository,machineCommit:revision,
    controllerRepository:owner.repository,controllerCommit:commit,controllerPath:owner.path,...(testScope==='toolchain'?{scope:testScope}:{})};
  const env={...process.env,PATH:dirname(process.execPath)+':'+(process.env.PATH??''),NODE_OPTIONS:'--max-old-space-size=384'};
  // A caller's node:test worker marker must not make a fresh package test runner
  // silently skip every file as a recursive run.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_PATH;
  for(const key of Object.keys(env))if(/^npm_config_/i.test(key))delete env[key];
  mkdirSync(work,{recursive:true});
  const configs=mkdtempSync(join(work,'.test-config-'));
  const userConfig=join(configs,'user.npmrc'),globalConfig=join(configs,'global.npmrc');
  writeFileSync(userConfig,'',{mode:0o600});writeFileSync(globalConfig,'',{mode:0o600});
  env.NPM_CONFIG_CACHE=join(configs,'npm-cache');
  const checks=testScope==='toolchain'?[]:[
    ['package-tests','npm',['--offline','--no-audit','--no-fund','--no-update-notifier','--ignore-scripts',`--userconfig=${userConfig}`,`--globalconfig=${globalConfig}`,
      '--script-shell=/bin/sh','--node-options=--max-old-space-size=384','test']],
    ['health-reading','guile',['--no-auto-compile',join(service,'test/health-reading.scm')]],
    ['controller-owner','guile',['--no-auto-compile',join(service,'test/controller-owner.scm')]],
  ];
  // Toolchain scope realizes only the two fixed tooling inputs. It never reads
  // the application's dependency lock or invokes normal package discovery,
  // source formation, application installation, assembly, receiving or promotion.
  const writeReceipt=(value)=>{
    const temporary=join(work,testScope==='toolchain'?`.controller-toolchain-test-${randomUUID()}.json`:`.controller-test-${randomUUID()}.json`);
    writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
    renameSync(temporary,join(work,receiptName));
  };
  const completed=[];let stage='package-tests',toolchainReading;
  try{
    if(testScope==='toolchain'){
      toolchainReading=qualifyToolchain({service,snapshot,configs,path:env.PATH,query,execute,onStage:value=>{stage=value;},onReading:value=>{toolchainReading=value;}});
      completed.push('toolchain-realization','toolchain-inventory','toolchain-frozen-provider');
    }
    for(const [name,program,args] of checks){stage=name;execute(program,args,service,env);completed.push(name);}
    stage='source-integrity';
    if(git(service,'rev-parse','HEAD')!==commit||git(snapshot,'rev-parse','HEAD')!==revision)
      throw new Error('source identity changed during controller tests');
    requireClean(sourceRoot,'controller source',controllerPrefix);requireClean(snapshot,'machine snapshot');
    requireExact(sourceRoot,commit,controllerPrefix);requireExact(snapshot,revision);
    const receipt={...identity,outcome:'passed',checks:completed,...(toolchainReading?{toolchain:toolchainReading}:{})};
    writeReceipt(receipt);return receipt;
  }catch(error){
    writeReceipt({...identity,outcome:'failed',stage,checks:completed,error:error.message,...(toolchainReading?{toolchain:toolchainReading}:{})});
    throw error;
  }finally{rmSync(configs,{recursive:true,force:true});}
}

if(isCliEntry(import.meta.url)){
  if(process.argv.length!==4&&!(process.argv.length===5&&process.argv[4]==='--toolchain'))throw new Error('usage: test-controller.mjs <admitted-snapshot> <result-directory> [--toolchain]');
  process.stdout.write(JSON.stringify(testController(process.argv[2],process.argv[3],process.argv[4]?'toolchain':'controller'))+'\n');
}
