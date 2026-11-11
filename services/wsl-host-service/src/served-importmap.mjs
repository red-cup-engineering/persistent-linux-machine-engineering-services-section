const owns = (object, key) => Object.hasOwn(object, key);
const urlLike = value => /^(?:\.{1,2}\/|\/|[A-Za-z][A-Za-z0-9+.-]*:)/u.test(value);
function data(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('import map Data object required');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !owns(descriptors[key], 'value'))) throw new TypeError('import map Data properties required');
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}
export function parseServedImportMap(value, baseURL) {
  const base = new URL(baseURL);
  if (!['https:', 'http:'].includes(base.protocol)) throw new TypeError('HTTP import map base required');
  const original = data(value);
  const processMap = value => {
    const result = Object.create(null);
    for (const [key, target] of Object.entries(data(value))) {
      if (!key || (target !== null && (typeof target !== 'string' || !urlLike(target)))) throw new TypeError('invalid import map entry');
      const normalized = urlLike(key) ? new URL(key, base).href : key;
      if (owns(result, normalized)) throw new TypeError('ambiguous normalized import map key');
      const address = target === null ? null : new URL(target, base).href;
      if (key.endsWith('/') && address !== null && !address.endsWith('/')) throw new TypeError('prefix target must end with /');
      result[normalized] = address;
    }
    return result;
  };
  const scopes = Object.create(null);
  for (const [key, entries] of Object.entries(data(original.scopes === undefined ? {} : original.scopes))) {
    const normalized = new URL(key, base).href;
    if (owns(scopes, normalized)) throw new TypeError('ambiguous normalized scope');
    scopes[normalized] = processMap(entries);
  }
  return {imports: processMap(original.imports === undefined ? {} : original.imports), scopes};
}
function findMatch(specifier, map, asURL) {
  // HTML resolving-an-imports-match permits exact URLs but excludes prefix
  // matches for non-special schemes, such as data: and node:.
  const prefixAllowed = asURL === null || ['ftp:', 'file:', 'http:', 'https:', 'ws:', 'wss:'].includes(asURL.protocol);
  const key = owns(map, specifier) ? specifier : Object.keys(map)
    .filter(key => prefixAllowed && key.endsWith('/') && specifier.startsWith(key)).sort((a, b) => b.length - a.length)[0];
  if (key === undefined) return undefined;
  if (map[key] === null) throw new Error('Blocked import map entry');
  if (key === specifier) return map[key];
  const target = new URL(specifier.slice(key.length), map[key]).href;
  if (!target.startsWith(map[key])) throw new Error('Backtracking in import map prefix');
  return target;
}
export function resolveServedImport(specifier, referrerURL, map) {
  if (typeof specifier !== 'string' || !specifier) throw new TypeError('module specifier required');
  const referrer = new URL(referrerURL);
  const asURL = urlLike(specifier) ? new URL(specifier, referrer) : null;
  const normalized = asURL === null ? specifier : asURL.href;
  const scopes = Object.keys(map.scopes).sort((a, b) => b.length - a.length);
  for (const scope of scopes) {
    if (referrer.href === scope || (scope.endsWith('/') && referrer.href.startsWith(scope))) {
      const selected = findMatch(normalized, map.scopes[scope], asURL);
      if (selected !== undefined) return selected;
    }
  }
  const selected = findMatch(normalized, map.imports, asURL);
  if (selected !== undefined) return selected;
  if (urlLike(specifier)) return normalized;
  throw new Error('Unresolved bare module specifier: ' + specifier);
}
