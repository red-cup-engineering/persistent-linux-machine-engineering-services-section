// The one place this app learns anything host-specific. Everything that used
// to be an environment variable or a compiled-in literal — the machine's node
// name, the public origin, the listeners, the admitted Google accounts, which
// session-transcript dialects are observed, and every proxied upstream — is a
// field of one JSON configuration document named by path, so the same app
// serves any persistent Linux machine and the machine owns only its config.
//
// Credentials are deliberately NOT in this document: the Google OAuth client
// id and secret are read either from the JSON file `oauth.clientConfigPath`
// names (mode 0600, outside this repository) or, when that field is null,
// from GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in the process environment.
//
// This module is pure admission (no filesystem effect), so it stays in
// src/. Reading the configuration document and the OAuth client file off
// disk are a separate single effect, in
// ../scripts/read-machine-status-site-configuration.mjs, through the house
// file-services effect owner.

export const MACHINE_STATUS_SITE_CONFIGURATION_TYPE = "PersistentLinuxMachineStatusSite";
export const CONFIGURATION_PATH_ENVIRONMENT_VARIABLE = "MACHINE_STATUS_SITE_CONFIG";
export const SESSION_ACTIVITY_DIALECT_NAMES = Object.freeze(["claude", "codex"]);
const HTTP_METHODS = Object.freeze(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const HOST_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const ACTOR_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
const PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

function fail(where, expectation) {
  throw new TypeError(`${where} ${expectation}`);
}

function object(value, where) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(where, "must be a JSON object");
  return value;
}

function text(value, where, pattern) {
  if (typeof value !== "string" || value.length === 0) fail(where, "must be a non-empty string");
  if (pattern && !pattern.test(value)) fail(where, `must match ${String(pattern)}`);
  return value;
}

function optionalText(value, where, pattern) {
  return value === null || value === undefined ? null : text(value, where, pattern);
}

function port(value, where) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) fail(where, "must name a TCP port (1-65535)");
  return value;
}

function optionalPort(value, where) {
  return value === null || value === undefined ? null : port(value, where);
}

function absolutePath(value, where) {
  const path = text(value, where);
  // A POSIX absolute path starts with "/"; this deployment's machines are
  // Linux hosts, so a plain prefix check stands in for node:path's
  // isAbsolute without importing it -- no house filepath owner exposes an
  // isAbsolute check as a pure (non-effectful) library call.
  if (!path.startsWith("/")) fail(where, "must be an absolute filesystem path");
  return path;
}

function origin(value, where) {
  const url = new URL(text(value, where));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    fail(where, "must be an HTTP(S) origin with no credentials, path, query, or fragment");
  }
  return url.origin;
}

function httpUrl(value, where) {
  const url = new URL(text(value, where));
  if (!["http:", "https:"].includes(url.protocol)) fail(where, "must be an HTTP(S) URL");
  return url.href;
}

function optionalHttpUrl(value, where) {
  return value === null || value === undefined ? null : httpUrl(value, where);
}

function listener(value, where) {
  const listen = object(value, where);
  return Object.freeze({
    host: text(listen.host, `${where}.host`),
    port: port(listen.port, `${where}.port`),
  });
}

function machine(value) {
  const parts = object(value, "machine");
  return Object.freeze({
    nodeName: text(parts.nodeName, "machine.nodeName", HOST_NAME_PATTERN),
    displayName: text(parts.displayName, "machine.displayName"),
    systemdScope: text(parts.systemdScope, "machine.systemdScope"),
  });
}

function site(value) {
  const parts = object(value, "site");
  return Object.freeze({
    title: text(parts.title, "site.title"),
    summary: text(parts.summary, "site.summary"),
    publicOrigin: origin(parts.publicOrigin, "site.publicOrigin"),
  });
}

function faces(value) {
  const parts = object(value, "faces");
  if (!Array.isArray(parts.readOnly)) fail("faces.readOnly", "must be an array of read-only transports");
  const mutable = listener(parts.mutable, "faces.mutable");
  const readOnly = parts.readOnly.map((transport, index) => {
    const where = `faces.readOnly[${index}]`;
    const bound = listener(transport, where);
    return Object.freeze({ ...bound, transport: text(object(transport, where).transport, `${where}.transport`) });
  });
  const bindings = [mutable, ...readOnly].map(({ host, port: bound }) => `${host}:${bound}`);
  if (new Set(bindings).size !== bindings.length) fail("faces", "must bind every listener to a distinct host:port");
  return Object.freeze({ mutable, readOnly: Object.freeze(readOnly) });
}

