#!/usr/bin/env node
// Explicit read-only client qualification. No browser execution or host outage claim.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {isIP} from 'node:net';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseServedImportMap, resolveServedImport} from '../src/served-importmap.mjs';

const script = fileURLToPath(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const refusal = (stage, nativeProcess) => { const error = new Error(stage); error.stage = stage; error.nativeProcess = nativeProcess; throw error; };
const stages = new Set(['arguments', 'canonical-https-origin', 'owner-or-parser-selection', 'parser-source',
  'external-control-selection', 'curl-process-unreceived', 'curl-metadata', 'graph-cross-origin',
  'trusted-local-response', 'multiple-document-bases', 'unsupported-import-map-carrier', 'import-map-after-module',
  'module-entries-absent', 'native-module-parser-flag', 'client-owner-or-control', 'external-egress-not-denied',
  'original-parser-api', 'health-json', 'document-base-cross-origin', 'module-cross-origin', 'dependency-cross-origin',
  'system-manager-owner-required', 'external-baseline-unreceived', 'parser-or-native-client', 'unclassified-client']);
const signals = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGPIPE', 'SIGXCPU', 'SIGXFSZ']);
const nativeCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'EAGAIN', 'ENOMEM', 'ENOBUFS', 'ETIMEDOUT', 'ESRCH', 'EIO']);
export function nativeProcessDiagnostic(value) {
  const code = value?.error?.code ?? value?.errorCode;
  return {signal: signals.has(value?.signal) ? value.signal : null, errorCode: nativeCodes.has(code) ? code : null};
}
function classifiedFailure(value) {
  return {kind: 'wsl-local-origin-offline-unreceived', stage: stages.has(value?.stage) ? value.stage : 'unclassified-client',
    name: ['TypeError', 'SyntaxError', 'Error'].includes(value?.name) ? value.name : 'Error', nativeProcess: nativeProcessDiagnostic(value?.nativeProcess)};
}
export function offlineChildFailure(stderr) {
  let failure = null;
  for (const line of String(stderr ?? '').split('\n')) {
    let value; try { value = JSON.parse(line); } catch { continue; }
    if (value?.kind === 'wsl-local-origin-offline-unreceived') failure = classifiedFailure(value);
  }
  return failure;
}
function options(argv) {
  const result = {};
  for (const value of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(value);
    if (!match || !['origin', 'uid', 'parser-module', 'parser-sha256', 'external-control', 'control-ip', 'client'].includes(match[1]) || Object.hasOwn(result, match[1])) refusal('arguments');
    result[match[1]] = match[2];
  }
  const origin = new URL(result.origin);
  if (origin.protocol !== 'https:' || origin.port || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) refusal('canonical-https-origin');
  if (!/^[1-9]\d*$/u.test(result.uid ?? '') || !/^[a-f0-9]{64}$/u.test(result['parser-sha256'] ?? '')) refusal('owner-or-parser-selection');
  const parser = result['parser-module'];
  if (typeof parser !== 'string' || !parser.startsWith('/gnu/store/') || fs.realpathSync(parser) !== parser || !fs.lstatSync(parser).isFile() || hash(fs.readFileSync(parser)) !== result['parser-sha256']) refusal('parser-source');
  const control = new URL(result['external-control'] ?? 'https://example.com/');
  if (control.protocol !== 'https:' || control.port || control.username || control.password || control.origin === origin.origin || control.hash) refusal('external-control-selection');
  return {...result, origin: origin.origin, control: control.href};
}
function curl(url, hostname, address, seconds = 15) {
  const target = new URL(url), ip = address?.includes(':') ? '[' + address + ']' : address;
  const args = ['--disable', '--silent', '--show-error', '--noproxy', '*', '--proto', '=https', '--connect-timeout', '5', '--max-time', String(seconds)];
  if (address) args.push('--resolve', hostname + ':443:' + ip);
  args.push('--write-out', '\nWSL_OFFLINE_META %{http_code} %{ssl_verify_result} %{remote_ip}', target.href);
  const environment = {...process.env};
  for (const key of ['CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) delete environment[key];
  const result = spawnSync('/usr/bin/curl', args, {encoding: 'buffer', env: environment, maxBuffer: 8 * 1024 * 1024});
  if (result.status === null || result.signal || result.error) refusal('curl-process-unreceived', result);
  const output = result.stdout ?? Buffer.alloc(0), marker = Buffer.from('\nWSL_OFFLINE_META '), index = output.lastIndexOf(marker);
  if (index < 0) refusal('curl-metadata');
  const fields = output.subarray(index + marker.length).toString('ascii').trim().split(' ');
  return {exit: result.status, status: Number(fields[0]), tls: Number(fields[1]), ip: fields[2], body: output.subarray(0, index)};
}
function localGet(url, selected) {
  if (new URL(url).origin !== selected.origin) refusal('graph-cross-origin');
  const response = curl(url, new URL(selected.origin).hostname, '127.0.0.1');
  if (response.exit || response.status !== 200 || response.tls !== 0 || response.ip !== '127.0.0.1') refusal('trusted-local-response');
  return response.body;
}
function attribute(text, name) {
  const match = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'=<>]+))', 'iu').exec(text);
  return match ? match[1] ?? match[2] ?? match[3] : undefined;
}
export function servedPageEntries(html, documentURL) {
  // This qualifier receives ordinary served script carriers, not a browser DOM.
  html = html.replace(/<!--[\s\S]*?-->/gu, '');
  const bases = [...html.matchAll(/<base\b([^>]*)>/giu)].map(m => attribute(m[1], 'href')).filter(x => x !== undefined);
  if (bases.length > 1) refusal('multiple-document-bases');
  const base = new URL(bases[0] ?? documentURL, documentURL).href;
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)];
  const maps = scripts.filter(m => attribute(m[1], 'type')?.toLowerCase() === 'importmap');
  if (maps.length > 1 || maps.some(m => attribute(m[1], 'src') !== undefined)) refusal('unsupported-import-map-carrier');
  if (maps.length && scripts.some(m => attribute(m[1], 'type')?.toLowerCase() === 'module' && m.index < maps[0].index)) refusal('import-map-after-module');
  const map = parseServedImportMap(maps.length ? JSON.parse(maps[0][2]) : {}, base);
  const entries = scripts.filter(m => attribute(m[1], 'type')?.toLowerCase() === 'module').map((m, index) => {
    const src = attribute(m[1], 'src');
    return src === undefined ? {url: base + '#offline-inline-' + index, source: m[2], referrer: base} : {url: new URL(src, base).href};
  });
  if (!entries.length) refusal('module-entries-absent');
  return {base, map, entries};
}
function requests(source, parser) {
  if (typeof vm.SourceTextModule !== 'function') refusal('native-module-parser-flag');
  const module = new vm.SourceTextModule(source);
  const result = module.dependencySpecifiers.map(specifier => ({specifier, dynamic: false}));
  let opaque = 0;
  parser.walkJavaScript(parser.parseJavaScript(source, {sourceType: 'module'}), node => {
    if (node.type !== 'ImportExpression') return;
    if (node.source?.type === 'Literal' && typeof node.source.value === 'string') result.push({specifier: node.source.value, dynamic: true});
    else opaque++;
  });
  return {result, opaque};
}
async function client(selected) {
  if (process.getuid() !== Number(selected.uid) || !isIP(selected['control-ip'] ?? '')) refusal('client-owner-or-control');
  const external = curl(selected.control, new URL(selected.control).hostname, selected['control-ip'], 3);
  if (![7, 28].includes(external.exit) || external.status !== 0) refusal('external-egress-not-denied');
  const parser = await import(pathToFileURL(selected['parser-module']).href);
  if (typeof parser.parseJavaScript !== 'function' || typeof parser.walkJavaScript !== 'function') refusal('original-parser-api');
  const page = localGet(selected.origin + '/', selected), health = localGet(selected.origin + '/healthz', selected);
  const healthReading = JSON.parse(health.toString('utf8'));
  if (!healthReading || typeof healthReading !== 'object' || Array.isArray(healthReading)) refusal('health-json');
  const carrier = servedPageEntries(page.toString('utf8'), selected.origin + '/');
  if (new URL(carrier.base).origin !== selected.origin) refusal('document-base-cross-origin');
  const queue = [...carrier.entries], seen = new Set(), modules = [], nodeSchemeDynamicImports = [];
  let total = page.length + health.length, opaqueDynamicImports = 0;
  while (queue.length) {
    const next = queue.shift();
    if (seen.has(next.url)) continue;
    if (new URL(next.url).origin !== selected.origin) refusal('module-cross-origin');
    seen.add(next.url);
    const body = next.source === undefined ? localGet(next.url, selected) : Buffer.from(next.source);
    if (next.source === undefined) total += body.length;
    const parsed = requests(body.toString('utf8'), parser), edges = [];
    opaqueDynamicImports += parsed.opaque;
    for (const request of parsed.result) {
      if (request.dynamic && request.specifier.startsWith('node:')) { nodeSchemeDynamicImports.push(request.specifier); continue; }
      const target = resolveServedImport(request.specifier, next.referrer ?? next.url, carrier.map);
      if (new URL(target).origin !== selected.origin) refusal('dependency-cross-origin');
      edges.push(target); queue.push({url: target});
    }
    modules.push({url: next.url, bytes: body.length, sha256: hash(body), edges: [...new Set(edges)].sort()});
  }
  modules.sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0);
  return {kind: 'wsl-local-origin-offline-client/v1', externalBlocked: true, externalExit: external.exit,
    trustedLocalTLS: true, pageBytes: page.length, healthBytes: health.length, moduleCount: modules.length,
    totalReceivedBytes: total, pageSHA256: hash(page), healthSHA256: hash(health), graphSHA256: hash(JSON.stringify(modules)),
    importMapSHA256: hash(JSON.stringify(carrier.map)), opaqueDynamicImports, nodeSchemeDynamicImports: [...new Set(nodeSchemeDynamicImports)].sort(),
    scope: 'served import map and static/literal HTTP ESM graph; node: dynamic imports excluded with no condition proof; no code/browser execution, authenticated session, nonliteral dynamic closure or whole-host outage proof'};
}
async function main(argv) {
  const selected = options(argv);
  if (selected.client === 'yes') return client(selected);
  if (selected.client !== undefined || selected['control-ip'] !== undefined || process.getuid() !== 0) refusal('system-manager-owner-required');
  const source = {qualifierSHA256: hash(fs.readFileSync(script)),
    resolverSHA256: hash(fs.readFileSync(new URL('../src/served-importmap.mjs', import.meta.url))), parserSHA256: selected['parser-sha256']};
  const baseline = curl(selected.control);
  if (baseline.exit || baseline.status !== 200 || baseline.tls !== 0 || !isIP(baseline.ip) || ['127.0.0.1', '::1'].includes(baseline.ip)) refusal('external-baseline-unreceived');
  const unit = 'wsl-local-origin-offline-' + randomUUID() + '.service';
  const args = ['--system', '--unit=' + unit, '--collect', '--wait', '--pipe', '--service-type=exec', '--uid=' + selected.uid,
    '--property=IPAddressDeny=any', '--property=IPAddressAllow=localhost', '--property=RuntimeMaxSec=180s',
    '--setenv=NODE_DISABLE_COMPILE_CACHE=1', '--property=UnsetEnvironment=NODE_COMPILE_CACHE NODE_V8_COVERAGE NODE_REDIRECT_WARNINGS NODE_OPTIONS',
    process.execPath, '--experimental-vm-modules', script, ...argv, '--client=yes', '--control-ip=' + baseline.ip];
  const run = spawnSync('/usr/bin/systemd-run', args, {encoding: 'utf8', maxBuffer: 2 * 1024 * 1024});
  const after = spawnSync('/usr/bin/systemctl', ['--system', 'show', unit, '--property=LoadState', '--value'], {encoding: 'utf8'});
  const unitGone = after.stdout?.trim() === 'not-found';
  const lines = (run.stdout ?? '').trim().split('\n').filter(Boolean);
  let received;
  try { received = lines.length === 1 ? JSON.parse(lines[0]) : undefined; } catch {}
  const clientFailure = offlineChildFailure(run.stderr);
  const sourceStable = hash(fs.readFileSync(script)) === source.qualifierSHA256
    && hash(fs.readFileSync(new URL('../src/served-importmap.mjs', import.meta.url))) === source.resolverSHA256
    && hash(fs.readFileSync(selected['parser-module'])) === source.parserSHA256;
  const qualified = run.status === 0 && !run.signal && !run.error && unitGone && sourceStable && !clientFailure && received?.kind === 'wsl-local-origin-offline-client/v1';
  const result = {kind: 'wsl-local-origin-offline-qualification/v1', qualified, unit, unitGone,
    nativeExit: run.status, nativeProcess: nativeProcessDiagnostic(run),
    unitObservation: {exit: after.status, ...nativeProcessDiagnostic(after)}, clientFailure,
    client: received?.kind === 'wsl-local-origin-offline-client/v1' ? received : null, source, sourceStable,
    effects: 'one awaited transient diagnostic client; no persistent host/app/network/Data mutation'};
  console.log(JSON.stringify(result));
  if (!qualified) process.exitCode = 1;
}
if (import.meta.main) main(process.argv.slice(2)).then(result => {
  if (result) console.log(JSON.stringify(result));
}).catch(error => {
  console.error(JSON.stringify(classifiedFailure({stage: error.stage ?? 'parser-or-native-client', name: error.name, nativeProcess: error.nativeProcess ?? {error}})));
  process.exitCode = 1;
});
