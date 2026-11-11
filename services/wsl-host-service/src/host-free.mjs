// The real free bytes of the disk shared by this WSL root and Windows.
// The root filesystem's free space is never read: the root is a virtual disk
// stored on the Windows drive, so it reports space that does not exist.
import { readFileSync } from 'node:fs';
import { observeBackingVolumeCapacity } from './backing-capacity.mjs';

export function hostFreeBytes(parameters, ports = {}) {
  const capacity = observeBackingVolumeCapacity(parameters, ['/'], ports);
  return BigInt(capacity.volumes[0].availableBytes);
}

export function hostFreeFromRecord(path, ports = {}) {
  return hostFreeBytes(JSON.parse(readFileSync(path, 'utf8')), ports);
}
