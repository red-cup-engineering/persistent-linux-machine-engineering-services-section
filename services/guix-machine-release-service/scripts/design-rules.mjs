#!/usr/bin/env node
// The design-rule deck, version 1 (fabrication line design, section 5), read from the exact committed sources a
// machine assembles. Each violation has a stable key, so a reading is a ledger: the change test reads the machine
// as pinned (the baseline, section 5.1) and the machine with the change, and a change may remove violations but
// not add them.
//
//   DRC-2 one owner     a package name defined at more than one path across the pinned repositories
//   DRC-3 no SQL        a runtime import of an SQL module outside a package's declared `sqlAdmissionPaths`
//   DRC-6 no misfold    a package's exported operation that only re-exports, aliases or forwards to a capability a
//                       dependency already exports (misfoldsOfModule, computer-coding-services-section
//                       node-js-packages-engineering-services-section/src/misfold.mjs, read from the machine's own composition)
//   copy                the same code file (Git blob) in two packages of the closure
//   DRC-7 legacy kept   a file deleted under a legacy path with no migration-ledger entry naming it
//   one-log             STD-ONE-LOG: runtime code outside the journal's owners that writes raw SEAVT rows (an
//                       `appendSeavt`/`appendSeavtEntries` call, or an import of `witness-journal-log-service`)
//                       instead of recording through `semiotic-eavt-services-section/record-semantic-record`
//   journal-hand-append STD-ONE-LOG: runtime code that appends to a `.jsonl` file by hand (`appendFileSync`)
//   STD-ENTRY           a hand-written entry-point guard (`process.argv[1]` compared with `import.meta.url`) outside
//                       its owner, node-process-services-section/entrypoint `isEntryModule` (findEntryGuards,
//                       computer-coding-services-section javascript-node-services-section/src/std-entry.mjs, read
//                       from the machine's own composition; apply-std-entry.mjs there rewrites them)
//
//   PDK-3 law pinned    a module that reads another house package's file (resolve, or a JSON import) without a digest
//   PDK-4 wiring        a manifest whose house wiring is out of sync with what its code uses, read by the owner's
//                       sync-package-manifest over its package-imports reader (node-js-packages-engineering-services-section),
//                       the same reader the manifest generator writes with; an older owner falls back to imports only
//   PDK-7 no assertion  a committed record that stores its own status, health or value instead of deriving it
//
// Each rule is keyed to the Software Process Design Kit rule it enforces (`pdk`), the July 23 exemplar PDK:
// bare-cedar-fog .../leader-movement-team/content/documents/articles/notes/2026/07/23/2026-07-23-software-process-design-kit.md
//
//   node scripts/design-rules.mjs SPEC.json      (a prepare-sources spec: repositories with directories, entries)
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,writeFileSync,readdirSync,realpathSync,lstatSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {isCliEntry} from './cli-entry.mjs';
import {decodeGitBlobBatch,ownedBy,packageSources,prefetch,selectedSources,treeFiles} from './prepare-sources.mjs';

