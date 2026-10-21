import assert from "node:assert/strict";
import test from "node:test";
import { readReportProvider } from "../src/report-provider.mjs";

test("readReportProvider returns 503 when no provider URL is configured", async () => {
  const result = await readReportProvider({ providerUrl: undefined, unavailableType: "ColonyReportUnavailable" });
  assert.equal(result.status, 503);
  assert.equal(result.body.type, "ColonyReportUnavailable");
});

test("readReportProvider passes through a successful JSON object response", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ metrics: [] }), { status: 200 });
  const result = await readReportProvider({ providerUrl: "http://example.test/report", unavailableType: "X", fetchImpl });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { metrics: [] });
});

test("readReportProvider returns 503 when the provider responds with a non-object body", async () => {
  const fetchImpl = async () => new Response(JSON.stringify([1, 2, 3]), { status: 200 });
  const result = await readReportProvider({ providerUrl: "http://example.test/report", unavailableType: "X", fetchImpl });
  assert.equal(result.status, 503);
});

test("readReportProvider returns 503 with the upstream status when the provider is not ok", async () => {
  const fetchImpl = async () => new Response(null, { status: 500 });
  const result = await readReportProvider({ providerUrl: "http://example.test/report", unavailableType: "X", fetchImpl });
  assert.equal(result.status, 503);
  assert.equal(result.body.providerStatus, 500);
});

test("readReportProvider returns 503 when fetch throws", async () => {
  const fetchImpl = async (): Promise<Response> => { throw new Error("connection refused"); };
  const result = await readReportProvider({ providerUrl: "http://example.test/report", unavailableType: "X", fetchImpl });
  assert.equal(result.status, 503);
});