function oauth(value) {
  const parts = object(value, "oauth");
  if (!Array.isArray(parts.allowedEmails) || parts.allowedEmails.length === 0) {
    fail("oauth.allowedEmails", "must list at least one admitted Google account");
  }
  return Object.freeze({
    allowedEmails: Object.freeze(parts.allowedEmails.map((email, index) => text(email, `oauth.allowedEmails[${index}]`).toLowerCase())),
    stateDir: absolutePath(parts.stateDir, "oauth.stateDir"),
    clientConfigPath: parts.clientConfigPath === null || parts.clientConfigPath === undefined
      ? null
      : absolutePath(parts.clientConfigPath, "oauth.clientConfigPath"),
    realm: text(parts.realm, "oauth.realm"),
  });
}

function activityProviders(value) {
  if (!Array.isArray(value)) fail("activityProviders", "must be an array of session-transcript dialect names");
  const names = value.map((name, index) => text(name, `activityProviders[${index}]`));
  for (const name of names) {
    if (!SESSION_ACTIVITY_DIALECT_NAMES.includes(name)) {
      fail("activityProviders", `names no known session-transcript dialect: ${name} (known: ${SESSION_ACTIVITY_DIALECT_NAMES.join(", ")})`);
    }
  }
  if (new Set(names).size !== names.length) fail("activityProviders", "must not repeat a dialect");
  return Object.freeze(names);
}

function agentCard(value) {
  if (value === null || value === undefined) return null;
  const parts = object(value, "agentCard");
  return Object.freeze({
    path: absolutePath(parts.path, "agentCard.path"),
    actorName: text(parts.actorName, "agentCard.actorName", ACTOR_NAME_PATTERN),
  });
}

function peer(value) {
  if (value === null || value === undefined) return null;
  const parts = object(value, "peer");
  return Object.freeze({
    label: text(parts.label, "peer.label"),
    statusUrl: httpUrl(parts.statusUrl, "peer.statusUrl"),
  });
}

function reportProviders(value) {
  const parts = object(value ?? {}, "reportProviders");
  return Object.freeze({
    colonyUrl: optionalHttpUrl(parts.colonyUrl, "reportProviders.colonyUrl"),
    unionUrl: optionalHttpUrl(parts.unionUrl, "reportProviders.unionUrl"),
  });
}

function swarmMessages(value) {
  if (value === null || value === undefined) return null;
  const parts = object(value, "swarmMessages");
  return Object.freeze({ endpoint: httpUrl(parts.endpoint, "swarmMessages.endpoint") });
}

function runtimePulse(value) {
  if (value === null || value === undefined) return null;
  const parts = object(value, "runtimePulse");
  return Object.freeze({
    healthUrl: httpUrl(parts.healthUrl, "runtimePulse.healthUrl"),
    connectorMetricsUrl: httpUrl(parts.connectorMetricsUrl, "runtimePulse.connectorMetricsUrl"),
    providerActor: text(parts.providerActor, "runtimePulse.providerActor"),
    settlementActor: text(parts.settlementActor, "runtimePulse.settlementActor"),
    colonyActor: text(parts.colonyActor, "runtimePulse.colonyActor"),
  });
}

function actorRoutes(value) {
  const parts = object(value ?? {}, "activityPub.actorRoutes");
  const routes = {};
  for (const [actor, target] of Object.entries(parts)) {
    const where = `activityPub.actorRoutes.${actor}`;
    text(actor, where, ACTOR_NAME_PATTERN);
    routes[actor] = typeof target === "number" ? port(target, where) : origin(target, where);
  }
  return Object.freeze(routes);
}

function activityPub(value) {
  if (value === null || value === undefined) return null;
  const parts = object(value, "activityPub");
  return Object.freeze({
    colonyHost: text(parts.colonyHost, "activityPub.colonyHost", HOST_NAME_PATTERN),
    publicOrigin: origin(parts.publicOrigin, "activityPub.publicOrigin"),
    actorRoutes: actorRoutes(parts.actorRoutes),
    nodeInfoProviderPort: optionalPort(parts.nodeInfoProviderPort, "activityPub.nodeInfoProviderPort"),
    objectProviderPort: optionalPort(parts.objectProviderPort, "activityPub.objectProviderPort"),
  });
}

