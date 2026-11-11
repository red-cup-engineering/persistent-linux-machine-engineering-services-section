import {isCliEntry} from './cli-entry.mjs';
// Value-free failure context for the existing media receiving transaction.
// The media script may already have attempted rollback. These later readings
// prove neither the original failing dependency nor the candidate unit state.
// Fixed units and properties only: no arguments, environment, logs or actions.
import { spawnSync } from 'node:child_process';

const UNITS = ['561-group-credentials.service', 'media-studio-display.service', 'media-studio-browser.service'];
const PROPERTIES = ['Id', 'LoadState', 'ActiveState', 'SubState', 'Result', 'ExecMainCode', 'ExecMainStatus'];
const LOAD = ['stub', 'loaded', 'not-found', 'bad-setting', 'error', 'merged', 'masked'];
const ACTIVE = ['active', 'reloading', 'inactive', 'failed', 'activating', 'deactivating', 'maintenance', 'refreshing'];
const SUB = ['dead', 'condition', 'start-pre', 'start', 'start-post', 'running', 'exited', 'reload',
  'reload-signal', 'reload-notify', 'reload-post', 'stop', 'stop-watchdog', 'stop-sigterm', 'stop-sigkill',
  'stop-post', 'final-watchdog', 'final-sigterm', 'final-sigkill', 'failed', 'dead-before-auto-restart',
  'failed-before-auto-restart', 'dead-resources-pinned', 'auto-restart', 'auto-restart-queued', 'cleaning'];
const RESULTS = ['success', 'resources', 'timeout', 'exit-code', 'signal', 'core-dump', 'watchdog',
  'start-limit-hit', 'protocol', 'oom-kill', 'exec-condition', 'skip-condition'];
const enumeration = (value, allowed) => allowed.includes(value) ? value : null;
const integer = (value, maximum) => /^(0|[1-9][0-9]{0,2})$/.test(value ?? '') && Number(value) <= maximum ? Number(value) : null;

export function observeMediaDependencies(execute = spawnSync) {
  const units = UNITS.map(unit => {
    try {
      const result = execute('systemctl', ['--user', 'show', '--all', `--property=${PROPERTIES.join(',')}`, unit],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 16 * 1024 });
      if (result.error) return { unit, observation: 'unavailable', reason: 'query-error' };
      const fields = {};
      for (const line of (result.stdout ?? '').trimEnd().split('\n')) {
        const at = line.indexOf('='), key = line.slice(0, at);
        if (at < 1 || !PROPERTIES.includes(key) || Object.hasOwn(fields, key))
          return { unit, observation: 'unavailable', reason: 'invalid-response' };
        fields[key] = line.slice(at + 1);
      }
      if (fields.Id !== unit || !LOAD.includes(fields.LoadState))
        return { unit, observation: 'unavailable', reason: 'unmatched-unit' };
      return { unit, observation: 'observed', queryStatus: integer(String(result.status), 255),
        LoadState: fields.LoadState, ActiveState: enumeration(fields.ActiveState, ACTIVE),
        SubState: enumeration(fields.SubState, SUB), Result: enumeration(fields.Result, RESULTS),
        ExecMainCode: integer(fields.ExecMainCode, 6), ExecMainStatus: integer(fields.ExecMainStatus, 255) };
    } catch {
      return { unit, observation: 'unavailable', reason: 'query-exception' };
    }
  });
  // Observed state is diagnostic context, never freshness or release acceptance.
  return { kind: 'media-dependency-observation', units };
}

if (isCliEntry(import.meta.url)) {
  if (process.argv.length !== 2) {
    process.stderr.write('Media dependency observation accepts no unit or command arguments.\n');
    process.exitCode = 2;
  } else process.stdout.write(JSON.stringify(observeMediaDependencies()) + '\n');
}
