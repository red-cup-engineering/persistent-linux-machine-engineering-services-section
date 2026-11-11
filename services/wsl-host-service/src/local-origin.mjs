// Scoped host integration for a canonical private web origin. TLS, ACME and proxying stay Caddy-owned.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { renderIni } from './wsl-host.mjs';

const fail = message => { throw new Error('local origin refused: ' + message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const scalar = v => typeof v === 'string' && v.length > 0 && v.length <= 8192 && !/[\x00-\x1f\x7f]/.test(v);
const path = v => scalar(v) && isAbsolute(v) && resolve(v) === v && !v.includes('\\');
const quoted = s => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
const ps = s => "'" + s.replaceAll("'", "''") + "'";
const run = (program, args, options = {}) => execFileSync(program, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1048576, ...options });

const canonicalHostname = v => /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v ?? '');
const loopbackUpstream = v => { const m = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(v ?? ''); return m !== null && Number(m[1]) <= 65535; };
const requestBodyMaxSize = v => typeof v === 'string' && /^[1-9][0-9]{0,5}(KB|MB|GB)$/.test(v);
const routesOf = d => d.routes ?? [];
const servedNames = d => [d.hostname, ...routesOf(d).map(r => r.hostname)];

function validateRoutes(d) {
  if (d.routes === undefined) return;
  if (!Array.isArray(d.routes)) fail('routes must be an array');
  const seen = new Set([d.hostname]);
  for (const r of d.routes) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) fail('route must be an object');
    if (Object.keys(r).some(k => !['hostname', 'upstream', 'requestBodyMaxSize'].includes(k))) fail('unknown route field');
    if (!canonicalHostname(r.hostname)) fail('canonical DNS hostname required for route');
    if (!loopbackUpstream(r.upstream)) fail('loopback HTTP upstream required for route');
    if (r.requestBodyMaxSize !== undefined && !requestBodyMaxSize(r.requestBodyMaxSize)) fail('route requestBodyMaxSize must be a Caddy size such as 64MB');
    if (seen.has(r.hostname)) fail('duplicate served hostname ' + r.hostname);
    seen.add(r.hostname);
  }
}

export function localOriginDeclaration(parameters) {
  if (parameters.schema !== 'wsl-host-parameters@1') fail('unknown parameter schema');
  const d = parameters.localOrigin;
  if (!d || !/^[a-z][a-z0-9-]{0,47}$/.test(d.name ?? '')) fail('named declaration required');
  if (!canonicalHostname(d.hostname)) fail('canonical DNS hostname required');
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(d.user ?? '') || !Number.isSafeInteger(d.uid) || d.uid <= 0) fail('unprivileged user required');
  for (const key of ['home', 'stateDirectory', 'credentialEnvironmentFile']) if (!path(d[key])) fail('absolute ' + key + ' required');
  if (!/^\/[A-Za-z0-9_./:@+-]+$/.test(d.credentialEnvironmentFile)) fail('systemd-safe credential environment path required');
  if (d.linuxHostsFile !== undefined && d.linuxHostsFile !== '/etc/hosts') fail('Linux hosts destination must be /etc/hosts');
  if (!d.provider || !path(d.provider.binary) || !/^[a-f0-9]{64}$/.test(d.provider.sha256 ?? '')) fail('pinned Caddy provider required');
  if (d.dns?.provider !== 'cloudflare' || !/^[A-Z][A-Z0-9_]*$/.test(d.dns.tokenVariable ?? '')) fail('explicit Cloudflare token variable required');
  if (!Array.isArray(d.dns.resolvers) || !d.dns.resolvers.length || d.dns.resolvers.some(v => {
    if (typeof v !== 'string') return true;
    const address=v.replace(/:53$/, '');
    if (isIP(address)!==4) return true;
    const [a,b]=address.split('.').map(Number);
    return a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127;
  })) fail('explicit public IPv4 DNS resolvers required');
  if (!loopbackUpstream(d.upstream)) fail('loopback HTTP upstream required');
  validateRoutes(d);
  const generateHosts = parameters.linux?.wslConf?.sections?.filter(s => s.name === 'network').flatMap(s => s.entries ?? []).filter(e => e.key === 'generateHosts');
  if (generateHosts?.length !== 1 || !['false', false].includes(generateHosts[0].value)) fail('record must disable WSL generated hosts');
  const w = d.windows;
  if (!w || !['powershell','tailscale','hostsFile','scriptPath'].every(k => path(w[k]))) fail('explicit Windows native paths required');
  for (const key of ['tailscaleWindowsPath','hostsWindowsPath','scriptWindowsPath','resultWindowsPath']) if (!scalar(w[key]) || !/^[A-Za-z]:\\/.test(w[key])) fail('absolute Windows ' + key + ' required');
  if (!/^100\.(?:[6-9][0-9]|1[01][0-9]|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(w.tailnetIP ?? '')) fail('selected Tailnet IPv4 required');
  return { ...d, linuxHostsFile: d.linuxHostsFile ?? '/etc/hosts', service: 'wsl-local-origin-' + d.name + '.service' };
}

