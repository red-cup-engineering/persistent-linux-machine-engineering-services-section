import assert from "node:assert/strict";
import test from "node:test";
import { admittedSwarmMessageEndpoint, submitSwarmMessage } from "../src/swarm-message-provider.mts";

const endpoint = "http://127.0.0.1:8796/messages";

test("submitSwarmMessage rejects a non-string message", async () => {
  const result = await submitSwarmMessage(42, { endpoint });
  assert.equal(result.status, 400);
  assert.equal(result.body.status, "failed");
});

test("submitSwarmMessage rejects a blank message", async () => {
  assert.equal((await submitSwarmMessage("   ", { endpoint })).status, 400);
});

test("submitSwarmMessage rejects a message over the byte limit", async () => {
  assert.equal((await submitSwarmMessage("a".repeat(16_001), { endpoint })).status, 413);
});

test("the endpoint is required: there is no compiled-in swarm provider", () => {
  assert.throws(() => admittedSwarmMessageEndpoint(undefined), /endpoint is required/u);
});

test("an endpoint that is not the loopback /messages service is refused", () => {
  assert.throws(() => admittedSwarmMessageEndpoint("http://example.com/messages"), /loopback-only \/messages service/u);
  assert.throws(() => admittedSwarmMessageEndpoint("http://127.0.0.1:8796/other"), /loopback-only \/messages service/u);
  assert.equal(admittedSwarmMessageEndpoint(endpoint).port, "8796");
});

test("submitSwarmMessage refuses an endpoint that is not the loopback /messages service", async () => {
  await assert.rejects(() => submitSwarmMessage("hi", { endpoint: "http://example.com/messages" }));
});

test("submitSwarmMessage returns the provider's result on success", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ type: "SwarmMessageResult", status: "completed", result: "hello" }), { status: 200 });
  const result = await submitSwarmMessage("hi", { endpoint, fetchImpl });
  assert.equal(result.status, 200);
  assert.equal(result.body.result, "hello");
});

test("submitSwarmMessage returns 502 when the provider returns an invalid envelope", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ nope: true }), { status: 200 });
  assert.equal((await submitSwarmMessage("hi", { endpoint, fetchImpl })).status, 502);
});

test("submitSwarmMessage returns 502 when the provider is unreachable", async () => {
  const fetchImpl = async (): Promise<Response> => { throw new Error("ECONNREFUSED"); };
  const result = await submitSwarmMessage("hi", { endpoint, fetchImpl });
  assert.equal(result.status, 502);
  assert.match(result.body.reason ?? "", /ECONNREFUSED/);
});
