/**
 * The machine release receiver must not confuse a package's presence in a
 * runtime with receiving of its declared application behavior.
 *
 * The caller supplies the source-owned profile and manifest read from its
 * immutable materialized release, not search results or a hand-written map.
 * This predicate does not read a corpus, grant access, or settle a release.
 */
const packageNameOf = module => {
  const match = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)(?:\/[a-zA-Z0-9._/-]+)?$/u.exec(module ?? '');
  if (!match || module.split('/').some((segment, index) => index > 1 && (!segment || segment === '.' || segment === '..')))
    throw new Error('invalid installed application module');
  return match[1];
};

const unique = (values, name) => {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || value.length === 0)
      || new Set(values).size !== values.length)
    throw new Error(`${name} must contain unique nonempty strings`);
  return values;
};

export function applicationReceivingCoverage({sources, profile, manifests}) {
  if (!sources || !profile || !manifests || typeof manifests !== 'object' || Array.isArray(manifests))
    throw new Error('release coverage requires source, profile and admitted manifest evidence');
  const entries = unique(sources.entries, 'source entries');
  const receiving = unique(sources.receivingPackages, 'receiving packages');
  if (!Array.isArray(profile.applications)) throw new Error('installed applications are required');
  const apps = unique(profile.applications.map(app => app?.module), 'installed application modules');
  const evidence = [];
  for (const module of apps) {
    const name = packageNameOf(module);
    // A runtime application is not necessarily a top-level entry. Only direct
    // entries can impose a host receiving requirement; dependency packages
    // are still governed by their owning manifest and ordinary provider tests.
    if (!entries.includes(name)) continue;
    const manifest = manifests[name];
    if (!manifest || manifest.name !== name)
      throw new Error(`installed application lacks its admitted package manifest: ${name}`);
    const tests = manifest.receivingTests;
    if (tests === undefined) continue;
    if (!Array.isArray(tests) || tests.length === 0 || tests.some(t => typeof t !== 'string' || !t)
        || new Set(tests).size !== tests.length)
      throw new Error(`invalid owning receiving declaration: ${name}`);
    if (!receiving.includes(name))
      throw new Error(`installed application declares receiving tests but was not enrolled: ${name}`);
    evidence.push({package: name, module, receivingTests: [...tests]});
  }
  return {kind: 'application-receiving-coverage.v1', enrolledChecks: evidence};
}