export function mergeHosts(input, d) {
  const original = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (original.includes(0)) fail('UTF-16 or binary hosts file unsupported');
  const bom = original.subarray(0,3).equals(Buffer.from([239,187,191]));
  const body = original.subarray(bom ? 3 : 0).toString('utf8');
  if (!Buffer.from(body).equals(original.subarray(bom ? 3 : 0))) fail('hosts file is not UTF-8');
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const begin = '# wsl-host-service local-origin ' + d.name + ' begin';
  const end = '# wsl-host-service local-origin ' + d.name + ' end';
  const lines = body.split(/\r?\n/);
  const starts = lines.flatMap((v,i) => v === begin ? [i] : []);
  const ends = lines.flatMap((v,i) => v === end ? [i] : []);
  if (starts.length !== ends.length || starts.length > 1 || starts.length && starts[0] >= ends[0]) fail('ambiguous managed hosts block');
  const outside = lines.filter((_,i) => !starts.length || i < starts[0] || i > ends[0]);
  const served = servedNames(d);
  for (const line of outside) {
    const names = line.split('#')[0].trim().split(/\s+/).slice(1);
    if (names.some(n => served.includes(n.toLowerCase().replace(/\.$/, '')))) fail('competing hostname mapping outside owned block');
  }
  const block = [begin, ...served.map(n => '127.0.0.1\t' + n), end];
  const output = starts.length ? [...lines.slice(0,starts[0]), ...block, ...lines.slice(ends[0]+1)] : [...lines.filter((v,i) => i !== lines.length-1 || v !== ''), ...block, ''];
  return Buffer.concat([bom ? Buffer.from([239,187,191]) : Buffer.alloc(0), Buffer.from(output.join(newline))]);
}

export function renderLocalOriginCaddy(d) {
  // Caddy permits one global options block, so it is emitted once; every site block carries its own bind and tls.
  const site = (hostname, upstream, requestBodyMaxSize) => 'https://' + hostname + ' {\n\tbind 127.0.0.1\n\ttls {\n\t\tdns cloudflare {env.' + d.dns.tokenVariable + '}\n\t\tresolvers ' + d.dns.resolvers.join(' ') + '\n\t}\n' + (requestBodyMaxSize === undefined ? '' : '\trequest_body {\n\t\tmax_size ' + requestBodyMaxSize + '\n\t}\n') + '\treverse_proxy ' + upstream + '\n}\n';
  return '{\n\tadmin off\n\tauto_https disable_redirects\n}\n\n' + [site(d.hostname, d.upstream), ...routesOf(d).map(r => site(r.hostname, r.upstream, r.requestBodyMaxSize))].join('\n');
}

