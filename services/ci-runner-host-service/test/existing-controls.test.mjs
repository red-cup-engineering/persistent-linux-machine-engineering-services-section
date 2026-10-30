import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyExistingControls, bytes, planExistingControls, renderDropin } from '../src/existing-controls.mjs';

const runner = (name, memoryMax = '3G') => ({ name, scope: `https://github.com/${name}`, root: `/runners/${name}`,
  slice: 'ci.slice', nice: 10, cpuWeight: 20, ioWeight: 20, memoryMax });
const record = (home, runners = [runner('a'), runner('b')]) => ({ schema: 'ci-runner-host-parameters@1',
  controls: { mode: 'existing-flat', home, sliceMemoryMax: '4G' }, runners });

// A fake user manager: running units with their current properties, changed by set-property.
function manager(units) {
  const state = Object.fromEntries(units.map(u => [u, { Id: u, LoadState: 'loaded', ActiveState: 'active', Slice: 'app.slice',
    MemoryMax: 'infinity', MemorySwapMax: 'infinity', CPUWeight: '[not set]', IOWeight: '[not set]' }]));
  const calls = [];
  return { calls, state,
    show: unit => state[unit],
    reload: () => calls.push(['reload']),
    setProperty: (unit, props) => { calls.push([unit, ...props]);
      for (const p of props) { const [k, v] = p.split('='); state[unit][k] = /Max$/.test(k) ? String(bytes(v)) : v; } } };
}

test('a runner drop-in carries its declared ceiling, no swap, weights, nice and slice', () => {
  const text = renderDropin(record('/h'), runner('a'));
  for (const line of ['[Service]', 'Slice=ci.slice', 'Nice=10', 'MemoryMax=3G', 'MemorySwapMax=0', 'CPUWeight=20', 'IOWeight=20'])
    assert.ok(text.split('\n').includes(line), line);
  assert.doesNotMatch(text, /MemoryHigh/);
});

test('a runner ceiling above the CI slice ceiling is refused', () => {
  assert.throws(() => renderDropin(record('/h'), runner('big', '6G')), /exceeds the CI slice's 4G/);
});

test('apply writes the slice and drop-ins, reloads, applies ceilings live, and is idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'ci-controls-'));
  const m = manager(['ci-runner-a.service', 'ci-runner-b.service']);
  const rec = record(home);
  const ports = { show: m.show, reload: m.reload, setProperty: m.setProperty };
  assert.equal(planExistingControls(rec, ports).changed, true);
  const first = applyExistingControls(rec, ports);
  assert.equal(first.writes.length, 3);
  assert.match(readFileSync(join(home, '.config/systemd/user/ci.slice'), 'utf8'), /^MemoryMax=4G$/m);
  assert.match(readFileSync(join(home, '.config/systemd/user/ci-runner-a.service.d/80-ci-runner-host-controls.conf'), 'utf8'), /^MemoryMax=3G$/m);
  assert.deepEqual(m.calls[0], ['reload']);
  assert.deepEqual(m.calls.slice(1).map(c => c[0]), ['ci-runner-a.service', 'ci-runner-b.service']);
  assert.deepEqual(first.live, ['ci-runner-a.service', 'ci-runner-b.service']);
  assert.deepEqual(first.unconverged, []);
  assert.deepEqual(first.pendingSlice, ['ci-runner-a.service', 'ci-runner-b.service'], 'joining the slice waits for the next start');
  assert.deepEqual(applyExistingControls(rec, ports), { changed: false, writes: [], live: [] });
});

test('a changed record replaces what this service rendered, but never a foreign file', () => {
  const home = mkdtempSync(join(tmpdir(), 'ci-controls-'));
  const m = manager(['ci-runner-a.service', 'ci-runner-b.service']);
  const ports = { show: m.show, reload: m.reload, setProperty: m.setProperty };
  applyExistingControls(record(home), ports);
  const smaller = record(home, [runner('a', '2G'), runner('b')]);
  const second = applyExistingControls(smaller, ports);
  assert.deepEqual(second.writes, [join(home, '.config/systemd/user/ci-runner-a.service.d/80-ci-runner-host-controls.conf')]);
  assert.equal(m.state['ci-runner-a.service'].MemoryMax, String(bytes('2G')));
  const foreign = join(home, '.config/systemd/user/ci-runner-b.service.d/80-ci-runner-host-controls.conf');
  writeFileSync(foreign, '[Service]\nMemoryMax=infinity\n');
  assert.throws(() => planExistingControls(smaller, ports), /not owned by ci-runner-host-service/);
});

test('a stopped runner gets its files but no live change', () => {
  const home = mkdtempSync(join(tmpdir(), 'ci-controls-'));
  const m = manager(['ci-runner-a.service', 'ci-runner-b.service']);
  m.state['ci-runner-b.service'].ActiveState = 'inactive';
  const result = applyExistingControls(record(home), { show: m.show, reload: m.reload, setProperty: m.setProperty });
  assert.deepEqual(result.live, ['ci-runner-a.service']);
});
