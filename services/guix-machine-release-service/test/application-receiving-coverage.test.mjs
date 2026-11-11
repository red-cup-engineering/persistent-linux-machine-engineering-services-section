import test from 'node:test';
import assert from 'node:assert/strict';
import {applicationReceivingCoverage} from '../scripts/application-receiving-coverage.mjs';

const lspace = '@lenticule-science/l-space';
const template = () => ({
  sources: {entries: [lspace, '@red-cup-engineering/metroplat'], receivingPackages: ['@red-cup-engineering/metroplat']},
  profile: {applications: [{module: `${lspace}/metroplat`}]},
  manifests: {[lspace]: {name: lspace, receivingTests: [
    'test/metroplat-root.test.mjs', 'test/metroplat-receiving.test.mjs',
    'test/oauth-grant-profile.test.mjs', 'test/reader-policy.test.mjs']}}
});

test('real Cold Red Gate 2026-10-10 omission fails, rather than counting package installation as receiving', () => {
  assert.throws(() => applicationReceivingCoverage(template()),
    /declares receiving tests but was not enrolled: @lenticule-science\/l-space/);
});

test('enrollment receives all source-declared L-Space checks without a shadow list', () => {
  const f = template(); f.sources.receivingPackages.push(lspace);
  const report = applicationReceivingCoverage(f);
  assert.equal(report.kind, 'application-receiving-coverage.v1');
  assert.deepEqual(report.enrolledChecks, [{package:lspace, module:`${lspace}/metroplat`,
    receivingTests:f.manifests[lspace].receivingTests}]);
});

test('an absent or wrong owning manifest cannot bless the consuming application', () => {
  const f=template();f.sources.receivingPackages.push(lspace);
  delete f.manifests[lspace];
  assert.throws(()=>applicationReceivingCoverage(f),/lacks its admitted package manifest/);
  f.manifests[lspace]={name:'@other/owner',receivingTests:['test/a.mjs']};
  assert.throws(()=>applicationReceivingCoverage(f),/lacks its admitted package manifest/);
});

test('malformed, duplicate, or empty declarations fail before selection', () => {
  const f=template(); f.sources.receivingPackages.push(lspace);
  for (const receivingTests of [[], ['x','x'], 'node --test', [null]]) {
    f.manifests[lspace].receivingTests=receivingTests;
    assert.throws(()=>applicationReceivingCoverage(f),/invalid owning receiving declaration/);
  }
});

test('duplicate selections, identities, and application modules are refused', () => {
  for (const change of [
    f=>f.sources.entries.push(lspace),
    f=>f.sources.receivingPackages.push('@red-cup-engineering/metroplat'),
    f=>f.profile.applications.push({module:`${lspace}/metroplat`}),
  ]) {
    const f=template(); change(f);
    assert.throws(()=>applicationReceivingCoverage(f),/unique/);
  }
});

test('invalid module traversal is refused and cannot alias another package', () => {
  for (const bad of ['@lenticule-science/l-space/../other','@lenticule-science/l-space/./metroplat',
    '@lenticule-science/l-space/../../other','l-space/metroplat']) {
    const f=template(); f.profile.applications[0].module=bad;
    assert.throws(()=>applicationReceivingCoverage(f),/invalid installed application module/);
  }
});

test('uninstalled module and entry lacking a receiving declaration make no false acceptance claim',()=>{
  const f=template();f.sources.entries=['@red-cup-engineering/metroplat'];
  assert.deepEqual(applicationReceivingCoverage(f).enrolledChecks,[]);
  f.sources.entries.push(lspace);delete f.manifests[lspace].receivingTests;
  assert.deepEqual(applicationReceivingCoverage(f).enrolledChecks,[]);
});

test('source manifests cannot be inferred from the receivingPackages names alone',()=>{
  const f=template();f.sources.receivingPackages.push(lspace); f.manifests={};
  assert.throws(()=>applicationReceivingCoverage(f),/lacks its admitted package manifest/);
});

// Path aliases must not cause two different module specifiers to count as one received package.
test('reject noncanonical installed application suffixes and double separators', () => {
  for (const suffix of ['/foo/.', '/foo//bar', '/foo/./', '/foo/..', '//foo']) {
    const f = template();
    f.profile.applications[0].module = lspace + suffix;
    assert.throws(() => applicationReceivingCoverage(f), /invalid installed application module/, suffix);
  }
});

test('enrollment is never execution, verification, or independent acceptance', () => {
  const f = template(); f.sources.receivingPackages.push(lspace);
  const report = applicationReceivingCoverage(f);
  assert.equal(Object.hasOwn(report,'received'),false);
  assert.equal(Object.hasOwn(report,'verified'),false);
  assert.equal(Object.hasOwn(report,'accepted'),false);
  assert.deepEqual(report.enrolledChecks[0].receivingTests,f.manifests[lspace].receivingTests);
});
