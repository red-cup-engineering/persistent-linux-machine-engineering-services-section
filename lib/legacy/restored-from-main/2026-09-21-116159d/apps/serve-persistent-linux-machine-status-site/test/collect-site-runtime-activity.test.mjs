import assert from "node:assert/strict";
import test from "node:test";
import { collectStatusSiteRuntimeActivity, statusSiteRuntimeActivityProvider } from "../src/collect-site-runtime-activity.mjs";
const testWindow = {
    fromExclusive: "2026-08-20T00:00:00.000Z",
    toInclusive: "2026-08-20T01:00:00.000Z"
};
const recordedAt = "2026-08-20T01:00:00.000Z";
const pulseParameters = {
    healthUrl: "http://127.0.0.1:19748/healthz",
    connectorMetricsUrl: "http://127.0.0.1:20241/metrics",
    providerActor: "urn:ame:quiet-oak-hill-status-site:runtime-health-pulse-provider",
    settlementActor: "urn:ame:quiet-oak-hill-status-site",
    colonyActor: "urn:ame:quiet-oak-hill-colony"
};
function fetchFor(healthOk, metricsBody) {
    return async (url)=>{
        if (String(url).endsWith("/healthz")) return new Response(null, {
            status: healthOk ? 200 : 503
        });
        return new Response(metricsBody, {
            status: 200
        });
    };
}
test("reports the site as available and sums connector metrics when both endpoints answer", async ()=>{
    const metrics = "cloudflared_tunnel_ha_connections{edge=\"a\"} 2\ncloudflared_tunnel_ha_connections{edge=\"b\"} 1\ncloudflared_tunnel_request_errors 0\n";
    const pulse = await collectStatusSiteRuntimeActivity({
        ...pulseParameters,
        window: testWindow,
        recordedAt,
        fetchImpl: fetchFor(true, metrics)
    });
    assert.equal(pulse.type, "ColonyActivityPulseEnvelope");
    assert.equal(pulse.providerActor, pulseParameters.providerActor);
    assert.equal(pulse.colonyActor, pulseParameters.colonyActor);
    assert.equal(pulse.events[0].outcome, "available");
    const byLabel = new Map(pulse.events[0].quantities.map((quantity)=>[
            quantity.label,
            quantity.amount
        ]));
    assert.equal(byLabel.get("Status site runtime available"), "1");
    assert.equal(byLabel.get("Connector HA connections"), "3");
    assert.equal(pulse.refusals.length, 0);
});
test("records a refusal and reports unavailable when the health endpoint fails", async ()=>{
    const pulse = await collectStatusSiteRuntimeActivity({
        ...pulseParameters,
        window: testWindow,
        recordedAt,
        fetchImpl: fetchFor(false, "")
    });
    assert.equal(pulse.events[0].outcome, "unavailable");
    assert.ok(pulse.refusals.some((refusal)=>refusal.domain === "operations"));
});
test("records a refusal when a fetch throws", async ()=>{
    const fetchImpl = async ()=>{
        throw new Error("network down");
    };
    const pulse = await collectStatusSiteRuntimeActivity({
        ...pulseParameters,
        window: testWindow,
        recordedAt,
        fetchImpl
    });
    assert.ok(pulse.refusals.some((refusal)=>refusal.reason.includes("network down")));
});
test("every endpoint and actor identity is required: nothing about a host is compiled in", async ()=>{
    for (const omitted of Object.keys(pulseParameters)){
        const parameters = {
            ...pulseParameters,
            window: testWindow,
            recordedAt
        };
        delete parameters[omitted];
        await assert.rejects(()=>collectStatusSiteRuntimeActivity(parameters), new RegExp(`${omitted} is required`, "u"));
    }
});
test("statusSiteRuntimeActivityProvider binds the pulse as a named colony-report provider", async ()=>{
    const provider = statusSiteRuntimeActivityProvider(pulseParameters);
    assert.equal(provider.name, pulseParameters.providerActor);
    const pulse = await provider.collect({
        window: testWindow,
        recordedAt
    });
    assert.equal(pulse.type, "ColonyActivityPulseEnvelope");
});
