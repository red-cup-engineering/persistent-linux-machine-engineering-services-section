import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan, bytes, liveReloadHooks, memoryBudget, observeLive, planFiles, renderFiles, renderCompactScript, renderHeadroomGuardUnit, renderIni, renderPagefileScript, renderSysctl, renderBlockQueueUnit, renderUdev, renderZramSwapUnit } from "../src/wsl-host.mjs";

test("the headroom guard takes a page-cache ceiling only when the record sets one (WSL-20)", () => {
  const g = { description: "d", minOrder7Blocks: 32, intervalSeconds: 5, dropCachesWhenShort: true };
  assert.match(renderHeadroomGuardUnit(g), /ExecStart=\/usr\/local\/sbin\/wsl-hvsock-headroom-guard 32 5 yes\n/);
  assert.match(renderHeadroomGuardUnit({ ...g, maxCacheMiB: 3072, minSecondsBetweenCacheDrops: 60 }), /ExecStart=\/usr\/local\/sbin\/wsl-hvsock-headroom-guard 32 5 yes 3072 60\n/);
});

test("the headroom guard passes its reclaim cgroups in record order (WSL-22)", () => {
  const g = { description: "d", minOrder7Blocks: 32, intervalSeconds: 5, dropCachesWhenShort: true, maxCacheMiB: 3072, minSecondsBetweenCacheDrops: 60 };
  assert.match(renderHeadroomGuardUnit({ ...g, reclaimCgroups: ["user.slice/a.slice", "user.slice", "non-systemd"] }), /guard 32 5 yes 3072 60 user\.slice\/a\.slice:user\.slice:non-systemd\n/);
  assert.match(renderHeadroomGuardUnit({ ...g, reclaimCgroups: [] }), /guard 32 5 yes 3072 60\n/);
});

test("a system-managed pagefile hands sizing back to Windows and removes no setting by hand (WSL-19)", () => {
  const s = renderPagefileScript({ mode: "system" });
  assert.match(s, /AutomaticManagedPagefile = \$true/);
  assert.doesNotMatch(s, /Remove-CimInstance|New-CimInstance/);
  assert.match(renderPagefileScript({ mode: "fixed", path: "C:\\pagefile.sys", megabytes: 4096 }), /InitialSize = 4096; MaximumSize = 4096/);
});

const params = {
  schema: "wsl-host-parameters@1",
  windows: {
    profileMount: "/win", profileWindowsPath: "C:\\u",
    wslConfig: { sections: [{ name: "wsl2", entries: [{ key: "memory", value: "6GB" }, { key: "kernelCommandLine", value: "swiotlb=131072" }] }] },
    defender: { paths: ["C:\\a"], processes: ["vmmem"], resultFile: "C:\\r.txt" },
    pagefile: { mode: "none" },
  },
  linux: {
    wslConf: { sections: [{ name: "boot", entries: [{ key: "systemd", value: "true" }] }] },
    sysctl: [{ file: "93.conf", entries: [{ key: "vm.swappiness", value: 10 }] }],
    blockQueue: { file: "60.rules", kernel: "sd[a-z]", attributes: { nr_requests: 256 } },
    agentLimits: { description: "d", defaults: { entries: [{ key: "PIDS_MAX", value: "4096" }] } },
    relayReaper: { description: "r", minAgeSeconds: 600, minFreeRings: 64, bootDelayMinutes: 15, intervalMinutes: 5 },
  },
};

test("renderers", () => {
  assert.equal(renderIni([{ name: "a", entries: [{ comment: ["why"], key: "k", value: 1 }] }]), "[a]\n# why\nk=1\n");
  assert.equal(renderSysctl({ entries: [{ key: "a.b", value: 1 }] }), "a.b = 1\n");
  assert.match(renderUdev(params.linux.blockQueue), /KERNEL=="sd\[a-z\]", ATTR\{queue\/nr_requests\}="256"/);
});

