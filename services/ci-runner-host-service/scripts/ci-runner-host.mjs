#!/usr/bin/env node
// ci-runner-host plan  --parameters=<ci-runner-host.json>   read-only; exit 0 converged, 2 drift
// ci-runner-host apply --parameters=<ci-runner-host.json> [--now]   idempotent; --now stops a busy old runner (CR-12)
import { resolve } from 'node:path';
import { loadRecord, observe, apply } from '../src/ci-runner-host.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
if (!['plan', 'apply'].includes(cmd) || !opt.parameters) {
  console.error('usage: ci-runner-host plan|apply --parameters=<ci-runner-host.json> [--now]');
  process.exit(64);
}
const record = loadRecord(resolve(opt.parameters));
if (cmd === 'apply') {
  const log = await apply(record, { now: !!opt.now });
  console.log(log.length ? log.join('\n') : 'nothing to change');
  console.log('---');
}
const items = observe(record);
for (const i of items) console.log(`${i.status.padEnd(8)} ${i.id.padEnd(44)} ${i.detail}`);
process.exit(items.some((i) => i.status !== 'current') ? 2 : 0);
