import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

// Node's default ESM loader resolves the entry module through symlinks while
// argv[1] keeps the invoked carrier path. Compare that path's canonical URL.
// Missing/non-file entry arguments are ordinary imports, not CLI execution.
export function isCliEntry(moduleUrl, entry=process.argv[1]) {
  if (typeof entry!=='string'||!entry) return false;
  try { return moduleUrl===pathToFileURL(realpathSync(entry)).href; }
  catch { return false; }
}
