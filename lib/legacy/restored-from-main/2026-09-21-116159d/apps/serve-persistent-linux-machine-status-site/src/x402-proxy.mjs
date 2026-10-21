// A bounded local reverse proxy from this machine's public metered surface to
// the x402 tollbooth and brokerage processes behind it. The formerly
// compiled-in route tables (three /compute paths, eight brokerage paths) and
// their ports are now one declarative table in the machine's configuration,
// so a machine that sells different metered products changes only its config.

import { request as httpRequest } from "node:http";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const PROVIDER_OPERATION = "(?:offer|invoke|result\\/[0-9a-f]{64}|recover\\/[0-9a-f]{64})";
const WRITE_OPERATIONS = /^(?:invoke|recover\/[0-9a-f]{64})$/u;

function port(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new TypeError(`${label} must name one TCP port`);
  return value;
}

/**
 * Admits the configuration's `x402` block as the route table this proxy
 * resolves against: a fixed method+path table with an upstream path and port
 * each, and the per-provider metered ports reached under the metered prefix.
 */
export function admitX402Routes({ fixedRoutes = [], providerRoutes = {}, meteredPathPrefix = "/x402" } = {}) {
  if (!Array.isArray(fixedRoutes)) throw new TypeError("x402 fixedRoutes must be an array");
  if (providerRoutes === null || typeof providerRoutes !== "object" || Array.isArray(providerRoutes)) throw new TypeError("x402 providerRoutes must be an object of provider:port bindings");
  if (typeof meteredPathPrefix !== "string" || !meteredPathPrefix.startsWith("/")) throw new TypeError("x402 meteredPathPrefix must be an absolute path prefix");
  const fixed = new Map();
  for (const route of fixedRoutes) {
    const key = `${route?.method} ${route?.path}`;
    if (fixed.has(key)) throw new TypeError(`x402 fixedRoutes binds ${key} twice`);
    fixed.set(key, Object.freeze({ port: port(route?.port, `the x402 provider for ${key}`), upstreamPath: route.upstreamPath }));
  }
  const providers = new Map();
  for (const [provider, bound] of Object.entries(providerRoutes)) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(provider)) throw new TypeError(`x402 provider name is malformed: ${provider}`);
    providers.set(provider, port(bound, `the x402 provider ${provider}`));
  }
  const meteredPath = new RegExp(`^${meteredPathPrefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\/([a-z0-9][a-z0-9-]*)\\/${PROVIDER_OPERATION}$`, "u");
  const meteredOperation = new RegExp(`^${meteredPathPrefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\/[a-z0-9][a-z0-9-]*\\/(${PROVIDER_OPERATION})$`, "u");
  return Object.freeze({ fixed, providers, meteredPath, meteredOperation });
}

/** The upstream port and path one metered request is contracted to reach. */
export function x402Route(method, pathname, routes) {
  const fixed = routes.fixed.get(`${method} ${pathname}`);
  if (fixed) return fixed;
  const provider = routes.meteredPath.exec(pathname)?.[1];
  const operation = routes.meteredOperation.exec(pathname)?.[1];
  const write = operation !== undefined && WRITE_OPERATIONS.test(operation);
  if (provider === undefined || (write ? method !== "POST" : method !== "GET")) {
    throw new Error("request is outside the contracted metered ingress");
  }
  const bound = routes.providers.get(provider);
  if (bound === undefined) throw new Error("request is outside the contracted metered ingress");
  return Object.freeze({ port: bound, upstreamPath: pathname });
}

/** Whether a request path is anywhere inside the contracted metered ingress. */
export function isX402Path(path, routes) {
  if (routes.meteredPath.test(path)) return true;
  for (const key of routes.fixed.keys()) if (key.endsWith(` ${path}`)) return true;
  return false;
}

export async function proxyX402Request(ctx, { routes, publicOrigin }) {
  const route = x402Route(ctx.req.method ?? "GET", ctx.url.pathname, routes);
  const headers = Object.fromEntries(Object.entries(ctx.req.headers).flatMap(([name, value]) => HOP_BY_HOP.has(name) || value === undefined ? [] : [[name, value]]));
  const origin = new URL(publicOrigin ?? ctx.url.origin);
  headers["x-forwarded-proto"] = origin.protocol.replace(":", "");
  headers["x-forwarded-host"] = origin.host;
  return new Promise((resolve, reject) => {
    const upstream = httpRequest({ hostname: "127.0.0.1", port: route.port, method: ctx.req.method, path: route.upstreamPath, headers, signal: ctx.signal }, (response) => {
      const responseHeaders = Object.fromEntries(Object.entries(response.headers).flatMap(([name, value]) => HOP_BY_HOP.has(name) || value === undefined ? [] : [[name, value]]));
      resolve({ status: response.statusCode ?? 502, headers: responseHeaders, type: response.headers["content-type"] ?? "application/octet-stream", body: response });
    });
    upstream.once("error", reject);
    ctx.req.pipe(upstream);
  });
}

/** The metered x402 boundary of one machine's status site. */
export function x402ProxyApp({ routes, publicOrigin }) {
  return { resources: [{
    match: (path) => isX402Path(path, routes),
    route: "metered-inference-x402-boundary",
    methods: ["GET", "POST"],
    handler: (ctx) => proxyX402Request(ctx, { routes, publicOrigin }),
  }] };
}
