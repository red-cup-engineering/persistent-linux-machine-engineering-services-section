#!/usr/bin/env node
import {isCliEntry} from './cli-entry.mjs';
// Activate declared build swap on existing disk through existing sudo permission.
import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const SWAPS = new Set(['github-guix-build.swap', 'github-guix-build-extra.swap']);
const exec = (command, args) => { const result = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'inherit'] }); if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} failed (${result.status})`); };

export function prepare(config, { home = homedir(), swaps = '/proc/swaps', run = exec } = {}) {
  const active = new Set(readFileSync(swaps, 'utf8').split('\n').slice(1).filter((line) => line.trim()).map((line) => line.split(/\s+/u)[0]));
  const permitted = join(home, '.cache/561-group');
  for (const item of config.buildSwapFiles ?? []) {
    const path = item.path, size = item.bytes;
    if (dirname(path) !== permitted || !SWAPS.has(basename(path))) throw new Error('build swap must use its dedicated machine cache paths');
    if (!Number.isInteger(size) || size < 1024 * 1024 || size > 4 * 1024 ** 3) throw new Error('build swap must declare a bounded allocation');
    mkdirSync(dirname(path), { recursive: true });
    let info = null;
    try { info = lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!info) {
      closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600));
      run('fallocate', ['-l', String(size), path]);
      run('/usr/sbin/mkswap', [path]);
      info = lstatSync(path);
    }
    if (!info.isFile() || info.size !== size || (info.mode & 0o777) !== 0o600) throw new Error('build swap must be a private regular file of the declared size');
    if (!active.has(path)) {
      // Existing inactive swap is never reinitialized. These are the only privileged operations;
      // no host settings or existing swap are changed.
      run('sudo', ['-n', 'chown', 'root:root', path]);
      run('sudo', ['-n', '/usr/sbin/swapon', path]);
    }
    console.log(`Build swap active: ${path} (${size} bytes)`);
  }
}

if (isCliEntry(import.meta.url)) prepare(JSON.parse(readFileSync(process.argv[2], 'utf8')));
