#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argument as option } from "@red-cup-engineering/parse-javascript-argv-service";
import { createSemanticRecordJournal } from "@red-cup-engineering/semantic-record-journal-service";
import { observeSetOfUnitResourceAccounting, serviceUnitNames } from "@red-cup-engineering/systemd-unit-inventory-observation-service/resource-accounting";
import { deriveSetOfUnitResourceReceipts } from "@red-cup-engineering/systemd-unit-inventory-observation-service/resource-receipts";

/** This section's own root -- the default semantic-record-journal custody root (writes land at data/logs/, per house data-custody law: a journal's content/claim feeds are an append-only event stream, not a records/ receipt). */
export const NODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** This host's SSH destination / systemctl --host identity, fixed: this script meters only Cold Red Gate. */
export const HOST = "cold-red-gate";

export const OBSERVATION_OBJECT_KIND = "cold-red-gate.unit-resource-observation";
export const OBSERVATION_CATEGORY = "cold-red-gate.unit-resource-observation";
export const RECEIPT_OBJECT_KIND = "cold-red-gate.unit-resource-receipt";
export const RECEIPT_CATEGORY = "cold-red-gate.unit-resource-receipt";

function collectRepeated(name, argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name) values.push(argv[index + 1]);
  }
  return values;
}

function latestObservationByUnit(rows) {
  const latest = new Map();
  for (const row of rows) {
    const observation = row.record;
    const existing = latest.get(observation.unit);
    if (!existing || observation.observedAt > existing.observedAt) latest.set(observation.unit, observation);
  }
  return latest;
}

/**
 * Observes Cold Red Gate's live systemd resource-accounting state for the
 * given units (default: every *.service unit in its current inventory),
 * records each observation, and -- for any unit that already has a prior
 * observation in this journal -- derives and records the resource-consumed
 * receipts (cpu-seconds, memory-peak-bytes, network-ingress/egress-bytes)
 * for the interval between the two. This die stays host-agnostic and
 * writes nowhere; this script is the one place resource metering actually
 * gets persisted for this host.
 * @param {{units?: string[], dataRoot?: string, recordedAt?: string, run?: (command: string, args: string[]) => string}} [options] -
 *   `run` overrides the systemctl/ssh transport; tests inject a fake so no real ssh call is ever made.
 * @returns {{observations: object[], receipts: object[]}} the journal's own record() receipts for every write this call made.
 */
export function recordColdRedGateUnitResourceUsage({ units, dataRoot, recordedAt, run } = {}) {
  const root = resolve(dataRoot ?? NODE_ROOT);
  const journal = createSemanticRecordJournal({ root });
  const unitNames = units && units.length > 0 ? units : serviceUnitNames(HOST, { run });
  const observations = observeSetOfUnitResourceAccounting(HOST, unitNames, { run });
  const priorByUnit = latestObservationByUnit(
    journal.query({ objectKind: OBSERVATION_OBJECT_KIND, category: OBSERVATION_CATEGORY }),
  );

  const observationReceipts = [];
  const resourceReceipts = [];
  for (const observation of observations) {
    observationReceipts.push(journal.record({
      objectKind: OBSERVATION_OBJECT_KIND,
      category: OBSERVATION_CATEGORY,
      record: observation,
      recordedAt: recordedAt ?? observation.observedAt,
      charge: { support: true, refutation: false },
    }));
    const prior = priorByUnit.get(observation.unit);
    if (!prior) continue;
    for (const receipt of deriveSetOfUnitResourceReceipts([prior], [observation])) {
      resourceReceipts.push(journal.record({
        objectKind: RECEIPT_OBJECT_KIND,
        category: RECEIPT_CATEGORY,
        record: receipt,
        recordedAt: recordedAt ?? observation.observedAt,
        charge: { support: true, refutation: false },
      }));
    }
  }
  return { observations: observationReceipts, receipts: resourceReceipts };
}

if (import.meta.main) {
  try {
    const units = collectRepeated("--unit", process.argv);
    const dataRoot = option("--root");
    process.stdout.write(`${JSON.stringify(recordColdRedGateUnitResourceUsage({ units, dataRoot }), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
