// Collects a short activity pulse describing whether this status site's own
// runtime and its tunnel connector are up, for a colony-activity aggregator
// (e.g. @red-cup-engineering/colony-report-service) to fold into a wider
// report. Both endpoints and all three actor identities are parameters the
// machine's configuration supplies: no host, port, or colony is compiled in.

function sumMetric(text, name) {
  const values = text
    .split("\n")
    .filter((line) => line.startsWith(name) && !line.startsWith("#"))
    .map((line) => Number(line.trim().split(/\s+/u).at(-1)))
    .filter(Number.isFinite);
  return values.length ? String(values.reduce((sum, value) => sum + value, 0)) : "0";
}

async function checkHealth(fetchImpl, healthUrl, refusals) {
  try {
    const response = await fetchImpl(healthUrl);
    if (!response.ok) refusals.push({ domain: "operations", reason: `status site health endpoint returned HTTP ${response.status}` });
    return response.ok ? "1" : "0";
  } catch (error) {
    refusals.push({ domain: "operations", reason: `status site health endpoint unavailable: ${error instanceof Error ? error.message : String(error)}` });
    return "0";
  }
}

async function checkConnector(fetchImpl, connectorMetricsUrl, refusals) {
  try {
    const response = await fetchImpl(connectorMetricsUrl);
    if (!response.ok) {
      refusals.push({ domain: "operations", reason: `connector metrics endpoint returned HTTP ${response.status}` });
      return { connections: "0", requestErrors: "0" };
    }
    const body = await response.text();
    return { connections: sumMetric(body, "cloudflared_tunnel_ha_connections"), requestErrors: sumMetric(body, "cloudflared_tunnel_request_errors") };
  } catch (error) {
    refusals.push({ domain: "operations", reason: `connector metrics observation unavailable: ${error instanceof Error ? error.message : String(error)}` });
    return { connections: "0", requestErrors: "0" };
  }
}

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required to collect a status-site runtime pulse`);
  return value;
}

export async function collectStatusSiteRuntimeActivity({
  window,
  recordedAt,
  fetchImpl = fetch,
  healthUrl,
  connectorMetricsUrl,
  providerActor,
  settlementActor,
  colonyActor,
} = {}) {
  required(healthUrl, "healthUrl");
  required(connectorMetricsUrl, "connectorMetricsUrl");
  required(providerActor, "providerActor");
  required(settlementActor, "settlementActor");
  required(colonyActor, "colonyActor");
  const refusals = [];
  const siteAvailable = await checkHealth(fetchImpl, healthUrl, refusals);
  const { connections, requestErrors } = await checkConnector(fetchImpl, connectorMetricsUrl, refusals);
  return {
    type: "ColonyActivityPulseEnvelope",
    providerActor,
    settlementActor,
    colonyActor,
    window,
    recordedAt,
    events: [{
      id: `${providerActor}:event:${recordedAt}`,
      kind: "status-site-runtime-pulse",
      domain: "operations",
      outcome: siteAvailable === "1" ? "available" : "unavailable",
      summary: `Status site runtime ${siteAvailable === "1" ? "responded" : "did not respond"} at ${healthUrl}.`,
      occurredAt: recordedAt,
      quantities: [
        { label: "Status site runtime available", amount: siteAvailable, unit: "boolean" },
        { label: "Connector HA connections", amount: connections, unit: "connections" },
        { label: "Connector request errors", amount: requestErrors, unit: "errors" },
      ],
    }],
    refusals,
  };
}

/** Binds the collector to one machine's configured runtime-pulse parameters. */
export function statusSiteRuntimeActivityProvider(runtimePulse) {
  return {
    name: runtimePulse.providerActor,
    collect: ({ window, recordedAt }) => collectStatusSiteRuntimeActivity({ window, recordedAt, ...runtimePulse }),
  };
}