test("apply is idempotent and keeps a backup of a replaced Windows file", () => {
  const root = mkdtempSync(join(tmpdir(), "wsl-host-"));
  const files = renderFiles(params, root);
  const first = applyPlan(planFiles(files), { stamp: "t", staged: true });
  assert.equal(first.written.length, files.length);
  const second = applyPlan(planFiles(files), { stamp: "t", staged: true });
  assert.deepEqual(second.written, []);
  const cfg = files.find((f) => f.path.endsWith(".wslconfig"));
  const changed = renderFiles({ ...params, windows: { ...params.windows, wslConfig: { sections: [{ name: "wsl2", entries: [{ key: "memory", value: "8GB" }] }] } } }, root);
  applyPlan(planFiles(changed), { stamp: "t", staged: true });
  assert.match(readFileSync(`${cfg.path}.t-before-wsl-host-service`, "utf8"), /memory=6GB/);
});

test("boot waits on neither the block-queue re-send nor emptying /tmp (WSL-139)", () => {
  const unit = renderBlockQueueUnit();
  assert.match(unit, /^Type=exec$/m);
  assert.equal(unit.match(/^ExecStart=/gm).length, 1);
  assert.ok(!renderFiles(params).some((f) => f.path.startsWith("/etc/tmpfiles.d/") || f.path.includes("wsl-tmp-age")));
  const files = renderFiles({ ...params, linux: { ...params.linux, bootTmp: { file: "tmp.conf", age: "3d", cleanAfterBoot: "15min", cleanEvery: "1d" } } });
  const at = (path) => files.find((f) => f.path === path);
  assert.equal(at("/etc/tmpfiles.d/tmp.conf").content.split("\n")[1], "d /tmp 1777 root root 3d");
  assert.match(at("/etc/systemd/system/wsl-tmp-age.service").content, /^ExecStart=\/usr\/bin\/systemd-tmpfiles --clean \/etc\/tmpfiles\.d\/tmp\.conf$/m);
  assert.match(at("/etc/systemd/system/wsl-tmp-age.timer").content, /^OnBootSec=15min\nOnUnitActiveSec=1d$/m);
  assert.deepEqual(at("/etc/systemd/system/wsl-tmp-age.timer").hooks, ["boot-tmp"]);
});

test("the headroom guard renders only when the record declares it, with its floor, interval and cache step", () => {
  const without = renderFiles(params).map((f) => f.path);
  assert.ok(!without.some((p) => p.includes("headroom-guard")));
  const guarded = { ...params, linux: { ...params.linux, headroomGuard: { description: "g", minOrder7Blocks: 32, intervalSeconds: 5, dropCachesWhenShort: true } } };
  const files = renderFiles(guarded);
  const unit = files.find((f) => f.path === "/etc/systemd/system/wsl-hvsock-headroom-guard.service");
  assert.match(unit.content, /ExecStart=\/usr\/local\/sbin\/wsl-hvsock-headroom-guard 32 5 yes/);
  assert.match(unit.content, /Restart=always/);
  const script = files.find((f) => f.path === "/usr/local/sbin/wsl-hvsock-headroom-guard");
  assert.equal(script.mode, 0o755);
  assert.ok(script.hooks.includes("headroom-guard"));
});

const budgeted = (agentHigh, units) => ({
  ...params,
  linux: {
    ...params.linux,
    agentLimits: { description: "d", defaults: { entries: [{ key: "MEMORY_HIGH", value: agentHigh }, { key: "MEMORY_MAX", value: "4608M" }] } },
    memoryBudget: { kernelHeadroom: "2G", units },
  },
});
const units = [
  { unit: "user.slice", cgroup: "user.slice", high: "1G", max: "2G" },
  { unit: "guix-daemon.service", cgroup: "system.slice/guix-daemon.service", high: "512M", max: "2G" },
];

test("sizes read as systemd and .wslconfig write them", () => {
  assert.equal(bytes("4608M"), 4608 * 2 ** 20);
  assert.equal(bytes("4G"), 4 * 2 ** 30);
  assert.equal(bytes("6GB"), 6 * 2 ** 30);
  assert.throws(() => bytes("lots"), /unreadable size/);
});

