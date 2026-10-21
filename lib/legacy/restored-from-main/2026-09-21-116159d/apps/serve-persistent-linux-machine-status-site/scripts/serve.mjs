#!/usr/bin/env node
import process from "node:process";
import { htmlRepr } from "@red-cup-engineering/http-services-section/representation";
import { installGracefulShutdown } from "@red-cup-engineering/http-services-section/node-server";
import { jsonRepr } from "@red-cup-engineering/http-services-section/representation";
import { mergeApps } from "@red-cup-engineering/computer-web-server/compose";
import { readJsonBody } from "@red-cup-engineering/http-services-section/body";
import { startNativeApplication as start } from "@red-cup-engineering/computer-web-server/native-application";
import { OAuthServer, oauthApp, oauthConfigFromEnv, authorizationServerMetadata, protectedResourceMetadata } from "@red-cup-engineering/serve-google-oauth-service";
import { judgeRequestMutability } from "@red-cup-engineering/oauth-services-section/judge-request-mutability";
import { readFileText } from "@red-cup-engineering/file-services/read-file";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { statPath } from "@red-cup-engineering/file-observation-services-section/stat-path";
import { machineStatusSiteConfigurationPath } from "../src/machine-status-site-configuration.mjs";
import { readMachineStatusSiteConfiguration, readOAuthClientEnvironment } from "./read-machine-status-site-configuration.mjs";
import { statusSitePage, statusSiteDashboardFragment } from "../src/status-site-page.mjs";
import { activityPubProxyApp } from "../src/activitypub-proxy.mjs";
import { admitX402Routes, x402ProxyApp } from "../src/x402-proxy.mjs";
import { readReportProvider } from "../src/report-provider.mjs";
import { submitSwarmMessage } from "../src/swarm-message-provider.mjs";
import { createMachineObservation } from "../src/machine-fars.mjs";
export async function activityPubCarrierCard({ path, actorName }, publicOrigin) {
    const card = JSON.parse(await readFileText(path));
    if (!Array.isArray(card.supportedInterfaces) || card.supportedInterfaces.length !== 0 || card["x-carrier"]?.protocol !== "ActivityPub" || card["x-carrier"]?.actor !== `${publicOrigin}/actors/${actorName}`) {
        throw new TypeError("the published Agent Card must declare ActivityPub as its sole public carrier");
    }
    return card;
}
async function peerStatus(peer) {
    if (peer === null) return {
        configured: false
    };
    try {
        const response = await fetch(peer.statusUrl, {
            signal: AbortSignal.timeout(5_000)
        });
        return {
            configured: true,
            label: peer.label,
            endpoint: peer.statusUrl,
            reachable: response.ok,
            httpStatus: response.status
        };
    } catch (error) {
        return {
            configured: true,
            label: peer.label,
            endpoint: peer.statusUrl,
            reachable: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
async function oauthStateFile(path) {
    const stat = await statPath({
        path
    });
    if (!stat.exists) return {
        exists: false
    };
    return {
        exists: true,
        updatedAt: new Date(stat.mtimeMs).toISOString()
    };
}
export async function serveMachineStatusSite(configuration, environment) {
    const { machine, site, faces, oauth: oauthConfiguration } = configuration;
    await mkdir(oauthConfiguration.stateDir, { recursive: true });
    const oauth = new OAuthServer(oauthConfigFromEnv({
        publicBaseUrl: site.publicOrigin,
        allowedEmails: oauthConfiguration.allowedEmails,
        stateDir: oauthConfiguration.stateDir,
        env: await readOAuthClientEnvironment(configuration, environment)
    }));
    const challenge = `Bearer realm="${oauthConfiguration.realm}", resource_metadata="${site.publicOrigin}/.well-known/oauth-protected-resource"`;
    const admitted = new Set(oauthConfiguration.allowedEmails);
    const observation = createMachineObservation({
        nodeName: machine.nodeName,
        systemdScope: machine.systemdScope,
        activityProviders: configuration.activityProviders
    });
    function guard(inner) {
        return async (ctx)=>{
            const authorization = ctx.req.headers.authorization;
            const token = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
            const claims = token ? oauth.validateToken(token) : null;
            const email = typeof claims?.email === "string" ? claims.email.toLowerCase() : null;
            const status = !token ? 401 : email !== null && admitted.has(email) ? 200 : 403;
            if (status !== 200) {
                const reply = jsonRepr({
                    error: status === 401 ? "unauthorized" : "forbidden",
                    reason: "an admitted Google OAuth token is required"
                }, status);
                return {
                    ...reply,
                    headers: {
                        ...reply.headers ?? {},
                        "www-authenticate": challenge
                    }
                };
            }
            return await inner(ctx) ?? jsonRepr({
                error: "no response"
            }, 500);
        };
    }
    function onMutableFaceOnly(mutableFace, inner) {
        return async (ctx)=>{
            const judgment = judgeRequestMutability({
                method: ctx.req.method,
                mutableFace
            });
            if (!judgment.allowed) return jsonRepr({
                error: "read-only-face",
                reason: judgment.reason
            }, judgment.status);
            return await inner(ctx) ?? jsonRepr({
                error: "no response"
            }, 500);
        };
    }
    function guardRemoteRead(mutableFace, inner) {
        return mutableFace ? inner : guard(inner);
    }
    async function statusObservation(mutableFace) {
        return {
            node: machine.nodeName,
            face: mutableFace ? "mutable" : "read-only",
            oauthState: await oauthStateFile(resolve(
                oauthConfiguration.stateDir,
                "tokens.json"
            )),
            peer: await peerStatus(configuration.peer),
            checkedAt: new Date().toISOString()
        };
    }
    const noActivityNotice = configuration.activityProviders.length === 0 ? "No agent-session activity provider is configured." : `No ${configuration.activityProviders.join(" or ")} activity in the last hour.`;
    const state = (mutableFace)=>({
            resources: [
                ...configuration.swarmMessages === null ? [] : [
                    {
                        match: "/api/swarm/messages",
                        methods: [
                            "POST"
                        ],
                        produces: [
                            "application/json"
                        ],
                        handler: onMutableFaceOnly(mutableFace, guard(async (ctx)=>{
                            const input = await readJsonBody(ctx.req, {
                                maxBytes: 20_000,
                                empty: {}
                            });
                            const result = await submitSwarmMessage(input.message, {
                                endpoint: configuration.swarmMessages.endpoint
                            });
                            return jsonRepr(result.body, result.status);
                        }))
                    }
                ],
                {
                    match: "/api/colony-report",
                    methods: [
                        "GET"
                    ],
                    produces: [
                        "application/json"
                    ],
                    handler: guardRemoteRead(mutableFace, async ()=>{
                        const result = await readReportProvider({
                            providerUrl: configuration.reportProviders.colonyUrl,
                            unavailableType: "ColonyReportUnavailable"
                        });
                        return jsonRepr(result.body, result.status);
                    })
                },
                {
                    match: "/api/union-report",
                    methods: [
                        "GET"
                    ],
                    produces: [
                        "application/json"
                    ],
                    handler: guardRemoteRead(mutableFace, async ()=>{
                        const result = await readReportProvider({
                            providerUrl: configuration.reportProviders.unionUrl,
                            unavailableType: "UnionReportUnavailable"
                        });
                        return jsonRepr(result.body, result.status);
                    })
                },
                {
                    match: "/api/dashboard-observation",
                    methods: [
                        "GET"
                    ],
                    produces: [
                        "application/json"
                    ],
                    handler: guardRemoteRead(mutableFace, async ()=>jsonRepr(await statusObservation(mutableFace)))
                },
                {
                    match: "/api/fars/machine",
                    methods: [
                        "GET"
                    ],
                    produces: [
                        "application/json"
                    ],
                    handler: guardRemoteRead(mutableFace, async ()=>jsonRepr(await observation.readProjection()))
                },
                {
                    match: "/api/fars/graph",
                    methods: [
                        "GET"
                    ],
                    produces: [
                        "application/json"
                    ],
                    handler: guardRemoteRead(mutableFace, async ()=>jsonRepr(await observation.readGraph()))
                },
                {
                    match: "/api/dashboard-fragment",
                    methods: [
                        "GET"
                    ],
                    produces: [
                        "text/html"
                    ],
                    handler: guardRemoteRead(mutableFace, async ()=>htmlRepr(statusSiteDashboardFragment({
                            machineDisplayName: machine.displayName,
                            summary: site.summary,
                            swarmMessages: configuration.swarmMessages !== null
                        })))
                }
            ]
        });
    const shell = (mutableFace)=>({
            resources: [
                {
                    match: "/healthz",
                    methods: [
                        "GET"
                    ],
                    produces: [
                        "application/json"
                    ],
                    handler: ()=>jsonRepr({
                            ok: true,
                            machine: machine.nodeName
                        })
                },
                {
                    match: "/",
                    methods: [
                        "GET"
                    ],
                    produces: [
                        "text/html"
                    ],
                    handler: ()=>htmlRepr(statusSitePage({
                            localFace: mutableFace,
                            title: site.title,
                            machineDisplayName: machine.displayName,
                            colonyActor: configuration.runtimePulse?.colonyActor ?? null,
                            noActivityNotice
                        }))
                }
            ]
        });
    const metadata = {
        resources: [
            ...configuration.agentCard === null ? [] : [
                {
                    match: "/.well-known/agent-card.json",
                    methods: [
                        "GET"
                    ],
                    produces: [
                        "application/json"
                    ],
                    handler: async ()=>jsonRepr(await activityPubCarrierCard(configuration.agentCard, site.publicOrigin))
                }
            ],
            {
                match: "/.well-known/oauth-authorization-server",
                methods: [
                    "GET"
                ],
                produces: [
                    "application/json"
                ],
                handler: ()=>jsonRepr(authorizationServerMetadata(oauth))
            },
            {
                match: "/.well-known/oauth-protected-resource",
                methods: [
                    "GET"
                ],
                produces: [
                    "application/json"
                ],
                handler: ()=>jsonRepr(protectedResourceMetadata(`${site.publicOrigin}/api/colony-report`, site.publicOrigin))
            }
        ]
    };
    const proxies = [];
    if (configuration.x402 !== null) {
        proxies.push(x402ProxyApp({
            routes: admitX402Routes(configuration.x402),
            publicOrigin: site.publicOrigin
        }));
    }
    if (configuration.activityPub !== null) {
        proxies.push(activityPubProxyApp({
            actorRoutes: configuration.activityPub.actorRoutes,
            colonyHost: configuration.activityPub.colonyHost,
            publicOrigin: configuration.activityPub.publicOrigin,
            nodeInfoProviderPort: configuration.activityPub.nodeInfoProviderPort,
            objectProviderPort: configuration.activityPub.objectProviderPort
        }));
    }
    const face = (mutableFace)=>mergeApps(...proxies, shell(mutableFace), oauthApp(oauth), metadata, state(mutableFace));
    const local = await start(face(true), {
        host: faces.mutable.host,
        port: faces.mutable.port
    });
    installGracefulShutdown(local);
    process.stderr.write(`[${machine.nodeName}] mutable face on ${faces.mutable.host}:${local.port}; Google-OAuth sealed for ${oauthConfiguration.allowedEmails.join(", ")}\n`);
    const listeners = [
        local
    ];
    for (const transport of faces.readOnly){
        const relay = await start(face(false), {
            host: transport.host,
            port: transport.port
        });
        installGracefulShutdown(relay);
        process.stderr.write(`[${machine.nodeName}] read-only ${transport.transport} face on ${transport.host}:${relay.port} for ${site.publicOrigin}\n`);
        listeners.push(relay);
    }
    return listeners;
}
await serveMachineStatusSite(await readMachineStatusSiteConfiguration(machineStatusSiteConfigurationPath(process.argv.slice(2), process.env)), process.env);
