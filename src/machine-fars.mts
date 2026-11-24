import { defineProvider, type Provider } from "@red-cup-engineering/fare/provider";
import { composeProviders, serializeComposition, type Composition } from "@red-cup-engineering/fare/compositor";
import { createRendererRegistry, defineRenderer, renderGraph } from "@red-cup-engineering/fare/renderer";
import { activityPulseResourceGraph } from "@red-cup-engineering/fare/adapters/activity-pulse";
import { observeHostHealthResourceGraph } from "@red-cup-engineering/fare/adapters/host-health";
import { observeLinuxProcessResourceGraphs } from "@red-cup-engineering/fare/adapters/linux-processes";
import { systemdInventoryResourceGraphs } from "@red-cup-engineering/fare/adapters/systemd-inventory";
import { observeUnitInventory } from "@red-cup-engineering/systemd-unit-inventory-observation-service";
import { summarizeSessionActivity as collectCodexActivity } from "@red-cup-engineering/codex-session-activity-provider/session-activity";
import { collectClaudeSessionActivity as collectClaudeActivity } from "@red-cup-engineering/claude-session-activity-provider/collect-claude-session-activity";

interface MachineContext {
  readonly nodeName: string;
  readonly observedAt: string;
  readonly window: { readonly fromExclusive: string; readonly toInclusive: string };
}

// Both session-activity providers return a plain object of counts for the
// window (sessions active, turns completed, tool calls, ...); neither knows
// about the FARS resource graph. This turns those counts into the single
// activity-pulse event shape `activityPulseResourceGraph` expects, so the
// dashboard's "last-hour activity" cards can show them next to the other
// machine resources.
function activityPulse(providerActor: string, nodeName: string, window: MachineContext["window"], recordedAt: string, label: string, counts: Record<string, unknown>) {
  const { sessionsActive, ...rest } = counts as { sessionsActive?: number; [key: string]: unknown };
  const quantities = Object.entries(rest)
    .filter(([key, value]) => key !== "window" && typeof value === "number")
    .map(([quantityLabel, amount]) => ({ label: quantityLabel, amount: String(amount), unit: "count" }));
  return {
    type: "ColonyActivityPulseEnvelope",
    providerActor,
    settlementActor: providerActor,
    colonyActor: `urn:fars:machine:${nodeName}`,
    window,
    recordedAt,
    events: [{
      id: `${providerActor}:event:${recordedAt}`,
      kind: "session-activity",
      domain: "agent-sessions",
      outcome: (sessionsActive ?? 0) > 0 ? "active" : "quiet",
      summary: `${label}: ${sessionsActive ?? 0} session(s) active in the last hour.`,
      occurredAt: window.toInclusive,
      quantities,
    }],
    refusals: [],
  };
}

const healthProvider = defineProvider<MachineContext>({
  id: "urn:fars:provider:linux-host-health",
  async observe(context) { return { resources: [await observeHostHealthResourceGraph(context)] }; },
});
const processProvider = defineProvider<MachineContext>({
  id: "urn:fars:provider:linux-processes",
  async observe(context) { return observeLinuxProcessResourceGraphs(context); },
});
const systemdProvider = defineProvider<MachineContext>({
  id: "urn:fars:provider:systemd-user-inventory",
  async observe(context) { return { resources: systemdInventoryResourceGraphs(observeUnitInventory("local"), { observedAt: context.observedAt }) }; },
});
const codexActivityProvider = defineProvider<MachineContext>({
  id: "urn:fars:provider:codex-session-activity",
  async observe(context) {
    const counts = await collectCodexActivity({ window: context.window });
    const pulse = activityPulse("urn:fars:provider:codex-session-activity", context.nodeName, context.window, context.observedAt, "Codex", counts);
    return { resources: [activityPulseResourceGraph(pulse)] };
  },
});
const claudeActivityProvider = defineProvider<MachineContext>({
  id: "urn:fars:provider:claude-session-activity",
  async observe(context) {
    const counts = await collectClaudeActivity({ window: context.window });
    const pulse = activityPulse("urn:fars:provider:claude-session-activity", context.nodeName, context.window, context.observedAt, "Claude", counts);
    return { resources: [activityPulseResourceGraph(pulse)] };
  },
});

const machineProviders: readonly Provider<MachineContext>[] = Object.freeze([
  healthProvider, processProvider, systemdProvider, codexActivityProvider, claudeActivityProvider,
]);

function subjectsOf(composition: Composition, predicate: string, object: string) {
  return [...new Set(composition.store.order.filter((cell) => cell.predicate === predicate && cell.object === object).map((cell) => cell.subject))];
}
function valuesOf(composition: Composition, subject: string, predicate: string) {
  return composition.store.order.filter((cell) => cell.subject === subject && cell.predicate === predicate).map((cell) => cell.object);
}
function first(composition: Composition, subject: string, predicate: string) { return valuesOf(composition, subject, predicate)[0] ?? null; }
function number(composition: Composition, subject: string, predicate: string) {
  const value = Number(first(composition, subject, predicate));
  return Number.isFinite(value) ? value : null;
}
function roleOrder(role: string | null) { return role === "agent" ? 0 : role === "script" ? 1 : 2; }

