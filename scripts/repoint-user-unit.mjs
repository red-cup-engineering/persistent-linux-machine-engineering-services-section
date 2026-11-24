#!/usr/bin/env node
import path from "node:path";
import { executeJavascriptNodeCommand } from "@red-cup-engineering/execute-javascript-node-command-service";
import { readFileText } from "@red-cup-engineering/file-services/read-file";
import { writeFileText } from "@red-cup-engineering/file-services/write-file";
import { argument as option } from "@red-cup-engineering/parse-javascript-argv-service";
import { projectFileUrlFilepath } from "@red-cup-engineering/project-file-url-filepath-service";
import { projectFilepathDirectory } from "@red-cup-engineering/project-filepath-directory-service";
import { resolveFilepath } from "@red-cup-engineering/resolve-filepath-service";
import { createSemanticRecordJournal } from "@red-cup-engineering/semantic-record-journal-service";

/** This section's own root -- the default semantic-record-journal custody root. */
export const NODE_ROOT = resolveFilepath([projectFilepathDirectory(projectFileUrlFilepath(import.meta.url)), ".."]);

export const RECEIPT_OBJECT_KIND = "persistent-computer-machine.unit-repoint";
export const RECEIPT_CATEGORY = "release";

// The one seam every local effect routes through; tests inject a fake `run`.
function defaultRun(command, args) {
  const receipt = executeJavascriptNodeCommand({
    type: "JavascriptNodeCommandExecutionRequest",
    version: 1,
    command,
    arguments: args,
    directory: process.cwd(),
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

/**
 * Rewrites the first `<key>=` line found in unit-file text to `<key>=<value>`,
 * leaving every other line -- `EnvironmentFile=` directives included --
 * byte-for-byte untouched. Never reads or echoes anything beyond the one
 * rewritten line's own previous value.
 * @param {string} text
 * @param {string} key - e.g. "WorkingDirectory" or "ExecStart".
 * @param {string} value
 * @returns {{text: string, previous: string|null, found: boolean}}
 */
export function rewriteUnitKeyLine(text, key, value) {
  const lines = text.split("\n");
  const pattern = new RegExp(`^${key}=`, "u");
  let previous = null;
  let found = false;
  const rewritten = lines.map((line) => {
    if (!found && pattern.test(line)) {
      previous = line.slice(key.length + 1);
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  return { text: rewritten.join("\n"), previous, found };
}

/**
 * Rewrites one systemd `--user` unit file's `WorkingDirectory=` and
 * `ExecStart=` lines in place -- every other line, `EnvironmentFile=`
 * directives included, left byte-for-byte untouched and never read for
 * content -- then runs `systemctl --user daemon-reload`. Refuses (no file
 * write, no daemon-reload) when either line is absent from the unit, since
 * this verb repoints an existing unit and never authors one.
 * @param {object} options
 * @param {string} options.unitFile - absolute path to the unit file (e.g. `/home/<user>/.config/systemd/user/<unit>.service`).
 * @param {string} options.workingDirectory - new `WorkingDirectory=` value.
 * @param {string} options.execStart - new `ExecStart=` value.
 * @param {string} [options.dataRoot] - overrides the semantic-record-journal custody root (tests only).
 * @param {string} [options.recordedAt] - overrides the receipt's recordedAt (tests only).
 * @param {(command: string, args: string[]) => string} [options.run] - overrides the command transport (tests only).
 * @returns {Promise<{outcome: "repointed"|"refused", unitFile?: string, previousWorkingDirectory?: string, workingDirectory?: string, previousExecStart?: string, execStart?: string, receipt?: object, refusals?: object[]}>}
 */
export async function repointUserUnit({ unitFile, workingDirectory, execStart, dataRoot, recordedAt, run = defaultRun } = {}) {
  for (const [name, value] of [["unitFile", unitFile], ["workingDirectory", workingDirectory], ["execStart", execStart]]) {
    if (!value) return { outcome: "refused", refusals: [refusal("usage", `${name} is required`, null)] };
  }
  if (!path.isAbsolute(unitFile)) return { outcome: "refused", refusals: [refusal("usage", "unitFile must be an absolute path", unitFile)] };

  let text;
  try {
    text = await readFileText(unitFile);
  } catch (error) {
    return { outcome: "refused", refusals: [refusal("unit-file-unreadable", error.message, unitFile)] };
  }

  const wd = rewriteUnitKeyLine(text, "WorkingDirectory", workingDirectory);
  if (!wd.found) {
    return { outcome: "refused", refusals: [refusal("working-directory-missing", `${unitFile} carries no WorkingDirectory= line to repoint`, unitFile)] };
  }
  const es = rewriteUnitKeyLine(wd.text, "ExecStart", execStart);
  if (!es.found) {
    return { outcome: "refused", refusals: [refusal("exec-start-missing", `${unitFile} carries no ExecStart= line to repoint`, unitFile)] };
  }

  await writeFileText(unitFile, es.text);
  run("systemctl", ["--user", "daemon-reload"]);

  const at = recordedAt ?? new Date().toISOString();
  const receiptValue = {
    type: "UnitRepointReceipt",
    version: 1,
    kind: RECEIPT_OBJECT_KIND,
    unitFile,
    previousWorkingDirectory: wd.previous,
    workingDirectory,
    previousExecStart: es.previous,
    execStart,
    recordedAt: at,
  };
  const journal = createSemanticRecordJournal({ root: resolveFilepath([dataRoot ?? NODE_ROOT]) });
  const receipt = journal.record({ objectKind: RECEIPT_OBJECT_KIND, category: RECEIPT_CATEGORY, record: receiptValue, recordedAt: at, charge: { support: true, refutation: false } });

  return {
    outcome: "repointed",
    unitFile,
    previousWorkingDirectory: wd.previous,
    workingDirectory,
    previousExecStart: es.previous,
    execStart,
    receipt,
  };
}

if (import.meta.main) {
  try {
    const argUnitFile = option("--unit-file");
    let input;
    if (argUnitFile) {
      input = { unitFile: argUnitFile, workingDirectory: option("--working-directory"), execStart: option("--exec-start") };
    } else {
      let text = "";
      for await (const chunk of process.stdin) text += chunk;
      input = text.trim() ? JSON.parse(text) : {};
    }
    const result = await repointUserUnit(input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.outcome === "refused" ? 2 : 0;
  } catch (error) {
    process.stderr.write(`repoint-user-unit: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
