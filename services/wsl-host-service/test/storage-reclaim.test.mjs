import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan, assessBackingReclaim, guestUsedBytes, liveReloadHooks, observeLive, planFiles, renderCompactScript, renderFiles, renderSparseMaintenanceScript, renderTrimUnits, windowsInstruction } from "../src/wsl-host.mjs";

// Host storage reclaims itself (Group rule host-storage-reclaims-itself): a daily trim inside Linux,
// a sparse backing disk, and a plan that shows both without a frontier model.

const GUID = "{645c490d-c03a-4203-80e4-451ee497d286}";
const trimTimer = {
  description: "Trim the root filesystem so freed blocks return to Windows",
  comment: ["Bare Cedar Fog 2026-10-25: 580 GB on Windows for 436 GB of ext4.", "", "No fstrim timer existed."],
  executable: "/usr/sbin/fstrim", mountpoint: "/", calendar: "*-*-* 03:30:00",
  bootDelayMinutes: 10, randomizedDelayMinutes: 30, timeoutMinutes: 120,
};
const sparse = { want: true, wslExecutable: "C:\\Program Files\\WSL\\wsl.exe", allowUnsafe: false, compactWhenBelowFloor: false, maxSlackBytes: "53687091200", basis: "Leader 2026-10-25", relaunchers: ["ChatGPT.exe", "Docker Desktop.exe"], conversionAttempts: 5, trimAfterConversion: true };
const backingStorage = {
  distributionName: "Ubuntu",
  registryKey: `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\${GUID}`,
  basePath: `C:\\Users\\emsen\\AppData\\Local\\wsl\\${GUID}`,
  vhdFileName: "ext4.vhdx",
  volumeId: "\\\\?\\Volume{715daebd-cb0c-495a-a2cb-85c7ff775c00}\\",
  linuxMount: "/", powershell: "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", wslpath: "/usr/bin/wslpath",
  timeoutMs: 10000, maxAgeMs: 15000,
  policy: { minFreeBytes: "100000000000", minFreePercent: 3, growthBytes: "2147483648", overheadBytes: "67108864", basis: "physical floor" },
  sparse,
};
const base = {
  schema: "wsl-host-parameters@1",
  windows: {
    profileMount: "/win", profileWindowsPath: "C:\\u",
    wslConfig: { sections: [{ name: "wsl2", entries: [{ key: "memory", value: "6GB" }] }] },
    defender: { paths: ["C:\\a"], processes: ["vmmem"], resultFile: "C:\\r.txt" },
    backingStorage,
  },
  linux: {
    wslConf: { sections: [{ name: "boot", entries: [{ key: "systemd", value: "true" }] }] },
    sysctl: [{ file: "93.conf", entries: [{ key: "vm.swappiness", value: 10 }] }],
    blockQueue: { file: "60.rules", kernel: "sd[a-z]", attributes: { nr_requests: 256 } },
    agentLimits: { description: "d", defaults: { entries: [{ key: "PIDS_MAX", value: "4096" }] } },
    relayReaper: { description: "r", minAgeSeconds: 600, minFreeRings: 64, bootDelayMinutes: 15, intervalMinutes: 5 },
    trimTimer,
  },
};
const withSparse = (patch) => ({ ...base, windows: { ...base.windows, backingStorage: { ...backingStorage, sparse: { ...sparse, ...patch } } } });

// (a) the daily Linux-side trim

