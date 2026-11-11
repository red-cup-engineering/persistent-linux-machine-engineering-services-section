// Bounded qualification control, not an OS security boundary or a replacement provider.
'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),tls=require('node:tls');
const dns=require('node:dns'),dgram=require('node:dgram'),cp=require('node:child_process');
const Module=require('node:module'),threads=require('node:worker_threads');
const root=fs.realpathSync(process.env.DRC3_FIXTURE_ROOT),port=Number(process.env.DRC3_FIXTURE_PORT);
const role=process.env.DRC3_FIXTURE_ROLE;
const cli=process.env.DRC3_PNPM_CLI,yaml=process.env.DRC3_YAML_CLI,generator=process.env.DRC3_GENERATOR;
const parser=path.join(path.dirname(__filename),'controller/scripts/parse-frozen-yaml.mjs');
const denied=detail=>{throw new Error('DRC3_FIXTURE_BOUNDARY_REFUSED: '+detail);};
const inside=p=>{const relative=path.relative(root,path.resolve(p));return relative===''||relative!=='..'&&!relative.startsWith('../')&&!path.isAbsolute(relative);};
if(!Number.isInteger(port)||port<1||!['controller','manager','parser','assembler','generator','probe'].includes(role))denied('invalid fixture contract');
fs.appendFileSync(path.join(root,'boundary-events.jsonl'),JSON.stringify({event:'initialized',role,threadId:threads.threadId})+'\n');
const originalResolve=Module._resolveFilename;
Module._resolveFilename=function(request,...args){
  if(request==='node:sqlite'||request==='sqlite')denied('SQL module requested');
  const resolved=originalResolve.call(this,request,...args);
  if(path.isAbsolute(resolved)&&!inside(fs.realpathSync(resolved))){
    const error=new Error('External optional module is unavailable in this fixture');error.code='MODULE_NOT_FOUND';throw error;
  }
  return resolved;
};
const socketConnect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
  let a=args;if(Array.isArray(a[0]))a=a[0];
  const options=typeof a[0]==='object'?a[0]:{port:a[0],host:a[1]};
  if(options?.host!=='127.0.0.1'||Number(options.port)!==port)denied('external socket');
  return socketConnect.apply(this,args);
};
tls.connect=()=>denied('TLS');dgram.createSocket=()=>denied('UDP');
for(const key of ['lookup','resolve','resolve4','resolve6','resolveAny','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','reverse']){
  if(typeof dns[key]==='function')dns[key]=()=>denied('DNS');
  if(typeof dns.promises[key]==='function')dns.promises[key]=()=>denied('DNS');
}
const fetch=globalThis.fetch;
if(fetch)globalThis.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||Number(url.port)!==port)denied('external fetch');
  return fetch(input,options);
};
const guardOptions=`--no-addons --no-global-search-paths --require=${__filename}`;
const originalSpawnSync=cp.spawnSync;
cp.spawnSync=function(program,args,options={}){
  let nextRole;
  if(role==='controller'&&program===process.execPath&&args.length===2&&args[0]===parser&&
     args[1]===path.resolve(path.dirname(yaml),'dist/index.js'))nextRole='parser';
  else if(role==='controller'&&program===process.execPath&&args[0]===cli)nextRole='manager';
  else if(role==='assembler'&&program===process.execPath&&args[0]===generator)nextRole='generator';
  else if(role==='assembler'&&program==='cp'&&args[0]==='--archive'&&args[1]==='--link'&&args.length===4&&inside(args[2])&&inside(args[3])){
    return originalSpawnSync('/bin/cp',args,options);
  }else denied('unexpected subprocess');
  if(!options.env)denied('subprocess has no explicit environment');
  return originalSpawnSync(program,args,{...options,env:{...options.env,NODE_OPTIONS:guardOptions,DRC3_FIXTURE_ROLE:nextRole}});
};
for(const name of ['spawn','exec','execFile','execSync','execFileSync','fork'])cp[name]=()=>denied('subprocess escape');
const ActualWorker=threads.Worker;
threads.Worker=class extends ActualWorker{
  constructor(filename,options={}){
    const target=filename instanceof URL?require('node:url').fileURLToPath(filename):filename;
    if(role!=='manager'||options.eval||!inside(target)||fs.realpathSync(target)!==path.resolve(path.dirname(cli),'../dist/worker.js'))denied('unexpected worker');
    fs.appendFileSync(path.join(root,'boundary-events.jsonl'),JSON.stringify({event:'worker-created',role})+'\n');
    super(filename,{...options,execArgv:['--no-addons','--no-global-search-paths','--require',__filename]});
  }
};
Module.syncBuiltinESMExports();
