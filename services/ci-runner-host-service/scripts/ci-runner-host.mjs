#!/usr/bin/env node
// ci-runner-host plan  --parameters=<ci-runner-host.json>   read-only; exit 0 converged, 2 drift
// ci-runner-host apply --parameters=<ci-runner-host.json> [--now]   idempotent; --now stops a busy old runner (CR-12)
import { resolve } from 'node:path';
import { loadRecord, observe, observeExistingControls, observeHostAdmission, apply } from '../src/ci-runner-host.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
if (!['plan', 'apply', 'startup-admit', 'job-admit'].includes(cmd) || !opt.parameters) {
  console.error('usage: ci-runner-host plan|apply --parameters=<ci-runner-host.json> [--now]');
  process.exit(64);
}
const record = loadRecord(resolve(opt.parameters));
if (['startup-admit','job-admit'].includes(cmd)) {
  try {
    const selected=record.runners.filter(r=>r.name===opt.runner);
    if(selected.length!==1)throw Error('one declared original runner required');
    const root=record.controls?.mode==='existing-flat'?selected[0].root:resolve(selected[0].root,'runner');
    const result=await observeHostAdmission(record,{phase:cmd==='startup-admit'?'startup':'job',destinations:[root]});
    console.log(JSON.stringify(result));
    process.exit(result.admitted?0:1);
  } catch(error) {console.error('runner physical admission refused: '+error.message);process.exit(1);}
}
if (cmd === 'apply') {
  const log = await apply(record, { now: !!opt.now });
  console.log(log.length ? log.join('\n') : 'nothing to change');
  console.log('---');
}
const items = await (record.controls?.mode==='existing-flat'?observeExistingControls(record):observe(record));
for (const i of items) console.log(`${i.status.padEnd(8)} ${i.id.padEnd(44)} ${i.detail}`);
process.exit(items.some((i) => i.status !== 'current') ? 2 : 0);
