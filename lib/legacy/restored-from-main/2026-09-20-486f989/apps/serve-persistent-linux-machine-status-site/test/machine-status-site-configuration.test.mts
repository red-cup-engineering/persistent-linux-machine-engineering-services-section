import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONFIGURATION_PATH_ENVIRONMENT_VARIABLE,
  admitMachineStatusSiteConfiguration,
  machineStatusSiteConfigurationPath,
} from "../src/machine-status-site-configuration.mjs";
import { readMachineStatusSiteConfiguration, readOAuthClientEnvironment } from "../scripts/read-machine-status-site-configuration.mjs";

// One complete configuration for a machine that is not the machine this
// package was folded out of: nothing host-specific is compiled in, so the
// fixture names an entirely different host.
function configuration(overrides: Record<string, unknown> = {}) {
  return {
    type: "PersistentLinuxMachineStatusSite",
    machine: { nodeName: "quiet-oak-hill", displayName: "Quiet Oak Hill", systemdScope: "local" },
    site: { title: "quiet-oak-hill", summary: "Status dashboard for the quiet-oak-hill host.", publicOrigin: "https://quiet-oak-hill.example" },
    faces: {
      mutable: { host: "127.0.0.1", port: 19749 },
      readOnly: [{ transport: "tunnel connector", host: "127.0.0.1", port: 19748 }],
    },
    oauth: { allowedEmails: ["Operator@Example.test"], stateDir: "/var/lib/status-site/oauth", clientConfigPath: null, realm: "quiet-oak-hill-state" },
    activityProviders: ["codex", "claude"],
    agentCard: null,
    peer: { label: "operations", statusUrl: "https://ops.example/.well-known/oauth-authorization-server" },
    reportProviders: { colonyUrl: null, unionUrl: null },
    swarmMessages: { endpoint: "http://127.0.0.1:8796/messages" },
    runtimePulse: {
      healthUrl: "http://127.0.0.1:19748/healthz",
      connectorMetricsUrl: "http://127.0.0.1:20241/metrics",
      providerActor: "urn:ame:quiet-oak-hill-status-site:runtime-health-pulse-provider",
      settlementActor: "urn:ame:quiet-oak-hill-status-site",
      colonyActor: "urn:ame:quiet-oak-hill-colony",
    },
    activityPub: { colonyHost: "quiet-oak-hill.example", publicOrigin: "https://quiet-oak-hill.example", actorRoutes: { codex: 8794 }, nodeInfoProviderPort: 8794, objectProviderPort: null },
    x402: { fixedRoutes: [{ method: "POST", path: "/compute/inference", upstreamPath: "/inference", port: 4022 }], providerRoutes: { acme: 9000 }, meteredPathPrefix: "/x402" },
    ...overrides,
  };
}

test("admits a complete configuration and normalizes the admitted accounts", () => {
  const admitted = admitMachineStatusSiteConfiguration(configuration());
  assert.equal(admitted.machine.nodeName, "quiet-oak-hill");
  assert.equal(admitted.site.publicOrigin, "https://quiet-oak-hill.example");
  assert.deepEqual(admitted.oauth.allowedEmails, ["operator@example.test"]);
  assert.deepEqual(admitted.faces.readOnly.map(({ transport }) => transport), ["tunnel connector"]);
  assert.deepEqual([...admitted.activityProviders], ["codex", "claude"]);
  assert.equal(Object.isFrozen(admitted), true);
});

test("every optional face of the site may be absent", () => {
  const admitted = admitMachineStatusSiteConfiguration(configuration({
    agentCard: null, peer: null, swarmMessages: null, runtimePulse: null, activityPub: null, x402: null,
    activityProviders: [], faces: { mutable: { host: "127.0.0.1", port: 19749 }, readOnly: [] },
  }));
  assert.equal(admitted.peer, null);
  assert.equal(admitted.swarmMessages, null);
  assert.equal(admitted.activityPub, null);
  assert.equal(admitted.x402, null);
  assert.deepEqual(admitted.faces.readOnly, []);
});

test("refuses a document that does not declare the configuration type", () => {
  assert.throws(() => admitMachineStatusSiteConfiguration(configuration({ type: "SomethingElse" })), /must declare "type"/u);
  assert.throws(() => admitMachineStatusSiteConfiguration(null), TypeError);
});