export function renderLocalOriginUnit(d) {
  return [
    '[Unit]', 'Description=Private canonical web origin ' + d.hostname, 'After=network.target',
    '', '[Service]', 'Type=simple', 'User=' + d.user,
    'Environment=HOME=' + quoted(d.home), 'Environment=XDG_DATA_HOME=' + quoted(join(d.stateDirectory,'caddy-data')),
    'Environment=XDG_CONFIG_HOME=' + quoted(join(d.stateDirectory,'caddy-config')),
    'EnvironmentFile=' + d.credentialEnvironmentFile,
    'ExecStart=' + quoted(d.provider.binary) + ' run --config ' + quoted(join(d.stateDirectory,'Caddyfile')) + ' --adapter caddyfile',
    'Restart=on-failure', 'RestartSec=5', 'UMask=0077',
    'AmbientCapabilities=CAP_NET_BIND_SERVICE', 'CapabilityBoundingSet=CAP_NET_BIND_SERVICE', 'NoNewPrivileges=true',
    'ProtectSystem=strict', 'ProtectHome=read-only', 'PrivateTmp=true',
    'ReadWritePaths=' + quoted(d.stateDirectory), '', '[Install]', 'WantedBy=multi-user.target', ''
  ].join('\n');
}

export function renderLocalOriginWindows(d) {
  const w=d.windows, begin='# wsl-host-service local-origin '+d.name+' begin', end='# wsl-host-service local-origin '+d.name+' end';
  return `param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$hostname = ${ps(d.hostname)}
$hostsFile = ${ps(w.hostsWindowsPath)}
$tailscale = ${ps(w.tailscaleWindowsPath)}
$resultFile = ${ps(w.resultWindowsPath)}
$begin = ${ps(begin)}
$end = ${ps(end)}
$expectedIP = ${ps(w.tailnetIP)}
function Invoke-TailscaleNative([string[]]$Arguments) {
  # These native operations have fixed, whitespace-free arguments. Never use a
  # shell, and do not depend on PowerShell's GUI-subsystem invocation semantics.
  foreach ($argument in $Arguments) {
    if ($argument -notmatch '^[a-z0-9:/=.-]+$') { throw 'Unsupported Tailscale argument' }
  }
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $tailscale
  $start.Arguments = [String]::Join(' ',$Arguments)
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $start
  $started = $false
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $output = New-Object Text.StringBuilder
  $errors = New-Object Text.StringBuilder
  $outputBuffer = New-Object char[] 4096
  $errorBuffer = New-Object char[] 4096
  $outputDone = $false; $errorDone = $false; $bytesRead = 0
  try {
    if (-not $process.Start()) { throw 'Tailscale process did not start' }
    $started = $true
    $outputRead = $process.StandardOutput.ReadAsync($outputBuffer,0,$outputBuffer.Length)
    $errorRead = $process.StandardError.ReadAsync($errorBuffer,0,$errorBuffer.Length)
    while (-not $outputDone -or -not $errorDone) {
      if ($clock.ElapsedMilliseconds -ge 30000) { throw 'Tailscale outcome timed out; do not replay without receiving current state' }
      if (-not $outputDone -and $outputRead.IsCompleted) {
        $count = $outputRead.GetAwaiter().GetResult()
        if ($count -eq 0) { $outputDone = $true } else {
          $chunk = New-Object String($outputBuffer,0,$count)
          $bytesRead += [Text.Encoding]::UTF8.GetByteCount($chunk)
          if ($bytesRead -gt 1048576) { throw 'Tailscale output exceeded its bound' }
          [void]$output.Append($chunk)
          $outputRead = $process.StandardOutput.ReadAsync($outputBuffer,0,$outputBuffer.Length)
        }
      }
      if (-not $errorDone -and $errorRead.IsCompleted) {
        $count = $errorRead.GetAwaiter().GetResult()
        if ($count -eq 0) { $errorDone = $true } else {
          $chunk = New-Object String($errorBuffer,0,$count)
          $bytesRead += [Text.Encoding]::UTF8.GetByteCount($chunk)
          if ($bytesRead -gt 1048576) { throw 'Tailscale output exceeded its bound' }
          [void]$errors.Append($chunk)
          $errorRead = $process.StandardError.ReadAsync($errorBuffer,0,$errorBuffer.Length)
        }
      }
      if (-not $outputDone -or -not $errorDone) { Start-Sleep -Milliseconds 10 }
    }
    $remaining = [Math]::Max(0,30000-[int]$clock.ElapsedMilliseconds)
    if (-not $process.WaitForExit($remaining)) { throw 'Tailscale terminal outcome was not received' }
    if ($process.ExitCode -ne 0) { throw ('Tailscale native command failed, exit ' + $process.ExitCode + ': ' + $errors.ToString()) }
    return $output.ToString()
  } catch {
    if ($started -and -not $process.HasExited) {
      try { $process.Kill(); [void]$process.WaitForExit(5000) } catch { }
    }
    throw
  } finally { $process.Dispose() }
}
function Native-Json([string[]]$Arguments) {
  return (Invoke-TailscaleNative -Arguments $Arguments | ConvertFrom-Json)
}
$status = Native-Json -Arguments @('status','--json')
if ($status.BackendState -ne 'Running' -or @($status.TailscaleIPs) -notcontains $expectedIP) { throw 'Selected Tailnet node identity is not running' }
$config = Native-Json -Arguments @('serve','status','--json')
foreach ($property in @($config.AllowFunnel.PSObject.Properties)) {
  if ($property.Name -match ':443$' -and $property.Value -eq $true) { throw 'Funnel exposes selected port' }
}
$port = $config.TCP.'443'
$desiredForward = '127.0.0.1:443'
if ($null -ne $port -and ($port.TCPForward -ne $desiredForward -or $port.HTTPS -eq $true -or $port.TerminateTLS)) { throw 'Port 443 belongs to another Serve handler' }
foreach ($property in @($config.Web.PSObject.Properties)) {
  if ($property.Name -match ':443$') { throw 'Port 443 belongs to a Serve web handler' }
}
$bytes = [IO.File]::ReadAllBytes($hostsFile)
if ($bytes -contains 0) { throw 'UTF-16 or binary hosts file unsupported' }
$bom = $bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191
$encoding = New-Object Text.UTF8Encoding($false,$true)
$offset = if ($bom) { 3 } else { 0 }
$text = $encoding.GetString($bytes,$offset,$bytes.Length-$offset)
$crlf = [string][char]13 + [char]10
$newline = if ($text.Contains($crlf)) { $crlf } else { [string][char]10 }
$lines = @($text -split '\\r?\\n')
$starts = @(); $ends = @()
for ($i=0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -eq $begin) { $starts += $i }
  if ($lines[$i] -eq $end) { $ends += $i }
}
if ($starts.Count -ne $ends.Count -or $starts.Count -gt 1 -or ($starts.Count -eq 1 -and $starts[0] -ge $ends[0])) { throw 'Ambiguous managed hosts block' }
$out = New-Object 'Collections.Generic.List[string]'
for ($i=0; $i -lt $lines.Count; $i++) {
  if ($starts.Count -eq 1 -and $i -ge $starts[0] -and $i -le $ends[0]) { continue }
  $tokens = @(($lines[$i] -split '#')[0].Trim() -split '\\s+')
  if ($tokens.Count -gt 1) {
    foreach ($name in $tokens[1..($tokens.Count-1)]) {
      if ($name.TrimEnd('.').Equals($hostname,[StringComparison]::OrdinalIgnoreCase)) { throw 'Competing hostname mapping outside owned block' }
    }
  }
  $out.Add($lines[$i])
}
if ($starts.Count -eq 1) {
  $out = New-Object 'Collections.Generic.List[string]'
  for ($i=0; $i -lt $starts[0]; $i++) { $out.Add($lines[$i]) }
  $out.Add($begin); $out.Add('127.0.0.1' + [char]9 + $hostname); $out.Add($end)
  for ($i=$ends[0]+1; $i -lt $lines.Count; $i++) { $out.Add($lines[$i]) }
} else {
  if ($out.Count -gt 0 -and $out[$out.Count-1] -eq '') { $out.RemoveAt($out.Count-1) }
  $out.Add($begin); $out.Add('127.0.0.1' + [char]9 + $hostname); $out.Add($end); $out.Add('')
}
$newText = [String]::Join($newline,$out)
$newBytes = $encoding.GetBytes($newText)
if ($bom) { $newBytes = [byte[]](@(239,187,191) + $newBytes) }
$hostsChanged = [Convert]::ToBase64String($bytes) -ne [Convert]::ToBase64String($newBytes)
$serveChanged = $null -eq $port
$result = [ordered]@{ hostname=$hostname; applied=$false; hostsChanged=$hostsChanged; serveChanged=$serveChanged; current=(-not $hostsChanged -and -not $serveChanged) }
if ($Apply) {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Windows Administrator token required before apply' }
  # Receive both original inputs again before the first effect.
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($hostsFile)) -ne [Convert]::ToBase64String($bytes)) { throw 'Hosts file changed before apply' }
  $again = Native-Json -Arguments @('serve','status','--json')
  if (($again | ConvertTo-Json -Depth 20 -Compress) -ne ($config | ConvertTo-Json -Depth 20 -Compress)) { throw 'Serve configuration changed before apply' }
  if ($hostsChanged -or $serveChanged) {
    $backup = $resultFile + '.before-' + [Guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($backup+'.serve.json',($config | ConvertTo-Json -Depth 20),$encoding)
    if ($hostsChanged) {
      [IO.File]::WriteAllBytes($backup+'.hosts',$bytes)
      [IO.File]::WriteAllBytes($hostsFile,$newBytes)
    }
    if ($serveChanged) {
      [void](Invoke-TailscaleNative -Arguments @('serve','--bg','--tcp=443','tcp://127.0.0.1:443'))
    }
    Clear-DnsClientCache
  }
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($hostsFile)) -ne [Convert]::ToBase64String($newBytes)) { throw 'Installed hosts bytes differ' }
  $received = Native-Json -Arguments @('serve','status','--json')
  if ($received.TCP.'443'.TCPForward -ne $desiredForward) { throw 'Selected Serve forward was not received' }
  foreach ($property in @($received.AllowFunnel.PSObject.Properties)) { if ($property.Name -match ':443$' -and $property.Value -eq $true) { throw 'Selected forward is public' } }
  # Preserve every unrelated top-level Serve configuration entry, including other TCP ports.
  $beforeOther = $config | ConvertTo-Json -Depth 20 | ConvertFrom-Json
  $afterOther = $received | ConvertTo-Json -Depth 20 | ConvertFrom-Json
  if ($null -ne $beforeOther.TCP) { $beforeOther.TCP.PSObject.Properties.Remove('443') }
  if ($null -ne $afterOther.TCP) { $afterOther.TCP.PSObject.Properties.Remove('443') }
  if ($null -eq $beforeOther.TCP -and @($afterOther.TCP.PSObject.Properties).Count -eq 0) { $afterOther.PSObject.Properties.Remove('TCP') }
  if (($beforeOther | ConvertTo-Json -Depth 20 -Compress) -ne ($afterOther | ConvertTo-Json -Depth 20 -Compress)) { throw 'Unrelated Serve entries changed; inspect retained backup' }
  $result.applied=$true; $result.current=$true
  [IO.File]::WriteAllText($resultFile,($result | ConvertTo-Json),$encoding)
}
$result | ConvertTo-Json
`;
}

