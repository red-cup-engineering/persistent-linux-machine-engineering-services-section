import assert from "node:assert/strict";
import test from "node:test";
import { projectMachineComposition } from "../src/machine-projection.mts";

type Cell = { subject: string; predicate: string; object: string };

// The projection reads a composed predication graph and returns a value, so
// these tests hand it literal compositions rather than running the FARS
// compositor: the compositor is its owner's concern, this is the projection's.
function composition({ cells = [], resources = [], providers = [], diagnostics = [] }: {
  cells?: Cell[];
  resources?: { observedAt: string }[];
  providers?: { id: string; status: string }[];
  diagnostics?: { code: string }[];
}) {
  return { store: { order: cells }, resources, providers, diagnostics } as never;
}

const observedAt = "2026-08-20T00:00:00.000Z";
const machineCells: Cell[] = [
  { subject: "urn:test:machine", predicate: "urn:fars:type", object: "urn:fars:type:machine" },
  { subject: "urn:test:machine", predicate: "urn:fars:node-name", object: "quiet-oak-hill" },
  { subject: "urn:test:machine", predicate: "compute-load-1m", object: "0.5" },
  { subject: "urn:test:machine", predicate: "cpu-core-count", object: "8" },
  { subject: "urn:test:machine", predicate: "free-memory-bytes", object: "1024" },
  { subject: "urn:test:machine", predicate: "total-memory-bytes", object: "4096" },
];

test("machine health is derived from the composed graph cells", () => {
  const projection = projectMachineComposition(composition({ cells: machineCells, resources: [{ observedAt }] }));
  assert.equal(projection.type, "LinuxMachineFarsProjection");
  assert.equal(projection.observedAt, observedAt);
  assert.equal(projection.health?.nodeName, "quiet-oak-hill");
  // An absent numeric cell reads as 0, not null: Number(null) is 0 and 0 is
  // finite. This is the shape the dashboard has always been handed.
  assert.deepEqual(projection.health?.load, [0.5, 0, 0]);
  assert.equal(projection.health?.cpuCores, 8);
  assert.deepEqual(projection.health?.memory, { freeBytes: 1024, totalBytes: 4096 });
  assert.deepEqual(projection.graph, { resources: 1, cells: machineCells.length });
});

test("a graph with no machine cell projects null health rather than inventing one", () => {
  const projection = projectMachineComposition(composition({ resources: [{ observedAt }] }));
  assert.equal(projection.health, null);
  assert.deepEqual(projection.processes, []);
  assert.deepEqual(projection.units, []);
});

test("processes sort agents before scripts, then by resident memory", () => {
  const process = (id: string, pid: string, role: string, memory: string): Cell[] => [
    { subject: id, predicate: "urn:fars:type", object: "urn:fars:type:os-process" },
    { subject: id, predicate: "os-pid", object: pid },
    { subject: id, predicate: "process-role-hint", object: role },
    { subject: id, predicate: "resident-memory-bytes", object: memory },
  ];
  const projection = projectMachineComposition(composition({ cells: [
    ...process("urn:test:other", "3", "other", "900"),
    ...process("urn:test:script", "2", "script", "100"),
    ...process("urn:test:small-agent", "1", "agent", "10"),
    ...process("urn:test:big-agent", "4", "agent", "500"),
  ], resources: [{ observedAt }] }));
  assert.deepEqual(projection.processes.map(({ pid }) => pid), [4, 1, 2, 3]);
});

test("only .service units are projected, sorted by unit name", () => {
  const unit = (id: string, name: string): Cell[] => [
    { subject: id, predicate: "urn:fars:type", object: "urn:fars:type:systemd-unit" },
    { subject: id, predicate: "urn:fars:unit-name", object: name },
    { subject: id, predicate: "urn:fars:unit-active", object: "active" },
  ];
  const projection = projectMachineComposition(composition({ cells: [
    ...unit("urn:test:b", "b.service"),
    ...unit("urn:test:socket", "c.socket"),
    ...unit("urn:test:a", "a.service"),
  ], resources: [{ observedAt }] }));
  assert.deepEqual(projection.units.map(({ name }) => name), ["a.service", "b.service"]);
});

test("activity events project newest first with their quantities", () => {
  const event = (id: string, kind: string, at: string, amount: string): Cell[] => [
    { subject: id, predicate: "urn:fars:type", object: "urn:fars:type:activity-event" },
    { subject: id, predicate: "urn:fars:event-kind", object: kind },
    { subject: id, predicate: "urn:fars:event-domain", object: "work" },
    { subject: id, predicate: "urn:fars:occurred-at", object: at },
    { subject: id, predicate: "urn:fars:has-quantity", object: `${id}:quantity` },
    { subject: `${id}:quantity`, predicate: "urn:fars:quantity-label", object: "Turns" },
    { subject: `${id}:quantity`, predicate: "urn:fars:quantity-amount", object: amount },
    { subject: `${id}:quantity`, predicate: "urn:fars:quantity-unit", object: "turns" },
  ];
  const projection = projectMachineComposition(composition({ cells: [
    ...event("urn:test:codex", "interactive-codex-work-observed", "2026-08-19T23:30:00.000Z", "1"),
    ...event("urn:test:claude", "interactive-claude-work-observed", observedAt, "2"),
  ], resources: [{ observedAt }] }));
  assert.deepEqual(projection.activity.map(({ kind, quantities }) => [kind, quantities[0]?.amount]), [
    ["interactive-claude-work-observed", "2"],
    ["interactive-codex-work-observed", "1"],
  ]);
});

test("timers are projected separately from services", () => {
  const projection = projectMachineComposition(composition({ cells: [
    { subject: "urn:test:timer", predicate: "urn:fars:type", object: "urn:fars:type:systemd-timer" },
    { subject: "urn:test:timer", predicate: "urn:fars:unit-name", object: "nightly.timer" },
    { subject: "urn:test:timer", predicate: "urn:fars:timer-activates", object: "nightly.service" },
    { subject: "urn:test:timer", predicate: "urn:fars:timer-next-microseconds", object: "42" },
  ], resources: [{ observedAt }] }));
  assert.deepEqual(projection.timers, [{ id: "urn:test:timer", name: "nightly.timer", activates: "nightly.service", nextMicroseconds: 42 }]);
});

test("a failed provider and its diagnostic survive into the projection", () => {
  const projection = projectMachineComposition(composition({
    cells: machineCells,
    resources: [{ observedAt }],
    providers: [{ id: "urn:fars:provider:observed", status: "observed" }, { id: "urn:fars:provider:failed", status: "failed" }],
    diagnostics: [{ code: "provider-observation-failed" }],
  }));
  assert.deepEqual(projection.providers.map(({ status }) => status), ["observed", "failed"]);
  assert.equal(projection.diagnostics[0].code, "provider-observation-failed");
});

test("the latest observation instant across resources is the projection's instant", () => {
  const projection = projectMachineComposition(composition({
    cells: machineCells,
    resources: [{ observedAt: "2026-08-19T00:00:00.000Z" }, { observedAt }, { observedAt: "2026-08-18T00:00:00.000Z" }],
  }));
  assert.equal(projection.observedAt, observedAt);
});