test("a declared trim timer renders an idle-priority fstrim service and a boot-and-daily timer", () => {
  const { service, timer } = renderTrimUnits(base.linux);
  assert.match(service, /^# Bare Cedar Fog 2026-10-25: 580 GB on Windows for 436 GB of ext4\.\n#\n# No fstrim timer existed\.\n\[Unit\]/);
  assert.match(service, /Type=oneshot\nExecStart=\/usr\/sbin\/fstrim --verbose \/\n/);
  assert.match(service, /IOSchedulingClass=idle\n/);
  assert.match(service, /Nice=19\n/);
  assert.match(service, /ConditionPathIsMountPoint=\/\n/);
  assert.match(service, /TimeoutStartSec=120min\n/);
  assert.match(timer, /OnBootSec=10min\nOnCalendar=\*-\*-\* 03:30:00\nRandomizedDelaySec=30min\nPersistent=true\n/);
  assert.match(timer, /\[Install\]\nWantedBy=timers\.target\n/);
});

test("the trim units are rendered, hooked and installed only when the record declares them", () => {
  const without = { ...base, linux: { ...base.linux, trimTimer: undefined } };
  assert.ok(!renderFiles(without).some((f) => f.path.includes("fstrim")));
  const files = renderFiles(base).filter((f) => f.path.includes("fstrim"));
  assert.deepEqual(files.map((f) => f.path), ["/etc/systemd/system/wsl-fstrim.service", "/etc/systemd/system/wsl-fstrim.timer"]);
  assert.ok(files.every((f) => f.scope === "linux" && f.mode === 0o644 && f.hooks.join() === "trim-timer"));
});

test("apply installs and enables the trim timer once, and a second apply does nothing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wsl-trim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = renderFiles(base).filter((f) => f.path.includes("fstrim")).map((f) => ({ ...f, path: join(dir, f.path.split("/").pop()) }));
  const ran = [];
  const first = applyPlan(planFiles(files), { stamp: "t", run: (c) => ran.push(c.join(" ")) });
  assert.equal(first.written.length, 2);
  assert.deepEqual(ran, ["systemctl daemon-reload", "systemctl enable wsl-fstrim.timer", "systemctl restart wsl-fstrim.timer"]);
  assert.match(readFileSync(files[1].path, "utf8"), /OnCalendar=/);
  const again = applyPlan(planFiles(files), { stamp: "t", run: (c) => ran.push(c.join(" ")) });
  assert.deepEqual(again, { written: [], ran: [] });
  assert.equal(ran.length, 3);
});

const unit = (states) => (name) => states[name] ?? null;
const enabledTimer = { LoadState: "loaded", UnitFileState: "enabled", ActiveState: "active", SubState: "waiting", NextElapseUSecRealtime: "Mon 2026-10-26 03:41:00 CDT", LastTriggerUSec: "n/a" };
const okService = { Result: "success" };
const live = (states) => observeLive(base, { read: () => null, list: () => [], unit: unit(states) }).filter((c) => c.name.includes("fstrim"));

test("the live plan reports the trim timer enabled with its next trigger and the last trim's result", () => {
  const [timer, service] = live({ "wsl-fstrim.timer": enabledTimer, "wsl-fstrim.service": okService });
  assert.equal(timer.ok, true);
  assert.match(timer.have, /enabled, active \(waiting\), next trigger Mon 2026-10-26 03:41:00 CDT/);
  assert.equal(service.ok, true);
  assert.match(service.have, /^success; last trigger never$/);
});

test("a missing or disabled trim timer is drift that the apply hook repairs; a failed trim is reported", () => {
  const [absent] = live({});
  assert.equal(absent.ok, false);
  assert.equal(absent.have, null);
  const [disabled] = live({ "wsl-fstrim.timer": { ...enabledTimer, UnitFileState: "disabled", ActiveState: "inactive", SubState: "dead", NextElapseUSecRealtime: "" }, "wsl-fstrim.service": okService });
  assert.equal(disabled.ok, false);
  assert.deepEqual(liveReloadHooks([disabled]), ["trim-timer"]);
  const [, failed] = live({ "wsl-fstrim.timer": enabledTimer, "wsl-fstrim.service": { Result: "exit-code" } });
  assert.equal(failed.ok, false);
  assert.match(failed.have, /^exit-code/);
  assert.deepEqual(liveReloadHooks([failed]), []);
  // A host that declares no trim timer is not asked about one.
  assert.equal(observeLive({ ...base, linux: { ...base.linux, trimTimer: undefined } }, { read: () => null, list: () => [] }).some((c) => c.name.includes("fstrim")), false);
});

