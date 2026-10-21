// A bounded local reverse proxy from this machine's public ActivityPub
// surface to the provider processes that actually own each actor. Which
// actors exist, which host is this colony's territory, and which local port
// or remote HTTPS origin serves each of them are all parameters: the
// machine's configuration supplies them, this module compiles in none.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const ACTIVITYPUB_PATH = /^(?:\/actors\/[^/]+(?:\/(?:inbox|outbox))?|\/activities\/[^/]+\/[^/]+\/[^/]+|\/inbox|\/nodeinfo\/2\.1|\/\.well-known\/(?:webfinger|nodeinfo))$/u;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const ACTOR_PATH = /^\/actors\/([^/]+)(?:\/(?:inbox|outbox))?$/u;
const MAXIMUM_SHARED_INBOX_BYTES = 1024 * 1024;

export function isActivityPubPath(path) {
  return ACTIVITYPUB_PATH.test(path);
}

function port(value, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new TypeError(`${label} must name a TCP port`);
  return result;
}

/**
 * Admits the configuration's `activityPub.actorRoutes` object — one entry per
 * public actor, bound either to a loopback TCP port or to an HTTPS origin —
 * as the route map the proxy resolves against.
 */
export function admitActorRoutes(actorRoutes) {
  if (actorRoutes === null || typeof actorRoutes !== "object" || Array.isArray(actorRoutes)) {
    throw new TypeError("ActivityPub actor routes must be an object binding every public actor to one provider target");
  }
  const routes = new Map();
  for (const [actor, target] of Object.entries(actorRoutes)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(actor)) throw new TypeError(`ActivityPub actor name is malformed: ${actor}`);
    if (typeof target === "number") { routes.set(actor, port(target, `ActivityPub provider for ${actor}`)); continue; }
    if (typeof target !== "string") throw new TypeError(`ActivityPub provider for ${actor} must be a TCP port or an HTTPS origin`);
    const origin = new URL(target);
    if (origin.protocol !== "https:" || origin.username !== "" || origin.password !== "" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
      throw new TypeError(`ActivityPub provider for ${actor} must be an HTTPS origin without credentials, path, query, or fragment`);
    }
    routes.set(actor, origin);
  }
  return routes;
}

function actorIdentifier(value, colonyHost) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.hostname !== colonyHost) return null;
  return ACTOR_PATH.exec(url.pathname)?.[1] ?? null;
}

/**
 * The provider target (a loopback port or an HTTPS origin) that owns one
 * public ActivityPub request URL within this colony's territory.
 */
export function providerTargetForUrl(url, { routes, colonyHost, nodeInfoProviderPort = null, objectProviderPort = null }) {
  if (typeof colonyHost !== "string" || colonyHost.length === 0) throw new TypeError("an ActivityPub colony host is required");
  if (url.hostname !== colonyHost) {
    throw new Error(`ActivityPub route is outside the ${colonyHost} colony territory`);
  }
  const actor = ACTOR_PATH.exec(url.pathname)?.[1];
  if (actor) {
    const selected = routes.get(actor);
    if (!selected) throw new Error(`no ActivityPub provider is contracted for actor ${actor}`);
    return selected;
  }
  if (url.pathname === "/.well-known/webfinger") {
    const resource = url.searchParams.get("resource") ?? "";
    const match = /^acct:([^@]+)@([^@]+)$/u.exec(resource);
    const selected = match?.[2] === colonyHost ? routes.get(match[1]) : null;
    if (!selected) throw new Error("WebFinger resource names no contracted ActivityPub actor");
    return selected;
  }
  if (["/.well-known/nodeinfo", "/nodeinfo/2.1"].includes(url.pathname)) {
    if (nodeInfoProviderPort === null) throw new Error("no ActivityPub node-information provider is contracted");
    return port(nodeInfoProviderPort, "the ActivityPub node-information provider");
  }
  if (url.pathname.startsWith("/activities/")) {
    if (objectProviderPort === null) throw new Error("no ActivityPub object provider is contracted");
    return port(objectProviderPort, "the ActivityPub object provider");
  }
  throw new Error(`ActivityPub route requires an exact actor: ${url.pathname}`);
}

