import { defineProvider } from "@red-cup-engineering/fare/provider";
import { composeProviders, serializeComposition } from "@red-cup-engineering/fare/compositor";
import { createRendererRegistry, defineRenderer, renderGraph } from "@red-cup-engineering/fare/renderer";
import { activityPulseResourceGraph } from "@red-cup-engineering/fare/adapters/activity-pulse";
import { observeHostHealthResourceGraph } from "@red-cup-engineering/fare/adapters/host-health";
import { observeLinuxProcessResourceGraphs } from "@red-cup-engineering/fare/adapters/linux-processes";
import { systemdInventoryResourceGraphs } from "@red-cup-engineering/fare/adapters/systemd-inventory";
import { observeUnitInventory } from "@red-cup-engineering/systemd-unit-inventory-observation-service";
import { collectColonyActivity } from "@red-cup-engineering/session-activity-provider-service/collect-colony-activity";
import { claudeSessionTranscriptDialect } from "@red-cup-engineering/session-transcript-dialects/claude-dialect";
import { codexSessionTranscriptDialect } from "@red-cup-engineering/session-transcript-dialects/codex-dialect";
import { projectMachineComposition } from "./machine-projection.mjs";
export const SESSION_ACTIVITY_DIALECTS = Object.freeze({
    claude: claudeSessionTranscriptDialect,
    codex: codexSessionTranscriptDialect
});
function sessionActivityProvider(dialectName) {
    const dialect = SESSION_ACTIVITY_DIALECTS[dialectName];
    if (dialect === undefined) throw new TypeError(`no session-transcript dialect is named ${dialectName}`);
    return defineProvider({
        id: `urn:fars:provider:${dialectName}-session-activity`,
        async observe (context) {
            const pulse = await collectColonyActivity(dialect, {
                window: context.window,
                recordedAt: context.observedAt
            });
            return {
                resources: [
                    activityPulseResourceGraph(pulse)
                ]
            };
        }
    });
}
export function machineProviders({ systemdScope, activityProviders = [] }) {
    return Object.freeze([
        defineProvider({
            id: "urn:fars:provider:linux-host-health",
            async observe (context) {
                return {
                    resources: [
                        await observeHostHealthResourceGraph(context)
                    ]
                };
            }
        }),
        defineProvider({
            id: "urn:fars:provider:linux-processes",
            async observe (context) {
                return observeLinuxProcessResourceGraphs(context);
            }
        }),
        defineProvider({
            id: "urn:fars:provider:systemd-unit-inventory",
            async observe (context) {
                return {
                    resources: systemdInventoryResourceGraphs(observeUnitInventory(systemdScope), {
                        observedAt: context.observedAt
                    })
                };
            }
        }),
        ...activityProviders.map(sessionActivityProvider)
    ]);
}
const renderers = createRendererRegistry([
    defineRenderer({
        id: "urn:fars:renderer:linux-machine",
        mediaType: "application/json",
        accepts: ({ selection })=>selection?.kind === "machine",
        render: ({ composition })=>projectMachineComposition(composition)
    }),
    defineRenderer({
        id: "urn:fars:renderer:predication-graph-json",
        mediaType: "application/json",
        accepts: ({ selection })=>selection?.kind === "graph",
        render: ({ composition })=>serializeComposition(composition)
    })
]);
export function createMachineObservation({ nodeName, systemdScope, activityProviders = [], cacheMilliseconds = 15_000, activityWindowMilliseconds = 3_600_000 }) {
    if (typeof nodeName !== "string" || nodeName.length === 0) throw new TypeError("a machine node name is required to observe a machine");
    const providers = machineProviders({
        systemdScope,
        activityProviders
    });
    let cached = null;
    async function readComposition({ now = new Date(), force = false } = {}) {
        if (!force && cached !== null && cached.expiresAt > now.getTime()) return cached.composition;
        const observedAt = now.toISOString();
        const context = {
            nodeName,
            observedAt,
            window: {
                fromExclusive: new Date(now.getTime() - activityWindowMilliseconds).toISOString(),
                toInclusive: observedAt
            }
        };
        const composition = await composeProviders(providers, {
            context,
            onProviderError: "diagnose"
        });
        cached = {
            expiresAt: now.getTime() + cacheMilliseconds,
            composition
        };
        return composition;
    }
    return {
        readComposition,
        async readProjection (options = {}) {
            const composition = await readComposition(options);
            return (await renderGraph(renderers, {
                composition,
                selection: {
                    kind: "machine"
                }
            })).body;
        },
        async readGraph (options = {}) {
            const composition = await readComposition(options);
            return (await renderGraph(renderers, {
                composition,
                selection: {
                    kind: "graph"
                }
            })).body;
        }
    };
}
