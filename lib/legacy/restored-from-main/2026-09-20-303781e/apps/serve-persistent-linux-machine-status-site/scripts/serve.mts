#!/usr/bin/env node
// Serves one persistent Linux machine's status site from one configuration
// document named by `--config <path>` (or MACHINE_STATUS_SITE_CONFIG).
//
// One capability face, with any number of read-only transports. The machine's
// loopback capability face holds write authority; every remote transport
// (a tunnel connector, a private relay) terminates on its own read-only
// listener, so no proxy header or caller-controlled value can manufacture
// local authority.

import process from "node:process";
import {
  htmlRepr,
  installGracefulShutdown,
  jsonRepr,
  mergeApps,
  readJsonBody,
  start,
  type App,
  type Context,
  type Handler,
} from "@red-cup-engineering/http-server";
import { OAuthServer, oauthApp, oauthConfigFromEnv, authorizationServerMetadata, protectedResourceMetadata } from "@red-cup-engineering/serve-google-oauth-service";
import { judgeRequestMutability } from "@red-cup-engineering/judge-request-mutability-service";
import { readFileText } from "@red-cup-engineering/file-services/read-file";
import { makeDirectory } from "@red-cup-engineering/make-directory-service";
import { resolveFilepath } from "@red-cup-engineering/resolve-filepath-service";
import { statPath } from "@red-cup-engineering/stat-path-service";
import {
  machineStatusSiteConfigurationPath,
  type MachineStatusSiteConfiguration,
} from "../src/machine-status-site-configuration.mjs";
import { readMachineStatusSiteConfiguration, readOAuthClientEnvironment } from "./read-machine-status-site-configuration.mjs";
import { statusSitePage, statusSiteDashboardFragment } from "../src/status-site-page.mjs";
import { activityPubProxyApp } from "../src/activitypub-proxy.mjs";
import { admitX402Routes, x402ProxyApp } from "../src/x402-proxy.mjs";
import { readReportProvider } from "../src/report-provider.mjs";
import { submitSwarmMessage } from "../src/swarm-message-provider.mts";
import { createMachineObservation } from "../src/machine-fars.mts";

/**
 * The agent card this machine publishes at /.well-known/agent-card.json,
 * admitted only if it still declares ActivityPub as its sole public carrier
 * for this machine's own actor: a card that grew a direct HTTP interface
 * would silently widen the machine's public surface.
 */
export async function activityPubCarrierCard({ path, actorName }: { path: string; actorName: string }, publicOrigin: string) {
  const card = JSON.parse(await readFileText(path));
  if (!Array.isArray(card.supportedInterfaces) || card.supportedInterfaces.length !== 0
      || card["x-carrier"]?.protocol !== "ActivityPub"
      || card["x-carrier"]?.actor !== `${publicOrigin}/actors/${actorName}`) {
    throw new TypeError("the published Agent Card must declare ActivityPub as its sole public carrier");
  }
  return card;
}

