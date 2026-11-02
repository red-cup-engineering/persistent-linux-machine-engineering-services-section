// Where a runner's files live. Each runner is the GitHub Actions runner directory itself (its root);
// pinned versions are shared beside the roots and hard-linked into each runner (CR-3, CR-5).
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
export const unitName = r => `ci-runner-${r.name}.service`;
export const paths = r => ({
  runner: r.root, version: join(dirname(r.root), 'versions', r.version),
  hook: join(dirname(r.root), 'hooks', `${r.name}-job-completed.sh`), work: join(r.root, '_work'), diag: join(r.root, '_diag'),
});
export const tarballPath = r => r.tarball ?? join(tmpdir(),`actions-runner-linux-x64-${r.version}.tar.gz`);
