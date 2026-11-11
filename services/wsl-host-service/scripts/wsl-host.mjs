#!/usr/bin/env node
import {planCapacityCommands,applyCapacityCommands} from '../src/capacity-commands.mjs';
import { prepareOrphanSwapRequest } from '../src/orphan-swap.mjs';
import { renderDerivedCodeCacheRequest } from '../src/derived-code-cache.mjs';
import { renderWinInetCacheRequest } from '../src/wininet-cache.mjs';
import { planUserUnitRetirements, applyUserUnitRetirements } from '../src/user-unit-retirement.mjs';
import { planStorageProviders } from '../src/storage-providers.mjs';
import { discardMountedRoot } from '../src/mounted-discard.mjs';
import { operateSparseMaintenance } from '../src/sparse-maintenance.mjs';
import { observeTrimTimer } from '../src/trim-timer.mjs';
import { planLocalOrigin, applyLocalOrigin } from '../src/local-origin.mjs';
import { planManagedTimers, applyManagedTimers, renderManagedTimerFiles } from '../src/managed-timers.mjs';
// wsl-host plan|apply --parameters=<file> [--scope=linux|windows|all] [--root=<staging>]
// Plan observes; apply reconciles scoped files and managed live values, then receives convergence.
import { holdQuarantine, planQuarantine, releaseQuarantine, completeQuarantine, receiveLegacyQuarantine, prepareQuarantineOwnerPaths } from '../src/user-unit-quarantine.mjs';
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { applyPlan, liveReloadHooks, observeLive, planFiles, renderFiles, windowsInstruction, observeBackingVolumeCapacity, assessBackingVolumeHeadroom, assessBackingReclaim, guestUsedBytes } from "../src/wsl-host.mjs";