export async function sharedInboxRoute(req, routes, colonyHost) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAXIMUM_SHARED_INBOX_BYTES) throw new Error("shared ActivityPub inbox request exceeds the colony ingress bound");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  let activity;
  try { activity = JSON.parse(body.toString("utf8")); } catch { throw new Error("shared ActivityPub inbox requires one JSON activity"); }
  const addressed = ["to", "cc"].flatMap((field) => Array.isArray(activity[field]) ? activity[field] : [activity[field]]);
  const recipients = [...new Set(addressed.map((value) => actorIdentifier(value, colonyHost)).filter(Boolean))];
  const targets = [...new Set(recipients.map((identifier) => routes.get(identifier)).filter(Boolean))];
  if (targets.length !== 1 || recipients.some((identifier) => !routes.has(identifier))) throw new Error("shared ActivityPub inbox requires recipients owned by exactly one contracted provider");
  return { body, target: targets[0] };
}

export async function proxyActivityPubRequest(ctx, { routes, colonyHost, publicOrigin, nodeInfoProviderPort = null, objectProviderPort = null }) {
  const routed = ctx.url.pathname === "/inbox"
    ? await sharedInboxRoute(ctx.req, routes, colonyHost)
    : { body: null, target: providerTargetForUrl(ctx.url, { routes, colonyHost, nodeInfoProviderPort, objectProviderPort }) };
  const headers = Object.fromEntries(Object.entries(ctx.req.headers).flatMap(([name, value]) => {
    if (HOP_BY_HOP.has(name) || value === undefined) return [];
    return [[name, value]];
  }));
  const upstreamTarget = new URL(`${ctx.url.pathname}${ctx.url.search}`, publicOrigin ?? ctx.url.origin);
  // Absolute-form preserves the public HTTPS target URI across this bounded
  // local reverse-proxy hop. That exact URI is covered by HTTP signatures.
  return new Promise((resolve, reject) => {
    const target = routed.target;
    const remote = target instanceof URL;
    const upstream = (remote ? httpsRequest : httpRequest)({
      hostname: remote ? target.hostname : "127.0.0.1",
      port: remote ? (target.port || 443) : target,
      method: ctx.req.method,
      path: remote ? `${ctx.url.pathname}${ctx.url.search}` : upstreamTarget.href,
      headers: remote ? { ...headers, host: target.host } : headers,
      signal: ctx.signal,
    }, (response) => {
      const responseHeaders = Object.fromEntries(Object.entries(response.headers).flatMap(([name, value]) => {
        if (HOP_BY_HOP.has(name) || value === undefined) return [];
        return [[name, value]];
      }));
      const type = typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : "application/octet-stream";
      resolve({ status: response.statusCode ?? 502, headers: responseHeaders, type, body: response });
    });
    upstream.once("error", reject);
    if (routed.body === null) ctx.req.pipe(upstream);
    else upstream.end(routed.body);
  });
}

/**
 * The ActivityPub boundary of one machine's status site, over that machine's
 * configured actor routes.
 */
export function activityPubProxyApp({ actorRoutes, colonyHost, publicOrigin, nodeInfoProviderPort = null, objectProviderPort = null }) {
  const routes = admitActorRoutes(actorRoutes);
  const options = { routes, colonyHost, publicOrigin, nodeInfoProviderPort, objectProviderPort };
  return { resources: [
    {
      match: "/inbox",
      route: "activitypub-provider-shared-inbox-boundary",
      methods: ["POST"],
      handler: (ctx) => proxyActivityPubRequest(ctx, options),
    },
    {
      match: (path) => path !== "/inbox" && isActivityPubPath(path),
      route: "activitypub-provider-boundary",
      methods: ["GET", "HEAD", "POST"],
      handler: (ctx) => proxyActivityPubRequest(ctx, options),
    },
  ] };
}
