import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {project,withSessionStart} from '../scripts/project-session-bootstrap.mjs';

const script=resolve('scripts/project-session-bootstrap.mjs');
const repository=t=>{const root=mkdtempSync(join(tmpdir(),'session-bootstrap-'));t.after(()=>rmSync(root,{recursive:true,force:true}));spawnSync('git',['init','-q'],{cwd:root});return root;};

test('a repository gains the hook, the shim and the skill, keeping its own settings', t=>{
  const root=repository(t);
  mkdirSync(join(root,'.claude'));writeFileSync(join(root,'.claude/settings.json'),JSON.stringify({permissions:{allow:['Bash(ls)']}}));
  assert.deepEqual(project(root),['.claude/settings.json','.claude/hooks/session-start.sh','.claude/skills/receive-change/SKILL.md']);
  const settings=JSON.parse(readFileSync(join(root,'.claude/settings.json'),'utf8'));
  assert.deepEqual(settings.permissions,{allow:['Bash(ls)']});
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command,'$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh');
  assert.equal(statSync(join(root,'.claude/hooks/session-start.sh')).mode&0o777,0o755);
  assert.equal(readFileSync(join(root,'.claude/skills/receive-change/SKILL.md'),'utf8'),readFileSync('session/receive-change/SKILL.md','utf8'));
  assert.deepEqual(project(root,{check:true}),[]);
});

test('check reports a drifted copy without writing it', t=>{
  const root=repository(t);project(root);
  writeFileSync(join(root,'.claude/hooks/session-start.sh'),'#!/bin/sh\n');
  const r=spawnSync(process.execPath,[script,root,'--check'],{encoding:'utf8'});
  assert.equal(r.status,1);assert.deepEqual(JSON.parse(r.stdout).stale,['.claude/hooks/session-start.sh']);
  assert.equal(readFileSync(join(root,'.claude/hooks/session-start.sh'),'utf8'),'#!/bin/sh\n');
});

test('a repository that ignores .claude is refused and pointed at the user-level install', t=>{
  const root=repository(t);writeFileSync(join(root,'.gitignore'),'.claude/\n');
  assert.throws(()=>project(root),/ignores \.claude.*--install-user/);
});

test('the hook is added once, beside existing hooks', ()=>{
  const existing={hooks:{SessionStart:[{hooks:[{type:'command',command:'other'}]}]}};
  const once=withSessionStart(existing,'bash shim');
  assert.equal(once.hooks.SessionStart.length,2);
  assert.deepEqual(withSessionStart(once,'bash shim'),once);
  assert.equal(existing.hooks.SessionStart.length,1);
});

test('user-level install writes the hook into the given settings file', t=>{
  const root=repository(t),settings=join(root,'home/.claude/settings.json');
  for(let i=0;i<2;i++)assert.equal(spawnSync(process.execPath,[script,'--user',settings,'bash /x/shim.sh']).status,0);
  assert.deepEqual(JSON.parse(readFileSync(settings,'utf8')),{hooks:{SessionStart:[{hooks:[{type:'command',command:'bash /x/shim.sh'}]}]}});
});

test('the session start is silent outside cloud sessions', ()=>{
  const r=spawnSync('bash',['scripts/session-start.sh'],{encoding:'utf8',env:{...process.env,CLAUDE_CODE_REMOTE:''}});
  assert.equal(r.status,0);assert.equal(r.stdout,'');
});

test('the hook names the machine repository the session tests against, and only a repository name', t=>{
  const root=repository(t);
  project(root,{machine:'o/machine'});
  assert.equal(JSON.parse(readFileSync(join(root,'.claude/settings.json'),'utf8')).hooks.SessionStart[0].hooks[0].command,'$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh o/machine');
  assert.deepEqual(project(root,{check:true,machine:'o/machine'}),[]);
  assert.throws(()=>project(root,{machine:'o/machine; rm -rf /'}),/OWNER\/REPO/);
  const r=spawnSync(process.execPath,[script,root,'--machine','o/other','--check'],{encoding:'utf8'});
  assert.equal(r.status,1);assert.deepEqual(JSON.parse(r.stdout).stale,['.claude/settings.json']);
});

test('the session start names no machine of its own', ()=>{
  const text=readFileSync('scripts/session-start.sh','utf8');
  assert.doesNotMatch(text,/cold-red-gate|Cold Red Gate/u);
  assert.match(text,/machine_repository="\$\{1:-\$machine_repository\}"/u);
});
