// Every assembly failure the controller raises is named by its break class, with stable keys matching the
// fabrication line design, section 8 (bare-cedar-fog engineering-services-section/fabrication-services-section,
// 2026-10-10-fabrication-line-high-level-design.md). A break is recorded as `561-group.assembly-break`; a class
// met twice is owed a re-architecture, so the class must be read from the failure, never guessed later.
export const BREAK_CLASSES = Object.freeze([
  'unpinned-workspace-dependency',
  'unexported-interface',
  'divergent-copy',
  'stale-consumer-after-rename',
  'undeclared-import',
  'repository-formation-unavailable',
  'export-target-missing',
  'export-into-retired-tree',
]);

// The import reader's diagnostics (source-imports.mjs) that name a package-interface break, under the class
// node-js-packages-engineering-services-section's check-package-interfaces reports for the same defect at PR time: an export
// whose target file is not committed, and an export that reaches into a legacy/ or test/ tree.
const RETIRED_TREES = new Set(['legacy', 'test']);

/** The break class an import-reader diagnostic names, or null. */
export function classOfImportDiagnostic(diagnostic) {
  if (diagnostic?.reason === 'runtime-target-not-in-committed-source') return 'export-target-missing';
  if (diagnostic?.reason === 'runtime-target-not-materialized'
    && String(diagnostic.file ?? '').split('/').some((part) => RETIRED_TREES.has(part))) return 'export-into-retired-tree';
  return null;
}

// A pinned or changed repository could not be formed at its commit: the clone or fetch failed, the ref it
// tracks is gone while its pin is held, or the remote no longer serves the commit ("not our ref").
const FORMATION_UNAVAILABLE = [
  /\bnot our ref\b/u,
  /Ref gone, pin held: (\S+)@/u,
  /couldn't find remote ref/u,
  /\bgit (?:clone|fetch) failed\b/u,
  /fatal: (?:repository '[^']*' not found|could not read from remote repository|unable to access)/iu,
];

const MISSING_PROVIDER = [
  /entry or workspace dependency has no home among the machine's sources: (\S+)/u,
  /workspace dependency has no home among the machine's sources: \S+ -> (\S+)/u,
  /unresolved workspace provider: \S+ -> (\S+)/u,
];

/** The break class of a failure message, or null when it is not an assembly break the deck names.
 * A missing provider whose name a pinned package carried before the change is a stale consumer of a rename. */
export function classifyBreak(message, { formerNames = new Set() } = {}) {
  const text = String(message ?? '');
  let breakClass = null, missing = null;
  const formation = FORMATION_UNAVAILABLE.map((pattern) => text.match(pattern)).find(Boolean);
  if (formation) breakClass = 'repository-formation-unavailable';
  else if (/ambiguous source owner for required package/u.test(text)) breakClass = 'divergent-copy';
  else if (/Selected runtime imports have no exported interface/u.test(text)) breakClass = 'unexported-interface';
  else if (/Selected runtime imports lack declarations/u.test(text)) breakClass = 'undeclared-import';
  else for (const pattern of MISSING_PROVIDER) {
    const match = text.match(pattern);
    if (match) { missing = match[1]; breakClass = formerNames.has(missing) ? 'stale-consumer-after-rename' : 'unpinned-workspace-dependency'; break; }
  }
  if (!breakClass) return null;
  const repository = formation?.[1];
  return { kind: '561-group.assembly-break', class: breakClass, ...(missing ? { package: missing } : {}),
    ...(repository ? { repository } : {}), message: text.slice(-4000) };
}