/** The Software Process Design Kit rule (2026-07-23, "Design rules") each deck rule mechanizes. */
export const PDK = Object.freeze({
  'drc-1': [4], 'drc-2': [5], 'copy': [5], 'drc-3': [1], 'drc-6': [5], 'drc-7': [5],
  'pdk-3': [3], 'pdk-4': [4], 'pdk-7': [7], 'one-log': [1], 'journal-hand-append': [1], 'std-entry': [5],
});
export const PDK_RULES = Object.freeze({
  1: 'Atomic units: a unit is one pure function; its own dated, append-only records are its only deposit.',
  2: 'Typed refusal is a product, not an error.',
  3: "Law imports are digest-pinned: a unit that consumes another unit's law reads it by content digest and refuses on drift.",
  4: 'Wiring is code or it is nothing: a connection exists when an import, client call or contract file demonstrates it.',
  5: 'Fabrication is subtractive: dead layers, unused shims, stale pins and duplicate trees are removed; no interface material by default.',
  6: 'One register: classification lives in structured records.',
  7: 'No assertion: a unit never stores its own status, health or value; every such fact is derived by re-running a check.',
});
const keyed = (violation) => ({...violation, pdk: PDK[violation.rule] ?? []});
const HOUSE_SCOPE = /^@(?:561-group|causeway-services|coesite-operations|emsenn|emsweb|harmonious-union|koios-news|lenticule-science|red-cup-engineering|red-cup-science|rsc-quiescent|turntide-islands|union-officer-academy)\//u;
const RESOLVED_READ = /(?:import\.meta\.resolve|require\.resolve|\.resolve)\(\s*['"](@[^'"\s]+)['"]/gu;
const JSON_IMPORT = /\bfrom\s*['"](@[^'"\s]+\.json)['"]\s*(?:with|assert)\s*\{\s*type\s*:\s*['"]json['"]/gu;
const DIGESTED = /createHash\(|sha-?256|\bdigest\b/iu;
const ASSERTED_KEYS = new Set(['health', 'healthy']);
const HEALTH_WORDS = new Set(['ok', 'healthy', 'unhealthy', 'green', 'red', 'passing', 'failing', 'up', 'down', 'live', 'degraded', 'ready']);
const RECORD = /\.json$/u, NOT_RECORD = /(?:^|\/)(?:package|tsconfig[^/]*|package-lock|jsconfig|\.?eslintrc[^/]*)\.json$/u;

/** PDK-3: another house package's file read by resolution or JSON import, in a module that never digests. */
const LAW_FILE = /\.(?:json|jsonl|ya?ml|toml|rml|sen|ttl|md|txt|lean)$/u;
export function unpinnedLawReads(text) {
  if (DIGESTED.test(text)) return [];
  const found = [...text.matchAll(RESOLVED_READ), ...text.matchAll(JSON_IMPORT)].map((m) => m[1])
    .filter((s) => HOUSE_SCOPE.test(s) && LAW_FILE.test(s) && !s.endsWith('/package.json'));
  return [...new Set(found)].sort();
}

/** PDK-7: the keys by which a committed record asserts its own status, health or value. */
export function assertedFacts(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
  return Object.entries(record).filter(([key, value]) => ASSERTED_KEYS.has(key) ||
    (key === 'status' && typeof value === 'string' && HEALTH_WORDS.has(value.toLowerCase()))).map(([key]) => key).sort();
}

export const SQLITE_MODULES = Object.freeze(['node:sqlite','sqlite','better-sqlite3','sqlite3','@fedify/sqlite','sql.js','wa-sqlite','@sqlite.org/sqlite-wasm','@libsql']);
export const SQL_MODULES = [...SQLITE_MODULES,'pg','mysql','mysql2','knex','drizzle-orm','@prisma/client'];
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const NOT_RUNTIME = /(?:^|\/)(?:test|tests|__tests__|fixtures|examples|legacy|vendor|vendored|node_modules)\//u;
// `getBuiltinModule('node:sqlite')` loads a built-in without an import statement, so it is read the same way.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bgetBuiltinModule\s*\(\s*|\bimport\s+)['"]([^'"\s]+)['"]/gu;
// DRC-3 reads code, not prose: a line that is wholly a comment (`//`, `/*`, or a ` *` block line) names no module the
// file loads, as this file's own note above shows. Lines of code, and comments trailing them, are read as they are.
const COMMENT_LINE = /^[ \t]*(?:\/\/|\/\*|\*).*$/gmu;
const MISFOLD_MINIMUM_BYTES = 1024;
const NOT_PACKAGE_CODE = /(?:^|\/)(?:legacy|vendor|vendored|node_modules)\//u;
const WIRING_OWNER = '@red-cup-engineering/jsnode-package-services-section';

/** The PDK-4 key of one sync-package-manifest change. */
export function wiringKey(name, change) {
  const runtimeDeclared = change.from === 'dependencies' || change.from === 'optionalDependencies';
  if (runtimeDeclared && (change.action === 'removed' || change.action === 'moved-to-devDependencies')) return `pdk-4:${name}:${change.dependency}`;
  const suffix = {removed: 'dev-unused', 'moved-to-dependencies': 'runtime-in-dev', added: change.to === 'devDependencies' ? 'test-undeclared' : 'undeclared'}[change.action] ?? change.action;
  return `pdk-4:${name}:${change.dependency}:${suffix}`;
}

// STD-ONE-LOG. The journal's owners write its rows; everyone else records through record-semantic-record. The owners
// are every package of computer-data-services-section and the witness-journal services of semiotic-software.
const ONE_LOG_OWNER_REPOSITORIES = new Set(['red-cup-engineering/computer-data-services-section']);
const ONE_LOG_OWNER_PATH = /(?:^|\/)witness-journal-services-section(?:\/|$)/u;
const RAW_ROW_CALL = /\bappendSeavt(?:Entries)?\s*\(/u;
const RAW_ROW_MODULE = '@red-cup-engineering/witness-journal-log-service';
const HAND_APPEND = /\bappendFileSync\s*\([^\n]*\.jsonl\b|\.jsonl\b[^\n]*\bappendFileSync\s*\(/u;

/** Whether a package is one of the journal's owners, which alone write its rows. */
export function oneLogOwner(repository, path) {
  return ONE_LOG_OWNER_REPOSITORIES.has(repository) || (repository === 'red-cup-engineering/semiotic-software-services-section' && ONE_LOG_OWNER_PATH.test(path));
}

/** STD-ONE-LOG: the raw journal writes one module's code makes (comment lines aside), as `{rule, writer}`. */
export function rawJournalWrites(text) {
  const code = text.replace(COMMENT_LINE, ''), found = [];
  if (RAW_ROW_CALL.test(code)) found.push({rule: 'one-log', writer: 'appendSeavt'});
  if ([...code.matchAll(SPECIFIER)].some((m) => m[1] === RAW_ROW_MODULE || m[1].startsWith(RAW_ROW_MODULE + '/'))) found.push({rule: 'one-log', writer: 'witness-journal-log-service'});
  if (HAND_APPEND.test(code)) found.push({rule: 'journal-hand-append', writer: 'appendFileSync'});
  return found;
}

/** The SQL module a specifier names, or null. Subpaths count (`pg/lib`, `drizzle-orm/sqlite-core`). */
export function sqlModule(specifier) {
  return SQL_MODULES.find((name) => specifier === name || specifier.startsWith(name + '/')) ?? null;
}

/** DRC-2: package names discovered at more than one place, owners ignored. */
export function oneOwner(repositories) {
  const violations = [];
  for (const [name, found] of packageSources(repositories))
    if (Array.isArray(found)) violations.push(keyed({rule: 'drc-2', key: `drc-2:${name}`, package: name, at: found.map((s) => `${s.repository}:${s.path}`).sort()}));
  return violations.sort((a, b) => a.key.localeCompare(b.key));
}

/** The code files a package's manifest exports (its operations' modules), package-relative. */
export function exportedModules(manifest) {
  const targets = [];
  const walk = (value) => {
    if (typeof value === 'string') targets.push(value);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v);
  };
  walk(manifest.exports ?? manifest.main ?? []);
  return new Set(targets.filter((t) => !t.includes('*') && CODE.test(t) && !/\.d\.[cm]?ts$/u.test(t)).map((t) => t.replace(/^\.\//u, '')));
}

const STD_ENTRY_OWNER = '@red-cup-engineering/node-process-services-section';
// Packages whose guards stay as they are until the founder decides: rewriting a symlink-blind guard starts a script
// that has been a silent no-op, and these move money or run brokerage and chain work (the two Alpaca loops are
// paper, but starting a silent unit on the live host is an operating call). Their violations stay counted and keyed
// as any other, marked `held: 'founder'`, so the ratchet keeps them in view rather than grandfathering them.
export const STD_ENTRY_FOUNDER_HELD = Object.freeze([
  '@red-cup-engineering/alpaca-esther-paper-redistributor-loop', '@red-cup-engineering/alpaca-esther-paper-trading-loop',
  '@red-cup-engineering/alpha-chain-node-service', '@red-cup-engineering/blockchain-trashpanda',
  '@red-cup-engineering/brokerage-control-api-federation', '@red-cup-engineering/hive-blockchain-client-service',
  '@red-cup-engineering/multi-chain-finality-services-section', '@red-cup-engineering/x402-services-section',
]);

/** DRC-3, DRC-6 and the copy rule over the runtime code of the closure the entries select. DRC-6 is read only when
 * a misfold reader is given: `misfolds(text, fileName)` returns the module's misfolded exports. */
export function closureRules(repositories, {entries = [], misfolds, wiring, absoluteSqlite = false, entryGuards} = {}) {
  const trees = new Map(), roots = new Map();
  const selected = selectedSources(packageSources(repositories, trees, roots), entries);
  const sql = [], blobs = new Map(), misfold = [], pdk = [], oneLog = [], guarded = [];
  for (const [name, p] of selected) {
    const repo = repositories.find((r) => r.repository === p.repository);
    const admitted = new Set((p.manifest.sqlAdmissionPaths ?? []).map((path) => p.path === '.' ? path : `${p.path}/${path}`));
    const files = trees.get(p.repository).filter(({type, mode, file}) => type === 'blob' && ['100644', '100755'].includes(mode) && CODE.test(file) &&
      (p.path === '.' || file.startsWith(p.path + '/')) && ownedBy(roots.get(p.repository), p.path, file) &&
      !NOT_RUNTIME.test(p.path === '.' ? file : file.slice(p.path.length + 1)));
    const records = trees.get(p.repository).filter(({type, mode, file}) => type === 'blob' && ['100644', '100755'].includes(mode) &&
      RECORD.test(file) && !NOT_RECORD.test(file) && (p.path === '.' || file.startsWith(p.path + '/')) &&
      ownedBy(roots.get(p.repository), p.path, file) && !NOT_RUNTIME.test(p.path === '.' ? file : file.slice(p.path.length + 1)));
    // The owner's wiring reader reads test code too: a house package only tests use belongs in devDependencies.
    const tests = wiring ? trees.get(p.repository).filter(({type, mode, file}) => type === 'blob' && ['100644', '100755'].includes(mode) && CODE.test(file) &&
      (p.path === '.' || file.startsWith(p.path + '/')) && ownedBy(roots.get(p.repository), p.path, file) &&
      NOT_RUNTIME.test(p.path === '.' ? file : file.slice(p.path.length + 1)) && !NOT_PACKAGE_CODE.test(p.path === '.' ? file : file.slice(p.path.length + 1))) : [];
    if (!files.length && !records.length && !tests.length) continue;
    const exported = exportedModules(p.manifest), used = new Set(), code = [], owner = oneLogOwner(p.repository, p.path);
    const all = [...files, ...records, ...tests];
    prefetch(repo.directory, p.commit, all.map((f) => f.oid));
    const read = spawnSync('git', ['cat-file', '--batch'], {cwd: repo.directory, input: all.map((f) => f.oid + '\n').join(''), maxBuffer: 512 * 1024 * 1024});
    if (read.error || read.status !== 0) throw read.error ?? new Error(`cannot read committed sources: ${p.repository}`);
    for (const {entry, bytes} of decodeGitBlobBatch(read.stdout, all)) {
      const relativeFile = p.path === '.' ? entry.file : entry.file.slice(p.path.length + 1);
      if (RECORD.test(entry.file)) {
        if (bytes.length > 1024 * 1024) continue;
        let record; try { record = JSON.parse(bytes.toString('utf8')); } catch { continue; }
        for (const key of assertedFacts(record)) pdk.push({rule: 'pdk-7', key: `pdk-7:${name}:${relativeFile}:${key}`, package: name, file: relativeFile, field: key});
        continue;
      }
      const text = bytes.toString('utf8');
      code.push({path: relativeFile, text});
      if (NOT_RUNTIME.test(relativeFile)) continue;
      for (const m of [...text.matchAll(SPECIFIER), ...text.matchAll(RESOLVED_READ)]) used.add(m[1]);
      if (/\.test\.[cm]?[jt]sx?$/u.test(entry.file)) continue;
      if (!owner) for (const {rule, writer} of rawJournalWrites(text))
        oneLog.push({rule, key: rule === 'one-log' ? `one-log:${name}:${relativeFile}:${writer}` : `journal-hand-append:${name}:${relativeFile}`, package: name, file: relativeFile, writer});
      for (const target of unpinnedLawReads(text)) pdk.push({rule: 'pdk-3', key: `pdk-3:${name}:${relativeFile}:${target}`, package: name, file: relativeFile, reads: target});
      if (bytes.length >= MISFOLD_MINIMUM_BYTES) {
        if (!blobs.has(entry.oid)) blobs.set(entry.oid, new Set());
        blobs.get(entry.oid).add(`${name}:${relativeFile}`);
      }
      if (misfolds && exported.has(relativeFile)) {
        for (const found of misfolds(bytes.toString('utf8'), relativeFile))
          misfold.push({rule: 'drc-6', key: `drc-6:${name}:${relativeFile}:${found.export}`, package: name, file: relativeFile,
            export: found.export, shape: found.kind, dependency: found.dependency});
      }
      if (entryGuards && name !== STD_ENTRY_OWNER && text.includes('process.argv[1]')) {
        const guards = entryGuards(text, relativeFile);
        if (guards.length) guarded.push({rule: 'std-entry', key: `std-entry:${name}:${relativeFile}`, package: name, file: relativeFile,
          guards: guards.length, symlinkBlind: guards.filter((guard) => guard.symlinkBlind).length,
          ...(STD_ENTRY_FOUNDER_HELD.includes(name) ? {held: 'founder'} : {})});
      }
      const modules = new Set([...text.replace(COMMENT_LINE, '').matchAll(SPECIFIER)].map((m) => sqlModule(m[1])).filter(Boolean));
      for (const module of modules) if (!admitted.has(entry.file) || (absoluteSqlite && sqliteModule(module))) sql.push({rule: 'drc-3', key: `drc-3:${name}:${relativeFile}:${module}`, package: name, file: relativeFile, module});
    }
    // PDK-4: the manifest's house wiring is what sync-package-manifest would write for the package's code. Removing a
    // dependency or moving it to devDependencies keeps the key the imports-only reading gave it; the rest are new.
    if (wiring) {
      for (const change of wiring.syncPackageManifest(p.manifest, wiring.importsOfFiles(code), {rangeOf: () => 'workspace:*'}).changes)
        pdk.push({rule: 'pdk-4', key: wiringKey(name, change), package: name, dependency: change.dependency, action: change.action});
      continue;
    }
    // An owner older than the shared reader: a declared house dependency is wiring only when some code imports it.
    const scripts = JSON.stringify({...p.manifest.scripts, ...(typeof p.manifest.bin === 'object' ? p.manifest.bin : {})});
    if (files.length) for (const dependency of Object.keys({...p.manifest.dependencies, ...p.manifest.optionalDependencies}))
      if (HOUSE_SCOPE.test(dependency) && dependency !== name && ![...used].some((s) => s === dependency || s.startsWith(dependency + '/')) && !scripts.includes(dependency))
        pdk.push({rule: 'pdk-4', key: `pdk-4:${name}:${dependency}`, package: name, dependency});
  }
  const copies = [];
  for (const [oid, at] of blobs) {
    const packages = new Set([...at].map((location) => location.slice(0, location.lastIndexOf(':'))));
    if (packages.size > 1) copies.push({rule: 'copy', key: `copy:${oid}`, gitBlob: oid, at: [...at].sort()});
  }
  return {packages: [...selected.keys()], misfold: misfolds ? 'read' : 'unread', stdEntry: entryGuards ? 'read' : 'unread',
    violations: [...sql, ...misfold, ...guarded, ...copies, ...pdk, ...oneLog].map(keyed).sort((a, b) => a.key.localeCompare(b.key))};
}

/** DRC-7: legacy deletions between two commits of a repository that no migration ledger names. */
export function legacyKept(directory, repository, from, to) {
  const git = (...args) => spawnSync('git', args, {cwd: directory, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
  const deleted = git('diff', '--name-only', '--diff-filter=D', from, to, '--').stdout.split('\n')
    .filter((file) => file && (/(?:^|\/)legacy\//u.test(file) || repository.endsWith('-legacy')));
  if (!deleted.length) return [];
  const ledgers = git('ls-tree', '-r', '--name-only', to).stdout.split('\n').filter((file) => /(?:^|\/)migration-ledger[^/]*\.jsonl?$/u.test(file));
  const text = ledgers.map((file) => git('show', `${to}:${file}`).stdout).join('\n');
  return deleted.filter((file) => !text.includes(file))
    .map((file) => keyed({rule: 'drc-7', key: `drc-7:${repository}:${file}`, repository, file}));
}

/** A whole reading of the deck over a prepared spec's sources. */
export function readDesignRules(spec, {misfolds, wiring, entryGuards} = {}) {
  const closure = closureRules(spec.repositories, {entries: [...(spec.entries ?? []), ...(spec.buildEntries ?? [])], misfolds, wiring, entryGuards});
  return {kind: 'design-rule-reading', deck: 1, pdk: '2026-07-23-software-process-design-kit', packages: closure.packages.length, misfold: closure.misfold, stdEntry: closure.stdEntry,
    violations: [...oneOwner(spec.repositories), ...closure.violations].sort((a, b) => a.key.localeCompare(b.key))};
}

/** The owner's wiring reader (package-imports and sync-package-manifest of node-js-packages-engineering-services-section), loaded
 * from its committed blobs in the given sources, or null when that owner predates them. Both modules depend only on
 * the language and on each other, so they are read without composing a workspace. */
export async function wiringReader(repositories) {
  const found = packageSources(repositories).get(WIRING_OWNER);
  const owner = Array.isArray(found) ? null : found;
  if (!owner) return null;
  const show = (file) => spawnSync('git', ['show', `${owner.commit}:${owner.path === '.' ? '' : owner.path + '/'}src/${file}`], {cwd: repositories.find((r) => r.repository === owner.repository).directory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  const imports = show('package-imports.mjs'), sync = show('sync-package-manifest.mjs');
  if (imports.status !== 0 || sync.status !== 0) return null;
  const directory = mkdtempSync(join(tmpdir(), 'wiring-reader-'));
  writeFileSync(join(directory, 'package-imports.mjs'), imports.stdout);
  writeFileSync(join(directory, 'sync-package-manifest.mjs'), sync.stdout);
  const {importsOfFiles} = await import(pathToFileURL(join(directory, 'package-imports.mjs')).href);
  const {syncPackageManifest} = await import(pathToFileURL(join(directory, 'sync-package-manifest.mjs')).href);
  return {importsOfFiles, syncPackageManifest, owner: `${owner.repository}@${owner.commit}`};
}

/** A misfold reader from a composed workspace: misfoldsOfModule over every export the module names, with the
 * owner's own parser (javascript-node-services-section/syntax). Null when the workspace does not hold them. */
export async function misfoldReader(packageDirectory) {
  const coding = packageDirectory('@red-cup-engineering/jsnode-package-services-section');
  const node = packageDirectory('@red-cup-engineering/javascript-node-services-section');
  const misfoldFile = coding && join(coding, 'src/misfold.mjs');
  const syntaxTarget = node && existsSync(join(node, 'package.json')) && JSON.parse(readFileSync(join(node, 'package.json'), 'utf8')).exports?.['./syntax'];
  const syntaxFile = typeof syntaxTarget === 'string' ? join(node, syntaxTarget) : syntaxTarget?.import ?? syntaxTarget?.default ? join(node, syntaxTarget.import ?? syntaxTarget.default) : null;
  if (!misfoldFile || !existsSync(misfoldFile) || !syntaxFile || !existsSync(syntaxFile)) return null;
  const {misfoldsOfModule} = await import(pathToFileURL(misfoldFile).href);
  const {readJsnodeAst} = await import(pathToFileURL(syntaxFile).href);
  return (text, fileName) => {
    let program;
    try { program = readJsnodeAst(text, fileName); } catch { return []; }
    return misfoldsOfModule(text, fileName, exportNames(program));
  };
}

/** An entry-guard reader from a composed workspace: findEntryGuards (javascript-node-services-section/std-entry,
 * the owner's own codemod) over a module. Null when the workspace does not hold it; a module the parser cannot read
 * is reported as one guard, so it is never passed over silently. */
export async function entryGuardReader(packageDirectory) {
  const node = packageDirectory('@red-cup-engineering/javascript-node-services-section');
  const target = node && existsSync(join(node, 'package.json')) && JSON.parse(readFileSync(join(node, 'package.json'), 'utf8')).exports?.['./std-entry'];
  const file = typeof target === 'string' ? join(node, target) : target?.import ?? target?.default ? join(node, target.import ?? target.default) : null;
  if (!file || !existsSync(file)) return null;
  const {findEntryGuards} = await import(pathToFileURL(file).href);
  return (text) => {
    try { return findEntryGuards(text).guards; } catch { return [{symlinkBlind: true, unparsed: true}]; }
  };
}

/** The names a module exports, read from its ESTree. */
export function exportNames(program) {
  const names = [];
  for (const statement of program.body ?? []) {
    if (statement.type !== 'ExportNamedDeclaration') continue;
    for (const specifier of statement.specifiers ?? []) names.push(specifier.exported.name ?? specifier.exported.value);
    const declaration = statement.declaration;
    if (declaration?.id?.name) names.push(declaration.id.name);
    for (const declarator of declaration?.declarations ?? []) if (declarator.id?.type === 'Identifier') names.push(declarator.id.name);
  }
  return names;
}

/** The ratchet: violations the change adds and removes against the baseline reading. */
export function ratchet(base, head) {
  const before = new Set(base.map((v) => v.key)), after = new Set(head.map((v) => v.key));
  return {added: head.filter((v) => !before.has(v.key)), removed: base.filter((v) => !after.has(v.key)).map((v) => v.key)};
}


/** DRC-3's SQLite carriers, including package aliases and peer-qualified lock identities.
 * This is an identity check, not a claim about opaque bundled/native code. */
export function sqliteModule(value) {
  if (typeof value !== 'string') return null;
  for (const part of value.replace(/^npm:/u, '').split('(')) {
    const identity = part.replace(/\)+$/u, '');
    const found = SQLITE_MODULES.find(name => identity === name || identity.startsWith(name + '/') || identity.startsWith(name + '@'));
    if (found) return found;
  }
  return null;
}
function refuseDrc3(violations) {
  if (violations.length) throw Object.assign(new Error('DRC-3 SQLite admission refused: ' + violations.map(v => v.key).join('; ')), {violations});
}
function identityFinding(value, at) {
  const module = sqliteModule(value);
  return module ? [keyed({rule:'drc-3', key:`drc-3:${at}:${module}`, package:at, module})] : [];
}
const dependencyFields = ['dependencies','optionalDependencies','peerDependencies'];
export function sqliteManifestFindings(manifest, at = manifest?.name ?? 'manifest') {
  const found = identityFinding(manifest?.name, at);
  for (const field of dependencyFields)
    for (const [name, requested] of Object.entries(manifest?.[field] ?? {}))
      found.push(...identityFinding(name, `${at}:${field}`), ...identityFinding(requested, `${at}:${field}:${name}`));
  for (const field of ['bundledDependencies','bundleDependencies'])
    for (const name of Array.isArray(manifest?.[field]) ? manifest[field] : [])
      found.push(...identityFinding(name, `${at}:${field}`));
  return found;
}
export function assertNoSqliteManifest(manifest, at) {
  refuseDrc3(sqliteManifestFindings(manifest, at));
  return manifest;
}
/** The same DRC-3 source reader before registry acquisition, with no migration-path exemption. */
export function assertNoSqliteSources(spec) {
  const selected = selectedSources(packageSources(spec.repositories),
    [...(spec.entries ?? []),...(spec.buildEntries ?? [])]);
  for (const [name, source] of selected) assertNoSqliteManifest(source.manifest,name);
  const reading = closureRules(spec.repositories,{entries:[...(spec.entries ?? []),...(spec.buildEntries ?? [])],absoluteSqlite:true});
  refuseDrc3(reading.violations.filter(v => v.rule === 'drc-3' && sqliteModule(v.module)));
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** pnpm's serialized v9 lock identities; retained DRC-3 reading. */
export function assertNoSqliteLock(lock) {
  if (!record(lock) || !['9','9.0'].includes(String(lock.lockfileVersion)) || !record(lock.importers))
    throw new Error('DRC-3 dependency reading incomplete: expected pnpm v9 lock');
  const found = [];
  const inspect = (value, at) => found.push(...identityFinding(value, at));
  const edges = (node, at) => {
    if (!record(node)) throw new Error(`DRC-3 dependency reading incomplete: ${at}`);
    for (const field of [...dependencyFields,'devDependencies','specifiers']) {
      if (node[field] !== undefined && !record(node[field])) throw new Error(`DRC-3 dependency reading incomplete: ${at}:${field}`);
      for (const [name, value] of Object.entries(node[field] ?? {})) {
        inspect(name, `${at}:${field}`);
        if (typeof value === 'string') inspect(value, `${at}:${field}:${name}`);
        else if (record(value) && typeof value.version === 'string') {
          inspect(value.version, `${at}:${field}:${name}`);
          inspect(value.specifier, `${at}:${field}:${name}`);
        } else throw new Error(`DRC-3 dependency reading incomplete: ${at}:${field}:${name}`);
      }
    }
    for (const name of node.transitivePeerDependencies ?? []) inspect(name, `${at}:transitivePeerDependencies`);
    for (const field of ['bundledDependencies','bundleDependencies'])
      for (const name of Array.isArray(node[field]) ? node[field] : []) inspect(name, `${at}:${field}`);
    inspect(node.name, at);
  };
  for (const section of ['importers','packages','snapshots']) {
    if (lock[section] !== undefined && !record(lock[section])) throw new Error(`DRC-3 dependency reading incomplete: ${section}`);
    for (const [identity, node] of Object.entries(lock[section] ?? {})) {
      if (section !== 'importers') inspect(identity, section);
      edges(node, `${section}:${identity}`);
    }
  }
  for (const [name, value] of Object.entries(lock.overrides ?? {})) { inspect(name, 'overrides'); inspect(value, 'overrides'); }
  for (const [catalog, entries] of Object.entries(lock.catalogs ?? {})) edges({dependencies:entries}, `catalogs:${catalog}`);
  refuseDrc3(found);
  return lock;
}


/** Exhaustive immutable manifest/lock comparison: identify *all* mistaken edges
 * in the selected source graph before a build is retried. This changes only
 * diagnostics. An unresolved or incompatible edge still refuses the release.
 */
export function manifestLockDiscrepancies(manifest, importer, at) {
  if (!record(manifest) || !record(importer) || typeof at !== 'string')
    throw new TypeError('frozen manifest and importer records are required');
  const problems = [];
  for (const field of ['dependencies','optionalDependencies','devDependencies']) {
    const declared = manifest[field] ?? {}, locked = importer[field] ?? {};
    if (!record(declared) || !record(locked))
      throw new TypeError('frozen dependency sections must be records: ' + at + ':' + field);
    const missing = Object.keys(declared).filter(key => !Object.hasOwn(locked,key)).sort();
    const extra = Object.keys(locked).filter(key => !Object.hasOwn(declared,key)).sort();
    const specifiers = Object.keys(declared).filter(key => Object.hasOwn(locked,key) &&
      (!record(locked[key]) || locked[key].specifier !== declared[key]))
      .sort().map(key => ({dependency:key, declared:declared[key], reviewed:locked[key]?.specifier ?? null}));
    if (missing.length || extra.length || specifiers.length)
      problems.push({importer:at, field, missing, extra, specifiers});
  }
  return problems;
}

/** Source-qualified tooling identity; no ambient PATH or package-manager autoswitch. */
export const FROZEN_PNPM_VERSION = '10.34.6';
function incomplete(detail) { throw new Error('DRC-3 frozen acquisition reading incomplete: ' + detail); }
function toolPath(path, name, version, manifestPath) {
  if (typeof path !== 'string' || !isAbsolute(path)) incomplete(`${name} needs an explicit absolute provider path`);
  const actual=realpathSync(path),manifest=JSON.parse(readFileSync(resolve(dirname(actual),manifestPath),'utf8'));
  if(manifest.name!==name||manifest.version!==version)incomplete(`${name} provider version differs`);
  return actual;
}
export function parseFrozenYaml(text,{yamlCli,environment,execute=spawnSync}) {
  const cli=toolPath(yamlCli,'yaml','2.9.0','package.json');
  // The pinned CLI incrementally parses pipe chunks; a valid large lock can fail at a chunk boundary.
  // Use the same inspected provider's API on one complete string, retaining strict single-document refusal.
  const parser=fileURLToPath(new URL('./parse-frozen-yaml.mjs',import.meta.url));
  const result=execute(process.execPath,[parser,resolve(dirname(cli),'dist/index.js')],
    {input:text,encoding:'utf8',maxBuffer:64*1024*1024,env:environment});
  if(result.error||result.status!==0)incomplete('genuine YAML parser failed or input is malformed');
  try{return JSON.parse(result.stdout);}catch{incomplete('YAML parser did not return a JSON record');}
}
export function assertFrozenRegistryGraph(lock,{sourceManifests,workspaceOverrides}={}) {
  assertNoSqliteLock(lock);
  if(lock.pnpmfileChecksum!==undefined)incomplete('reviewed hook checksum needs its own qualified provider');
  if(lock.patchedDependencies&&Object.keys(lock.patchedDependencies).length)incomplete('patched graph requires separate qualification');
  if(!record(lock.packages)||!record(lock.snapshots))incomplete('complete serialized v9 packages and snapshots are required');
  for(const [identity,node] of Object.entries(lock.packages)){
    // pnpm merges package metadata over snapshots; forbid a second dependency graph.
    for(const field of ['dependencies','optionalDependencies'])
      if(Object.hasOwn(node,field))incomplete(`package metadata overrides snapshot edges: ${identity}:${field}`);
    const resolution=node.resolution;
    if(!record(resolution)||resolution.type!==undefined||resolution.gitHosted||resolution.repo||resolution.directory)
      incomplete(`non-registry resolution: ${identity}`);
    if(typeof resolution.integrity!=='string'||!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(resolution.integrity)||Buffer.from(resolution.integrity.slice(7),'base64').length!==64)
      incomplete(`reviewed SHA-512 integrity is missing: ${identity}`);
    if(resolution.tarball!==undefined){
      let url;try{url=new URL(resolution.tarball);}catch{incomplete(`invalid tarball URL: ${identity}`);}
      if(!['https:','http:'].includes(url.protocol)||url.username||url.password)incomplete(`non-registry archive: ${identity}`);
      // Stock lock conversion infers gitHosted for these archive authorities.
      if(['codeload.github.com','gitlab.com','bitbucket.org'].includes(url.hostname))
        incomplete(`Git-hosted archive requires separate qualification: ${identity}`);
    }
  }
  const known=(name,value,at,allowLink)=>{
    const version=typeof value==='string'?value:value?.version;
    if(typeof version!=='string')incomplete(`unreadable edge: ${at}:${name}`);
    if(version.startsWith('link:')){
      // pnpm10 resolves importer links relative to the importer, snapshot links to lockfileDir.
      const from=allowLink?at:'.',base='/frozen-workspace',target=version.slice(5);
      const key=relative(base,resolve(base,from,target));
      if(!target||isAbsolute(target)||!key.startsWith('packages/')||!Object.hasOwn(lock.importers,key)||
         !(sourceManifests instanceof Map)||!sourceManifests.has(key))
        incomplete(`workspace link escapes admitted source or has no qualified importer: ${at}:${name}`);
      if(version!==`link:${relative(resolve(base,from),resolve(base,key))}`)
        incomplete(`workspace source link is not canonical: ${at}:${name}`);
      if(sourceManifests.get(key)?.name!==name)
        incomplete(`workspace source link package identity differs: ${at}:${name}`);
      if(!allowLink&&(lock.overrides?.[name]!=='workspace:*'||workspaceOverrides?.[name]!=='workspace:*'))
        incomplete(`unqualified transitive source override: ${at}:${name}`);
      return;
    }
    if(version.includes(':')||version.startsWith('/'))incomplete(`unqualified edge protocol: ${at}:${name}`);
    const key=version.split('(')[0].includes('@')?version:`${name}@${version}`;
    if(!Object.hasOwn(lock.snapshots,key)||!Object.hasOwn(lock.packages,key.split('(')[0]))incomplete(`incomplete frozen edge: ${at}:${name}`);
  };
  for(const [at,node] of Object.entries(lock.importers))
    for(const field of ['dependencies','optionalDependencies','devDependencies'])
      for(const [name,value] of Object.entries(node[field]??{}))known(name,value,at,true);
  for(const [at,node] of Object.entries(lock.snapshots))
    for(const field of ['dependencies','optionalDependencies'])
      for(const [name,value] of Object.entries(node[field]??{}))known(name,value,at,false);
  return lock;
}
export function readFrozenWorkspace({workspace,yamlCli,environment,execute=spawnSync}) {
  const root=realpathSync(workspace),readYaml=text=>parseFrozenYaml(text,{yamlCli,environment,execute});
  const config=readYaml(readFileSync(join(root,'pnpm-workspace.yaml'),'utf8'));
  if(!record(config))incomplete('workspace configuration is not a record');
  const allowed=new Set(['packages','linkWorkspacePackages','preferWorkspacePackages','autoInstallPeers','ignoreScripts','overrides']);
  for(const key of Object.keys(config))if(!allowed.has(key))incomplete(`workspace setting needs separate qualification: ${key}`);
  if(!Array.isArray(config.packages)||!(config.packages.length===0||config.packages.length===1&&config.packages[0]==='packages/*'))
    incomplete('expected the existing generated flat workspace');
  const lockText=readFileSync(join(root,'pnpm-lock.yaml'),'utf8');
  // This is a conflict-marker refusal, not a YAML parser or automatic conflict repair.
  if(/^(?:<<<<<<<|=======|>>>>>>>)(?:\s|$)/mu.test(lockText))incomplete('reviewed lock has conflict markers');
  const lock=assertNoSqliteLock(readYaml(lockText));
  const paths=['.'];
  if(config.packages.length){
    for(const entry of readdirSync(join(root,'packages'),{withFileTypes:true})){
      if(!entry.isDirectory())incomplete('generated workspace package is not a directory');
      paths.push(`packages/${entry.name}`);
    }
  }
  const materialized = [...paths].sort(), reviewed = Object.keys(lock.importers).sort();
  if (JSON.stringify(materialized) !== JSON.stringify(reviewed)) {
    const materializedSet = new Set(materialized), reviewedSet = new Set(reviewed);
    const unreviewed = materialized.filter(at => !reviewedSet.has(at));
    const absent = reviewed.filter(at => !materializedSet.has(at));
    const sample = entries => JSON.stringify(entries.slice(0, 12));
    incomplete('reviewed importer set differs from materialized workspace: '
      + `materialized=${materialized.length} reviewed=${reviewed.length}; `
      + `not-in-lock=${unreviewed.length} ${sample(unreviewed)}; `
      + `not-on-disk=${absent.length} ${sample(absent)}`);
  }
  const sourceManifests=new Map(),sourceNames=new Set(),drift=[];
  for(const at of paths){
    const directory=realpathSync(resolve(root,at));
    if(directory!==resolve(root,at))incomplete('workspace source directory is redirected');
    if(existsSync(join(directory,'.npmrc')))incomplete(`workspace npm configuration needs separate qualification: ${at}`);
    const manifestPath=join(directory,'package.json');
    if(!lstatSync(manifestPath).isFile())incomplete(`workspace source manifest is redirected or nonregular: ${at}`);
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    if(at!=='.'){
      if(typeof manifest.name!=='string'||!manifest.name||sourceNames.has(manifest.name))
        incomplete(`workspace source package identity is missing or ambiguous: ${at}`);
      sourceNames.add(manifest.name);
    }
    sourceManifests.set(at,manifest);
    assertNoSqliteManifest(manifest,at);
    assertNoSqliteManifest({dependencies:manifest.devDependencies},`${at}:active-development`);
    if(manifest.pnpm||manifest.devEngines?.runtime)incomplete(`package configuration/runtime bootstrap needs qualification: ${at}`);
    if(at==='.'&&manifest.packageManager!==`pnpm@${FROZEN_PNPM_VERSION}`)incomplete('generated packageManager does not match the qualified provider');
    drift.push(...manifestLockDiscrepancies(manifest,lock.importers[at],at));
  }
  if (drift.length) incomplete('manifest and reviewed lock declarations differ: '
    + JSON.stringify({count:drift.length,examples:drift.slice(0,32)}));
  assertFrozenRegistryGraph(lock,{sourceManifests,workspaceOverrides:config.overrides});
  return {root,lock,lockText};
}
/** Bounded stock frozen installation. Resolution is intentionally not implemented by hooks. */
export function acquireFrozenDependencies({workspace,cache,store,pnpmCli,yamlCli,environment,mode='frozen',execute=spawnSync}) {
  if(mode!=='frozen')incomplete('metadata resolution is held: public pnpm10 hooks do not cover all acquisition paths');
  if(!record(environment)||!environment.HOME||!environment.PATH)incomplete('explicit isolated tool environment is required');
  const cli=toolPath(pnpmCli,'pnpm',FROZEN_PNPM_VERSION,'../package.json');
  const admitted=readFrozenWorkspace({workspace,yamlCli,environment,execute});
  const args=[cli,'--dir',admitted.root,'install','--frozen-lockfile','--lockfile=true','--lockfile-dir',admitted.root,
    '--ignore-scripts','--ignore-pnpmfile=true','--fix-lockfile=false','--force=false',
    '--config.git-branch-lockfile=false','--merge-git-branch-lockfiles=false','--shared-workspace-lockfile=true',
    '--use-store-server=false','--use-running-store-server=false','--config.enable-global-virtual-store=false',
    '--config.manage-package-manager-versions=false','--config.package-manager-strict-version=true',
    '--cache-dir',cache,'--store-dir',store];
  const env={...environment,NPM_CONFIG_WORKSPACE_DIR:admitted.root,npm_config_workspace_dir:admitted.root,
    NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS:'false',npm_config_manage_package_manager_versions:'false'};
  const result=execute(process.execPath,args,{cwd:admitted.root,encoding:'utf8',maxBuffer:256*1024*1024,env});
  if(result.error||result.status!==0)throw result.error??new Error(`frozen dependency acquisition refused: ${String(result.stderr||result.stdout).slice(-4000)}`);
  if(readFileSync(join(admitted.root,'pnpm-lock.yaml'),'utf8')!==admitted.lockText)incomplete('reviewed lock changed during frozen installation');
  return {lockState:'frozen',pnpmVersion:FROZEN_PNPM_VERSION};
}

/** Exact inspected archive inventories, bound to this selected controller source. */
const toolchainInventorySha256 = 'e8ce6400d7a73a795ee9133cb0f9cd7e09b67f92e42750b80934ccd63265a712';
export function verifyFrozenToolchain(root) {
  const inventoryBytes=readFileSync(new URL('../specifications/dependency-toolchain.json',import.meta.url));
  if(createHash('sha256').update(inventoryBytes).digest('hex')!==toolchainInventorySha256)
    incomplete('toolchain inventory source digest differs');
  const providers=JSON.parse(inventoryBytes),paths={};
  for(const provider of providers){
    const directory=join(root,'share',provider.name,'package');
    if(realpathSync(directory)!==directory)incomplete('toolchain provider is redirected');
    const observed=[];
    const visit=at=>{
      for(const entry of readdirSync(at,{withFileTypes:true})){
        const path=join(at,entry.name),stat=lstatSync(path);
        if(stat.isDirectory())visit(path);
        else if(stat.isFile())observed.push(path);
        else incomplete('toolchain contains a non-regular carrier');
      }
    };visit(directory);
    const expected=new Map(provider.files.map(file=>[join(root,'share',provider.name,file.path),file]));
    if(observed.length!==expected.size)incomplete('toolchain file set differs');
    for(const path of observed){
      const file=expected.get(path),bytes=readFileSync(path);
      if(!file||bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)
        incomplete('toolchain file bytes differ');
    }
    // Prevent optional dependency lookup from escaping the inspected package.
    for(let parent=dirname(directory);;parent=dirname(parent)){
      if(existsSync(join(parent,'node_modules')))incomplete('unqualified ancestor module directory');
      if(parent===dirname(parent))break;
    }
    paths[provider.name]=join(directory,provider.name==='pnpm'?'bin/pnpm.cjs':'bin.mjs');
  }
  return {pnpmCli:paths.pnpm,yamlCli:paths.yaml,inventorySha256:toolchainInventorySha256,
    nodeExecutable:realpathSync(process.execPath),nodeVersion:process.versions.node};
}
export function acquireGuixFrozenDependencies({toolchain,workspace,work,execute=spawnSync}) {
  const root=realpathSync(toolchain);
  if(root!==toolchain||!/^\/gnu\/store\/[0-9a-z]{32}-[^/]+$/u.test(root))
    incomplete('provider must be the exact realized Guix toolchain store path');
  if(process.versions.node!=='24.18.0')incomplete('Guix Node version needs separate qualification');
  if(realpathSync(join(root,'bin/node'))!==realpathSync(process.execPath))
    incomplete('controller must run through the toolchain Node interpreter');
  const providers=verifyFrozenToolchain(root),state=mkdtempSync(join(realpathSync(work),'dependency-tool-environment-'));
  // Fresh state prevents user/global configuration or stores from prior invocations.
  const home=join(state,'home'),config=join(state,'config'),cache=join(state,'cache'),temp=join(state,'tmp'),store=join(state,'store');
  for(const path of [home,config,cache,temp,store])mkdirSync(path);
  const user=join(config,'npmrc'),global=join(config,'global-npmrc');
  writeFileSync(user,'');writeFileSync(global,'');
  const environment={HOME:home,PATH:join(root,'bin'),LANG:'C.UTF-8',LC_ALL:'C.UTF-8',
    XDG_CONFIG_HOME:config,XDG_CACHE_HOME:cache,TMPDIR:temp,TMP:temp,TEMP:temp,
    npm_config_userconfig:user,NPM_CONFIG_USERCONFIG:user,npm_config_globalconfig:global,NPM_CONFIG_GLOBALCONFIG:global,
    NODE_OPTIONS:'--no-addons --no-global-search-paths',NODE_DISABLE_COMPILE_CACHE:'1',
    npm_config_update_notifier:'false',npm_config_manage_package_manager_versions:'false',NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS:'false'};
  return acquireFrozenDependencies({workspace,cache,store,...providers,environment,execute});
}

if (isCliEntry(import.meta.url)) {
  if(process.argv[2]==='--verify-guix-toolchain'){
    if(process.argv.length!==4)incomplete('usage: --verify-guix-toolchain TOOLCHAIN');
    process.stdout.write(JSON.stringify(verifyFrozenToolchain(process.argv[3]))+'\n');
  }else if(process.argv[2]==='--acquire-guix-frozen'){
    if(process.argv.length!==6)incomplete('usage: --acquire-guix-frozen TOOLCHAIN WORKSPACE WORK');
    process.stdout.write(JSON.stringify(acquireGuixFrozenDependencies({toolchain:process.argv[3],workspace:process.argv[4],work:process.argv[5]}))+'\n');
  }else{
  const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(JSON.stringify(readDesignRules(spec, {wiring: await wiringReader(spec.repositories)}), null, 2) + '\n');
}
}
