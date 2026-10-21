#!/usr/bin/env node
// Checks that a persistent Linux machine's home directory carries none of
// its retired home entries, retired state directories, or (optionally) a
// forbidden pattern in its installed systemd user units. The machine's own
// retired-entries list is a JSON config named by --config=<path>, so this
// script carries no machine-specific literal; a fleet of machines can each
// keep their own config and run the same script.
//
// Every filesystem effect here goes through the house effect owners:
// file-services reads the config and unit files, stat-path-service reports
// single-path existence, resolve-filepath-service resolves segments into
// one filepath, and path-walking-service lists one directory's entries.
import { homedir } from "node:os";
import { readFileText } from "@red-cup-engineering/computer-file-engineering-services-section/read-file";
import { resolve } from "node:path";
import { statPath } from "@red-cup-engineering/computer-file-engineering-services-section/stat-path";
import { walkPosixPaths } from "@red-cup-engineering/computer-filepath-engineering-services-section/walk-posix-paths";

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

async function exists(path) {
  return (await statPath({ path })).exists;
}

export async function readBoundaryConfig(path) {
  const parsed = JSON.parse(await readFileText(resolve(String(path))));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--config must name a JSON object");
  return parsed;
}

// config shape:
//   retiredHomeEntries: string[] -- entries directly under $HOME
//   retiredStateEntries: string[][] -- path-segment arrays under $HOME
//   forbiddenUserUnitPattern: string | undefined -- a case-insensitive regular
//     expression tested against each installed user unit's file name and
//     contents; omit to skip the systemd user-unit scan entirely.
export async function findWorkspaceBoundaryViolations(config, { home = homedir() } = {}) {
  const violations = [];
  const retiredHomeEntries = config.retiredHomeEntries ?? [];
  const retiredStateEntries = config.retiredStateEntries ?? [];

  for (const entry of retiredHomeEntries) {
    const path = resolve(home, entry);
    if (await exists(path)) violations.push(path);
  }

  for (const segments of retiredStateEntries) {
    const path = resolve(home, ...segments);
    if (await exists(path)) violations.push(path);
  }

  if (config.forbiddenUserUnitPattern) {
    const forbidden = new RegExp(config.forbiddenUserUnitPattern, "i");
    const userUnitDirectory = resolve(home, ".config", "systemd", "user");
    const walk = await walkPosixPaths({ root: userUnitDirectory, maxDepth: 0, missing: "empty" });
    for (const entry of walk.files) {
      // maxDepth: 0 means every entry is a direct child of userUnitDirectory,
      // so its relative path (the walker's default) is already a bare name.
      const path = resolve(userUnitDirectory, entry.path);
      let text;
      try {
        text = await readFileText(path);
      } catch {
        continue;
      }
      if (forbidden.test(`${entry.path}\n${text}`)) violations.push(path);
    }
  }

  return violations;
}

if (import.meta.main) {
  const configPath = arg("config");
  if (!configPath) {
    process.stderr.write("verify-workspace-boundary: --config=<path> is required\n");
    process.exitCode = 1;
  } else {
    try {
      const config = await readBoundaryConfig(configPath);
      const violations = await findWorkspaceBoundaryViolations(config);
      if (violations.length > 0) {
        console.error("Workspace-boundary violations:\n" + violations.map((path) => `- ${path}`).join("\n"));
        process.exitCode = 1;
      } else {
        console.log("Workspace boundary intact: no retired project-owned home state or installed project user units.");
      }
    } catch (error) {
      process.stderr.write(`verify-workspace-boundary: ${error instanceof Error ? error.message : "unknown failure"}\n`);
      process.exitCode = 1;
    }
  }
}
