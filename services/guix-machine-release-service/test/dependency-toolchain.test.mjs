import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyFrozenToolchain,acquireGuixFrozenDependencies} from '../scripts/design-rules.mjs';
import {testController} from '../scripts/test-controller.mjs';

function scratch(t){const root=mkdtempSync(join(tmpdir(),'toolchain-refusal-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
test('unrealized toolchain path refuses before any provider launch',t=>{
  const root=scratch(t);let calls=0;
  assert.throws(()=>acquireGuixFrozenDependencies({toolchain:root,workspace:root,work:root,execute:()=>{calls++;}}),/exact realized Guix/);
  assert.equal(calls,0);
});
test('missing inspected files refuse without evaluating package code',t=>{
  const root=scratch(t);mkdirSync(join(root,'share/pnpm/package'),{recursive:true});
  assert.throws(()=>verifyFrozenToolchain(root),/file set differs/);
});
test('redirected provider directory refuses without evaluating package code',t=>{
  const root=scratch(t);mkdirSync(join(root,'share/pnpm'),{recursive:true});mkdirSync(join(root,'elsewhere'));
  symlinkSync(join(root,'elsewhere'),join(root,'share/pnpm/package'),'dir');
  assert.throws(()=>verifyFrozenToolchain(root),/provider is redirected/);
});
test('source-test scope is fixed rather than caller-selected commands',()=>{
  assert.throws(()=>testController('/unused','/unused','resolve'),/unsupported controller test scope/);
});
test('source wiring retains pinned supply and no npm bootstrap',()=>{
  const scm=readFileSync(new URL('../scripts/github-machine-release.scm',import.meta.url),'utf8');
  assert.doesNotMatch(scm,/"npm"|pnpm@11/u);
  assert.match(scm,/pinned-guix\.scm/u);assert.match(scm,/--require-installed/u);assert.match(scm,/--acquire-guix-frozen/u);
  assert.match(scm,/metadata resolution held/u);
  const supplier=readFileSync(new URL('../src/guix-deployment.scm',import.meta.url),'utf8');
  assert.match(supplier,/\(when \(%graft\?\)/u);
  assert.match(supplier,/package-derivation store prerequisite #:graft\? #f/u);
  assert.match(supplier,/valid-path\? store path/u);
  assert.match(supplier,/list node tar gzip builder-guile/u);
  const runner=readFileSync(new URL('../scripts/test-controller.mjs',import.meta.url),'utf8');
  assert.match(runner,/mounted\[0\]\.commit!==commit/u);
  assert.match(runner,/testScope==='toolchain'\?\[\]:\[/u);
  assert.match(runner,/controller-toolchain-test\.json/u);
  assert.match(runner,/guix-controller-toolchain-test\.v1/u);
  assert.match(runner,/qualifyToolchain/u);
  const assay=readFileSync(new URL('../scripts/qualify-toolchain.mjs',import.meta.url),'utf8');
  assert.match(assay,/test\/qualification\/frozen-acquisition-provider\.test\.mjs/u);
});

test('canonical archive tools are selected once for both guard and builder',()=>{
  const source=readFileSync(new URL('../src/guix-deployment.scm',import.meta.url),'utf8');
  const factory=source.slice(source.indexOf('(define (dependency-toolchain)'),source.indexOf(';; Units and launchers'));
  assert.match(factory,/\(let \(\(tar \(canonical-package tar\)\)\s+\(gzip \(canonical-package gzip\)\)/u);
  assert.equal((factory.match(/\(canonical-package tar\)/gu)||[]).length,1);
  assert.equal((factory.match(/\(canonical-package gzip\)/gu)||[]).length,1);
  assert.doesNotMatch(factory,/\(canonical-package (?:node|builder-guile|guile-3\.0\.11)/u);
  assert.ok(factory.indexOf('(when (%graft?)')<factory.indexOf('(canonical-package tar)'));
  assert.ok(factory.indexOf('(canonical-package gzip)')<factory.indexOf('(with-store store'));
  assert.ok(factory.indexOf('(list node tar gzip builder-guile)')<factory.indexOf('(package\n'));
  assert.equal((factory.match(/#\$\(file-append tar "\/bin\/tar"\)/gu)||[]).length,2);
  assert.equal((factory.match(/#\$\(file-append gzip "\/bin\/gzip"\)/gu)||[]).length,2);
});

test('canonical selection keeps exact already-realized-only refusal without an acquisition fallback',()=>{
  const source=readFileSync(new URL('../src/guix-deployment.scm',import.meta.url),'utf8');
  const factory=source.slice(source.indexOf('(define (dependency-toolchain)'),source.indexOf(';; Units and launchers'));
  assert.match(factory,/\(when \(%graft\?\)\s+\(error "dependency toolchain requires the reviewed ungrafted context"\)\)/u);
  assert.match(factory,/\(package-derivation store prerequisite #:graft\? #f\)/u);
  assert.match(factory,/\(unless \(valid-path\? store path\)\s+\(error "dependency toolchain prerequisite is not already realized"\s+\(package-name prerequisite\) path\)\)/u);
  assert.doesNotMatch(factory,/build-derivations|#:graft\? #t|\(getenv|\(system\*?|\(search-path|\(package-replacement|\(local-file|\(load\s/u);
});

test('the exact pinned self-build Guile is checked and passed to the trivial builder',()=>{
  const source=readFileSync(new URL('../src/guix-deployment.scm',import.meta.url),'utf8');
  const start=source.indexOf('(define (dependency-toolchain)');
  const factory=source.slice(start,source.indexOf(';; Units and launchers'));
  assert.match(source.slice(0,start),/#:use-module \(\(gnu packages guile\) #:select \(guile-3\.0\.11\)\)/u);
  assert.equal((factory.match(/\(builder-guile guile-3\.0\.11\)/gu)||[]).length,1);
  assert.ok(factory.indexOf('(when (%graft?)')<factory.indexOf('(builder-guile guile-3.0.11)'));
  assert.ok(factory.indexOf('(builder-guile guile-3.0.11)')<factory.indexOf('(with-store store'));
  assert.match(factory,/\(list node tar gzip builder-guile\)/u);
  assert.match(factory,/\(arguments\s+\(list\s+#:guile builder-guile\s+#:modules/u);
  assert.equal((factory.match(/#:guile /gu)||[]).length,1);
  assert.doesNotMatch(factory,/\(default-guile\)|\(current-executable\)|\/proc\/|guile-3\.0-latest/u);
  const origins=source.slice(source.indexOf('(define pnpm-tool-source'),start);
  assert.equal((origins.match(/\(method url-fetch\)/gu)||[]).length,2);
  assert.doesNotMatch(origins,/\(patches|\(snippet|\(patch-guile|url-fetch\//u);
});

test('the release plan handed to preparation is the exact closure materialization resolved, never the declaration',()=>{
  const scm=readFileSync(new URL('../scripts/github-machine-release.scm',import.meta.url),'utf8');
  assert.match(scm,/\(call-with-output-file prepared \(lambda \(port\) \(display closure-text port\)\)\)/u);
  assert.match(scm,/prepare-sources\.mjs"\) prepared \(string-append "--output=" workspace\)/u);
  assert.doesNotMatch(scm,/"declarationOnly"/u);
});