const [command = "plan", ...rest] = process.argv.slice(2);
const opt = (name, fallback) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const parametersPath = opt("parameters");
const scope = opt("scope", "all");
const root = opt("root", "");
const component = opt("component", "all");
if (!["all", "managed-timers", "trim-timer", "local-origin", "storage-providers", "capacity-commands", "user-unit-retirement"].includes(component) || !parametersPath || !["plan", "apply", "capacity", "orphan-swap-request", "derived-code-cache-request", "wininet-cache-request", "maintain-disk", "maintenance-status", "maintenance-receive-interruption", "mounted-discard", "quarantine-plan", "quarantine-legacy-receive", "quarantine-hold", "quarantine-release", "quarantine-complete", "quarantine-prepare-owner-paths"].includes(command) || !["linux", "windows", "all"].includes(scope)) {
  console.error("usage: wsl-host plan|apply|capacity|orphan-swap-request|derived-code-cache-request|maintain-disk|maintenance-status|maintenance-receive-interruption|mounted-discard|quarantine-plan|quarantine-legacy-receive|quarantine-hold|quarantine-release|quarantine-complete|quarantine-prepare-owner-paths --parameters=<file> [--interrupted-request=<exact-request-sha256>] [--admission=<original-received-maintenance-file>] [--scope=linux|windows|all] [--root=<dir>] [--destinations-json=<array>] [--component=all|managed-timers|trim-timer|local-origin|storage-providers|capacity-commands|user-unit-retirement] [--quarantine-id=<declared-id>]");
  process.exit(64);
}
const parameterText = readFileSync(parametersPath, "utf8");
const params = JSON.parse(parameterText);
if (command === 'wininet-cache-request') {
  try {
    if(root||scope!=='all'||component!=='all')throw new Error('WinINet retirement requires the exact native record');
    const {script,encodedCommand,launcher,...manifest}=renderWinInetCacheRequest(parameterText,{action:opt('action'),nonce:opt('nonce')});
    console.log(JSON.stringify(manifest));process.exit(0);
  } catch(error) {console.error(error.message);process.exit(2);}
}
if (command === 'derived-code-cache-request') {
  try {
    if(root||scope!=='all'||component!=='all')throw new Error('derived Code retirement requires the exact native record');
    const {script,encodedCommand,launcher,...manifest}=renderDerivedCodeCacheRequest(parameterText,{action:opt('action'),nonce:opt('nonce')});
    console.log(JSON.stringify(manifest));process.exit(0);
  } catch(error) {console.error(error.message);process.exit(2);}
}
if (command === 'orphan-swap-request') {
  try {
    if(root||scope!=='all'||component!=='all')throw new Error('orphan-swap requires exact native record request');
    const {script,encodedCommand,...manifest}=prepareOrphanSwapRequest(parameterText,{action:opt('action'),nonce:opt('nonce')});
    console.log(JSON.stringify(manifest));process.exit(0);
  } catch(error) {console.error(error.message);process.exit(2);}
}
if (component === 'user-unit-retirement') {
  try {
    if (!['plan','apply'].includes(command) || scope==='windows') throw new Error('user-unit-retirement requires Linux plan/apply');
    const result=command==='plan'?planUserUnitRetirements(params,{root}):applyUserUnitRetirements(params,{root});
    console.log(JSON.stringify(result));process.exit(result.current||result.stagedCurrent?0:2);
  } catch(error) {console.error(JSON.stringify({message:error.message,outcome:error.retirementOutcome??null}));process.exit(2);}
}
if (component === 'capacity-commands') {
  try {
    if (!['plan','apply'].includes(command) || root || scope==='windows') throw new Error('capacity-commands requires native Linux plan/apply');
    const result=command==='plan'?planCapacityCommands(params):applyCapacityCommands(params);
    console.log(JSON.stringify(result));process.exit(result.current?0:2);
  } catch (error) {console.error(error.message);process.exit(2);}
}
if (component === 'storage-providers') {
  if (command !== 'plan' || root || scope === 'linux') { console.error('storage-providers requires native read-only Windows/all plan'); process.exit(64); }
  const result=planStorageProviders(params); console.log(JSON.stringify(result)); process.exit(result.current?0:2);
}
if (component === 'local-origin') {
  try {
    if (!['plan', 'apply'].includes(command)) throw new Error('local-origin requires plan or apply');
    const result = command === 'plan' ? planLocalOrigin(params, { root, scope }) : applyLocalOrigin(params, { root, scope });
    console.log(JSON.stringify(result)); process.exit(result.current === true || result.converged === true ? 0 : 2);
  } catch (error) { console.error(error.message); process.exit(2); }
}
if (['maintain-disk', 'maintenance-status', 'maintenance-receive-interruption'].includes(command)) {
  try {
    if(root||scope!=='all'||component!=='all')throw new Error('disk maintenance uses the exact native host record');
    const action = { 'maintain-disk': 'launch', 'maintenance-status': 'status', 'maintenance-receive-interruption': 'receive-interruption' }[command];
    console.log(JSON.stringify(operateSparseMaintenance(parameterText, action, { priorRequest: opt('interrupted-request') })));
    process.exit(0);
  } catch(error) {console.error(error.message);process.exit(2);}
}
if (component === 'trim-timer') {
  try {
    if(!['plan','apply'].includes(command)||scope==='windows')throw new Error('trim-timer requires Linux plan/apply');
    const files=renderFiles(params,root).filter(file=>file.scope==='linux'&&file.hooks.includes('trim-timer'));
    if(files.length!==2)throw new Error('host must declare the original trim service and timer');
    let plan=planFiles(files),live=root?[]:observeTrimTimer(params.linux);
    if(command==='apply') {
      if(!root&&process.getuid()!==0)throw new Error('trim-timer installation requires the native system owner');
      applyPlan(plan,{stamp:new Date().toISOString().slice(0,10),staged:Boolean(root),live,
        run:cmd=>execFileSync(cmd[0],cmd.slice(1),{stdio:'inherit'})});
      plan=planFiles(files);live=root?[]:observeTrimTimer(params.linux);
    }
    const current=plan.every(file=>file.state==='current')&&live.every(check=>check.ok);
    console.log(JSON.stringify({component:'trim-timer',current,files:plan.map(({path,state})=>({path,state})),live}));
    process.exit(current?0:2);
  } catch(error) {console.error(error.message);process.exit(2);}
}
if (command === 'mounted-discard') {
  try {
    if(root||scope!=='all'||component!=='all'||!opt('admission'))throw new Error('mounted-discard requires exact native record and original admission, without staging/component/scope substitution');
    const result=await discardMountedRoot(parameterText,readFileSync(opt('admission'),'utf8'));
    console.log(JSON.stringify(result));process.exit(result.status==='native-terminal-success'?0:2);
  } catch(error) {console.error(JSON.stringify({type:error.name,message:error.message,capacityReopened:false}));process.exit(2);}
}
if (component === 'managed-timers') {
  if (!['plan', 'apply'].includes(command) || scope === 'windows') {
    console.error('managed-timers requires plan/apply and Linux or all scope'); process.exit(64);
  }
  try {
    const result = command === 'plan'
      ? planManagedTimers(params, { root, planFiles })
      : applyManagedTimers(params, { root, planFiles, applyPlan });
    console.log(JSON.stringify(result));
    process.exit(result.current === true || result.converged === true ? 0 : 2);
  } catch (error) {
    console.error(JSON.stringify({ type: error.name, code: error.code ?? null, message: error.message, outcome: error.managedTimerOutcome ?? null }));
    process.exit(2);
  }
}
if (command.startsWith('quarantine-')) {
  try {
    if (root || scope !== 'all') throw new Error('quarantine requires the actual declared user manager, not staged/scoped file reconciliation');
    if (command === 'quarantine-prepare-owner-paths') {
      if (component !== 'all') throw new Error('owner-path preparation requires the original exact operation');
      const result = prepareQuarantineOwnerPaths(parametersPath, opt('parameters-sha256'), opt('quarantine-id'));
      console.log(JSON.stringify(result)); process.exit(0);
    }
    const operation = { 'quarantine-plan': planQuarantine, 'quarantine-legacy-receive': receiveLegacyQuarantine, 'quarantine-hold': holdQuarantine, 'quarantine-release': releaseQuarantine, 'quarantine-complete': completeQuarantine }[command];
    const selectorId = opt('quarantine-id');
    if (command === 'quarantine-legacy-receive' && selectorId !== undefined) throw new Error('legacy observation has its own explicit declaration, not quarantine-id');
    const result = operation(params, undefined, selectorId);
    console.log(JSON.stringify(result));
    if (command === 'quarantine-plan' && result.status !== 'held') process.exitCode = 2;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
} else if (command === 'capacity') {
  try {
    const raw = opt('destinations-json', '["/"]');
    if (Buffer.byteLength(raw) > 16384) throw new TypeError('destination input exceeds 16 KiB');
    const result = observeBackingVolumeCapacity(params, JSON.parse(raw));
    console.log(JSON.stringify(result));
  } catch (error) { console.error(`wsl-host capacity refused: ${error.message}`); process.exitCode = 2; }
} else {
const inScope = (f) => scope === "all" || f.scope === scope;
const files = renderFiles(params, root).filter(inScope);
const managed = scope !== 'windows' && ((params.linux?.managedTimers?.length ?? 0) + (params.linux?.retiredManagedTimers?.length ?? 0)) > 0;
const managedPaths = new Set(managed ? renderManagedTimerFiles(params, root).map(f => f.path) : []);
const observe = () => {
  if (root) return [];
  const result = observeLive(params).filter(inScope);
  if (scope!=='windows' && params.linux?.capacityCommands) {
    try {
      const selected=planCapacityCommands(params);
      result.push({name:'physical capacity command boundary',scope:'linux',ok:selected.current,want:'current; reconcile with --component=capacity-commands apply',have:selected.current?'guest-capacity commands refuse; original diagnostics retained':'drift'});
    } catch(error) {result.push({name:'physical capacity command boundary',scope:'linux',ok:false,want:'received original package/diagnostic/guard ownership',have:error.message});}
  }
  if (params.localOrigin) {
    try {
      const selected=planLocalOrigin(params,{scope});
      result.push({name:'canonical local origin',scope,ok:selected.current,want:'current; reconcile with --component=local-origin apply',have:JSON.stringify({files:selected.files,unit:selected.unit,windows:selected.windows})});
    } catch(error) { result.push({name:'canonical local origin',scope,ok:false,want:'received scoped local-origin configuration',have:error.message}); }
  }
  if (managed) {
    const selected = planManagedTimers(params, { planFiles });
    result.push({ name: 'record-owned managed timers', scope: 'linux', hook: 'managed-timers', ok: selected.current, want: 'received declared timer lifecycle and quiet retired roles', have: selected.current ? 'current' : 'drift' });
  }
  return result;
};
let plan = planFiles(files), live = observe();
let backing = [];
let storageProviders = [];
let quarantine = [];
let retirementChecks = [];
if (!root && scope!=='windows' && params.linux?.userUnitRetirements?.length) {
  try {
    const result=planUserUnitRetirements(params);
    retirementChecks=result.items.map(item=>({name:'retired user-unit role '+item.id,ok:item.current,want:'exact quiet native units and qualified artifact paths absent',have:item.current?'current':'reconcile with --component=user-unit-retirement'}));
    for(const row of retirementChecks.filter(row=>row.ok))console.log(`current ${row.name}: ${row.have}`);
    if(command==='apply'&&!result.current)console.log('RETIRE reconcile only through apply --component=user-unit-retirement; ordinary apply does not delete artifacts');
  } catch(error) {retirementChecks=[{name:'declared user-unit retirement',ok:false,want:'original owner, exact files and quiet native units',have:error.message}];}
}

if (command === 'plan' && !root && scope !== 'windows' && (params.linux?.userUnitQuarantine !== undefined || params.linux?.userUnitQuarantines !== undefined)) {
  try {
    const result = planQuarantine(params);
    quarantine = (result.quarantines ?? [result]).map(entry => ({ name: 'durable user-unit quarantine ' + entry.id, ok: entry.status === 'held', want: 'received loaded persistent hold', have: entry.status }));
  } catch (error) {
    quarantine = [{ name: 'durable user-unit quarantine', ok: false, want: 'received loaded persistent hold', have: error.message }];
  }
}
if (command === 'plan' && !root && scope !== 'windows' && params.linux?.legacyUserUnitQuarantine) {
  try {
    const result = receiveLegacyQuarantine(params);
    quarantine.push({ name: 'retained original legacy user-unit quarantine', ok: result.status === 'held', want: 'exact retained marker and loaded negative condition', have: result.status });
  } catch(error) { quarantine.push({ name: 'retained original legacy user-unit quarantine', ok: false, want: 'exact retained marker and loaded negative condition', have: error.message }); }
}
if (command === 'plan' && !root && scope !== 'linux' && params.windows?.backingStorage) {
  try {
    const capacity = observeBackingVolumeCapacity(params, ['/']);
    backing = assessBackingVolumeHeadroom(capacity).map(v => ({
      name: `Windows backing capacity ${v.id}`, ok: v.admitted,
      want: `at least ${v.requiredBytes} bytes (physical reserve + growth + estimated overhead)`, have: `${v.availableBytes} available bytes; VHD ${v.vhd.lengthBytes} logical bytes / ${v.vhd.allocatedBytes} allocated bytes (${v.vhd.sparse ? 'sparse' : 'not sparse'})`
    }));
    // Sparse state and Windows allocation beside ext4 use, when the record declares a sparse disk.
    backing.push(...assessBackingReclaim(params, capacity, guestUsedBytes(params.windows.backingStorage.linuxMount)));
    for (const c of backing.filter(c => c.ok)) console.log(`current ${c.name}: ${c.have}; ${c.want}`);
  } catch (error) { backing = [{ name: 'Windows backing capacity', ok: false, want: 'fresh registered physical capacity', have: `unknown: ${error.message}` }]; }
}
if (command === 'plan' && !root && scope !== 'linux' && params.windows?.storageProviders) {
  storageProviders=planStorageProviders(params).checks;
  for (const row of storageProviders.filter(row=>row.ok)) console.log(`current ${row.name}: ${row.have}`);
}
const reportLive = (checks) => {
  for (const c of checks.filter((c) => !c.ok)) console.log(`live    ${c.name}: want ${c.want}, have ${c.have ?? "unreadable"}`);
};
for (const f of plan) console.log(`${f.state.padEnd(7)} ${f.path}`);
for (const c of quarantine.filter(c => c.ok)) console.log(`current ${c.name}: ${c.have}`);
reportLive([...live, ...backing, ...storageProviders, ...quarantine, ...retirementChecks]);
const drift = plan.some((f) => f.state !== "current");
const hooks = liveReloadHooks(live);
if (command === "apply" && (drift || hooks.length || live.some(c => c.hook === 'managed-timers' && !c.ok))) {
  const needsRoot = (managed && !root) || hooks.length > 0 || plan.some((f) => f.state !== "current" && f.scope === "linux");
  if (needsRoot && !root && process.getuid() !== 0) {
    console.error(`Linux reconciliation needs root: sudo node ${process.argv[1]} apply --scope=linux --parameters=${parametersPath}`);
    process.exit(1);
  }
  const out = applyPlan(plan.filter(f => !managedPaths.has(f.path)), {
    stamp: new Date().toISOString().slice(0, 10), staged: Boolean(root), live,
    run: (cmd) => execFileSync(cmd[0], cmd.slice(1), { stdio: "inherit" }),
  });
  console.log(`wrote ${out.written.length} file(s); ran ${out.ran.length} command(s)`);
  if (managed) console.log(JSON.stringify(applyManagedTimers(params, { root, planFiles, applyPlan })));
}
const steps = windowsInstruction(plan, params, backing);
if (steps) for (const s of steps) console.log(`WINDOWS ${s}`);
if (command === "apply") {
  plan = planFiles(files);
  live = observe();
  reportLive(live);
}
process.exit(plan.some((f) => f.state !== "current") || live.some((c) => !c.ok) || (backing.some((c) => !c.ok) || storageProviders.some((c) => !c.ok) || quarantine.some((c) => !c.ok) || retirementChecks.some((c) => !c.ok)) ? 2 : 0);
}


