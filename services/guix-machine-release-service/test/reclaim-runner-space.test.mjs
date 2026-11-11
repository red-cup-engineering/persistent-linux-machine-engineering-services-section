import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,utimesSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planReclaim,reclaim,DEFAULT_FLOOR,DEFAULT_BUILD_MINIMUM} from '../scripts/reclaim-runner-space.mjs';

const OLD=new Date(Date.now()-48*3600*1000);
const OLD_SHA='a'.repeat(40), NEW_SHA='b'.repeat(40);
function fixture(){
  const cache=mkdtempSync(join(tmpdir(),'reclaim-')),runs=join(cache,'github-cold-red-gate-runs'),boot=join(cache,'github-source-bootstrap');
  for(const d of ['100-1','101-1','102-1'])mkdirSync(join(runs,d),{recursive:true});
  const repository=join(boot,'emsenn','cold-red-gate');
  const old=join(repository,OLD_SHA), fresh=join(repository,NEW_SHA);
  mkdirSync(join(old,'controller'),{recursive:true});
  mkdirSync(join(fresh,'controller'),{recursive:true});
  writeFileSync(join(runs,'101-1','blob'),'x'.repeat(50));
  writeFileSync(join(runs,'lease.lock'),'owned coordination metadata');
  mkdirSync(join(runs,'human-notes'),{recursive:true});
  writeFileSync(join(old,'controller','file'),'old');
  writeFileSync(join(fresh,'controller','file'),'new');
  // A stale parent can contain a freshly used descendant; only an old revision is disposable.
  utimesSync(old,OLD,OLD);utimesSync(repository,OLD,OLD);
  return {cache,runs,boot,work:join(runs,'102-1'),old,fresh,repository};
}

test('plan removes only old SHA revisions and prior runs, not newer children of an old repository',()=>{
  const {runs,boot,work,old,fresh,repository}=fixture();
  const plan=planReclaim({work,bootstrapDir:boot,activeBootstrap:''});
  assert.deepEqual(plan.filter(p=>p.kind==='earlier-run').map(p=>p.path).sort(),[join(runs,'100-1'),join(runs,'101-1')]);
  assert.deepEqual(plan.filter(p=>p.kind==='old-bootstrap').map(p=>p.path),[old]);
  assert.equal(plan.some(p=>p.path===fresh || p.path===repository),false);
});

test('a currently executing bootstrap revision survives even past the age cutoff',()=>{
  const {boot,work,old,fresh}=fixture();
  const plan=planReclaim({work,bootstrapDir:boot,activeBootstrap:join(old,'controller')});
  assert.equal(plan.some(p=>p.path===old || p.path===fresh),false);
});

test('reclaim removes old run and revision, runs Guix GC only when needed, reports free space',()=>{
  const {cache,runs,work,old,fresh}=fixture();
  let calls=0;
  const report=reclaim({work,cache,activeBootstrap:'',floor:1,guix:'true',statfs:()=>({bfree:10,bavail:++calls>=3?10:0,bsize:1})});
  assert.equal(existsSync(join(runs,'101-1')),false);
  assert.equal(existsSync(join(runs,'lease.lock')),true);
  assert.equal(existsSync(join(runs,'human-notes')),true);
  assert.equal(existsSync(work),true);
  assert.equal(existsSync(old),false);
  assert.equal(existsSync(fresh),true);
  assert.equal(report.gc.ok,true);
  assert.equal(report.enough,true);
  assert.equal(report.removed.find(r=>r.path===join(runs,'101-1')).bytes,50);
});

test('sufficient space skips Guix GC; dry-run is inert; deficient space is reported',()=>{
  const initial=fixture();
  const adequate=reclaim({work:initial.work,cache:initial.cache,activeBootstrap:'',floor:1,guix:'false',statfs:()=>({bavail:10,bsize:1})});
  assert.equal(adequate.enough,true);
  assert.match(adequate.gc.skipped,/already satisfied/);
  const another=fixture();
  reclaim({work:another.work,cache:another.cache,activeBootstrap:'',dryRun:true,statfs:()=>({bavail:1,bsize:1})});
  assert.equal(existsSync(join(another.runs,'101-1')),true);
  const report=reclaim({work:another.work,cache:another.cache,activeBootstrap:'',floor:100,guix:'false',statfs:()=>({bfree:1,bavail:1,bsize:1})});
  assert.equal(report.gc.ok,false);
  assert.equal(report.enough,false);
});

