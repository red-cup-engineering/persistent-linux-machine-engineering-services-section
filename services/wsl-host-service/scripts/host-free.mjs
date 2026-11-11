#!/usr/bin/env node
// host-free [--parameters=<wsl-host.json>]: print the real free bytes of the shared disk.
import { hostFreeFromRecord } from '../src/host-free.mjs';

const DEFAULT_RECORD = new URL('../data/records/wsl-host-parameter-records/bare-cedar-fog.json', import.meta.url).pathname;
const given = process.argv.slice(2).find(a => a.startsWith('--parameters='));
try {
  console.log(String(hostFreeFromRecord(given ? given.slice(13) : DEFAULT_RECORD)));
} catch (error) {
  console.error(`host-free: ${error.message}`);
  process.exitCode = 2;
}
