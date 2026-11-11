import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const boot=fileURLToPath(new URL('../scripts/ephemeral-boot.sh',import.meta.url));

test('the ephemeral boot is valid shell',()=>{
  const r=spawnSync('bash',['-n',boot],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
});

test('a machine that answers nothing is booted, not a reason to stop',t=>{
  const root=mkdtempSync(join(tmpdir(),'ephemeral-boot-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const bin=join(root,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'curl'),'#!/bin/sh\nexit 7\n',{mode:0o755});
  const source=readFileSync(boot,'utf8');
  const check=source.match(/^running=\$\([\s\S]*?^\s*.*\}\)'\)$/m)?.[0];
  assert.ok(check,'the boot reads the running release from the machine health check');
  const r=spawnSync('bash',['-c',`set -euo pipefail\nNODE=${JSON.stringify(process.execPath)}\nHEALTH=http://127.0.0.1:9/healthz\n${check}\necho "running=[$running]"`],
    {encoding:'utf8',env:{PATH:`${bin}:/usr/bin:/bin`}});
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.stdout.trim(),'running=[]');
});

test('the ephemeral boot refuses without a machine snapshot before any effect',t=>{
  const root=mkdtempSync(join(tmpdir(),'ephemeral-boot-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const bin=join(root,'bin'),effects=join(root,'effects');mkdirSync(bin);
  for(const program of ['curl','guix','guix-daemon','groupadd','useradd','herd','shepherd','git','openssl','npm','node'])
    writeFileSync(join(bin,program),`#!/bin/sh\necho ${program} >> '${effects}'\nexit 99\n`,{mode:0o755});
  for(const args of [[],[join(root,'no-such-snapshot')]]){
    const r=spawnSync('bash',[boot,...args],{encoding:'utf8',env:{PATH:`${bin}:/usr/bin:/bin`,HOME:root}});
    assert.equal(r.status,2,r.stderr);assert.equal(r.stdout,'');
    assert.match(r.stderr,/usage: ephemeral-boot\.sh SNAPSHOT \[--no-release\]/);
  }
  assert.equal(existsSync(effects),false,'a refused boot must not install, start or fetch anything');
});

// The tailnet stage, run alone against stand-in programs: its own effects are the assertions.
function tailnetStage(t,{key,installed=true,curlBody='not the release'}){
  const root=mkdtempSync(join(tmpdir(),'ephemeral-boot-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const bin=join(root,'bin'),effects=join(root,'effects'),state=join(root,'state'),logs=join(root,'logs');
  for(const dir of [bin,state,logs])mkdirSync(dir);
  const record=(program,body='')=>writeFileSync(join(bin,program),`#!/bin/sh\necho "${program} $*" >> '${effects}'\n${body}`,{mode:0o755});
  record('curl',`while [ $# -gt 0 ]; do [ "$1" = -o ] && printf '%s' '${curlBody}' > "$2"; shift; done\n`);
  record('pgrep','exit 1\n');
  const source=readFileSync(boot,'utf8');
  const version=source.match(/^TAILSCALE_VERSION=(.+)$/m)?.[1],sha=source.match(/^TAILSCALE_SHA256=(.+)$/m)?.[1];
  const stage=source.match(/^# --- Tailnet:[\s\S]*?^fi\n/m)?.[0];
  assert.ok(version&&sha&&stage,'the boot declares a pinned Tailscale release and a tailnet stage');
  if(installed){
    const home=join(root,`.local/share/561-group/tailscale-${version}`);mkdirSync(home,{recursive:true});
    for(const program of ['tailscale','tailscaled'])
      writeFileSync(join(home,program),`#!/bin/sh\necho "${program} $*" >> '${effects}'\n[ "$2" = status ] && exit 1\nexit 0\n`,{mode:0o755});
  }
  const env={PATH:`${bin}:/usr/bin:/bin`,HOME:root,...(key===undefined?{}:{TS_AUTHKEY:key})};
  const r=spawnSync('bash',['-c',`set -euo pipefail\nsay(){ :; }\nuntil_ready(){ :; }\nTAILSCALE_VERSION=${version}\nTAILSCALE_SHA256=${sha}\nSTATE=${state}\nLOGS=${logs}\nNAME=soft-grass-pebble\nCA_BUNDLE=/dev/null\n${stage}\nsleep 0.2`],{encoding:'utf8',env});
  return {r,effects:existsSync(effects)?readFileSync(effects,'utf8'):''};
}

test('without a tailnet key the machine stays outbound only and the tailnet stage does nothing',t=>{
  const {r,effects}=tailnetStage(t,{key:undefined});
  assert.equal(r.status,0,r.stderr);
  assert.equal(effects,'');
});

test('a Tailscale release that fails its published checksum is never installed',t=>{
  const {r,effects}=tailnetStage(t,{key:'tskey-test',installed:false});
  assert.notEqual(r.status,0);
  assert.match(effects,/^curl .*pkgs\.tailscale\.com\/stable\/tailscale_[0-9.]+_amd64\.tgz/m);
  assert.doesNotMatch(effects,/tailscaled|tailscale up/);
});

test('with a tailnet key the machine joins in userspace networking under its own name',t=>{
  const {r,effects}=tailnetStage(t,{key:'tskey-test'});
  assert.equal(r.status,0,r.stderr);
  assert.match(effects,/^tailscaled --tun=userspace-networking --state=\S+\/tailscaled\.state --socket=\S+\/tailscaled\.sock --socks5-server=127\.0\.0\.1:1055$/m);
  assert.match(effects,/^tailscale --socket=\S+ up --auth-key=tskey-test --hostname=soft-grass-pebble --accept-dns=false$/m);
});

test('a tailnet OAuth client secret registers an ephemeral, pre-authorized, tagged node, so no key is rotated',t=>{
  const {r,effects}=tailnetStage(t,{key:'tskey-client-abc'});
  assert.equal(r.status,0,r.stderr);
  assert.match(effects,/^tailscale --socket=\S+ up --auth-key=tskey-client-abc\?ephemeral=true&preauthorized=true --advertise-tags=tag:colony --hostname=soft-grass-pebble --accept-dns=false$/m);
});

// The credentials and DNS stages, run alone against a stand-in store and stand-in programs.
function credentialStages(t,{store=true,identity=true,rendered={},dnsJson=true,failInit=false}={}){
  const root=mkdtempSync(join(tmpdir(),'ephemeral-boot-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const bin=join(root,'bin'),effects=join(root,'effects'),state=join(root,'state'),logs=join(root,'logs'),snapshot=join(root,'snapshot'),node=join(root,'node');
  for(const dir of [bin,state,logs,join(snapshot,'deployment'),node])mkdirSync(dir,{recursive:true});
  writeFileSync(join(bin,'git'),`#!/bin/sh\necho "git $*" >> '${effects}'\n`,{mode:0o755});
  writeFileSync(join(node,'node'),`#!/bin/sh\nexec '${process.execPath}' "$@"\n`,{mode:0o755});
  writeFileSync(join(node,'npm'),`#!/bin/sh\necho "npm $* token=$CLOUDFLARE_API_TOKEN" >> '${effects}'\ncat > /dev/null\n`,{mode:0o755});
  if(dnsJson)writeFileSync(join(snapshot,'deployment/dns.json'),'{}');
  const credentials=join(root,'store');
  if(store){
    mkdirSync(join(credentials,'bin'),{recursive:true});mkdirSync(join(credentials,'data/credentials/hosts'),{recursive:true});
    if(identity)writeFileSync(join(credentials,'data/credentials/hosts/soft-grass-pebble.identity'),'AGE-SECRET-KEY-INERT');
    const renders=Object.entries(rendered).map(([service,text])=>`printf '%s' '${text}' > "$3/${service}.env"`).join('\n');
    writeFileSync(join(credentials,'bin/credentials'),`#!/bin/sh\necho "credentials $* host=$CREDENTIALS_HOST" >> '${effects}'\n${failInit?'[ "$1" = init-host ] && exit 3\n':''}[ "$1" = render-host ] && { mkdir -p "$3"; ${renders||':'}; }\nexit 0\n`,{mode:0o755});
  }
  const source=readFileSync(boot,'utf8');
  const creds=source.match(/^# --- Credentials:[\s\S]*?^\[ -n "\$\{TS_AUTHKEY:-\}" \] \|\| gap tailnet.*\n/m)?.[0];
  const dns=source.match(/^# --- DNS:[\s\S]*?^mv "\$GAPS\.new" "\$GAPS"; rm -f "\$GAPS\.lines"\n/m)?.[0];
  const version=source.match(/^DNS_RECONCILER_VERSION=(.+)$/m)?.[1];
  assert.ok(creds&&dns&&version,'the boot declares a credentials stage, a DNS stage and a pinned reconciler');
  const env={PATH:`${bin}:/usr/bin:/bin`,HOME:root,...(store?{GUIX_MACHINE_CREDENTIALS:credentials}:{})};
  const r=spawnSync('bash',['-c',`set -euo pipefail\nsay(){ :; }\nSTATE=${state}\nLOGS=${logs}\nNAME=soft-grass-pebble\nSNAPSHOT=${snapshot}\nNODE=${join(node,'node')}\nCA_BUNDLE=/dev/null\nDNS_RECONCILER_VERSION=${version}\n${creds}${dns}\necho "TS_AUTHKEY=[\${TS_AUTHKEY:-}]"`],{encoding:'utf8',env});
  if(process.env.DBG)console.error(r.stderr,r.stdout);
  const gapsFile=join(state,'credential-gaps.json');
  return {r,effects:existsSync(effects)?readFileSync(effects,'utf8'):'',gaps:existsSync(gapsFile)?JSON.parse(readFileSync(gapsFile,'utf8')):null};
}

test('without a credential store checkout the credentials and DNS stages do nothing',t=>{
  const {r,effects}=credentialStages(t,{store:false});
  assert.equal(r.status,0,r.stderr);
  assert.equal(effects,'');
  assert.match(r.stdout,/TS_AUTHKEY=\[\]/);
});

test('a machine renders its credentials under its own name and joins the tailnet with the stored secret',t=>{
  const {r,effects}=credentialStages(t,{rendered:{tailnet:'TS_AUTHKEY=tskey-client-stored\n'},dnsJson:false});
  assert.equal(r.status,0,r.stderr);
  assert.match(effects,/^credentials render-host --to \S+\/state\/credentials host=soft-grass-pebble$/m);
  assert.doesNotMatch(effects,/init-host/);
  assert.match(r.stdout,/TS_AUTHKEY=\[tskey-client-stored\]/);
});

test('a machine new to the store records and pushes its recipient, never its identity',t=>{
  const {r,effects}=credentialStages(t,{identity:false,dnsJson:false});
  assert.equal(r.status,0,r.stderr);
  assert.match(effects,/^credentials init-host host=soft-grass-pebble$/m);
  assert.match(effects,/^git -C \S+ add data\/credentials\/recipients\.json$/m);
  assert.match(effects,/^git -C \S+ push -q$/m);
  assert.doesNotMatch(effects,/add .*hosts/);
});

test('a machine that declares its DNS record and holds a DNS token reconciles it with the pinned house reconciler',t=>{
  const {r,effects}=credentialStages(t,{rendered:{'colony-dns':'CLOUDFLARE_API_TOKEN=inert-token\n'}});
  assert.equal(r.status,0,r.stderr);
  assert.match(effects,/^npm --registry=https:\/\/registry\.561\.group\/ exec --yes --package=@red-cup-engineering\/cloudflare-dns-record-reconciliation-service@[0-9.]+ -- reconcile-cloudflare-dns-record token=inert-token$/m);
});

test('without a DNS token the declared record is left for the store to supply',t=>{
  const {r,effects}=credentialStages(t,{rendered:{tailnet:'TS_AUTHKEY=x\n'}});
  assert.equal(r.status,0,r.stderr);
  assert.doesNotMatch(effects,/^npm /m);
});

test('a credential store that cannot make the machine its identity is a named gap, not a refused boot',t=>{
  const {r,gaps}=credentialStages(t,{identity:false,failInit:true,dnsJson:false});
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(gaps.map(g=>g.credential),['store-identity','tailnet']);
  assert.doesNotMatch(JSON.stringify(gaps),/SECRET|token=/);
});

test('with every credential rendered the gaps are empty; without a store the gap is named',t=>{
  const ok=credentialStages(t,{rendered:{tailnet:'TS_AUTHKEY=tskey-client-stored\n','colony-dns':'CLOUDFLARE_API_TOKEN=inert-token\n'}});
  assert.equal(ok.r.status,0,ok.r.stderr);assert.deepEqual(ok.gaps,[]);
  const none=credentialStages(t,{store:false});
  assert.deepEqual(none.gaps.map(g=>g.credential),['store','tailnet','colony-dns']);
});

// The registry stage, run alone: the machine's own declaration is the only source of scopes.
function registryStage(t,declaration,npmrcBefore){
  const root=mkdtempSync(join(tmpdir(),'ephemeral-boot-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const snapshot=join(root,'snapshot');mkdirSync(join(snapshot,'deployment'),{recursive:true});
  if(declaration!==undefined)writeFileSync(join(snapshot,'deployment/registry.json'),declaration);
  if(npmrcBefore!==undefined)writeFileSync(join(root,'.npmrc'),npmrcBefore);
  const stage=readFileSync(boot,'utf8').match(/^# --- Registries:[\s\S]*?^fi\n/m)?.[0];
  assert.ok(stage,'the boot has a registry stage');
  const r=spawnSync('bash',['-c',`set -euo pipefail\nrefuse(){ echo "$*" >&2; exit 1; }\nSNAPSHOT=${snapshot}\nNODE=${process.execPath}\n${stage}`],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:root}});
  const npmrc=join(root,'.npmrc');
  return {r,npmrc:existsSync(npmrc)?readFileSync(npmrc,'utf8'):''};
}

test('a machine routes exactly the private scopes its registry declaration names, once, however often it boots',t=>{
  const declaration=JSON.stringify({hosts:['registry.example.org'],origin:'https://registry.example.org',storage:'s',privateScopes:['@alpha','@beta-two']});
  const once=registryStage(t,declaration);
  assert.equal(once.r.status,0,once.r.stderr);
  assert.equal(once.npmrc,'@alpha:registry=https://registry.example.org/\n@beta-two:registry=https://registry.example.org/\n');
  const twice=registryStage(t,declaration,once.npmrc);
  assert.equal(twice.r.status,0,twice.r.stderr);
  assert.equal(twice.npmrc,once.npmrc);
});

test('a machine that declares no registry routes no scope',t=>{
  const {r,npmrc}=registryStage(t,undefined);
  assert.equal(r.status,0,r.stderr);assert.equal(npmrc,'');
});

test('a registry declaration that is not a URL and scope names is refused before any scope is routed',t=>{
  for(const bad of ['{"origin":"http://x","privateScopes":[]}','{"origin":"https://x","privateScopes":["a"]}','{"origin":"https://x/y","privateScopes":[]}','{"url":"https://x/","scopes":["a"]}']){
    const {r,npmrc}=registryStage(t,bad);
    assert.notEqual(r.status,0,bad);assert.equal(npmrc,'');
  }
});