test('an unsafe run root or invalid floor fails closed',()=>{
  assert.throws(()=>reclaim({work:'/tmp/elsewhere/1-1'}),/runs cache of the house cache/);
  assert.throws(()=>reclaim({work:'/tmp/github-cold-red-gate-runs/not-a-run'}),/RUN-ATTEMPT/);
  const {work,cache}=fixture();
  assert.throws(()=>reclaim({work,cache,floor:0}),/positive integer/);
});

test('a runs cache of any machine, directly in the house cache, is accepted',()=>{
  const cache=mkdtempSync(join(tmpdir(),'reclaim-')),work=join(cache,'github-bare-cedar-fog-runs','7-1');
  mkdirSync(work,{recursive:true});
  assert.doesNotThrow(()=>reclaim({work,cache,activeBootstrap:'',dryRun:true,statfs:()=>({bavail:1,bsize:1})}));
  assert.throws(()=>reclaim({work:join(cache,'nested','github-bare-cedar-fog-runs','7-1'),cache}),/runs cache of the house cache/);
});

test('runner collection uses service-usable capacity rather than root-reserved blocks',()=>{
  const {work,cache}=fixture(),collector=join(cache,'collector'),argumentsFile=join(cache,'collector-arguments');
  writeFileSync(collector,`#!/bin/sh\nprintf '%s\\n' "$@" > '${argumentsFile}'\n`,{mode:0o755});
  const report=reclaim({work,cache,activeBootstrap:'',floor:100,guix:collector,statfs:()=>({bfree:20,bavail:1,bsize:4096})});
  // This filesystem has 4096 usable bytes, so choose a floor above that value.
  assert.equal(report.enough,true);
  const pressure=reclaim({work,cache,activeBootstrap:'',floor:10000,guix:collector,statfs:()=>({bfree:20,bavail:1,bsize:4096})});
  assert.equal(readFileSync(argumentsFile,'utf8'),'gc\n--free-space=87824\n');
  assert.equal(pressure.gc.ok,true);
  assert.equal(pressure.enough,false,'successful GC is not a capacity receipt');
});

test('the Guix entrypoint never reclaims nested source-advance resolution scratch',()=>{
  const scm=readFileSync(new URL('../scripts/github-machine-release.scm',import.meta.url),'utf8');
  assert.ok(scm.includes("(member mode '(\"build\" \"deploy\"))"));
  assert.ok(!scm.includes("(member mode '(\"rollback\" \"test\"))"));
});

test('an unreachable 8 GiB cleanup target does not fail a build with a verified safe 6+ GiB reserve',()=>{
  const GiB=1024**3;
  assert.equal(DEFAULT_FLOOR,8*GiB);
  assert.equal(DEFAULT_BUILD_MINIMUM,6*GiB);
  const {work,cache}=fixture();
  let observations=0;
  const statfs=()=>({bfree:10*GiB/4096,bavail:(++observations>=4?27:20)*GiB/(4*4096),bsize:4096});
  const report=reclaim({work,cache,activeBootstrap:'',guix:'true',statfs});
  assert.equal(report.gc.ok,true,'run Guix GC toward the 8 GiB cleanup target');
  assert.equal(report.freeBefore,5*GiB);
  assert.equal(report.freeAfter,27*GiB/4,'Guix managed 6.75 GiB, limited by other rooted paths');
  assert.equal(report.minimum,6*GiB);
  assert.equal(report.targetMet,false,'do not falsely claim the target was reached');
  assert.equal(report.enough,true,'do not fail all releases at an unattainable aspirational target');
});

test('a genuine shortage below the minimum build reserve still fails closed',()=>{
  const GiB=1024**3,{work,cache}=fixture();
  const insufficient=reclaim({work,cache,activeBootstrap:'',guix:'true',
    statfs:()=>({bfree:10*GiB/4096,bavail:3*GiB/4096,bsize:4096})});
  assert.equal(insufficient.minimum,6*GiB);
  assert.equal(insufficient.enough,false);
  const underStricterPolicy=reclaim({work,cache,activeBootstrap:'',floor:8*GiB,minimum:7*GiB,guix:'true',
    statfs:()=>({bfree:10*GiB/4096,bavail:27*GiB/(4*4096),bsize:4096})});
  assert.equal(underStricterPolicy.enough,false);
  assert.equal(underStricterPolicy.targetMet,false);
  assert.throws(()=>reclaim({work,cache,minimum:0}),/build minimum/);
  assert.throws(()=>reclaim({work,cache,floor:6*GiB,minimum:7*GiB}),/build minimum/);
});
