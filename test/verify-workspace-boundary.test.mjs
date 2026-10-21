import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { findWorkspaceBoundaryViolations, readBoundaryConfig } from "../scripts/verify-workspace-boundary.mjs";

const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts", "verify-workspace-boundary.mjs");

function makeHome() {
  return mkdtempSync(join(tmpdir(), "workspace-boundary-home-"));
}

test("reports no violations against a clean home", async () => {
  const home = makeHome();
  try {
    const violations = await findWorkspaceBoundaryViolations(
      { retiredHomeEntries: ["retired-dir"], retiredStateEntries: [[".config", "retired-app"]] },
      { home },
    );
    assert.deepEqual(violations, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("flags a retired top-level home entry and a retired state directory", async () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, "retired-dir"));
    mkdirSync(join(home, ".config", "retired-app"), { recursive: true });
    const violations = await findWorkspaceBoundaryViolations(
      { retiredHomeEntries: ["retired-dir"], retiredStateEntries: [[".config", "retired-app"]] },
      { home },
    );
    assert.deepEqual(new Set(violations), new Set([
      join(home, "retired-dir"),
      join(home, ".config", "retired-app"),
    ]));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("flags an installed systemd user unit matching the configured forbidden pattern", async () => {
  const home = makeHome();
  try {
    const unitDirectory = join(home, ".config", "systemd", "user");
    mkdirSync(unitDirectory, { recursive: true });
    writeFileSync(join(unitDirectory, "innocuous.service"), "[Unit]\nDescription=fine\n");
    writeFileSync(join(unitDirectory, "retired-project.service"), "[Unit]\nDescription=retired-example-project unit\n");
    const violations = await findWorkspaceBoundaryViolations(
      { retiredHomeEntries: [], retiredStateEntries: [], forbiddenUserUnitPattern: "retired-example-project" },
      { home },
    );
    assert.deepEqual(violations, [join(unitDirectory, "retired-project.service")]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("skips the systemd user-unit scan entirely when no pattern is configured", async () => {
  const home = makeHome();
  try {
    const unitDirectory = join(home, ".config", "systemd", "user");
    mkdirSync(unitDirectory, { recursive: true });
    writeFileSync(join(unitDirectory, "anything.service"), "[Unit]\nDescription=whatever\n");
    const violations = await findWorkspaceBoundaryViolations({ retiredHomeEntries: [], retiredStateEntries: [] }, { home });
    assert.deepEqual(violations, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("readBoundaryConfig refuses a config that is not a JSON object", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-boundary-config-"));
  try {
    const path = join(directory, "config.json");
    writeFileSync(path, "[1, 2, 3]");
    await assert.rejects(() => readBoundaryConfig(path), /JSON object/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the CLI requires --config and exits nonzero without it", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--config=<path> is required/);
});

test("the CLI exits zero on a clean home and nonzero, listing violations, on a dirty one", () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-boundary-cli-"));
  const home = join(directory, "home");
  mkdirSync(home, { recursive: true });
  try {
    const configPath = join(directory, "config.json");
    writeFileSync(configPath, JSON.stringify({ retiredHomeEntries: ["old-stuff"], retiredStateEntries: [] }));
    const environment = { ...process.env, HOME: home };
    const clean = spawnSync(process.execPath, [script, `--config=${configPath}`], { encoding: "utf8", env: environment });
    assert.equal(clean.status, 0, clean.stderr);

    mkdirSync(join(home, "old-stuff"));
    const dirty = spawnSync(process.execPath, [script, `--config=${configPath}`], { encoding: "utf8", env: environment });
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /old-stuff/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
