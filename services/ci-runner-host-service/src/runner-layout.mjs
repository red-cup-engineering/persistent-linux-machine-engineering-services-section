// Original CI owner pure layout producers, shared by installation and admission.
import {join} from 'node:path';
import {tmpdir} from 'node:os';
export const unitName = r => `ci-runner-${r.name}.service`;
export const paths = r => ({
  runner: join(r.root, 'runner'), version: join(r.root, 'versions', r.version),
  hook: join(r.root, 'hooks', 'job-completed.sh'), work: join(r.root, 'runner', '_work'), diag: join(r.root, 'runner', '_diag'),
});
export const tarballPath = r => r.tarball ?? join(tmpdir(),`actions-runner-linux-x64-${r.version}.tar.gz`);