test("the memory budget bounds every systemd unit it names and leaves the kernel its headroom", () => {
  const ok = budgeted("2560M", units);
  assert.equal(memoryBudget(ok).highs, 2560 * 2 ** 20 + 2 ** 30 + 512 * 2 ** 20);
  const dropIns = renderFiles(ok).filter((f) => f.path.endsWith("90-wsl-host-memory.conf"));
  assert.deepEqual(dropIns.map((f) => f.path), ["/etc/systemd/system/user.slice.d/90-wsl-host-memory.conf", "/etc/systemd/system/guix-daemon.service.d/90-wsl-host-memory.conf"]);
  assert.match(dropIns[0].content, /\[Slice\]\nMemoryHigh=1G\nMemoryMax=2G/);
  assert.match(dropIns[1].content, /\[Service\]\nMemoryHigh=512M\nMemoryMax=2G/);
  assert.ok(dropIns.every((f) => f.hooks.includes("memory-budget")));
  // 6GB VM less 2G headroom leaves 4G of high-water marks; 3G of agents plus 1.5G overruns it.
  assert.throws(() => renderFiles(budgeted("3G", units)), /memory budget: high-water marks sum/);
  assert.equal(renderFiles(params).filter((f) => f.path.endsWith("90-wsl-host-memory.conf")).length, 0);
});

const zram = { description: "z", disksize: "2G", memLimit: "512M", algorithm: "lzo-rle", priority: 100 };

test("a declared compressed swap device renders its helper and unit, and counts its pool in the budget (WSL-21)", () => {
  assert.equal(renderFiles(params).filter((f) => f.path.includes("zram")).length, 0);
  const z = { ...budgeted("2G", units), linux: { ...budgeted("2G", units).linux, zramSwap: zram } };
  const files = renderFiles(z);
  const unit = files.find((f) => f.path === "/etc/systemd/system/wsl-zram-swap.service");
  assert.match(unit.content, /ExecStart=\/usr\/local\/sbin\/wsl-zram-swap 2G 512M lzo-rle 100\n/);
  assert.match(renderZramSwapUnit(zram), /RemainAfterExit=yes/);
  const helper = files.find((f) => f.path === "/usr/local/sbin/wsl-zram-swap");
  assert.equal(helper.mode, 0o755);
  assert.match(helper.content, /swapon -p "\$prio" \/dev\/zram0/);
  assert.ok(unit.hooks.includes("zram-swap") && helper.hooks.includes("zram-swap"));
  assert.equal(memoryBudget(z).zram, 512 * 2 ** 20);
  assert.equal(memoryBudget(z).highs, 2 * 2 ** 30 + 2 ** 30 + 512 * 2 ** 20 + 512 * 2 ** 20);
  // 6GB VM less 2G headroom leaves 4G: 2.5G of agents, 1.5G of units and the pool overrun it.
  const over = { ...budgeted("2560M", units), linux: { ...budgeted("2560M", units).linux, zramSwap: zram } };
  assert.throws(() => renderFiles(over), /high-water marks and the zram pool sum/);
});

test("the live check reports the compressed swap device and its priority (WSL-21)", () => {
  const z = { ...params, linux: { ...params.linux, zramSwap: zram } };
  const swaps = (s) => ({ read: (p) => (p === "/proc/swaps" ? s : null), list: () => [] });
  const header = "Filename Type Size Used Priority\n/dev/sdc partition 3145728 0 -2";
  const off = observeLive(z, swaps(header)).find((c) => c.name === "zram0 swap");
  assert.equal(off.ok, false);
  assert.deepEqual(liveReloadHooks([off]), ["zram-swap"]);
  const on = observeLive(z, swaps(`${header}\n/dev/zram0 partition 2097148 0 100`)).find((c) => c.name === "zram0 swap");
  assert.equal(on.ok, true);
  assert.equal(observeLive(params, swaps(header)).some((c) => c.name === "zram0 swap"), false);
});

