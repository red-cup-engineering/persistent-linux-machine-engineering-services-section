import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { localOriginDeclaration, mergeHosts, renderLocalOriginCaddy, renderLocalOriginUnit, renderLocalOriginWindows, planLocalOrigin, applyLocalOrigin, validateLocalOriginProvider } from '../src/local-origin.mjs';

const digest = v => createHash('sha256').update(v).digest('hex');
function declaration(root='/fixture') {
 return {schema:'wsl-host-parameters@1',linux:{wslConf:{sections:[{name:'boot',entries:[{key:'systemd',value:'true'}]},{name:'network',entries:[{key:'generateHosts',value:'false'}]}]}},
 localOrigin:{name:'example',hostname:'node.example.test',user:'fixture',uid:process.getuid()||1000,home:root,stateDirectory:root+'/state',
 provider:{binary:root+'/caddy',sha256:digest('fixture')},credentialEnvironmentFile:root+'/credentials.env',
 dns:{provider:'cloudflare',tokenVariable:'CF_API_TOKEN',resolvers:['1.1.1.1','8.8.8.8']},upstream:'http://127.0.0.1:18807',
 windows:{powershell:'/mnt/c/Windows/PowerShell.exe',tailscale:'/mnt/c/Program Files/Tailscale/tailscale.exe',hostsFile:'/mnt/c/Windows/hosts',hostsWindowsPath:'C:\\Windows\\hosts',scriptPath:'/mnt/c/Users/fixture/local-origin.ps1',scriptWindowsPath:'C:\\Users\\fixture\\local-origin.ps1',tailscaleWindowsPath:'C:\\Program Files\\Tailscale\\tailscale.exe',resultWindowsPath:'C:\\Users\\fixture\\result.json',tailnetIP:'100.114.48.122'}}};
}
function temporary(fn) {
 const root=mkdtempSync(join(tmpdir(),'wsl-local-origin-'));
 try {return fn(root);} finally {rmSync(root,{recursive:true,force:true});}
}
test('hosts merge preserves UTF8 BOM, CRLF and independent blocks, then is byte-idempotent',()=>{
 const d=localOriginDeclaration(declaration());
 const input=Buffer.concat([Buffer.from([239,187,191]),Buffer.from('# Docker\r\n192.0.2.3 host.docker.internal\r\n# TailscaleHostsSectionStart\r\n100.114.48.122 node.tail.test\r\n# TailscaleHostsSectionEnd\r\n')]);
 const merged=mergeHosts(input,d);
 assert.deepEqual(merged.subarray(0,3),input.subarray(0,3));
 assert.ok(merged.includes(input.subarray(3)));
 assert.ok(merged.toString().includes('127.0.0.1\tnode.example.test\r\n'));
 assert.deepEqual(mergeHosts(merged,d),merged);
});
test('hosts merge refuses foreign aliases, duplicate/partial blocks, and unsupported bytes',()=>{
 const d=localOriginDeclaration(declaration());
 for(const input of ['127.0.0.1 localhost NODE.EXAMPLE.TEST.\n','# wsl-host-service local-origin example begin\n','# wsl-host-service local-origin example begin\n# wsl-host-service local-origin example end\n# wsl-host-service local-origin example begin\n# wsl-host-service local-origin example end\n'])assert.throws(()=>mergeHosts(input,d));
 assert.throws(()=>mergeHosts(Buffer.from([255,254,0,1]),d));
});
test('declaration refuses unsafe network/provider inputs and generated hosts',()=>{
 for(const mutate of [p=>p.linux.wslConf.sections.pop(),p=>p.localOrigin.upstream='http://0.0.0.0:18807',p=>p.localOrigin.provider.sha256='unknown',p=>p.localOrigin.hostname='x; rm',p=>p.localOrigin.dns.resolvers=['127.0.0.1\nadmin on'],p=>p.localOrigin.credentialEnvironmentFile='/owner/credential file.env']){
  const p=declaration();mutate(p);assert.throws(()=>localOriginDeclaration(p));
 }
});
test('Caddy and native unit retain loopback, DNS01 and minimum binding privilege',()=>{
 const d=localOriginDeclaration(declaration());
 const config=renderLocalOriginCaddy(d),unit=renderLocalOriginUnit(d);
 assert.match(config,/admin off/);assert.match(config,/bind 127\.0\.0\.1/);assert.match(config,/resolvers 1\.1\.1\.1 8\.8\.8\.8/);
 assert.match(config,/dns cloudflare \{env.CF_API_TOKEN\}/);assert.doesNotMatch(config,/0\.0\.0\.0/);
 assert.match(unit,/User=fixture/);assert.match(unit,/AmbientCapabilities=CAP_NET_BIND_SERVICE/);assert.match(unit,/ProtectSystem=strict/);
 assert.ok(unit.split('\n').includes('EnvironmentFile=/fixture/credentials.env'));assert.doesNotMatch(unit,/ExecStart=.*sh -c/);
});
test('staged scoped apply preserves unrelated host content and converges without native effects',()=>temporary(root=>{
 const p=declaration('/owner');
 mkdirSync(join(root,'etc'),{recursive:true});writeFileSync(join(root,'etc/hosts'),'127.0.0.1 localhost\n192.0.2.4 unrelated.test\n');
 const first=planLocalOrigin(p,{root,scope:'all'});assert.equal(first.current,false);
 const applied=applyLocalOrigin(p,{root,scope:'all'});assert.equal(applied.converged,true);assert.equal(applied.written.length,5);assert.deepEqual(applied.ran,[]);
 assert.match(readFileSync(join(root,'etc/hosts'),'utf8'),/192.0.2.4 unrelated.test/);
 assert.match(readFileSync(join(root,'etc/wsl.conf'),'utf8'),/generateHosts=false/);
 assert.deepEqual(applyLocalOrigin(p,{root,scope:'all'}).written,[]);
 assert.equal(planLocalOrigin(p,{root,scope:'all'}).current,true);
}));
test('staging refuses a redirected managed hosts target including a dangling symlink',()=>temporary(root=>{
 const p=declaration('/owner');mkdirSync(join(root,'etc'),{recursive:true});symlinkSync(join(root,'missing'),join(root,'etc/hosts'));
 assert.throws(()=>applyLocalOrigin(p,{root,scope:'linux'}),/redirected/);
}));
test('provider receiving binds bytes, module, scoped credential permissions and content',()=>temporary(root=>{
 const p=declaration(root),d=localOriginDeclaration(p);writeFileSync(d.provider.binary,'fixture',{mode:0o555});writeFileSync(d.credentialEnvironmentFile,'CF_API_TOKEN="fixture_token"\n',{mode:0o600});
 let calls=[];const native={run:(binary,args,options)=>{calls.push({binary,args,options});return args[0]==='list-modules'?'dns.providers.cloudflare\n':'valid';}};
 const result=validateLocalOriginProvider(d,native);assert.equal(calls.length,2);
 assert.deepEqual(result,{validated:true});
 assert.equal(calls[0].options.uid,d.uid);
 assert.deepEqual(calls[0].options.env,calls[1].options.env);
 const validation=calls[1].options;
 assert.deepEqual(calls[1].args,['validate','--config','-','--adapter','caddyfile']);
 assert.equal(validation.uid,d.uid);assert.equal(validation.gid,d.uid);
 assert.deepEqual(Object.keys(validation.env).sort(),['CF_API_TOKEN','HOME','LOGNAME','USER','XDG_CONFIG_HOME','XDG_DATA_HOME'].sort());
 assert.equal(validation.env.CF_API_TOKEN,'fixture_token');
 assert.ok(!JSON.stringify(result).includes('fixture_token'));
 assert.throws(()=>validateLocalOriginProvider({...d,provider:{...d.provider,sha256:'0'.repeat(64)}},native),/identity/);
 chmodSync(d.credentialEnvironmentFile,0o644);assert.throws(()=>validateLocalOriginProvider(d,native),/private scoped/);chmodSync(d.credentialEnvironmentFile,0o600);
 writeFileSync(d.credentialEnvironmentFile,'CF_API_TOKEN="fixture_token"\nOTHER_SECRET=unrelated\n');assert.throws(()=>validateLocalOriginProvider(d,native),/only selected/);
 writeFileSync(d.credentialEnvironmentFile,'CF_API_TOKEN="fixture_token"\n');assert.throws(()=>validateLocalOriginProvider(d,{run:()=>''}),/module absent/);
}));
test('Windows script keeps explicit privilege, replay and public-exposure boundaries',()=>{
 const script=renderLocalOriginWindows(localOriginDeclaration(declaration()));
 assert.match(script,/param\(\[switch\]\$Apply\)/);
 assert.match(script,/Administrator token required before apply/);
 assert.doesNotMatch(script,/Native-Json @\(/);
 assert.match(script,/Native-Json -Arguments @\('status','--json'\)/);
 assert.match(script,/Hosts file changed before apply/);assert.match(script,/Serve configuration changed before apply/);
 assert.match(script,/Funnel exposes selected port/);assert.match(script,/Port 443 belongs to another Serve handler/);
 assert.match(script,/Invoke-TailscaleNative -Arguments @\('serve','--bg','--tcp=443','tcp:\/\/127\.0\.0\.1:443'\)/);
 assert.match(script,/UseShellExecute = \$false/);assert.match(script,/RedirectStandardOutput = \$true/);
 assert.match(script,/WaitForExit\(\$remaining\)/);assert.match(script,/bytesRead -gt 1048576/);
 assert.doesNotMatch(script,/\$LASTEXITCODE|& \$tailscale/);
 assert.doesNotMatch(script,/funnel --bg|wsl.*--shutdown/i);
});
test('plan local origin exercises default adapter and succeeds with long working directory and default cwd option', t => {
 const root = mkdtempSync(join(tmpdir(), 'wsl-local-origin-'));
 const origCwd = process.cwd();
 t.after(() => {
  process.chdir(origCwd);
  rmSync(root, { recursive: true, force: true });
 });
 const p = declaration(root);
 p.localOrigin.windows.scriptPath = join(root, 'local-origin.ps1');
 const d = localOriginDeclaration(p);
 const longDir = join(root, 'a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100));
 mkdirSync(longDir, { recursive: true });
 const psFixturePath = join(root, 'ps-fixture.mjs');
 writeFileSync(psFixturePath, '#!' + process.execPath + '\n' + 'process.stdout.write(JSON.stringify({current: process.cwd() === "/", cwd: process.cwd(), args: process.argv.slice(2)}));\n', { mode: 0o755 });
 p.localOrigin.windows.powershell = psFixturePath;
 writeFileSync(d.windows.scriptPath, renderLocalOriginWindows(d), { mode: 0o600 });
 process.chdir(longDir);
 const negativeRes = JSON.parse(execFileSync(psFixturePath, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', d.windows.scriptWindowsPath], { encoding: 'utf8' }));
 assert.equal(negativeRes.current, false);
 assert.equal(negativeRes.cwd, longDir);
 const plan = planLocalOrigin(p, { scope: 'windows' });
 assert.equal(plan.current, true);
 assert.equal(plan.windows.current, true);
 assert.equal(plan.windows.cwd, '/');
 assert.deepEqual(plan.windows.args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', d.windows.scriptWindowsPath]);
});
// Additional served names: `routes` on the declaration.
const route = (hostname='registry.example.test', upstream='http://127.0.0.1:18821', requestBodyMaxSize) => ({hostname, upstream, ...(requestBodyMaxSize===undefined?{}:{requestBodyMaxSize})});
function withRoutes(routes, root) {
 const p = declaration(root);
 p.localOrigin.routes = routes;
 return p;
}
const site = (hostname, upstream, extra='') => 'https://' + hostname + ' {\n\tbind 127.0.0.1\n\ttls {\n\t\tdns cloudflare {env.CF_API_TOKEN}\n\t\tresolvers 1.1.1.1 8.8.8.8\n\t}\n' + extra + '\treverse_proxy ' + upstream + '\n}\n';
const globalOptions = '{\n\tadmin off\n\tauto_https disable_redirects\n}\n\n';

test('declaration accepts routes and treats missing or empty routes as today',()=>{
 const base = localOriginDeclaration(declaration());
 const withEmpty = localOriginDeclaration(withRoutes([]));
 assert.deepEqual({...withEmpty, routes: undefined}, {...base, routes: undefined});
 assert.equal(renderLocalOriginCaddy(withEmpty), renderLocalOriginCaddy(base));
 const d = localOriginDeclaration(withRoutes([route(), route('files.example.test','http://127.0.0.1:65535','64MB')]));
 assert.deepEqual(d.routes, [route(), route('files.example.test','http://127.0.0.1:65535','64MB')]);
 for (const size of ['1KB','64MB','999999GB','5MB']) assert.doesNotThrow(()=>localOriginDeclaration(withRoutes([route(undefined, undefined, size)])), size);
});
test('declaration validates each route like the primary hostname and upstream',()=>{
 const refused = [
  ['non-array routes', 'registry.example.test'],
  ['object routes', {hostname:'registry.example.test', upstream:'http://127.0.0.1:18821'}],
  ['null entry', [null]],
  ['string entry', ['registry.example.test']],
  ['unknown key', [{...route(), requestBodyMax:'64MB'}]],
  ['injected hostname', [route('x; rm')]],
  ['newline hostname', [route('a.example.test\nadmin on')]],
  ['uppercase hostname', [route('Registry.Example.Test')]],
  ['single label hostname', [route('registry')]],
  ['trailing dot hostname', [route('registry.example.test.')]],
  ['missing hostname', [{upstream:'http://127.0.0.1:18821'}]],
  ['missing upstream', [{hostname:'registry.example.test'}]],
  ['wildcard-bind upstream', [route(undefined,'http://0.0.0.0:18821')]],
  ['non-loopback upstream', [route(undefined,'http://192.0.2.9:18821')]],
  ['https upstream', [route(undefined,'https://127.0.0.1:18821')]],
  ['upstream with path', [route(undefined,'http://127.0.0.1:18821/x')]],
  ['upstream port out of range', [route(undefined,'http://127.0.0.1:65536')]],
  ['upstream port zero', [route(undefined,'http://127.0.0.1:0')]],
  ['upstream without port', [route(undefined,'http://127.0.0.1')]],
  ['second route bad', [route(), route('files.example.test','http://localhost:18822')]],
  ['duplicate route hostname', [route(), route(undefined,'http://127.0.0.1:18822')]],
  ['route equal to primary', [route('node.example.test')]],
 ];
 for (const [label, routes] of refused) assert.throws(()=>localOriginDeclaration(withRoutes(routes)), /local origin refused/, label);
 for (const size of ['0MB','064MB','64mb','64M','64','MB','1000000MB','64 MB','64MB\n','64MBx','-1MB','1.5MB','64TB','', null, 64]) assert.throws(()=>localOriginDeclaration(withRoutes([route(undefined,undefined,size)])), /local origin refused/, String(size));
});
test('Caddy output without routes is byte-identical to the single-name rendering',()=>{
 const expected = globalOptions + site('node.example.test','http://127.0.0.1:18807');
 assert.equal(expected, '{\n\tadmin off\n\tauto_https disable_redirects\n}\n\nhttps://node.example.test {\n\tbind 127.0.0.1\n\ttls {\n\t\tdns cloudflare {env.CF_API_TOKEN}\n\t\tresolvers 1.1.1.1 8.8.8.8\n\t}\n\treverse_proxy http://127.0.0.1:18807\n}\n');
 assert.equal(renderLocalOriginCaddy(localOriginDeclaration(declaration())), expected);
 assert.equal(renderLocalOriginCaddy(localOriginDeclaration(withRoutes([]))), expected);
});
test('Caddy renders one block per route in order, with request_body only when sized',()=>{
 const plain = renderLocalOriginCaddy(localOriginDeclaration(withRoutes([route()])));
 assert.equal(plain, globalOptions + site('node.example.test','http://127.0.0.1:18807') + '\n' + site('registry.example.test','http://127.0.0.1:18821'));
 assert.doesNotMatch(plain, /request_body/);
 const sized = renderLocalOriginCaddy(localOriginDeclaration(withRoutes([route(undefined,undefined,'64MB')])));
 assert.equal(sized, globalOptions + site('node.example.test','http://127.0.0.1:18807') + '\n' + site('registry.example.test','http://127.0.0.1:18821','\trequest_body {\n\t\tmax_size 64MB\n\t}\n'));
 const two = renderLocalOriginCaddy(localOriginDeclaration(withRoutes([route('b.example.test','http://127.0.0.1:2'), route('a.example.test','http://127.0.0.1:1','2GB')])));
 assert.equal(two, globalOptions + site('node.example.test','http://127.0.0.1:18807') + '\n' + site('b.example.test','http://127.0.0.1:2') + '\n' + site('a.example.test','http://127.0.0.1:1','\trequest_body {\n\t\tmax_size 2GB\n\t}\n'));
 assert.equal(two.match(/admin off/g).length, 1);
 assert.equal(two.match(/bind 127\.0\.0\.1/g).length, 3);
 assert.equal(two.match(/dns cloudflare \{env\.CF_API_TOKEN\}/g).length, 3);
 assert.equal(two.match(/resolvers 1\.1\.1\.1 8\.8\.8\.8/g).length, 3);
});
test('hosts merge maps every served name, primary first, one line each',()=>{
 const d = localOriginDeclaration(withRoutes([route(), route('files.example.test','http://127.0.0.1:18822')]));
 const merged = mergeHosts('127.0.0.1 localhost\n192.0.2.4 unrelated.test\n', d);
 assert.equal(merged.toString(), '127.0.0.1 localhost\n192.0.2.4 unrelated.test\n# wsl-host-service local-origin example begin\n127.0.0.1\tnode.example.test\n127.0.0.1\tregistry.example.test\n127.0.0.1\tfiles.example.test\n# wsl-host-service local-origin example end\n');
 assert.deepEqual(mergeHosts(merged, d), merged);
 const crlf = mergeHosts(Buffer.concat([Buffer.from([239,187,191]), Buffer.from('# Docker\r\n192.0.2.3 host.docker.internal\r\n')]), d);
 assert.ok(crlf.toString().includes('127.0.0.1\tnode.example.test\r\n127.0.0.1\tregistry.example.test\r\n127.0.0.1\tfiles.example.test\r\n'));
 assert.deepEqual(mergeHosts(crlf, d), crlf);
 // A block written before routes existed is rewritten in place to cover the routes, and back again.
 const primaryOnly = localOriginDeclaration(declaration());
 const old = mergeHosts('127.0.0.1 localhost\n', primaryOnly);
 assert.equal(mergeHosts(old, d).toString(), '127.0.0.1 localhost\n# wsl-host-service local-origin example begin\n127.0.0.1\tnode.example.test\n127.0.0.1\tregistry.example.test\n127.0.0.1\tfiles.example.test\n# wsl-host-service local-origin example end\n');
 assert.deepEqual(mergeHosts(mergeHosts(old, d), primaryOnly), old);
});
test('hosts merge without routes is unchanged',()=>{
 const input = '127.0.0.1 localhost\n';
 const expected = '127.0.0.1 localhost\n# wsl-host-service local-origin example begin\n127.0.0.1\tnode.example.test\n# wsl-host-service local-origin example end\n';
 assert.equal(mergeHosts(input, localOriginDeclaration(declaration())).toString(), expected);
 assert.equal(mergeHosts(input, localOriginDeclaration(withRoutes([]))).toString(), expected);
});
test('hosts merge refuses a route name mapped outside the owned block',()=>{
 const d = localOriginDeclaration(withRoutes([route(), route('files.example.test','http://127.0.0.1:18822')]));
 for (const outside of ['127.0.0.1 registry.example.test\n', '127.0.0.1 localhost REGISTRY.EXAMPLE.TEST.\n', '192.0.2.9\tfiles.example.test # note\n', '127.0.0.1 node.example.test\n']) {
  assert.throws(()=>mergeHosts(outside, d), /competing hostname mapping outside owned block/, outside);
  const block = '# wsl-host-service local-origin example begin\n127.0.0.1\tnode.example.test\n127.0.0.1\tregistry.example.test\n127.0.0.1\tfiles.example.test\n# wsl-host-service local-origin example end\n';
  assert.throws(()=>mergeHosts(block + outside, d), /competing hostname mapping outside owned block/, 'after block: ' + outside);
  assert.throws(()=>mergeHosts(outside + block, d), /competing hostname mapping outside owned block/, 'before block: ' + outside);
 }
 // A name that is not served is not refused, and commented mappings are ignored.
 assert.doesNotThrow(()=>mergeHosts('127.0.0.1 other.example.test\n# 127.0.0.1 registry.example.test\n', d));
});
test('staged apply with routes writes every served name and converges',()=>temporary(root=>{
 const p = withRoutes([route(undefined,undefined,'64MB')], '/owner');
 mkdirSync(join(root,'etc'),{recursive:true});writeFileSync(join(root,'etc/hosts'),'127.0.0.1 localhost\n');
 const applied = applyLocalOrigin(p,{root,scope:'linux'});
 assert.equal(applied.converged,true);
 const hosts = readFileSync(join(root,'etc/hosts'),'utf8');
 assert.match(hosts,/127\.0\.0\.1\tnode\.example\.test\n127\.0\.0\.1\tregistry\.example\.test\n/);
 const caddy = readFileSync(join(root,'owner/state/Caddyfile'),'utf8');
 assert.match(caddy,/https:\/\/registry\.example\.test \{[\s\S]*request_body \{\n\t\tmax_size 64MB\n\t\}\n\treverse_proxy http:\/\/127\.0\.0\.1:18821\n\}/);
 assert.deepEqual(applyLocalOrigin(p,{root,scope:'linux'}).written,[]);
 assert.equal(planLocalOrigin(p,{root,scope:'linux'}).current,true);
}));
test('primary upstream port beyond 65535 is refused as a declaration refusal',()=>{
 const p = declaration();p.localOrigin.upstream = 'http://127.0.0.1:65536';
 assert.throws(()=>localOriginDeclaration(p), /local origin refused: loopback HTTP upstream required/);
});