function safePath(p, finalMayBeAbsent=true) {
  let current='/';
  for (const part of p.split('/').filter(Boolean)) {
    current=join(current,part);
    let info;
    try { info=lstatSync(current); }
    catch (error) { if (error.code==='ENOENT' && finalMayBeAbsent) continue; fail('missing or unreadable path '+current); }
    if (info.isSymbolicLink()) fail('redirected path '+current);
    if (current!==p && !info.isDirectory()) fail('non-directory ancestor '+current);
  }
}
function fileBytes(p) {
  safePath(p);
  if (!existsSync(p)) return null;
  const s=lstatSync(p);
  if (!s.isFile() || s.size>1048576) fail('bounded regular file required '+p);
  return readFileSync(p);
}
function nativeUnit(name) {
  try {
    const values=run('systemctl',['show',name,'--property=ActiveState,UnitFileState','--no-pager']);
    return Object.fromEntries(values.trim().split('\n').map(s=>s.split('=')));
  } catch { return {}; }
}
function atomic(p, content, mode, uid) {
  safePath(p); safePath(dirname(p));
  mkdirSync(dirname(p),{recursive:true,mode:0o700});
  const temp=p+'.local-origin-'+randomUUID();
  writeFileSync(temp,content,{mode,flag:'wx'});
  if(uid!==undefined)chownSync(temp,uid,uid);
  renameSync(temp,p);
}
function expectedFiles(parameters,{root='',scope='all'}={}) {
  const d=localOriginDeclaration(parameters), files=[];
  const target=p=>root?root+p:p;
  if(scope!=='windows') {
    const hosts=target(d.linuxHostsFile);
    const have=fileBytes(hosts)??Buffer.from('127.0.0.1 localhost\n');
    files.push({path:hosts,content:mergeHosts(have,d),mode:0o644});
    files.push({path:target('/etc/wsl.conf'),content:Buffer.from(renderIni(parameters.linux.wslConf.sections)),mode:0o644});
    files.push({path:target(join(d.stateDirectory,'Caddyfile')),content:Buffer.from(renderLocalOriginCaddy(d)),mode:0o600,uid:d.uid});
    files.push({path:target('/etc/systemd/system/'+d.service),content:Buffer.from(renderLocalOriginUnit(d)),mode:0o644});
  }
  if(scope!=='linux')files.push({path:target(d.windows.scriptPath),content:Buffer.from(renderLocalOriginWindows(d)),mode:0o600});
  return {d,files:files.map(f=>{const have=fileBytes(f.path);return {...f,have,state:have===null?'absent':have.equals(f.content)?'current':'drift'};})};
}
export function planLocalOrigin(parameters,options={}) {
  const {d,files}=expectedFiles(parameters,options);
  const native=options.native??{unit:nativeUnit,run};
  const linux=options.scope!=='windows';
  const unit=linux&&!options.root?native.unit(d.service):null;
  let windows=null;
  if(options.scope!=='linux'&&!options.root&&files.find(f=>f.path===d.windows.scriptPath)?.state==='current') {
    try { windows=JSON.parse(native.run(d.windows.powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',d.windows.scriptWindowsPath],{cwd:'/'})); }
    catch(error) { windows={current:false,error:error.message}; }
  }
  const current=files.every(f=>f.state==='current')&&(!linux||Boolean(options.root)||unit?.ActiveState==='active'&&unit?.UnitFileState==='enabled')&&(options.scope==='linux'||Boolean(options.root)||windows?.current===true);
  return {type:'WslLocalOriginPlan',current,files:files.map(({path,state})=>({path,state})),unit,windows,windowsCommand:d.windows.scriptWindowsPath};
}
export function validateLocalOriginProvider(d,native) {
  safePath(d.provider.binary,false);
  const info=lstatSync(d.provider.binary);
  if(!info.isFile()||info.size>134217728||(info.mode&0o022)||![0,d.uid].includes(info.uid)||hash(readFileSync(d.provider.binary))!==d.provider.sha256)fail('Caddy provider identity or permissions differ');
  const credentials=fileBytes(d.credentialEnvironmentFile);
  const ci=lstatSync(d.credentialEnvironmentFile);
  if(!credentials||(ci.mode&0o077)||![0,d.uid].includes(ci.uid))fail('private scoped credential environment required');
  const tokenPattern=new RegExp('^'+d.dns.tokenVariable+'=(?:\\x22([A-Za-z0-9_-]+)\\x22|\\x27([A-Za-z0-9_-]+)\\x27|([A-Za-z0-9_-]+))$');
  const nonComments=credentials.toString('utf8').split(/\r?\n/).filter(s=>s.trim()&&!s.startsWith('#'));
  if(nonComments.length!==1)fail('only selected DNS credential may enter Caddy');
  const m=tokenPattern.exec(nonComments[0]);
  if(!m)fail('unrecognized scoped DNS credential format');
  // Match the service's explicit credential/environment boundary. A root caller
  // may hold unrelated secrets, and validation must not inherit or return them.
  const env={[d.dns.tokenVariable]:m[1]??m[2]??m[3],HOME:d.home,USER:d.user,LOGNAME:d.user,XDG_DATA_HOME:join(d.stateDirectory,'caddy-data'),XDG_CONFIG_HOME:join(d.stateDirectory,'caddy-config')};
  const modules=native.run(d.provider.binary,['list-modules'],{env,uid:d.uid,gid:d.uid});
  if(!modules.split(/\r?\n/).includes('dns.providers.cloudflare'))fail('Caddy Cloudflare module absent');
  native.run(d.provider.binary,['validate','--config','-','--adapter','caddyfile'],{input:renderLocalOriginCaddy(d),env,uid:d.uid,gid:d.uid});
  return {validated:true};
}
export function applyLocalOrigin(parameters,options={}) {
  const {root='',scope='all'}=options;
  if(!['linux','windows','all'].includes(scope))fail('invalid scope');
  const {d,files}=expectedFiles(parameters,{root,scope});
  const native=options.native??{run,unit:nativeUnit,uid:()=>process.getuid()};
  const linux=scope!=='windows';
  if(linux&&!root) {
    if(native.uid()!==0)fail('Linux apply requires root');
    validateLocalOriginProvider(d,native);
    safePath(d.stateDirectory);
  }
  // Snapshot every managed target before any effect.
  for(const f of files){const current=fileBytes(f.path);if((current===null)!==(f.have===null)||current&&!current.equals(f.have))fail('target changed before apply');}
  const changed=files.filter(f=>f.state!=='current');
  const ran=[];
  if(linux&&!root) {
    mkdirSync(d.stateDirectory,{recursive:true,mode:0o700});
    chmodSync(d.stateDirectory,0o700);chownSync(d.stateDirectory,d.uid,d.uid);
  }
  for(const f of changed) {
    if(f.have!==null) {
      const backup=f.path+'.before-local-origin-'+hash(f.have).slice(0,16);
      if(!existsSync(backup))atomic(backup,f.have,f.mode);
    }
    atomic(f.path,f.content,f.mode,!root?f.uid:undefined);
  }
  if(linux&&!root) {
    const before=native.unit(d.service);
    const configurationChanged=changed.some(f=>f.path.endsWith('/Caddyfile')||f.path.endsWith('/'+d.service));
    if(configurationChanged){native.run('systemctl',['daemon-reload']);ran.push('daemon-reload');}
    if(before.UnitFileState!=='enabled'){native.run('systemctl',['enable',d.service]);ran.push('enable');}
    if(configurationChanged||before.ActiveState!=='active'){native.run('systemctl',[before.ActiveState==='active'?'restart':'start',d.service]);ran.push('start/restart');}
  }
  const after=planLocalOrigin(parameters,{...options,native});
  // Rendering Windows inputs is deliberately separate from its explicit elevated operation.
  const rendered=after.files.every(f=>f.state==='current')&&(!linux||Boolean(root)||after.unit?.ActiveState==='active'&&after.unit?.UnitFileState==='enabled');
  if(!rendered)fail('native local origin did not converge');
  return {type:'WslLocalOriginApply',rendered,converged:after.current,current:after.current,written:changed.map(f=>f.path),ran,windows:after.windows,windowsCommand:d.windows.scriptWindowsPath};
}
