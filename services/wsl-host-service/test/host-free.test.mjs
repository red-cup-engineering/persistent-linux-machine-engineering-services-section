import test from 'node:test';
import assert from 'node:assert/strict';
import { hostFreeBytes } from '../src/host-free.mjs';

const parameters = JSON.parse(JSON.stringify({
  schema: 'wsl-host-parameters@1',
  windows: { backingStorage: {
    distributionName: 'Ubuntu',
    registryKey: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{645c490d-c03a-4203-80e4-451ee497d286}',
    basePath: 'C:\\Users\\emsen\\AppData\\Local\\wsl\\{645c490d-c03a-4203-80e4-451ee497d286}',
    vhdFileName: 'ext4.vhdx',
    volumeId: '\\\\?\\Volume{715daebd-cb0c-495a-a2cb-85c7ff775c00}\\',
    linuxMount: '/', powershell: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    wslpath: '/usr/bin/wslpath', volumeMount: '/mnt/c', timeoutMs: 10000, maxAgeMs: 15000,
    policy: { minFreeBytes: '100000000000', minFreePercent: 3, growthBytes: '2147483648', overheadBytes: '67108864', basis: 'test floor' },
  } },
}));

test('hostFreeBytes returns the Windows volume availableBytes', () => {
  const p = parameters.windows.backingStorage;
  const free = hostFreeBytes(parameters, {
    osRelease: () => 'x-microsoft-standard-WSL2', environment: { WSL_DISTRO_NAME: 'Ubuntu' },
    deviceOf: path => ({ real: path, device: '1' }), run: () => '\\\\wsl.localhost\\Ubuntu\\\n',
    mountinfo: () => '137 88 0:69 / /mnt/c rw,noatime - 9p C:\\134 rw,aname=drvfs;path=C:\\;uid=1000\n',
    statfs: () => ({ bsize: 4096n, blocks: 244140625n, bfree: 4858398n, bavail: 4858398n }),
    lstat: () => ({ size: 1000n, blocks: 2n, dev: 1n, ino: 1n, isFile: () => true, isSymbolicLink: () => false }),
  });
  assert.equal(free, 19899998208n);
});
