#!/usr/bin/env node
import { readFileText } from "@red-cup-engineering/file-services/read-file";
import { argument as option } from "@red-cup-engineering/parse-javascript-argv-service";
import { projectFileUrlFilepath } from "@red-cup-engineering/project-file-url-filepath-service";
import { projectFilepathDirectory } from "@red-cup-engineering/project-filepath-directory-service";
import { resolveFilepath } from "@red-cup-engineering/resolve-filepath-service";
import { invokeSystemctlUser } from "@red-cup-engineering/systemd-unit-inventory-observation-service";
import { cutPackageRelease } from "../scripts/cut-package-release.mjs";
import { repointUserUnit, rewriteUnitKeyLine } from "../scripts/repoint-user-unit.mjs";

/** This section's own root. */
export const NODE_ROOT = resolveFilepath([projectFilepathDirectory(projectFileUrlFilepath(import.meta.url)), ".."]);

function refusal(step, reason, evidence) {
  return { step, reason, evidence };
}

function parseShowOutput(text) {
  const properties = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    properties[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return properties;
}

/**
 * Rewrites every ExecStart whitespace-separated token equal to, or nested
 * under, `oldPrefix` to use `newPrefix` instead; every other token (the
 * interpreter, flags, arguments outside the old package directory) is left
 * untouched. Whitespace between tokens is preserved exactly.
 * @param {string} execStart
 * @param {string} oldPrefix - the package directory a release replaces.
 * @param {string} newPrefix - the release's `current` symlink path.
 * @returns {string}
 */
export function rewriteExecStartPrefix(execStart, oldPrefix, newPrefix) {
  return execStart
    .split(/(\s+)/u)
    .map((token) => {
      if (/^\s+$/u.test(token) || token.length === 0) return token;
      if (token === oldPrefix) return newPrefix;
      if (token.startsWith(`${oldPrefix}/`)) return newPrefix + token.slice(oldPrefix.length);
      return token;
    })
    .join("");
}

/**
 * Releases one package onto this local host and repoints a named systemd
 * `--user` unit at it: reads the unit's own file to learn its package
 * directory and current `ExecStart=` (when `packageDir` is not given
 * explicitly), cuts a dated release via `cutPackageRelease`, repoints the
 * unit at the release's `current` path via `repointUserUnit`, and restarts
 * the unit only when it was already active before this call -- an inactive
 * unit stays inactive.
 * @param {object} options
 * @param {string} options.unit - the systemd `--user` unit name (e.g. "my-thing.service").
 * @param {string} [options.packageDir] - overrides the package directory read from the unit's own `WorkingDirectory=` line.
 * @param {string} [options.releasesRoot] - overrides the releases root `cutPackageRelease` uses.
 * @param {boolean} [options.apply] - when false (default), only plans and performs no mutation; true performs the release, repoint, and any restart.
 * @param {string} [options.dataRoot] - overrides the semantic-record-journal custody root the two composed scripts journal to (tests only).
 * @param {string} [options.recordedAt] - overrides each composed receipt's recordedAt (tests only).
 * @param {(command: string, args: string[]) => string} [options.run] - overrides the local command transport (tests only).
 * @returns {Promise<object>} `{outcome: "planned"|"released"|"refused", ...}`.
 */
export async function releasePackageOnHost({ unit, packageDir, releasesRoot, apply = false, dataRoot, recordedAt, run } = {}) {
  if (!unit) return { outcome: "refused", refusals: [refusal("usage", "unit is required", null)] };

  const showOptions = run ? { run } : {};
  const properties = parseShowOutput(invokeSystemctlUser("local", ["show", "-p", "FragmentPath,ActiveState", unit], showOptions));
  const unitFile = properties.FragmentPath;
  if (!unitFile) {
    return { outcome: "refused", unit, refusals: [refusal("unit-not-found", `systemctl --user show reported no FragmentPath for ${unit}`, unit)] };
  }

  let unitText;
  try {
    unitText = await readFileText(unitFile);
  } catch (error) {
    return { outcome: "refused", unit, unitFile, refusals: [refusal("unit-file-unreadable", error.message, unitFile)] };
  }

  const wd = rewriteUnitKeyLine(unitText, "WorkingDirectory", "");
  const es = rewriteUnitKeyLine(unitText, "ExecStart", "");
  const effectivePackageDir = packageDir ?? (wd.found ? wd.previous : null);
  if (!effectivePackageDir) {
    return { outcome: "refused", unit, unitFile, refusals: [refusal("package-dir-undetermined", `${unitFile} carries no WorkingDirectory= line, and no packageDir was given`, unitFile)] };
  }
  if (!es.found) {
    return { outcome: "refused", unit, unitFile, packageDir: effectivePackageDir, refusals: [refusal("exec-start-missing", `${unitFile} carries no ExecStart= line`, unitFile)] };
  }

  const wasActive = properties.ActiveState === "active";

  if (!apply) {
    return {
      outcome: "planned",
      unit,
      unitFile,
      packageDir: effectivePackageDir,
      currentWorkingDirectory: wd.previous,
      currentExecStart: es.previous,
      wasActive,
    };
  }

  const releaseOptions = run ? { run } : {};
  const releaseResult = await cutPackageRelease({ packageDir: effectivePackageDir, releasesRoot, dataRoot, recordedAt, ...releaseOptions });
  if (releaseResult.outcome === "refused") {
    return { outcome: "refused", stage: "cut-package-release", unit, unitFile, packageDir: effectivePackageDir, refusals: releaseResult.refusals };
  }

  const newWorkingDirectory = releaseResult.current;
  const newExecStart = rewriteExecStartPrefix(es.previous, effectivePackageDir, newWorkingDirectory);

  const repointResult = await repointUserUnit({ unitFile, workingDirectory: newWorkingDirectory, execStart: newExecStart, dataRoot, recordedAt, ...releaseOptions });
  if (repointResult.outcome === "refused") {
    return { outcome: "refused", stage: "repoint-user-unit", unit, unitFile, packageDir: effectivePackageDir, release: releaseResult, refusals: repointResult.refusals };
  }

  let restarted = false;
  if (wasActive) {
    invokeSystemctlUser("local", ["restart", unit], showOptions);
    restarted = true;
  }

  return { outcome: "released", unit, unitFile, packageDir: effectivePackageDir, release: releaseResult, repoint: repointResult, wasActive, restarted };
}

if (import.meta.main) {
  try {
    const argUnit = option("--unit");
    let input;
    if (argUnit) {
      const packageDir = option("--package-dir");
      const releasesRoot = option("--releases-root");
      input = {
        unit: argUnit,
        ...(packageDir ? { packageDir } : {}),
        ...(releasesRoot ? { releasesRoot } : {}),
        apply: process.argv.includes("--apply"),
      };
    } else {
      let text = "";
      for await (const chunk of process.stdin) text += chunk;
      input = text.trim() ? JSON.parse(text) : {};
    }
    const result = await releasePackageOnHost(input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.outcome === "refused" ? 2 : 0;
  } catch (error) {
    process.stderr.write(`release-package-on-host: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
