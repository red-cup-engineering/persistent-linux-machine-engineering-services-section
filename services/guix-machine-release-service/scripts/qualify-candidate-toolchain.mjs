import {accessSync,constants,readdirSync,readFileSync,lstatSync,realpathSync,mkdirSync,mkdtempSync,writeFileSync,renameSync,rmSync,existsSync} from 'node:fs';
import {resolve,join,dirname,basename,sep,delimiter,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {isCliEntry} from './cli-entry.mjs';
import {qualifyToolchain} from './qualify-toolchain.mjs';
import {qualifyControllerSources} from './qualify-controller-sources.mjs';
import {machineSourceIdentity} from './source-pins.mjs';
import {verifyMachineDirectory} from './machine-directory.mjs';
import {verifyCommittedSource} from './verify-release-source.mjs';

const repository='red-cup-engineering/guix-machine-release-service';
const channelsBlob='be2ad3e698618dc916fe126880b6ed9573ee1bb3';
const ownRoot=realpathSync(fileURLToPath(new URL('../',import.meta.url)));
function query(program,args,cwd,env){
  const result=spawnSync(program,args,{cwd,env,encoding:'utf8',maxBuffer:32*1024*1024});
  if(result.error||result.status!==0)throw result.error??new Error(`${program} candidate qualification failed: ${(result.stderr??'').slice(-1500)}`);
  return result.stdout.trim();
}
function execute(program,args,cwd,env){
  const result=spawnSync(program,args,{cwd,env,encoding:'utf8',maxBuffer:32*1024*1024});
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
  if(result.error||result.status!==0)throw result.error??new Error(`${program} candidate qualification failed (${result.status})`);
}
function blobOf(bytes){return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');}
function verifyTree(serviceArg,expectedCommit,expectedTree,env,allowGitlinks=false){
  if(!/^[0-9a-f]{40}$/u.test(expectedCommit)||!/^[0-9a-f]{40}$/u.test(expectedTree))throw new Error('candidate identity must be exact commit and tree');
  const environmentPath=env?.PATH??process.env.PATH??'';
  const gitExecutable=environmentPath.split(delimiter).filter(isAbsolute).map(directory=>join(directory,'git')).find(file=>{
    try{accessSync(file,constants.X_OK);return lstatSync(file).isFile()||lstatSync(file).isSymbolicLink();}catch{return false;}
  });
  if(!gitExecutable)throw new Error('trusted Git executable unavailable for source verification');
  // The same synchronous custody core is emitted by the trusted caller. Reading
  // source identity must not run repository clean/process filters or cached code.
  return verifyCommittedSource({directory:serviceArg,commit:expectedCommit,tree:expectedTree,gitExecutable,allowGitlinks},
    {readFileSync,readdirSync,lstatSync,realpathSync,resolve,join,spawnSync,createHash,environmentPath}).root;
}

export function verifySourceTree(serviceArg,expectedCommit,expectedTree,env){
  return verifyTree(serviceArg,expectedCommit,expectedTree,env);
}
export function verifySnapshotSource(snapshotArg,expectedCommit,expectedTree,env){
  return verifyTree(snapshotArg,expectedCommit,expectedTree,env,true);
}
/** Bind a definition under an already authenticated repository root. A
 * nested repository, lexical alias or redirected directory cannot self-identify
 * as that root merely by copying machine.json.repository. */
export function verifyMachineSnapshot(rootArg,identity,env){
  if(!identity||typeof identity.definition!=='string'||!(identity.definition==='.'||/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(identity.definition))
    ||identity.definition.split('/').some(part=>part==='..'||(part==='.'&&identity.definition!=='.')))
    throw new Error('machine definition must be a canonical repository-relative path');
  if(typeof rootArg!=='string'||resolve(rootArg)!==rootArg||rootArg.includes('\\')||rootArg.includes('//')||realpathSync(rootArg)!==rootArg)
    throw new Error('machine source root must be canonical');
  const root=verifySnapshotSource(rootArg,identity.commit,identity.tree,env),snapshot=join(root,identity.definition);
  if(realpathSync(snapshot)!==snapshot)throw new Error('machine definition path is redirected');
  const actual=machineSourceIdentity(snapshot);
  if(actual.repository!==identity.repository||actual.commit!==identity.commit||actual.tree!==identity.tree||actual.definition!==identity.definition)
    throw new Error('machine definition does not belong to the authenticated source root');
  verifyMachineDirectory(snapshot);
  return {root,snapshot,identity:actual};
}

export function verifyCandidateSource(serviceArg,expectedCommit,expectedTree,env){
  const service=verifySourceTree(serviceArg,expectedCommit,expectedTree,env);
  const manifest=JSON.parse(readFileSync(join(service,'package.json'),'utf8'));
  if(manifest.name!=='@red-cup-engineering/guix-machine-release-service')throw new Error('candidate package owner differs');
  return service;
}
export function verifyQualificationChannels(snapshotArg){
  const snapshot=realpathSync(snapshotArg),file=join(snapshot,'channels.scm');
  if(!lstatSync(file).isFile()||realpathSync(file)!==file||blobOf(readFileSync(file))!==channelsBlob)
    throw new Error('qualification channels differ from the workflow-reviewed source');
  return snapshot;
}

// The trusted workflow must verify this entire candidate BEFORE invoking it.
// These repeated checks bind evidence and catch mutation; they do not make
// candidate code its own trust root or admit it into a machine release.
export function qualifyCandidateToolchain(serviceArg,snapshotArg,workArg,expectedCommit,expectedTree){
  const env={PATH:process.env.PATH??'',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'};
  const service=verifyCandidateSource(serviceArg,expectedCommit,expectedTree,env);
  if(service!==ownRoot)throw new Error('qualification entrypoint is outside the exact candidate');
  const snapshot=verifyQualificationChannels(snapshotArg),work=resolve(workArg);
  let ancestor=work;const suffix=[];
  while(!existsSync(ancestor)){suffix.unshift(basename(ancestor));ancestor=dirname(ancestor);}
  const canonical=join(realpathSync(ancestor),...suffix);
  if(canonical!==work)throw new Error('qualification result path is redirected');
  for(const input of [service,snapshot])if(work===input||work.startsWith(input+sep))throw new Error('qualification results must be outside source inputs');
  if(existsSync(work)&&!lstatSync(work).isDirectory())throw new Error('qualification result path must be a directory');
  mkdirSync(work,{recursive:true});
  const configs=mkdtempSync(join(work,'.candidate-toolchain-'));
  const identity={kind:'guix-candidate-toolchain-qualification.v1',candidateRepository:repository,candidateCommit:expectedCommit,candidateTree:expectedTree,channelsBlob,scope:'fixed-toolchain-and-controller-source'};
  const receiptFile=join(work,'candidate-toolchain-qualification.json');
  const writeReceipt=reading=>{
    const temporary=join(work,`.candidate-toolchain-${randomUUID()}.json`);
    writeFileSync(temporary,JSON.stringify(reading,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temporary,receiptFile);
  };
  let stage='toolchain-realization',toolchain,controllerSources;
  try{
    toolchain=qualifyToolchain({service,snapshot,configs,path:env.PATH,query,execute,onStage:value=>{stage=value;},onReading:value=>{toolchain=value;}});
    controllerSources=qualifyControllerSources({service,snapshot,configs,path:env.PATH,toolchain,query,execute,onStage:value=>{stage=value;},onReading:value=>{controllerSources=value;}});
    stage='source-integrity';
    verifyCandidateSource(service,expectedCommit,expectedTree,env);verifyQualificationChannels(snapshot);
    const receipt={...identity,outcome:'passed',checks:['toolchain-realization','toolchain-inventory','toolchain-frozen-provider','controller-test-prerequisites','controller-source-assays','toolchain-workspace-reading','source-integrity'],toolchain,controllerSources};
    writeReceipt(receipt);return receipt;
  }catch(error){writeReceipt({...identity,outcome:'failed',stage,error:error.message,...(toolchain?{toolchain}:{}),...(controllerSources?{controllerSources}:{})});throw error;}
  finally{rmSync(configs,{recursive:true,force:true});}
}
if(isCliEntry(import.meta.url)){
  if(process.argv.length!==7)throw new Error('usage: qualify-candidate-toolchain.mjs SERVICE SNAPSHOT WORK EXPECTED_COMMIT EXPECTED_TREE');
  process.stdout.write(JSON.stringify(qualifyCandidateToolchain(...process.argv.slice(2)))+'\n');
}