function x402(value) {
  if (value === null || value === undefined) return null;
  const parts = object(value, "x402");
  if (!Array.isArray(parts.fixedRoutes)) fail("x402.fixedRoutes", "must be an array of fixed metered routes");
  const seen = new Set();
  const fixedRoutes = parts.fixedRoutes.map((route, index) => {
    const where = `x402.fixedRoutes[${index}]`;
    const parsed = object(route, where);
    const method = text(parsed.method, `${where}.method`);
    if (!HTTP_METHODS.includes(method)) fail(`${where}.method`, `must be one of ${HTTP_METHODS.join(", ")}`);
    const path = text(parsed.path, `${where}.path`);
    if (!path.startsWith("/")) fail(`${where}.path`, "must be an absolute request path");
    const key = `${method} ${path}`;
    if (seen.has(key)) fail("x402.fixedRoutes", `binds ${key} twice`);
    seen.add(key);
    const upstreamPath = text(parsed.upstreamPath, `${where}.upstreamPath`);
    if (!upstreamPath.startsWith("/")) fail(`${where}.upstreamPath`, "must be an absolute upstream path");
    return Object.freeze({ method, path, upstreamPath, port: port(parsed.port, `${where}.port`) });
  });
  const providers = object(parts.providerRoutes ?? {}, "x402.providerRoutes");
  const providerRoutes = {};
  for (const [provider, bound] of Object.entries(providers)) {
    const where = `x402.providerRoutes.${provider}`;
    text(provider, where, PROVIDER_NAME_PATTERN);
    providerRoutes[provider] = port(bound, where);
  }
  return Object.freeze({
    fixedRoutes: Object.freeze(fixedRoutes),
    providerRoutes: Object.freeze(providerRoutes),
    meteredPathPrefix: text(parts.meteredPathPrefix ?? "/x402", "x402.meteredPathPrefix"),
  });
}

/**
 * Admits one already-parsed configuration value, returning the frozen
 * configuration this app runs on. Every refusal names the offending field.
 */
export function admitMachineStatusSiteConfiguration(value) {
  const parts = object(value, "the machine status-site configuration");
  if (parts.type !== MACHINE_STATUS_SITE_CONFIGURATION_TYPE) {
    fail("the machine status-site configuration", `must declare "type": "${MACHINE_STATUS_SITE_CONFIGURATION_TYPE}"`);
  }
  return Object.freeze({
    type: MACHINE_STATUS_SITE_CONFIGURATION_TYPE,
    machine: machine(parts.machine),
    site: site(parts.site),
    faces: faces(parts.faces),
    oauth: oauth(parts.oauth),
    activityProviders: activityProviders(parts.activityProviders),
    agentCard: agentCard(parts.agentCard),
    peer: peer(parts.peer),
    reportProviders: reportProviders(parts.reportProviders),
    swarmMessages: swarmMessages(parts.swarmMessages),
    runtimePulse: runtimePulse(parts.runtimePulse),
    activityPub: activityPub(parts.activityPub),
    x402: x402(parts.x402),
  });
}

/**
 * The configuration path this process was given: `--config <path>` (or
 * `--config=<path>`) on the command line, else the
 * MACHINE_STATUS_SITE_CONFIG environment variable. There is no default:
 * a machine that names no configuration has nothing to serve.
 */
export function machineStatusSiteConfigurationPath(argv = [], environment = {}) {
  const flag = argv.indexOf("--config");
  const inline = argv.find((argument) => argument.startsWith("--config="));
  const named = flag >= 0 ? argv[flag + 1] : inline ? inline.slice("--config=".length) : environment[CONFIGURATION_PATH_ENVIRONMENT_VARIABLE];
  if (typeof named !== "string" || named.length === 0) {
    throw new TypeError(`no machine status-site configuration was named: pass --config <path> or set ${CONFIGURATION_PATH_ENVIRONMENT_VARIABLE}`);
  }
  return named;
}

// Reused by ../scripts/read-machine-status-site-configuration.mjs, the one
// place this app touches a filesystem to obtain these documents.
export { object, text, absolutePath };
