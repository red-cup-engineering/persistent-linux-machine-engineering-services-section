// The FARS providers that observe one persistent Linux machine, and the
// renderers that project their composition. Which machine is observed, which
// systemd scope is inventoried, and which session-transcript dialects are
// collected are all parameters the machine's configuration supplies; the
// session-activity collector itself is upstream's one dialect-parameterized
// owner, not a per-harness copy.

import { defineProvider, type Provider } from "@red-cup-engineering/fare/provider";
import { composeProviders, serializeComposition, type Composition } from "@red-cup-engineering/fare/compositor";
import { createRendererRegistry, defineRenderer, renderGraph } from "@red-cup-engineering/fare/renderer";
import { activityPulseResourceGraph } from "@red-cup-engineering/fare/adapters/activity-pulse";
import { observeHostHealthResourceGraph } from "@red-cup-engineering/fare/adapters/host-health";
import { observeLinuxProcessResourceGraphs } from "@red-cup-engineering/fare/adapters/linux-processes";
import { systemdInventoryResourceGraphs } from "@red-cup-engineering/fare/adapters/systemd-inventory";
import { observeUnitInventory } from "@red-cup-engineering/systemd-unit-inventory-observation-service";
import { collectColonyActivity } from "@red-cup-engineering/session-activity-provider-service/collect-colony-activity";
import { claudeSessionTranscriptDialect } from "@red-cup-engineering/session-transcript-dialects/claude-dialect";
import { codexSessionTranscriptDialect } from "@red-cup-engineering/session-transcript-dialects/codex-dialect";
import { projectMachineComposition } from "./machine-projection.mts";

export interface MachineContext {
  readonly nodeName: string;
  readonly observedAt: string;
  readonly window: { readonly fromExclusive: string; readonly toInclusive: string };
}

/**
 * The session-transcript dialects this app can observe, by the name a
 * machine configuration's `activityProviders` list uses. A dialect carries
 * everything provider-specific (which rows count as a turn, a patch, a web
 * search, a compaction, and the vocabulary for each); the collector is one.
 */
export const SESSION_ACTIVITY_DIALECTS = Object.freeze({
  claude: claudeSessionTranscriptDialect,
  codex: codexSessionTranscriptDialect,
} as Record<string, unknown>);

function sessionActivityProvider(dialectName: string): Provider<MachineContext> {
  const dialect = SESSION_ACTIVITY_DIALECTS[dialectName];
  if (dialect === undefined) throw new TypeError(`no session-transcript dialect is named ${dialectName}`);
  return defineProvider<MachineContext>({
    id: `urn:fars:provider:${dialectName}-session-activity`,
    async observe(context) {
      const pulse = await collectColonyActivity(dialect, { window: context.window, recordedAt: context.observedAt });
      return { resources: [activityPulseResourceGraph(pulse)] };
    },
  });
}

/** The providers that observe one machine, over its configured parameters. */
export function machineProviders({ systemdScope, activityProviders = [] }: {
  systemdScope: string;
  activityProviders?: readonly string[];
}): readonly Provider<MachineContext>[] {
  return Object.freeze([
    defineProvider<MachineContext>({
      id: "urn:fars:provider:linux-host-health",
      async observe(context) { return { resources: [await observeHostHealthResourceGraph(context)] }; },
    }),
    defineProvider<MachineContext>({
      id: "urn:fars:provider:linux-processes",
      async observe(context) { return observeLinuxProcessResourceGraphs(context); },
    }),
    defineProvider<MachineContext>({
      id: "urn:fars:provider:systemd-unit-inventory",
      async observe(context) { return { resources: systemdInventoryResourceGraphs(observeUnitInventory(systemdScope), { observedAt: context.observedAt }) }; },
    }),
    ...activityProviders.map(sessionActivityProvider),
  ]);
}

const renderers = createRendererRegistry([
  defineRenderer({ id: "urn:fars:renderer:linux-machine", mediaType: "application/json", accepts: ({ selection }) => (selection as { kind?: string })?.kind === "machine", render: ({ composition }) => projectMachineComposition(composition) }),
  defineRenderer({ id: "urn:fars:renderer:predication-graph-json", mediaType: "application/json", accepts: ({ selection }) => (selection as { kind?: string })?.kind === "graph", render: ({ composition }) => serializeComposition(composition) }),
]);

/**
 * One machine's observation face: a bounded-staleness composition of that
 * machine's providers, projected either as the dashboard's machine JSON or
 * as the raw predication graph.
 */
export function createMachineObservation({ nodeName, systemdScope, activityProviders = [], cacheMilliseconds = 15_000, activityWindowMilliseconds = 3_600_000 }: {
  nodeName: string;
  systemdScope: string;
  activityProviders?: readonly string[];
  cacheMilliseconds?: number;
  activityWindowMilliseconds?: number;
}) {
  if (typeof nodeName !== "string" || nodeName.length === 0) throw new TypeError("a machine node name is required to observe a machine");
  const providers = machineProviders({ systemdScope, activityProviders });
  let cached: { readonly expiresAt: number; readonly composition: Composition } | null = null;

  async function readComposition({ now = new Date(), force = false } = {}) {
    if (!force && cached !== null && cached.expiresAt > now.getTime()) return cached.composition;
    const observedAt = now.toISOString();
    const context: MachineContext = { nodeName, observedAt, window: { fromExclusive: new Date(now.getTime() - activityWindowMilliseconds).toISOString(), toInclusive: observedAt } };
    const composition = await composeProviders(providers, { context, onProviderError: "diagnose" });
    cached = { expiresAt: now.getTime() + cacheMilliseconds, composition };
    return composition;
  }

  return {
    readComposition,
    async readProjection(options = {}) {
      const composition = await readComposition(options);
      return (await renderGraph(renderers, { composition, selection: { kind: "machine" } })).body as ReturnType<typeof projectMachineComposition>;
    },
    async readGraph(options = {}) {
      const composition = await readComposition(options);
      return (await renderGraph(renderers, { composition, selection: { kind: "graph" } })).body;
    },
  };
}