test("refuses a public origin carrying a path, query, or credentials", () => {
  assert.throws(() => admitMachineStatusSiteConfiguration(configuration({ site: { title: "t", summary: "s", publicOrigin: "https://host.example/base" } })), /site.publicOrigin/u);
  assert.throws(() => admitMachineStatusSiteConfiguration(configuration({ site: { title: "t", summary: "s", publicOrigin: "https://user:pass@host.example" } })), /site.publicOrigin/u);
});

test("refuses two listeners bound to the same host and port", () => {
  assert.throws(() => admitMachineStatusSiteConfiguration(configuration({
    faces: { mutable: { host: "127.0.0.1", port: 19749 }, readOnly: [{ transport: "relay", host: "127.0.0.1", port: 19749 }] },
  })), /distinct host:port/u);
});

test("refuses a relative OAuth state directory and an empty account list", () => {
  assert.throws(() => admitMachineStatusSiteConfiguration(configuration({ oauth: { allowedEmails: ["a@b.test"], stateDir: "data/state", clientConfigPath: null, realm: "r" } })), /absolute filesystem path/u);
  assert.throws(() => admitMachineStatusSiteConfiguration(configuration({ oauth: { allowedEmails: [], stateDir: "/s", clientConfigPath: null, realm: "r" } })), /at least one admitted Google account/u);
});

test("refuses an activity provider that names no known session-transcript dialect", () => {
  assert.throws(() => admitMachineStatusSiteConfiguration(configuration({ activityProviders: ["telepathy"] })), /no known session-transcript dialect/u);
  assert.throws(() => admitMachineStatusSiteConfiguration(configuration({ activityProviders: ["codex", "codex"] })), /must not repeat a dialect/u);
});

test("refuses an x402 table that binds one method and path twice, or a bad port", () => {
  assert.throws(() => admitMachineStatusSiteConfiguration(configuration({
    x402: { fixedRoutes: [{ method: "POST", path: "/a", upstreamPath: "/a", port: 1 }, { method: "POST", path: "/a", upstreamPath: "/b", port: 2 }], providerRoutes: {} },
  })), /binds POST \/a twice/u);
  assert.throws(() => admitMachineStatusSiteConfiguration(configuration({
    x402: { fixedRoutes: [{ method: "POST", path: "/a", upstreamPath: "/a", port: 70000 }], providerRoutes: {} },
  })), /must name a TCP port/u);
});

test("reads and admits a configuration document from an absolute path", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "machine-status-site-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "site.json");
  writeFileSync(path, JSON.stringify(configuration()));
  assert.equal((await readMachineStatusSiteConfiguration(path)).machine.nodeName, "quiet-oak-hill");
  await assert.rejects(() => readMachineStatusSiteConfiguration("site.json"), /absolute filesystem path/u);
  await assert.rejects(() => readMachineStatusSiteConfiguration(join(dir, "absent.json")), /not readable JSON/u);
});

test("the configuration path comes from --config or the environment, never a default", () => {
  assert.equal(machineStatusSiteConfigurationPath(["--config", "/etc/site.json"], {}), "/etc/site.json");
  assert.equal(machineStatusSiteConfigurationPath(["--config=/etc/site.json"], {}), "/etc/site.json");
  assert.equal(machineStatusSiteConfigurationPath([], { [CONFIGURATION_PATH_ENVIRONMENT_VARIABLE]: "/etc/site.json" }), "/etc/site.json");
  assert.throws(() => machineStatusSiteConfigurationPath([], {}), /no machine status-site configuration was named/u);
});

test("OAuth client credentials come from the named secrets file, else the environment", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "machine-status-site-oauth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fromEnvironment = admitMachineStatusSiteConfiguration(configuration());
  assert.deepEqual(await readOAuthClientEnvironment(fromEnvironment, { GOOGLE_CLIENT_ID: "from-env" }), { GOOGLE_CLIENT_ID: "from-env" });
  const clientConfigPath = join(dir, "client.json");
  writeFileSync(clientConfigPath, JSON.stringify({ googleClientId: "id", googleClientSecret: "secret" }));
  const fromFile = admitMachineStatusSiteConfiguration(configuration({
    oauth: { allowedEmails: ["a@b.test"], stateDir: "/s", clientConfigPath, realm: "r" },
  }));
  const environment = await readOAuthClientEnvironment(fromFile, { PATH: "/usr/bin" });
  assert.equal(environment.GOOGLE_CLIENT_ID, "id");
  assert.equal(environment.GOOGLE_CLIENT_SECRET, "secret");
  assert.equal(environment.PATH, "/usr/bin");
});
