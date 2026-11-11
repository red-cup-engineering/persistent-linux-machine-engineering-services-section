import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,realpathSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {legacyFixture,stoppedReplacementFixture} from './user-unit-quarantine.test.mjs';
import {nativeQuarantinePort,releaseQuarantine} from '../src/user-unit-quarantine.mjs';

const artifact=process.env.WSL_TEST_NATIVE_ARTIFACT;
const liveProfile=process.env.WSL_TEST_NATIVE_PROFILE;
const guix=process.env.WSL_TEST_NATIVE_GUIX;
assert.ok(artifact && liveProfile && guix,'native receiving requires an existing qualified artifact/profile/Guix; no fabricated store or profile is built');
const sha=b=>createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(readFileSync(join(artifact,'node_modules/@red-cup-engineering/computer-deployment-engine/package.json')));
const selector=realpathSync(join(artifact,'node_modules/@red-cup-engineering/computer-deployment-engine/scripts/release-on-landing.mjs'));
const script=readFileSync(selector);
const selectorGitBlob=createHash('sha1').update('blob '+script.length+'\0').update(script).digest('hex');
const node=realpathSync(join(artifact,'bin/node'));

function receivedFixture(t) {
 const f=legacyFixture(t);delete f.parameters.linux.userUnitQuarantine;
 f.parameters.linux.quarantineReleaseSubject='legacy';
 const q=f.parameters.linux.legacyUserUnitQuarantine;
 const area=join(f.q.sectionRoot,'data/records/quarantine-receiving');
 mkdirSync(area,{recursive:true,mode:0o700});
 const profile=join(area,'profile');symlinkSync(realpathSync(liveProfile),profile);
 const record=readFileSync(liveProfile+'.lagoon-release.json');
 writeFileSync(profile+'.lagoon-release.json',record,{mode:0o600});
 const execStart=[node,join(artifact,'node_modules/@red-cup-engineering/computer-deployment-engine/scripts/release-on-landing.mjs')];
 const receiving={type:'WslQuarantineReplacementReceiving',version:1,receiver:'native-test-original-CDE-profile-reader',subject:'disposable test hold only',unknownEffectsReconciled:true,unresolvedEffects:[],id:q.id,unit:q.unit,markerSha256:q.markerSha256,oldInvocationId:f.expected.invocationId,profile,profileRecordSha256:sha(record),profileLink:realpathSync(liveProfile),artifactRoot:artifact,execStart};
 const path=join(area,'receiving.json'),bytes=JSON.stringify(receiving)+'\n';
 writeFileSync(path,bytes,{mode:0o600});
 q.replacementReceiving={path,sha256:sha(bytes)};
 q.replacement={profile,version:manifest.version,gitHead:manifest.gitHead,selectorGitBlob,guix,guixSha256:sha(readFileSync(guix))};
 f.u.ExecStart='{ path='+node+' ; argv[]='+execStart.join(' ')+' ; ignore_errors=no ; }';
 const native=nativeQuarantinePort({budgetMs:60000});
 f.native.profileArtifact=native.profileArtifact;
 return {...f,selected:q,receiving};
}
test('original legacy release receives the real shared-runtime native host through its original CDE codec',t=>{
 const f=receivedFixture(t),result=releaseQuarantine(f.parameters,f.native);
 assert.equal(result.status,'released');assert.equal(result.started,false);
 assert.equal(existsSync(f.marker),false);assert.equal(existsSync(f.q.marker),false);
 assert.equal(readFileSync(f.q.guard,'utf8'),f.guard);
 const outcome=JSON.parse(readFileSync(f.q.released));
 assert.equal(outcome.markerSha256,f.selected.markerSha256);
 assert.equal(outcome.receivingSha256,f.selected.replacementReceiving.sha256);
 assert.deepEqual(f.effects,[]);
});
test('the selected exact Guix and current native cohort remain mandatory for legacy release',t=>{
 for(const mutate of [
  f=>f.selected.replacement.guixSha256='0'.repeat(64),
  f=>f.native.profileArtifact=()=>'/gnu/store/00000000000000000000000000000000-foreign',
  f=>f.native.cohortTerminal=()=>false,
 ]) {
  const f=receivedFixture(t);mutate(f);
  assert.throws(()=>releaseQuarantine(f.parameters,f.native));
  assert.equal(readFileSync(f.marker,'utf8'),f.bytes);assert.equal(existsSync(f.q.released),false);
  assert.deepEqual(f.effects,[]);
 }
});
test('a profile record that changes during native receiving keeps the original legacy hold',t=>{
 const f=receivedFixture(t),observe=f.native.profileArtifact;
 f.native.profileArtifact=input=>{const result=observe(input);writeFileSync(f.receiving.profile+'.lagoon-release.json','changed\n',{mode:0o600});return result};
 assert.throws(()=>releaseQuarantine(f.parameters,f.native),/record before release/);
 assert.equal(readFileSync(f.marker,'utf8'),f.bytes);assert.equal(existsSync(f.q.released),false);
});


function receivedStoppedFixture(t) {
 const f=stoppedReplacementFixture(t), selected=f.parameters.linux.userUnitQuarantine;
 const area=join(f.q.sectionRoot,'data/records/quarantine-receiving');
 const profile=join(area,'stopped-profile');symlinkSync(realpathSync(liveProfile),profile);
 const record=readFileSync(liveProfile+'.lagoon-release.json');
 writeFileSync(profile+'.lagoon-release.json',record,{mode:0o600});
 const execStart=[node,join(artifact,'node_modules/@red-cup-engineering/computer-deployment-engine/scripts/release-on-landing.mjs')];
 Object.assign(f.receiving,{profile,profileRecordSha256:sha(record),profileLink:realpathSync(liveProfile),artifactRoot:artifact,execStart});
 selected.replacement={profile,version:manifest.version,gitHead:manifest.gitHead,selectorGitBlob,guix,guixSha256:sha(readFileSync(guix))};
 f.persist();
 f.u.ExecStart='{ path='+node+' ; argv[]='+execStart.join(' ')+' ; ignore_errors=no ; }';
 f.native.profileArtifact=nativeQuarantinePort({budgetMs:60000}).profileArtifact;
 return f;
}
test('stopped release retains original native product receiving and independently qualified effect dependency',t=>{
 const f=receivedStoppedFixture(t),result=releaseQuarantine(f.parameters,f.native);
 assert.equal(result.status,'released');assert.equal(result.started,false);
 assert.equal(existsSync(f.q.marker),false);assert.ok(existsSync(f.q.guard));
 const outcome=JSON.parse(readFileSync(f.q.released,'utf8'));
 assert.equal(outcome.marker.captureMode,'stopped-no-resident');
 assert.equal(outcome.marker.original.resident,null);
 assert.deepEqual(outcome.marker.effectDependencies,f.q.effectDependencies);
 assert.deepEqual(f.effects,['daemon-reload']);
});
test('dependency change during actual native profile receiving keeps original marker and partial release outcome',t=>{
 const f=receivedStoppedFixture(t),receive=f.native.profileArtifact;
 f.native.profileArtifact=input=>{const result=receive(input);writeFileSync(f.dependencyPath,'changed terminal evidence\n');return result;};
 assert.throws(()=>releaseQuarantine(f.parameters,f.native),/effect dependency receiving digest/);
 assert.ok(existsSync(f.q.marker));assert.ok(existsSync(f.q.guard));
 assert.ok(existsSync(f.q.released));
 assert.deepEqual(f.effects,['daemon-reload']);
});