test("a malformed trim declaration refuses before any file is rendered", () => {
  for (const bad of [{ executable: "fstrim" }, { executable: "/usr/sbin/fstrim -a" }, { mountpoint: "/a b" }, { calendar: "daily; rm -rf /" }, { bootDelayMinutes: 0 }, { timeoutMinutes: 1.5 }, { description: "two\nlines" }])
    assert.throws(() => renderFiles({ ...base, linux: { ...base.linux, trimTimer: { ...trimTimer, ...bad } } }), /linux\.trimTimer/, JSON.stringify(bad));
});

// (b) the sparse disk and the Windows maintenance script

test("the maintenance script verifies and stops the selected distribution before sparse conversion and below-floor compaction", () => {
  const script = renderSparseMaintenanceScript(base);
  assert.match(script, /THIS SCRIPT STOPS THE SELECTED WSL DISTRIBUTION/);
  assert.match(script, /\*\*\* THIS STOPS THE SELECTED WSL DISTRIBUTION\. \*\*\*/);
  assert.match(script, /Press Ctrl\+C within 10 seconds to cancel\./);
  // The desktop script's verification: registration, distro name, exact VHDX path, and the file itself.
  assert.ok(script.includes(`$base = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\${GUID}'`));
  assert.ok(script.includes(`$expectedVhd = 'C:\\Users\\emsen\\AppData\\Local\\wsl\\${GUID}\\ext4.vhdx'`));
  assert.match(script, /\$registered\.DistributionName -cne \$distro/);
  assert.ok(script.includes(String.raw`$vhd = $vhd -replace '^\\\\\?\\', ''`));
  assert.match(script, /if \(\$vhd -ine \$expectedVhd\) \{ throw/);
  assert.match(script, /Test-Path -LiteralPath \$vhd -PathType Leaf/);
  // Native sparse conversion refuses a running distribution. Receive the selected
  // stop before entering either offline operation; the outer finally restarts it.
  assert.ok(script.includes("$wsl = 'C:\\Program Files\\WSL\\wsl.exe'"));
  assert.match(script, /\$result\.stopExitCode = Invoke-Wsl @\('--terminate', \$distro\)/);
  assert.match(script, /catch \{ \$result\.stopExitCode=\$_\.Exception\.Data\['ExitCode'\]; \$result\.stopError=\$_\.Exception\.Message; throw \}/);
  assert.ok(script.indexOf("Invoke-Wsl @('--terminate', $distro)") < script.indexOf("$arguments = @('--manage'"));
  assert.match(script, /\$arguments = @\('--manage', \$distro, '--set-sparse', 'true'\)/);
  assert.match(script, /\$minFreeBytes = \[double\]100000000000\n\$minFreePercent = \[double\]3\n/);
  assert.match(script, /\$needSparse = -not \$isSparse/);
  assert.doesNotMatch(script, /diskpart|compact vdisk|RunAs|IsInRole/i);
});

test("the script is plain ASCII, because Windows PowerShell 5.1 reads an unmarked script as ANSI", () => {
  assert.match(renderSparseMaintenanceScript(base), /^[\x09\x0a\x20-\x7e]+$/);
  assert.throws(() => renderSparseMaintenanceScript({ ...base, windows: { ...base.windows, backingStorage: { ...backingStorage, basePath: "C:\\Users\\émsen\\wsl" } } }), /printable ASCII/);
});

test("sparse conversion refuses while a relauncher runs, retries a restarted distribution and trims after", () => {
  const script = renderSparseMaintenanceScript(base);
  assert.match(script, /\$relaunchers = @\('ChatGPT\.exe', 'Docker Desktop\.exe'\)/);
  // The 2026-10-26 attempts lost the race: an app restarted Ubuntu between --shutdown and --set-sparse.
  const refusal = script.indexOf("throw ('Refusing to stop"), banner = script.indexOf("THIS STOPS THE SELECTED WSL DISTRIBUTION. ***");
  assert.ok(refusal > 0 && refusal < banner, "a running relauncher refuses before anything is stopped");
  assert.match(script, /PlanOnly: not ready; nothing was changed\.'; exit 3/);
  assert.match(script, /for \(\$attempt = 1; \$attempt -le \$conversionAttempts; \$attempt\+\+\)/);
  assert.match(script, /\$conversionAttempts = 5/);
  assert.match(script, /'WSL_E_DISTRO_NOT_STOPPED'/);
  assert.match(script, /relaunchedBy=@\(Get-WslClients\)/);
  assert.match(script, /'-u', 'root', '--exec', '\/usr\/sbin\/fstrim', '-v', '\/'/);
  assert.match(script, /GetCompressedFileSizeW/);
  assert.match(renderSparseMaintenanceScript(withSparse({ trimAfterConversion: false })), /\$trimAfterConversion = \$false/);
  assert.match(renderSparseMaintenanceScript(withSparse({ relaunchers: [] })), /\$relaunchers = @\(\)/);
  for (const bad of [{ relaunchers: "ChatGPT.exe" }, { relaunchers: ["ChatGPT"] }, { relaunchers: ["a;b.exe"] }, { conversionAttempts: 0 },
    { conversionAttempts: 11 }, { conversionAttempts: 2.5 }, { trimAfterConversion: "yes" }])
    assert.throws(() => renderSparseMaintenanceScript(withSparse(bad)), /relaunchers|conversionAttempts|trimAfterConversion/, JSON.stringify(bad));
});

test("unsafe sparse conversion is passed to WSL only when the record says so, and policy flags follow the record", () => {
  assert.match(renderSparseMaintenanceScript(withSparse({ allowUnsafe: true })), /\$allowUnsafe = \$true/);
  assert.match(renderSparseMaintenanceScript(base), /\$allowUnsafe = \$false/);
  assert.doesNotMatch(renderSparseMaintenanceScript(base), /--compact|needCompact|compactBelowFloor/);
  assert.throws(() => renderSparseMaintenanceScript(withSparse({ compactWhenBelowFloor: true })), /compactWhenBelowFloor/);
  assert.match(renderSparseMaintenanceScript(withSparse({ wslExecutable: "wsl.exe" })), /\$wsl = 'wsl\.exe'/);
});

test("quotes in record values cannot leave their PowerShell string", () => {
  const bad = { ...base, windows: { ...base.windows, backingStorage: { ...backingStorage, basePath: "C:\\Users\\o'brien\\wsl" } } };
  assert.ok(renderSparseMaintenanceScript(bad).includes("$expectedVhd = 'C:\\Users\\o''brien\\wsl\\ext4.vhdx'"));
});

test("the Windows maintenance file is the sparse script when declared, and the effect-free refusal otherwise", () => {
  const rendered = renderFiles(base).find((f) => f.path.endsWith("wsl-compact-disk.ps1"));
  assert.equal(rendered.content, renderSparseMaintenanceScript(base));
  assert.equal(rendered.scope, "windows");
  const undeclared = { ...base, windows: { ...base.windows, backingStorage: { ...backingStorage, sparse: undefined } } };
  assert.match(renderCompactScript(undeclared), /^throw 'WSL compaction refused:/m);
  assert.equal(renderSparseMaintenanceScript(undeclared), null);
});

test("a malformed sparse declaration refuses rather than rendering a partial script", () => {
  for (const bad of [{ want: false }, { wslExecutable: "wsl.exe; calc" }, { wslExecutable: "C:\\..\\wsl.exe" }, { allowUnsafe: "no" }, { maxSlackBytes: "-1" }, { basis: "" }])
    assert.throws(() => renderFiles(withSparse(bad)), /sparse/, JSON.stringify(bad));
  assert.throws(() => renderFiles(withSparse({ compactWhenBelowFloor: true })), /compactWhenBelowFloor/);
  assert.throws(() => renderSparseMaintenanceScript({ ...base, windows: { ...base.windows, backingStorage: { ...backingStorage, registryKey: "HKCU:\\Software\\x" } } }), /registry key/);
});

// (c) the plan shows sparse state and VHDX allocation against ext4 use

const GiB = 2n ** 30n;
const capacity = (vhd) => ({ type: "WslBackingVolumeCapacity", volumes: [{ id: "v", vhd }] });
const vhd = (sparseState, allocatedGiB) => ({ sparse: sparseState, allocatedBytes: String(allocatedGiB * GiB), lengthBytes: String(1007n * GiB) });

test("plan reports a non-sparse disk and its accounting difference, as the 2026-10-25 incident looked", () => {
  const [sparseCheck, slackCheck] = assessBackingReclaim(base, capacity(vhd(false, 580n)), 436n * GiB);
  assert.equal(sparseCheck.ok, false);
  assert.equal(sparseCheck.hook, "windows-maintenance");
  assert.match(sparseCheck.have, /NOT sparse/);
  assert.equal(slackCheck.ok, false);
  assert.equal(slackCheck.have, "VHDX 580.0 GiB allocated on Windows, ext4 436.0 GiB used, accounting difference 144.0 GiB");
  assert.match(slackCheck.want, /at most 50\.0 GiB above ext4 used bytes/);
});

test("plan is quiet when the disk is sparse and its allocation tracks ext4 use", () => {
  const checks = assessBackingReclaim(base, capacity(vhd(true, 450n)), 436n * GiB);
  assert.deepEqual(checks.map((c) => c.ok), [true, true]);
  assert.match(checks[0].have, /^sparse$/);
  // Allocation below use (a sparse disk with trimmed metadata) is never drift.
  assert.equal(assessBackingReclaim(base, capacity(vhd(true, 400n)), 436n * GiB)[1].ok, true);
  // A sparse disk still drifts when the daily trim stops freeing: the tolerance is the record's.
  assert.equal(assessBackingReclaim(base, capacity(vhd(true, 500n)), 436n * GiB)[1].ok, false);
});

test("plan reports nothing about reclaim when the record declares no sparse disk", () => {
  const undeclared = { ...base, windows: { ...base.windows, backingStorage: { ...backingStorage, sparse: undefined } } };
  assert.deepEqual(assessBackingReclaim(undeclared, capacity(vhd(false, 580n)), 436n * GiB), []);
});

test("ext4 used bytes come from statfs on the declared mount, never a directory walk", () => {
  const seen = [];
  const used = guestUsedBytes("/", { statfs: (path, options) => { seen.push([path, options]); return { blocks: 1000n, bfree: 400n, bsize: 4096n }; } });
  assert.equal(used, 600n * 4096n);
  assert.deepEqual(seen, [["/", { bigint: true }]]);
  assert.ok(guestUsedBytes("/") > 0n);
});

test("a failing sparse check provides no executable command, only a held notice", () => {
  const steps = windowsInstruction([], base, assessBackingReclaim(base, capacity(vhd(false, 580n)), 436n * GiB));
  assert.equal(steps, null);
  assert.equal(windowsInstruction([], base, assessBackingReclaim(base, capacity(vhd(true, 440n)), 436n * GiB)), null);
});

test("rendering the sparse script prints the owner's one command, and the refusal for other records prints none", (t) => {
  const absent = () => null;
  const drift = planFiles(renderFiles(base), absent);
  const script = drift.find((f) => f.path.endsWith("wsl-compact-disk.ps1"));
  assert.deepEqual(script.hooks, ["windows-maintenance"]);
  const steps = windowsInstruction(drift, base);
  assert.deepEqual(steps, [
    "In an elevated PowerShell: powershell -ExecutionPolicy Bypass -File C:\\u\\wsl-defender-exclusions.ps1",
    "To make the WSL settings take effect, from Windows: wsl.exe --shutdown"
  ]);
  // The hook only names the step; applying runs no command for it.
  const tmpDir = mkdtempSync(join(tmpdir(), "wsl-ps1-"));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
  const applied = applyPlan([{ ...script, path: join(tmpDir, "wsl-compact-disk.ps1"), state: "absent" }], { stamp: "t", run: () => assert.fail("no command may run") });
  assert.deepEqual(applied.ran, []);
  const undeclared = { ...base, windows: { ...base.windows, backingStorage: { ...backingStorage, sparse: undefined } } };
  const refusal = planFiles(renderFiles(undeclared), absent).find((f) => f.path.endsWith("wsl-compact-disk.ps1"));
  assert.deepEqual(refusal.hooks, []);
  assert.equal(windowsInstruction(planFiles(renderFiles(undeclared), absent), undeclared)?.some((s) => s.includes("wsl-compact-disk")) ?? false, false);
});

