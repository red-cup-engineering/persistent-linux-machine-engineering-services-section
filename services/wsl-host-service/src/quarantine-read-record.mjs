// Private content receiver for the two committed input slots. No mutation authority.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const fail = () => { throw new Error('quarantine read record refused: private canonical identity or digest changed'); };
export function receiveQuarantineReadRecord(binding, slot, expectedSha256) {
  if (!['parametersPath', 'preparationPath'].includes(slot) || !/^[a-f0-9]{64}$/.test(expectedSha256 || '')) fail();
  const path = binding[slot];
  if (typeof path !== 'string' || resolve(path) !== path || !path.startsWith(join(binding.sectionRoot, 'data/records') + '/') || realpathSync(path) !== path || process.getuid() !== binding.uid) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = st => [st.dev, st.ino, st.uid, st.gid, st.mode, st.nlink, st.size, st.mtimeNs, st.ctimeNs];
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.uid !== BigInt(binding.uid) || st.gid !== BigInt(process.getgid()) || (st.mode & 0o077n) !== 0n || st.nlink !== 1n || st.size > 65536n) fail();
    const bytes = Buffer.alloc(Number(st.size) + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0), data = bytes.subarray(0, length);
    if (length !== Number(st.size) || createHash('sha256').update(data).digest('hex') !== expectedSha256) fail();
    const after = fstatSync(fd, { bigint: true }), pathAfter = lstatSync(path, { bigint: true });
    if (JSON.stringify(identity(st).map(String)) !== JSON.stringify(identity(after).map(String)) || JSON.stringify(identity(st).map(String)) !== JSON.stringify(identity(pathAfter).map(String)) || realpathSync(path) !== path) fail();
    return { text: data.toString('utf8'), identity: identity(st).map(String) };
  } finally { closeSync(fd); }
}
