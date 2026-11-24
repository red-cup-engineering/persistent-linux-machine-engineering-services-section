import assert from "node:assert/strict";
import test from "node:test";
import { defineProvider } from "@red-cup-engineering/fare/provider";
import { composeProviders } from "@red-cup-engineering/fare/compositor";
import { projectMachineComposition } from "../src/machine-fars.mts";
import { civicReportPage } from "../src/civic-report-page.mjs";

const observedAt = "2026-08-20T00:00:00.000Z";

test("machine rendering is derived from composed graph cells and retains failed providers", async () => {
  const observed = defineProvider({ id: "urn:fars:provider:test", async observe() { return { resources: [{
    resource: "urn:test:health", focus: "urn:test:machine", observedAt, diagnostics: [], cells: [
      { subject: "urn:test:machine", predicate: "urn:fars:type", object: "urn:fars:type:machine" },
      { subject: "urn:test:machine", predicate: "urn:fars:node-name", object: "test-machine" },
      { subject: "urn:test:machine", predicate: "compute-load-1m", object: "0.5" },
      { subject: "urn:test:process", predicate: "urn:fars:type", object: "urn:fars:type:os-process" },
      { subject: "urn:test:process", predicate: "os-pid", object: "42" },
      { subject: "urn:test:process", predicate: "process-role-hint", object: "agent" },
    ],
  }] }; } });
  const failed = defineProvider({ id: "urn:fars:provider:failed", async observe() { throw new Error("not present"); } });
  const projection = projectMachineComposition(await composeProviders([observed, failed], { onProviderError: "diagnose" }));
  assert.equal(projection.health?.nodeName, "test-machine");
  assert.equal(projection.processes[0].pid, 42);
  assert.deepEqual(projection.providers.map(({ status }) => status), ["observed", "failed"]);
  assert.equal(projection.diagnostics[0].code, "provider-observation-failed");
});

test("the machine-local shell bootstraps without remote OAuth while the relay shell does not", () => {
  assert.match(civicReportPage({ localFace: true }), /const localFace=true/u);
  assert.match(civicReportPage({ localFace: false }), /const localFace=false/u);
});
