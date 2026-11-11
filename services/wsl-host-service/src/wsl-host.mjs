import { renderManagedTimerFiles } from './managed-timers.mjs';
import { observeTrimTimer, renderTrimUnits, systemdUnitState, TRIM_TIMER } from './trim-timer.mjs';
import { renderSparseMaintenanceScript, sparseDisk } from './sparse-disk.mjs';
// WSL2 host engineering: render a host's configuration from one parameter record, observe the
// host, and report or repair the difference. Pure functions plus a thin filesystem edge.
// Node built-ins only: this must run when nothing else (no MetroPlat, no package install,
// no network) is up. Parameters are data and carry every particular; nothing here names a host.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export { observeBackingVolumeCapacity, validateBackingStorage, assessBackingVolumeHeadroom } from './backing-capacity.mjs';
export { assessBackingReclaim, guestUsedBytes, renderSparseMaintenanceScript, sparseDisk } from './sparse-disk.mjs';
export { observeTrimTimer, renderTrimUnits, systemdUnitState, trimTimerDeclaration } from './trim-timer.mjs';

export const PARAMETER_SCHEMA = "wsl-host-parameters@1";
const assetDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

const commentLines = (c) => (c ?? []).map((l) => (l === "" ? "#" : `# ${l}`));

/** Renders [{name, entries:[{key,value,comment?}]}] as an ini file (wsl.conf, .wslconfig). */
export function renderIni(sections) {
  const out = [];
  sections.forEach((section, i) => {
    if (i) out.push("");
    out.push(`[${section.name}]`);
    for (const e of section.entries) out.push(...commentLines(e.comment), `${e.key}=${e.value}`);
  });
  return out.join("\n") + "\n";
}

/** Renders a sysctl.d file; `compact` writes key=value, otherwise key = value. */
export function renderSysctl(file) {
  const eq = file.compact ? "=" : " = ";
  return [...commentLines(file.comment), ...file.entries.map((e) => `${e.key}${eq}${e.value}`)].join("\n") + "\n";
}

/** Renders one udev rule that sets block-queue attributes on matching disks. */
export function renderUdev(block) {
  const attrs = Object.entries(block.attributes).map(([k, v]) => `ATTR{queue/${k}}="${v}"`);
  const rule = [`ACTION=="add|change"`, `SUBSYSTEM=="block"`, `KERNEL=="${block.kernel}"`, ...attrs].join(", ");
  return [...commentLines(block.comment), rule].join("\n") + "\n";
}

/** Renders the shell-sourced defaults file read by the agent-limits script. */
export function renderEnv(env) {
  const out = [];
  for (const e of env.entries) out.push(...commentLines(e.comment), `${e.key}=${e.value}`);
  return out.join("\n") + "\n";
}

export function renderReaperUnits(r) {
  return {
    service: `[Unit]\nDescription=${r.description}\n\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/wsl-orphan-relay-reaper ${r.minAgeSeconds} ${r.minFreeRings}\n`,
    timer: `[Unit]\nDescription=${r.description} every ${r.intervalMinutes} minutes\n\n[Timer]\nOnBootSec=${r.bootDelayMinutes}min\nOnUnitInactiveSec=${r.intervalMinutes}min\n\n[Install]\nWantedBy=timers.target\n`,
  };
}

/**
 * The udev rule alone is not enough: at boot the kernel still holds the disks, and udev's write of
 * queue/nr_requests fails with "Device or resource busy" (measured 2026-10-09 on every boot-time disk
 * but the late-attached swap disk). A change event after boot succeeds, so this unit sends one.
 */