test("the live check reads each budgeted cgroup's high and max", () => {
  const live = { "/sys/fs/cgroup/non-systemd/memory.high": String(2560 * 2 ** 20), "/sys/fs/cgroup/user.slice/memory.high": "max" };
  const checks = observeLive(budgeted("2560M", units), { read: (p) => live[p] ?? null, list: () => [] });
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.equal(byName["non-systemd agents memory.high"].ok, true);
  assert.equal(byName["user.slice memory.high"].ok, false);
  assert.equal(byName["guix-daemon.service memory.max"].want, String(2 * 2 ** 30));
});


test("a record without a sparse disk declaration renders only a terminating refusal, never a distribution or disk operation", () => {
  const script = renderCompactScript();
  assert.match(script, /^throw 'WSL compaction refused:/m);
  assert.doesNotMatch(script, /wsl(?:\.exe)?\s+--|Get-ChildItem|diskpart|compact vdisk|set-sparse|Start-Process/i);
  assert.equal(renderFiles(params).find(f => f.path.endsWith('wsl-compact-disk.ps1')).content, script);
});

const sshd = { unit: "bare-cedar-fog-sshd.service", scope: "user", user: "emsenn", within: "user.slice", cgroup: "user.slice/user-1000.slice/user@1000.service/app.slice/bare-cedar-fog-sshd.service", high: "512M", max: "768M", oomPolicy: "continue" };

test("a user-manager unit within a budgeted group is bounded in its own drop-in, reloaded in its own manager, and is not a second share (WSL-88)", () => {
  const nested = budgeted("2560M", [...units, sshd]);
  assert.equal(memoryBudget(nested).highs, memoryBudget(budgeted("2560M", units)).highs, "a unit within user.slice adds nothing to the sum");
  const drop = renderFiles(nested).find((f) => f.path.includes("bare-cedar-fog-sshd"));
  assert.equal(drop.path, "/etc/systemd/user/bare-cedar-fog-sshd.service.d/90-wsl-host-memory.conf");
  assert.match(drop.content, /\[Service\]\nMemoryHigh=512M\nMemoryMax=768M\nOOMPolicy=continue\n/);
  assert.deepEqual(drop.hooks, ["user-manager-reload:emsenn"]);
  // user.slice is 1G high / 2G max in `units`: a child may not be given more than its parent has.
  assert.throws(() => memoryBudget(budgeted("2560M", [...units, { ...sshd, high: "2G" }])), /does not fit within user\.slice/);
  assert.throws(() => memoryBudget(budgeted("2560M", [...units, { ...sshd, within: "nowhere.slice" }])), /not a group of the budget/);
  assert.throws(() => renderFiles(budgeted("2560M", [...units, { ...sshd, user: "" }])), /needs the login/);
});

test("a drifted user-manager unit ceiling is repaired by reloading that user's manager only (WSL-88)", () => {
  const nested = budgeted("2560M", [...units, sshd]);
  const sys = { read: (p) => (p.includes("bare-cedar-fog-sshd") ? "max" : null), list: () => [] };
  const checks = observeLive(nested, sys).filter((c) => c.name.startsWith("bare-cedar-fog-sshd"));
  assert.deepEqual(checks.map((c) => [c.name, c.want, c.ok, c.hook]), [
    ["bare-cedar-fog-sshd.service memory.high", String(512 * 2 ** 20), false, "user-manager-reload:emsenn"],
    ["bare-cedar-fog-sshd.service memory.max", String(768 * 2 ** 20), false, "user-manager-reload:emsenn"]]);
  assert.deepEqual(liveReloadHooks(checks), ["user-manager-reload:emsenn"]);
  const ran = [];
  applyPlan([], { stamp: "t", run: (c) => ran.push(c), live: checks });
  assert.deepEqual(ran, [["systemctl", "--user", "--machine=emsenn@.host", "daemon-reload"]]);
});
