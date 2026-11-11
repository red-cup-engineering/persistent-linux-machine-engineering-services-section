#!/usr/bin/env node
// Read-only check of on-disk release metadata. It does NOT establish provider health or deployment.
// live-release-matches.mjs ROOT MACHINE_COMMIT REPOSITORY [--source-commit SOURCE_COMMIT] [--report]
// Exit 0 for match and 1 for mismatch. --report prints match/mismatch; malformed metadata is an error.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [root, commit, repository, ...options] = process.argv.slice(2);
const SHA = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/u;
const identity = (value, pattern) => typeof value === 'string' && !/\s/u.test(value) && pattern.test(value);

let report = false;
let expectedSourceCommit;
for (let i = 0; i < options.length; i++) {
  if (options[i] === '--report' && !report) report = true;
  else if (options[i] === '--source-commit' && expectedSourceCommit === undefined && options[i + 1] !== undefined) {
    expectedSourceCommit = options[++i];
  } else throw new Error('Unknown, repeated or incomplete live-release-matches option.');
}
if (!root || !identity(commit, SHA) || !identity(repository, REPOSITORY) ||
    (expectedSourceCommit !== undefined && !identity(expectedSourceCommit, SHA))) {
  throw new Error('Expected a release root, full machine commit, repository, and optional full source commit.');
}

try {
  const release = JSON.parse(readFileSync(join(root, '.metadata/release.json'), 'utf8'));
  const sources = JSON.parse(readFileSync(join(root, '.metadata/sources.json'), 'utf8'));
  const entries = sources?.repositories;
  if (!identity(release?.machineCommit, SHA) || !Array.isArray(entries) ||
      entries.some((r) => !identity(r?.repository, REPOSITORY))) {
    throw new Error('Invalid live release metadata.');
  }
  const chosen = entries.filter((r) => r.repository === repository);
  if (expectedSourceCommit !== undefined && chosen.some((r) => !identity(r?.commit, SHA))) {
    throw new Error('Invalid selected source identity in live release metadata.');
  }
  if (expectedSourceCommit !== undefined && chosen.length > 1) {
    throw new Error('Ambiguous source identity in live release metadata.');
  }
  const matches = release.machineCommit === commit &&
    (expectedSourceCommit === undefined ? chosen.length > 0 :
      chosen.length === 1 && chosen[0].commit === expectedSourceCommit);
  if (report) process.stdout.write(matches ? 'match\n' : 'mismatch\n');
  else process.exitCode = matches ? 0 : 1;
} catch (error) {
  if (!report && ['ENOENT', 'ENOTDIR'].includes(error.code)) process.exitCode = 1;
  else throw error;
}