/** Whether the configured peer status endpoint currently answers. */
async function peerStatus(peer: MachineStatusSiteConfiguration["peer"]) {
  if (peer === null) return { configured: false as const };
  try {
    const response = await fetch(peer.statusUrl, { signal: AbortSignal.timeout(5_000) });
    return { configured: true as const, label: peer.label, endpoint: peer.statusUrl, reachable: response.ok, httpStatus: response.status };
  } catch (error) {
    return { configured: true as const, label: peer.label, endpoint: peer.statusUrl, reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function oauthStateFile(path: string) {
  const stat = await statPath({ path });
  if (!stat.exists) return { exists: false };
  return { exists: true, updatedAt: new Date(stat.mtimeMs).toISOString() };
}

export async function serveMachineStatusSite(configuration: MachineStatusSiteConfiguration, environment: Record<string, string | undefined>) {
  const { machine, site, faces, oauth: oauthConfiguration } = configuration;
  await makeDirectory({ path: oauthConfiguration.stateDir });
  const oauth = new OAuthServer(oauthConfigFromEnv({
    publicBaseUrl: site.publicOrigin,
    allowedEmails: oauthConfiguration.allowedEmails,
    stateDir: oauthConfiguration.stateDir,
    env: await readOAuthClientEnvironment(configuration, environment),
  }));
  const challenge = `Bearer realm="${oauthConfiguration.realm}", resource_metadata="${site.publicOrigin}/.well-known/oauth-protected-resource"`;
  const admitted = new Set(oauthConfiguration.allowedEmails);
  const observation = createMachineObservation({
    nodeName: machine.nodeName,
    systemdScope: machine.systemdScope,
    activityProviders: configuration.activityProviders,
  });

  function guard(inner: Handler): Handler { return async (ctx: Context) => {
    const authorization = ctx.req.headers.authorization;
    const token = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const claims = token ? oauth.validateToken(token) : null;
    const email = typeof claims?.email === "string" ? claims.email.toLowerCase() : null;
    const status = !token ? 401 : email !== null && admitted.has(email) ? 200 : 403;
    if (status !== 200) { const reply = jsonRepr({ error: status === 401 ? "unauthorized" : "forbidden", reason: "an admitted Google OAuth token is required" }, status); return { ...reply, headers: { ...(reply.headers ?? {}), "www-authenticate": challenge } }; }
    return (await inner(ctx)) ?? jsonRepr({ error: "no response" }, 500);
  }; }

  // A face is the interface a request arrived on. The machine's own local
  // face holds write authority; a read-only transport refuses mutations
  // before authentication is even considered.
  function onMutableFaceOnly(mutableFace: boolean, inner: Handler): Handler { return async (ctx: Context) => {
    const judgment = judgeRequestMutability({ method: ctx.req.method, mutableFace });
    if (!judgment.allowed) return jsonRepr({ error: "read-only-face", reason: judgment.reason }, judgment.status);
    return (await inner(ctx)) ?? jsonRepr({ error: "no response" }, 500);
  }; }
  function guardRemoteRead(mutableFace: boolean, inner: Handler): Handler { return mutableFace ? inner : guard(inner); }

  async function statusObservation(mutableFace: boolean) {
    return {
      node: machine.nodeName,
      face: mutableFace ? "mutable" : "read-only",
      oauthState: await oauthStateFile(resolveFilepath([oauthConfiguration.stateDir, "tokens.json"])),
      peer: await peerStatus(configuration.peer),
      checkedAt: new Date().toISOString(),
    };
  }

  const noActivityNotice = configuration.activityProviders.length === 0
    ? "No agent-session activity provider is configured."
    : `No ${configuration.activityProviders.join(" or ")} activity in the last hour.`;

  const state = (mutableFace: boolean): App => ({ resources: [
    ...(configuration.swarmMessages === null ? [] : [{ match: "/api/swarm/messages", methods: ["POST"], produces: ["application/json"], handler: onMutableFaceOnly(mutableFace, guard(async (ctx: Context) => {
      const input = await readJsonBody<{ message?: unknown }>(ctx.req, { maxBytes: 20_000, empty: {} });
      const result = await submitSwarmMessage(input.message, { endpoint: configuration.swarmMessages!.endpoint });
      return jsonRepr(result.body, result.status);
    })) }]),
    { match: "/api/colony-report", methods: ["GET"], produces: ["application/json"], handler: guardRemoteRead(mutableFace, async () => { const result = await readReportProvider({ providerUrl: configuration.reportProviders.colonyUrl, unavailableType: "ColonyReportUnavailable" }); return jsonRepr(result.body, result.status); }) },
    { match: "/api/union-report", methods: ["GET"], produces: ["application/json"], handler: guardRemoteRead(mutableFace, async () => { const result = await readReportProvider({ providerUrl: configuration.reportProviders.unionUrl, unavailableType: "UnionReportUnavailable" }); return jsonRepr(result.body, result.status); }) },
    { match: "/api/dashboard-observation", methods: ["GET"], produces: ["application/json"], handler: guardRemoteRead(mutableFace, async () => jsonRepr(await statusObservation(mutableFace))) },
    { match: "/api/fars/machine", methods: ["GET"], produces: ["application/json"], handler: guardRemoteRead(mutableFace, async () => jsonRepr(await observation.readProjection())) },
    { match: "/api/fars/graph", methods: ["GET"], produces: ["application/json"], handler: guardRemoteRead(mutableFace, async () => jsonRepr(await observation.readGraph())) },
    { match: "/api/dashboard-fragment", methods: ["GET"], produces: ["text/html"], handler: guardRemoteRead(mutableFace, async () => htmlRepr(statusSiteDashboardFragment({
      machineDisplayName: machine.displayName,
      summary: site.summary,
      swarmMessages: configuration.swarmMessages !== null,
    }))) },
  ] });

  const shell = (mutableFace: boolean): App => ({ resources: [
    { match: "/healthz", methods: ["GET"], produces: ["application/json"], handler: () => jsonRepr({ ok: true, machine: machine.nodeName }) },
    { match: "/", methods: ["GET"], produces: ["text/html"], handler: () => htmlRepr(statusSitePage({
      localFace: mutableFace,
      title: site.title,
      machineDisplayName: machine.displayName,
      colonyActor: configuration.runtimePulse?.colonyActor ?? null,
      noActivityNotice,
    })) },
  ] });

  const metadata: App = { resources: [
    ...(configuration.agentCard === null ? [] : [{ match: "/.well-known/agent-card.json", methods: ["GET"], produces: ["application/json"], handler: async () => jsonRepr(await activityPubCarrierCard(configuration.agentCard!, site.publicOrigin)) }]),
    { match: "/.well-known/oauth-authorization-server", methods: ["GET"], produces: ["application/json"], handler: () => jsonRepr(authorizationServerMetadata(oauth)) },
    { match: "/.well-known/oauth-protected-resource", methods: ["GET"], produces: ["application/json"], handler: () => jsonRepr(protectedResourceMetadata(`${site.publicOrigin}/api/colony-report`, site.publicOrigin)) },
  ] };

  const proxies: App[] = [];
  if (configuration.x402 !== null) {
    proxies.push(x402ProxyApp({ routes: admitX402Routes(configuration.x402), publicOrigin: site.publicOrigin }));
  }
  if (configuration.activityPub !== null) {
    proxies.push(activityPubProxyApp({
      actorRoutes: configuration.activityPub.actorRoutes,
      colonyHost: configuration.activityPub.colonyHost,
      publicOrigin: configuration.activityPub.publicOrigin,
      nodeInfoProviderPort: configuration.activityPub.nodeInfoProviderPort,
      objectProviderPort: configuration.activityPub.objectProviderPort,
    }));
  }

  const face = (mutableFace: boolean) => mergeApps(...proxies, shell(mutableFace), oauthApp(oauth), metadata, state(mutableFace));

  const local = await start(face(true), { host: faces.mutable.host, port: faces.mutable.port });
  installGracefulShutdown(local);
  process.stderr.write(`[${machine.nodeName}] mutable face on ${faces.mutable.host}:${local.port}; Google-OAuth sealed for ${oauthConfiguration.allowedEmails.join(", ")}\n`);
  const listeners = [local];
  for (const transport of faces.readOnly) {
    const relay = await start(face(false), { host: transport.host, port: transport.port });
    installGracefulShutdown(relay);
    process.stderr.write(`[${machine.nodeName}] read-only ${transport.transport} face on ${transport.host}:${relay.port} for ${site.publicOrigin}\n`);
    listeners.push(relay);
  }
  return listeners;
}

await serveMachineStatusSite(
  await readMachineStatusSiteConfiguration(machineStatusSiteConfigurationPath(process.argv.slice(2), process.env)),
  process.env,
);