export function renderBlockQueueUnit() {
  return [
    "[Unit]",
    "Description=Re-apply block-queue limits after boot, when udev's boot-time write was refused as busy",
    "After=local-fs.target systemd-udevd.service",
    "",
    "[Service]",
    // exec, not oneshot: multi-user.target waits out a oneshot's whole run, and its 20 s pause held boot that long
    // (measured 2026-10-31). Nothing orders after these limits, so boot need not wait for them.
    "Type=exec",
    "RemainAfterExit=yes",
    // A disk still busy at the first event (measured: the 700 MB system disk) takes the second.
    "ExecStart=/bin/sh -c '/usr/bin/udevadm trigger --subsystem-match=block --action=change --settle; /bin/sleep 20; exec /usr/bin/udevadm trigger --subsystem-match=block --action=change --settle'",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/**
 * /tmp is a directory on the root VHDX, and Ubuntu's tmp.conf (`D /tmp`) empties it inside systemd-tmpfiles-setup,
 * which sysinit.target, and so logind, the lingering user manager and the SSH entry, wait for (94 s of a 117 s boot,
 * 2026-10-31). A file of the same name in /etc/tmpfiles.d replaces it, so /tmp ages out in systemd-tmpfiles-clean's
 * background pass instead.
 */
export function renderBootTmp(t) {
  return ["# Rendered by wsl-host-service from linux.bootTmp: age /tmp, do not empty it at boot.", `d /tmp 1777 root root ${t.age}`, ""].join("\n");
}

/** This Ubuntu image ships systemd-tmpfiles-clean.service without its timer, so nothing else ages /tmp once boot stops emptying it. */
export function renderTmpAgeService(t) {
  return [
    "[Unit]",
    `Description=Remove /tmp entries older than ${t.age} (linux.bootTmp), at idle priority`,
    "Documentation=man:systemd-tmpfiles(8)",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=/usr/bin/systemd-tmpfiles --clean /etc/tmpfiles.d/${t.file}`,
    "Nice=19",
    "IOSchedulingClass=idle",
    "",
  ].join("\n");
}

export function renderTmpAgeTimer(t) {
  return [
    "[Unit]",
    "Description=Age /tmp out shortly after boot and then daily (linux.bootTmp)",
    "",
    "[Timer]",
    `OnBootSec=${t.cleanAfterBoot}`,
    `OnUnitActiveSec=${t.cleanEvery}`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

/** A resident watcher that compacts when free order-7 blocks fall below the floor (hv_sock rings). */
export function renderHeadroomGuardUnit(g) {
  return [
    "[Unit]",
    `Description=${g.description}`,
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=/usr/local/sbin/wsl-hvsock-headroom-guard ${g.minOrder7Blocks} ${g.intervalSeconds} ${g.dropCachesWhenShort ? "yes" : "no"}` +
      (g.maxCacheMiB ? ` ${g.maxCacheMiB} ${g.minSecondsBetweenCacheDrops ?? 60}` + (g.reclaimCgroups?.length ? ` ${g.reclaimCgroups.join(":")}` : "") : ""),
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** WSL-21: a boot-time oneshot that creates the in-memory compressed swap device above the disk swap. */
export function renderZramSwapUnit(z) {
  return [
    "[Unit]",
    `Description=${z.description}`,
    "After=local-fs.target",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `ExecStart=/usr/local/sbin/wsl-zram-swap ${z.disksize} ${z.memLimit} ${z.algorithm} ${z.priority}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function renderAgentLimitsUnits(a) {
  return {
    path: `[Unit]\nDescription=Apply agent ceilings as soon as WSL creates its non-systemd cgroup\n\n[Path]\nPathExists=/sys/fs/cgroup/non-systemd\n\n[Install]\nWantedBy=paths.target\n`,
    service: `[Unit]\nDescription=${a.description}\nConditionPathIsDirectory=/sys/fs/cgroup/non-systemd\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/local/sbin/wsl-agent-limits\n`,
  };
}

const SIZE_UNITS = { "": 0, K: 1, M: 2, G: 3 };
/** Bytes of a size as systemd, the agent-limits file and .wslconfig write it (4608M, 4G, 8GB). */
export function bytes(size) {
  const m = /^(\d+(?:\.\d+)?)([KMG]?)B?$/.exec(String(size));
  if (!m) throw new Error(`unreadable size ${size}`);
  return Math.round(Number(m[1]) * 1024 ** SIZE_UNITS[m[2]]);
}

/**
 * The VM's memory budget. hv_sock rings need order-7 (512 KiB) contiguous blocks, which compaction can
 * assemble only while memory is free; so every consumer's high-water mark, summed, must leave the kernel
 * its headroom. The VM size is .wslconfig's `memory`, the non-systemd agents' marks are agentLimits', and
 * each systemd unit in `units` takes a drop-in. Throws when the marks overrun the VM. null without a budget.
 */
export function memoryBudget(params) {
  const b = params.linux.memoryBudget;
  if (!b) return null;
  const vm = bytes(params.windows.wslConfig.sections.flatMap((s) => s.entries).find((e) => e.key === "memory")?.value);
  const agent = Object.fromEntries(params.linux.agentLimits.defaults.entries.map((e) => [e.key, e.value]));
  const groups = [{ name: "non-systemd agents", cgroup: "non-systemd", high: agent.MEMORY_HIGH, max: agent.MEMORY_MAX }, ...b.units.map((u) => ({ name: u.unit, cgroup: u.cgroup, high: u.high, max: u.max, ...(u.within ? { within: u.within } : {}), ...(u.scope === "user" ? { user: userName(u) } : {}) }))];
  // A unit `within` another group is bounded by that group's share and is not a share of its own: it must fit inside it.
  for (const g of groups.filter((x) => x.within)) {
    const parent = groups.find((x) => x.cgroup === g.within && !x.within);
    if (!parent) throw new Error(`memory budget: ${g.name} is within ${g.within}, which is not a group of the budget`);
    if (bytes(g.high) > bytes(parent.high) || bytes(g.max) > bytes(parent.max)) throw new Error(`memory budget: ${g.name} (high ${g.high}, max ${g.max}) does not fit within ${parent.name} (high ${parent.high}, max ${parent.max})`);
  }
  // WSL-21: the compressed swap pool is memory no cgroup is charged for, so its limit is a mark of its own.
  const zram = params.linux.zramSwap ? bytes(params.linux.zramSwap.memLimit) : 0;
  const highs = groups.filter((g) => !g.within).reduce((sum, g) => sum + bytes(g.high), 0) + zram, limit = vm - bytes(b.kernelHeadroom);
  if (highs > limit) throw new Error(`memory budget: high-water marks${zram ? " and the zram pool" : ""} sum to ${highs} bytes, above the ${limit} the VM leaves after ${b.kernelHeadroom} of kernel headroom`);
  return { vm, limit, highs, groups, zram };
}

/** The login the user manager of a `scope: "user"` unit belongs to. */
function userName(u) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(u.user ?? "")) throw new Error(`memory budget: ${u.unit} is a user-manager unit and needs the login of its manager in "user"`);
  return u.user;
}

/**
 * A systemd drop-in that bounds one slice or service. `oomPolicy` (services) says what systemd does when the kernel
 * kills a process at MemoryMax: systemd's default, "stop", would stop the whole unit, every process of it.
 */
export function renderMemoryDropIn(u) {
  const service = !u.unit.endsWith(".slice");
  return [...commentLines(u.comment), `[${service ? "Service" : "Slice"}]`, `MemoryHigh=${u.high}`, `MemoryMax=${u.max}`, ...(service && u.oomPolicy ? [`OOMPolicy=${u.oomPolicy}`] : []), ""].join("\n");
}

const psList = (xs) => xs.map((x) => `'${x}'`).join(",");

export function renderDefenderScript(d) {
  return [
    `Add-MpPreference -ExclusionPath ${psList(d.paths)}`,
    `Add-MpPreference -ExclusionProcess ${psList(d.processes)}`,
    `Get-MpPreference | Select-Object ExclusionPath,ExclusionProcess | Format-List | Out-File '${d.resultFile}'`,
  ].join("\n") + "\n";
}

export function renderPagefileScript(p) {
  // WSL-19: Windows sizes the pagefile to commit demand, which on a host running a WSL VM beside desktop apps
  // exceeds physical memory (Bare Cedar Fog 2026-10-14: 35-40 GB committed on 23.3 GB of RAM).
  if (p.mode === "system") return `# Run from an elevated PowerShell; takes effect after a Windows restart.\n$cs = Get-CimInstance Win32_ComputerSystem\nSet-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $true }\n`;
  const head = `# Run from an elevated PowerShell; takes effect after a Windows restart.\n$cs = Get-CimInstance Win32_ComputerSystem\nSet-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $false }\nGet-CimInstance Win32_PageFileSetting | Remove-CimInstance\n`;
  if (p.mode === "none") return head;
  return head + `New-CimInstance -ClassName Win32_PageFileSetting -Property @{ Name = '${p.path}'; InitialSize = ${p.megabytes}; MaximumSize = ${p.megabytes} }\n`;
}

/**
 * The Windows maintenance script. A record that declares a sparse backing disk (WSL-87, WSL-88) gets the
 * owner-run script that makes the VHDX sparse; any other record keeps the effect-free refusal (WSL-46),
 * because the former wildcard/shutdown script was not an admitted maintenance operation.
 */
export function renderCompactScript(params) {
  const sparse = renderSparseMaintenanceScript(params);
  if (sparse) return sparse;
  return [
    "# Disk compaction requires the separately received scoped offline maintenance Resource.",
    "$ErrorActionPreference = 'Stop'",
    "throw 'WSL compaction refused: scoped maintenance admission, checkpoint and qualified native carrier are not received. No distribution or disk was changed.'",
    "",
  ].join("\n");
}

const asset = (name) => readFileSync(join(assetDir, name), "utf8");

/**
 * Every file the host needs, as {scope, path, content, mode, hooks}. `root` prefixes Linux
 * targets (for staging and tests); Windows targets are under params.windows.profileMount.
 */
export function renderFiles(params, root = "") {
  if (params.schema !== PARAMETER_SCHEMA) throw new Error(`parameters must declare schema ${PARAMETER_SCHEMA}`);
  const files = [];
  const linux = (path, content, mode, hooks = []) => files.push({ scope: "linux", path: root + path, content, mode, hooks });
  const L = params.linux, W = params.windows;

  linux("/etc/wsl.conf", renderIni(L.wslConf.sections), 0o644, ["wsl-restart"]);
  for (const f of L.sysctl) linux(`/etc/sysctl.d/${f.file}`, renderSysctl(f), 0o644, ["sysctl"]);
  linux(`/etc/udev/rules.d/${L.blockQueue.file}`, renderUdev(L.blockQueue), 0o644, ["udev"]);

  linux("/etc/systemd/system/wsl-block-queue.service", renderBlockQueueUnit(), 0o644, ["systemd"]);
  if (L.bootTmp) {
    linux(`/etc/tmpfiles.d/${L.bootTmp.file}`, renderBootTmp(L.bootTmp), 0o644);
    linux("/etc/systemd/system/wsl-tmp-age.service", renderTmpAgeService(L.bootTmp), 0o644, ["boot-tmp"]);
    linux("/etc/systemd/system/wsl-tmp-age.timer", renderTmpAgeTimer(L.bootTmp), 0o644, ["boot-tmp"]);
  }

  const a = L.agentLimits, lim = renderAgentLimitsUnits(a);
  linux("/etc/default/wsl-agent-limits", renderEnv(a.defaults), 0o644, ["agent-limits"]);
  linux("/usr/local/sbin/wsl-agent-limits", asset("wsl-agent-limits.sh"), 0o755, ["agent-limits"]);
  linux("/etc/systemd/system/wsl-agent-limits.path", lim.path, 0o644, ["systemd"]);
  linux("/etc/systemd/system/wsl-agent-limits.service", lim.service, 0o644, ["systemd", "agent-limits"]);

  if (memoryBudget(params))
    for (const u of L.memoryBudget.units) {
      // A unit of a user manager takes its drop-in beside the user units and a reload of that manager, not of the system's.
      if (u.scope === "user") linux(`/etc/systemd/user/${u.unit}.d/90-wsl-host-memory.conf`, renderMemoryDropIn(u), 0o644, [USER_RELOAD + userName(u)]);
      else linux(`/etc/systemd/system/${u.unit}.d/90-wsl-host-memory.conf`, renderMemoryDropIn(u), 0o644, ["memory-budget"]);
    }

  if (L.zramSwap) {
    linux("/usr/local/sbin/wsl-zram-swap", asset("wsl-zram-swap.sh"), 0o755, ["zram-swap"]);
    linux("/etc/systemd/system/wsl-zram-swap.service", renderZramSwapUnit(L.zramSwap), 0o644, ["zram-swap"]);
  }

  if (L.headroomGuard) {
    linux("/usr/local/sbin/wsl-hvsock-headroom-guard", asset("wsl-hvsock-headroom-guard.sh"), 0o755, ["headroom-guard"]);
    linux("/etc/systemd/system/wsl-hvsock-headroom-guard.service", renderHeadroomGuardUnit(L.headroomGuard), 0o644, ["systemd", "headroom-guard"]);
  }

  const r = L.relayReaper, units = renderReaperUnits(r);
  linux("/usr/local/sbin/wsl-orphan-relay-reaper", asset("wsl-orphan-relay-reaper.sh"), 0o755);
  linux("/etc/systemd/system/wsl-orphan-relay-reaper.service", units.service, 0o644, ["systemd"]);
  linux("/etc/systemd/system/wsl-orphan-relay-reaper.timer", units.timer, 0o644, ["systemd"]);

  if (L.trimTimer) {
    const trim = renderTrimUnits(L);
    linux("/etc/systemd/system/wsl-fstrim.service", trim.service, 0o644, ["trim-timer"]);
    linux("/etc/systemd/system/wsl-fstrim.timer", trim.timer, 0o644, ["trim-timer"]);
  }

  const win = (name, content, hooks = []) => files.push({ scope: "windows", path: join(root + W.profileMount, name), content, mode: 0o644, hooks });
  win(".wslconfig", renderIni(W.wslConfig.sections), ["wsl-restart"]);
  win("wsl-defender-exclusions.ps1", renderDefenderScript(W.defender), ["defender"]);
  if (W.pagefile) win("wsl-host-pagefile.ps1", renderPagefileScript(W.pagefile), ["windows-restart"]);
  // A rendered sparse-disk script is a Windows step the owner runs; the refusal for other records is not.
  win("wsl-compact-disk.ps1", renderCompactScript(params), sparseDisk(params) ? ["windows-maintenance"] : []);
  return [...files, ...renderManagedTimerFiles(params, root)];
}

const norm = (s) => s.replace(/\r\n/g, "\n").replace(/[ \t\n]+$/, "");

/** Compares rendered files with what is on disk. State: current | drift | absent. */
export function planFiles(files, read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null)) {
  return files.map((f) => {
    const have = read(f.path);
    return { ...f, state: have === null ? "absent" : norm(have) === norm(f.content) ? "current" : "drift", have };
  });
}

/** Reads live kernel state the files are meant to produce. Each check: {name, want, have, ok}. */
export function observeLive(params, sys = { read: (p) => { try { return readFileSync(p, "utf8").trim(); } catch { return null; } }, list: (p) => { try { return readdirSync(p); } catch { return []; } }, unit: systemdUnitState }) {
  const checks = [];
  for (const f of params.linux.sysctl) for (const e of f.entries) {
    const have = sys.read(`/proc/sys/${e.key.replaceAll(".", "/")}`);
    checks.push({ name: e.key, scope: "linux", hook: "sysctl", want: String(e.value), have, ok: have === String(e.value) });
  }
  const re = new RegExp(`^${params.linux.blockQueue.kernel}$`);
  for (const disk of sys.list("/sys/block").filter((d) => re.test(d)))
    for (const [k, v] of Object.entries(params.linux.blockQueue.attributes)) {
      const have = sys.read(`/sys/block/${disk}/queue/${k}`);
      checks.push({ name: `${disk} queue/${k}`, scope: "linux", hook: "udev", want: String(v), have, ok: have === String(v) });
    }
  const z = params.linux.zramSwap;
  if (z) {
    const line = (sys.read("/proc/swaps") ?? "").split("\n").find((l) => l.startsWith("/dev/zram0"));
    const have = line ? `active priority ${line.trim().split(/\s+/)[4]}` : null, want = `active priority ${z.priority}`;
    checks.push({ name: "zram0 swap", scope: "linux", hook: "zram-swap", want, have, ok: have === want });
  }
  checks.push(...observeTrimTimer(params.linux, sys.unit ?? (() => null)));
  const cmd = sys.read("/proc/cmdline") ?? "";
  const kcl = (params.windows.wslConfig.sections.flatMap((s) => s.entries).find((e) => e.key === "kernelCommandLine")?.value ?? "").split(/\s+/).filter(Boolean);
  for (const tok of kcl) checks.push({ name: `kernel cmdline ${tok}`, scope: "windows", want: tok, have: cmd.split(/\s+/).includes(tok) ? tok : null, ok: cmd.split(/\s+/).includes(tok) });
  for (const g of memoryBudget(params)?.groups ?? [])
    for (const [k, v] of [["high", g.high], ["max", g.max]]) {
      const have = sys.read(`/sys/fs/cgroup/${g.cgroup}/memory.${k}`);
      checks.push({ name: `${g.name} memory.${k}`, scope: "linux", hook: g.cgroup === "non-systemd" ? "agent-limits" : g.user ? USER_RELOAD + g.user : "memory-budget", want: String(bytes(v)), have, ok: have === String(bytes(v)) });
    }
  return checks;
}

/** What the Leader must do from Windows, given the plan. null when nothing is needed. */
export function windowsInstruction(plan, params, checks = []) {
  const drift = plan.filter((f) => f.state !== "current");
  const has = (h) => drift.some((f) => f.hooks.includes(h));
  const steps = [];
  const profile = params.windows.profileWindowsPath;
  if (has("defender")) steps.push(`In an elevated PowerShell: powershell -ExecutionPolicy Bypass -File ${profile}\\wsl-defender-exclusions.ps1`);
  if (has("windows-restart")) steps.push(`In an elevated PowerShell: powershell -ExecutionPolicy Bypass -File ${profile}\\wsl-host-pagefile.ps1, then restart Windows`);
  if (has("wsl-restart")) steps.push("To make the WSL settings take effect, from Windows: wsl.exe --shutdown");
  if (has("windows-maintenance") && checks.some((c) => !c.ok && c.hook === "windows-maintenance")) steps.push(`Hold/admission notice: windows-maintenance script is held (not executable due to drift or policy).`);
  return steps.length ? steps : null;
}

/** Hook prefix of a reload of one login's user manager (`user-manager-reload:<login>`). It applies a changed MemoryHigh/MemoryMax to a running unit without restarting it. */
const USER_RELOAD = "user-manager-reload:";
const knownHook = (h) => Object.hasOwn(HOOK_COMMANDS, h) || (h.startsWith(USER_RELOAD) && /^[a-z_][a-z0-9_-]{0,31}$/.test(h.slice(USER_RELOAD.length)));
const hookCommands = (h) => (h.startsWith(USER_RELOAD) ? [["systemctl", "--user", `--machine=${h.slice(USER_RELOAD.length)}@.host`, "daemon-reload"]] : HOOK_COMMANDS[h]);

const HOOK_COMMANDS = {
  sysctl: [["sysctl", "--system"]],
  udev: [["udevadm", "control", "--reload-rules"], ["systemctl", "restart", "wsl-block-queue.service"]],
  systemd: [["systemctl", "daemon-reload"], ["systemctl", "enable", "--now", "wsl-agent-limits.path", "wsl-block-queue.service", "wsl-orphan-relay-reaper.timer"]],
  "agent-limits": [["systemctl", "restart", "wsl-agent-limits.service"]],
  "boot-tmp": [["systemctl", "daemon-reload"], ["systemctl", "enable", "--now", "wsl-tmp-age.timer"]],
  "memory-budget": [["systemctl", "daemon-reload"]],
  "headroom-guard": [["systemctl", "daemon-reload"], ["systemctl", "enable", "wsl-hvsock-headroom-guard.service"], ["systemctl", "restart", "wsl-hvsock-headroom-guard.service"]],
  "zram-swap": [["systemctl", "daemon-reload"], ["systemctl", "enable", "wsl-zram-swap.service"], ["systemctl", "restart", "wsl-zram-swap.service"]],
  // A restart re-reads a changed schedule. OnBootSec has long elapsed on a running VM, so the restarted timer also
  // runs the trim once, which is harmless: ext4 skips block groups it has already trimmed since the mount.
  "trim-timer": [["systemctl", "daemon-reload"], ["systemctl", "enable", TRIM_TIMER], ["systemctl", "restart", TRIM_TIMER]],
};

/** Existing Linux reload operations needed by mismatched managed live values. */
export function liveReloadHooks(live) {
  return [...new Set(live.filter((c) => !c.ok && c.scope === "linux" && c.hook && knownHook(c.hook)).map((c) => c.hook))];
}

/**
 * Writes every file that is not current, then runs each file or live reload hook once.
 * A replaced Windows file is first copied to <name>.<stamp>-before-wsl-host-service.
 * `run` is injected so tests never execute commands; with a staging root no hooks run.
 */
export function applyPlan(plan, { stamp, run, staged = false, live = [] }) {
  const changed = plan.filter((f) => f.state !== "current");
  for (const f of changed) {
    mkdirSync(dirname(f.path), { recursive: true });
    if (f.state === "drift" && f.scope === "windows") copyFileSync(f.path, `${f.path}.${stamp}-before-wsl-host-service`);
    writeFileSync(f.path, f.content);
    chmodSync(f.path, f.mode);
  }
  const hooks = [...new Set([...changed.flatMap((f) => f.hooks), ...liveReloadHooks(live)])].filter(knownHook);
  const ran = [];
  if (!staged) for (const h of hooks) for (const cmd of hookCommands(h)) { run(cmd); ran.push(cmd.join(" ")); }
  return { written: changed.map((f) => f.path), ran };
}
