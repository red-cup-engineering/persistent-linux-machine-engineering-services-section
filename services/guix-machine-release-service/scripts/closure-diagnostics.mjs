/**
 * Exhaustive bounded diagnostic of missing workspace source identities in a
 * proposed immutable Guix package graph. A first-error resolver obscures
 * distinct simultaneous source-admission failures; this read-only pass
 * lists each reachable unmet workspace demand before materialization.
 *
 * This never authorizes a version alias, a guessed rename, or a deployment.
 */
export function missingWorkspaceSources(packages, entries) {
  if (!(packages instanceof Map)) throw new TypeError('packages must be a Map');
  if (!Array.isArray(entries) || !entries.every(name => typeof name === 'string'))
    throw new TypeError('entries must be package names');
  const queue = [...entries], visited = new Set(), failures = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const name = queue[cursor];
    if (visited.has(name)) continue;
    visited.add(name);
    const source = packages.get(name);
    // Missing/ambiguous entries remain the existing selectedSources gate's job.
    if (!source || Array.isArray(source)) continue;
    const manifest = source.manifest;
    const peers = Object.fromEntries(Object.entries(manifest.peerDependencies ?? {})
      .filter(([peer]) => !manifest.peerDependenciesMeta?.[peer]?.optional));
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...peers,
    };
    for (const [dependency, requested] of Object.entries(dependencies)) {
      if (packages.has(dependency)) queue.push(dependency);
      else if (typeof requested === 'string' && requested.startsWith('workspace:'))
        failures.push({consumer: name, dependency});
    }
  }
  return failures.sort((a, b) =>
    a.consumer.localeCompare(b.consumer) || a.dependency.localeCompare(b.dependency));
}

export function assertWorkspaceSources(packages, entries) {
  const failures = missingWorkspaceSources(packages, entries);
  if (failures.length) {
    throw new Error('workspace dependencies have no home among the machine\'s sources (' +
      failures.length + '): ' + failures.map(({consumer, dependency}) =>
        consumer + ' -> ' + dependency).join('; '));
  }
}

/**
 * Enumerate ambiguity in the *possible* dependency closure without selecting
 * a provider. If an unresolved name has two owners, follow both candidates'
 * declared dependencies so the operator learns every other potentially
 * obstructing owner in a single, read-only source review.
 *
 * A possible closure is conservative: an ambiguity's alternatives may have
 * different transitive dependencies. This never grants authority to either.
 */
export function ambiguousRequiredSources(packages, entries) {
  if (!(packages instanceof Map)) throw new TypeError('packages must be a Map');
  if (!Array.isArray(entries) || !entries.every(name => typeof name === 'string'))
    throw new TypeError('entries must be package names');
  const queue = [...entries], visited = new Set(), ambiguous = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const name = queue[cursor];
    if (visited.has(name)) continue;
    visited.add(name);
    const source = packages.get(name);
    if (!source) continue; // Missing requirements remain the original resolver's refusal.
    const alternatives = Array.isArray(source) ? source : [source];
    if (alternatives.length > 1) {
      ambiguous.push({
        name,
        sources: alternatives.map(candidate => String(candidate.repository) + ':' + String(candidate.path)).sort(),
      });
    }
    for (const candidate of alternatives) {
      const manifest = candidate.manifest;
      const peers = Object.fromEntries(Object.entries(manifest.peerDependencies ?? {})
        .filter(([peer]) => !manifest.peerDependenciesMeta?.[peer]?.optional));
      const deps = { ...manifest.dependencies, ...manifest.optionalDependencies, ...peers };
      for (const dependency of Object.keys(deps))
        if (packages.has(dependency)) queue.push(dependency);
    }
  }
  return ambiguous.sort((a, b) => a.name.localeCompare(b.name));
}
