#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { executeJavascriptNodeCommand } from "@red-cup-engineering/execute-javascript-node-command-service";
import { makeDirectory } from "@red-cup-engineering/make-directory-service";
import { argument as option } from "@red-cup-engineering/parse-javascript-argv-service";
import { projectFileUrlFilepath } from "@red-cup-engineering/project-file-url-filepath-service";
import { projectFilepathBasename } from "@red-cup-engineering/project-filepath-basename-service";
import { projectFilepathDirectory } from "@red-cup-engineering/project-filepath-directory-service";
import { resolveFilepath } from "@red-cup-engineering/resolve-filepath-service";
import { createSemanticRecordJournal } from "@red-cup-engineering/semantic-record-journal-service";

/** This section's own root -- the default semantic-record-journal custody root. */
export const NODE_ROOT = resolveFilepath([projectFilepathDirectory(projectFileUrlFilepath(import.meta.url)), ".."]);

/** Default releases root every persistent host's local release lands under. */
export const DEFAULT_RELEASES_ROOT = resolveFilepath([process.env.HOME ?? "/root", ".local", "share", "561-group", "releases"]);

/** The fixed set of a package's runtime entries copied into a release (each is skipped when absent). */
export const RELEASE_ENTRIES = Object.freeze(["package.json", "package-lock.json", "apps", "scripts", "src", "content"]);

export const RECEIPT_OBJECT_KIND = "persistent-computer-machine.package-release";
export const RECEIPT_CATEGORY = "release";

// The one seam every local effect routes through; tests inject a fake `run`.
function defaultRun(command, args, directory) {
  const receipt = executeJavascriptNodeCommand({
    type: "JavascriptNodeCommandExecutionRequest",
    version: 1,
    command,
    arguments: args,
    directory: directory ?? process.cwd(),
    environment: null,
    input: null,
  });
  const { result } = receipt;
  if (result.status !== 0) {
    const error = new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}

function refusal(step, reason, evidence) {
  return { step, reason, evidence };
}

function releaseStamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/gu, "-");
}

/**
 * Copies one package's runtime files into a dated release directory under a
 * releases root and atomically flips that package's `current` symlink to
 * point at it, so a systemd `--user` unit can run the package outside the
 * checkout ("the checkout is not a runtime").
 * @param {object} options
 * @param {string} options.packageDir - absolute path to the package root inside the checkout.
 * @param {string} [options.releasesRoot] - releases root directory (default `~/.local/share/561-group/releases`).
 * @param {string} [options.stamp] - the release directory's own name under the package's lane (tests only; default is now, as a colon/dot-free UTC ISO string).
 * @param {string} [options.dataRoot] - overrides the semantic-record-journal custody root (tests only).
 * @param {string} [options.recordedAt] - overrides the receipt's recordedAt (tests only).
 * @param {(command: string, args: string[], directory?: string) => string} [options.run] - overrides the command transport (tests only).
 * @returns {Promise<{outcome: "released"|"refused", releaseDirectory?: string, current?: string, filesCopied?: string[], receipt?: object, refusals?: object[]}>}
 */
export async function cutPackageRelease({ packageDir, releasesRoot = DEFAULT_RELEASES_ROOT, stamp, dataRoot, recordedAt, run = defaultRun } = {}) {
  if (!packageDir) return { outcome: "refused", refusals: [refusal("usage", "packageDir is required", null)] };
  if (!path.isAbsolute(packageDir)) return { outcome: "refused", refusals: [refusal("usage", "packageDir must be an absolute path", packageDir)] };

  const manifestPath = resolveFilepath([packageDir, "package.json"]);
  if (!existsSync(manifestPath)) {
    return { outcome: "refused", refusals: [refusal("package-json-missing", `${manifestPath} was not found`, packageDir)] };
  }
  const lockfilePath = resolveFilepath([packageDir, "package-lock.json"]);
  if (!existsSync(lockfilePath)) {
    return { outcome: "refused", refusals: [refusal("lockfile-missing", `${lockfilePath} was not found -- npm ci requires a committed lockfile`, packageDir)] };
  }

  const name = projectFilepathBasename(packageDir);
  const effectiveStamp = stamp ?? releaseStamp();
  const laneRoot = resolveFilepath([releasesRoot, name]);
  const releaseDir = resolveFilepath([laneRoot, effectiveStamp]);
  const currentPath = resolveFilepath([laneRoot, "current"]);

  await makeDirectory({ path: releaseDir });

  const filesCopied = [];
  for (const entryName of RELEASE_ENTRIES) {
    const src = resolveFilepath([packageDir, entryName]);
    if (!existsSync(src)) continue;
    run("cp", ["-a", src, resolveFilepath([releaseDir, entryName])]);
    filesCopied.push(entryName);
  }

  try {
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.561.group/"], releaseDir);
  } catch (error) {
    return {
      outcome: "refused",
      refusals: [refusal("npm-ci-failed", "npm ci --ignore-scripts failed in the release directory", { message: error.message, status: error.status ?? null, stderr: error.stderr ?? null })],
    };
  }

  run("ln", ["-sfn", releaseDir, currentPath]);

  const at = recordedAt ?? new Date().toISOString();
  const receiptValue = {
    type: "PackageReleaseCutReceipt",
    version: 1,
    kind: RECEIPT_OBJECT_KIND,
    packageDir,
    releaseName: name,
    stamp: effectiveStamp,
    releaseDirectory: releaseDir,
    current: currentPath,
    filesCopied,
    recordedAt: at,
  };
  const journal = createSemanticRecordJournal({ root: resolveFilepath([dataRoot ?? NODE_ROOT]) });
  const receipt = journal.record({ objectKind: RECEIPT_OBJECT_KIND, category: RECEIPT_CATEGORY, record: receiptValue, recordedAt: at, charge: { support: true, refutation: false } });

  return { outcome: "released", releaseDirectory: releaseDir, current: currentPath, filesCopied, receipt };
}

if (import.meta.main) {
  try {
    const argPackageDir = option("--package-dir");
    let input;
    if (argPackageDir) {
      const releasesRoot = option("--releases-root");
      input = { packageDir: argPackageDir, ...(releasesRoot ? { releasesRoot } : {}) };
    } else {
      let text = "";
      for await (const chunk of process.stdin) text += chunk;
      input = text.trim() ? JSON.parse(text) : {};
    }
    const result = await cutPackageRelease(input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.outcome === "refused" ? 2 : 0;
  } catch (error) {
    process.stderr.write(`cut-package-release: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