export function projectMachineComposition(composition: Composition) {
  const machine = subjectsOf(composition, "urn:fars:type", "urn:fars:type:machine")[0] ?? null;
  const health = machine === null ? null : {
    nodeName: first(composition, machine, "urn:fars:node-name"),
    load: [number(composition, machine, "compute-load-1m"), number(composition, machine, "compute-load-5m"), number(composition, machine, "compute-load-15m")],
    cpuCores: number(composition, machine, "cpu-core-count"),
    uptimeSeconds: number(composition, machine, "uptime-seconds"),
    memory: { freeBytes: number(composition, machine, "free-memory-bytes"), totalBytes: number(composition, machine, "total-memory-bytes") },
    swap: { freeBytes: number(composition, machine, "free-swap-bytes"), totalBytes: number(composition, machine, "total-swap-bytes") },
    storage: { freeBytes: number(composition, machine, "free-storage-bytes:/"), totalBytes: number(composition, machine, "total-storage-bytes:/") },
  };
  const processes = subjectsOf(composition, "urn:fars:type", "urn:fars:type:os-process").map((subject) => ({
    id: subject,
    pid: number(composition, subject, "os-pid"),
    parentPid: number(composition, subject, "os-parent-pid"),
    command: first(composition, subject, "os-command"),
    executable: first(composition, subject, "os-executable-name"),
    entrypoint: first(composition, subject, "os-entrypoint-name"),
    state: first(composition, subject, "os-process-state"),
    role: first(composition, subject, "process-role-hint"),
    residentMemoryBytes: number(composition, subject, "resident-memory-bytes"),
    threads: number(composition, subject, "os-thread-count"),
  })).sort((left, right) => roleOrder(left.role) - roleOrder(right.role) || (right.residentMemoryBytes ?? 0) - (left.residentMemoryBytes ?? 0));
  const units = subjectsOf(composition, "urn:fars:type", "urn:fars:type:systemd-unit").filter((subject) => first(composition, subject, "urn:fars:unit-name")?.endsWith(".service")).map((subject) => ({
    id: subject, name: first(composition, subject, "urn:fars:unit-name"), active: first(composition, subject, "urn:fars:unit-active"), substate: first(composition, subject, "urn:fars:unit-substate"), description: first(composition, subject, "urn:fars:description"),
  })).sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const timers = subjectsOf(composition, "urn:fars:type", "urn:fars:type:systemd-timer").map((subject) => ({
    id: subject, name: first(composition, subject, "urn:fars:unit-name"), activates: first(composition, subject, "urn:fars:timer-activates"), nextMicroseconds: number(composition, subject, "urn:fars:timer-next-microseconds"),
  })).sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const activity = subjectsOf(composition, "urn:fars:type", "urn:fars:type:activity-event").map((subject) => ({
    id: subject, kind: first(composition, subject, "urn:fars:event-kind"), domain: first(composition, subject, "urn:fars:event-domain"), outcome: first(composition, subject, "urn:fars:event-outcome"), summary: first(composition, subject, "urn:fars:event-summary"), occurredAt: first(composition, subject, "urn:fars:occurred-at"),
    quantities: valuesOf(composition, subject, "urn:fars:has-quantity").map((quantity) => ({ label: first(composition, quantity, "urn:fars:quantity-label"), amount: first(composition, quantity, "urn:fars:quantity-amount"), unit: first(composition, quantity, "urn:fars:quantity-unit") })),
  })).sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)));
  return Object.freeze({
    type: "BareCedarFogFarsMachineProjection", observedAt: composition.resources.map(({ observedAt }) => observedAt).sort().at(-1) ?? new Date().toISOString(),
    health, processes, units, timers, activity, providers: composition.providers,
    diagnostics: composition.diagnostics,
    graph: { resources: composition.resources.length, cells: composition.store.order.length },
  });
}

const renderers = createRendererRegistry([
  defineRenderer({ id: "urn:fars:renderer:bare-cedar-fog-machine", mediaType: "application/json", accepts: ({ selection }) => (selection as { kind?: string })?.kind === "machine", render: ({ composition }) => projectMachineComposition(composition) }),
  defineRenderer({ id: "urn:fars:renderer:predication-graph-json", mediaType: "application/json", accepts: ({ selection }) => (selection as { kind?: string })?.kind === "graph", render: ({ composition }) => serializeComposition(composition) }),
]);

let cached: { readonly expiresAt: number; readonly composition: Composition } | null = null;

export async function readMachineComposition({ nodeName = "bare-cedar-fog", now = new Date(), cacheMilliseconds = 15_000, force = false } = {}) {
  if (!force && cached !== null && cached.expiresAt > now.getTime()) return cached.composition;
  const observedAt = now.toISOString();
  const context: MachineContext = { nodeName, observedAt, window: { fromExclusive: new Date(now.getTime() - 3_600_000).toISOString(), toInclusive: observedAt } };
  const composition = await composeProviders(machineProviders, { context, onProviderError: "diagnose" });
  cached = { expiresAt: now.getTime() + cacheMilliseconds, composition };
  return composition;
}

export async function readMachineProjection(options = {}) {
  const composition = await readMachineComposition(options);
  return (await renderGraph(renderers, { composition, selection: { kind: "machine" } })).body as ReturnType<typeof projectMachineComposition>;
}

export async function readMachineGraph(options = {}) {
  const composition = await readMachineComposition(options);
  return (await renderGraph(renderers, { composition, selection: { kind: "graph" } })).body;
}
