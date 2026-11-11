#!/usr/bin/env node
// Project the house session start into a repository agents work in: .claude/settings.json gains the
// SessionStart hook (other settings are kept), .claude/hooks/session-start.sh is the shim that fetches this
// controller and runs scripts/session-start.sh, and .claude/skills/receive-change is the receiving skill.
// The controller owns all three; repositories carry projected copies that --check keeps current.
//
//   project-session-bootstrap.mjs REPOSITORY [--machine OWNER/REPO] [--check]
//                                                       project into a checkout (refuses one that ignores .claude);
//                                                       the hook names the machine repository the session tests against
//   project-session-bootstrap.mjs --user SETTINGS COMMAND add COMMAND as a user-level SessionStart hook
import {spawnSync} from 'node:child_process';
import {chmodSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isCliEntry} from './cli-entry.mjs';

const controller=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const HOOK='$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh';

/** Settings with COMMAND as a SessionStart hook, everything else as it was. */
export function withSessionStart(settings,command){
  const next=structuredClone(settings??{});
  next.hooks??={};next.hooks.SessionStart??=[];
  if(!next.hooks.SessionStart.some(group=>(group.hooks??[]).some(hook=>hook.type==='command'&&hook.command===command)))
    next.hooks.SessionStart.push({hooks:[{type:'command',command}]});
  return next;
}

const read=path=>existsSync(path)?readFileSync(path,'utf8'):null;
const json=value=>JSON.stringify(value,null,2)+'\n';

/** The files a repository should carry, as {path: [content, mode]}. */
export function projection(repository,machine){
  const settings=read(join(repository,'.claude/settings.json'));
  return {
    '.claude/settings.json':[json(withSessionStart(settings?JSON.parse(settings):{},machine?`${HOOK} ${machine}`:HOOK)),0o644],
    '.claude/hooks/session-start.sh':[readFileSync(join(controller,'session/session-start-shim.sh'),'utf8'),0o755],
    '.claude/skills/receive-change/SKILL.md':[readFileSync(join(controller,'session/receive-change/SKILL.md'),'utf8'),0o644],
  };
}

export function project(repository,{check=false,machine}={}){
  if(machine!==undefined&&!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(machine))throw new Error('the machine repository must be OWNER/REPO');
  const ignored=spawnSync('git',['check-ignore','-q','.claude/settings.json'],{cwd:repository});
  if(ignored.status===0)throw new Error(`${repository} ignores .claude; start its sessions from the environment setup script instead: bash ~/.cache/561-group/controller/scripts/session-start.sh --install-user OWNER/REPO`);
  const stale=[];
  for(const [path,[content,mode]] of Object.entries(projection(repository,machine))){
    const target=join(repository,path);
    if(read(target)===content)continue;
    stale.push(path);
    if(check)continue;
    mkdirSync(dirname(target),{recursive:true});writeFileSync(target,content);chmodSync(target,mode);
  }
  return stale;
}

if(isCliEntry(import.meta.url)){
  const args=process.argv.slice(2);
  try{
    if(args[0]==='--user'){
      const [,settings,command]=args;
      if(!settings||!command)throw new Error('usage: project-session-bootstrap.mjs --user SETTINGS COMMAND');
      mkdirSync(dirname(settings),{recursive:true});
      writeFileSync(settings,json(withSessionStart(read(settings)?JSON.parse(read(settings)):{},command)));
    }else{
      const at=args.indexOf('--machine'),machine=at>=0?args[at+1]:undefined;
      const repository=args.find((a,i)=>!a.startsWith('--')&&(at<0||i!==at+1)),check=args.includes('--check');
      if(!repository||(at>=0&&!machine))throw new Error('usage: project-session-bootstrap.mjs REPOSITORY [--machine OWNER/REPO] [--check]');
      const stale=project(resolve(repository),{check,machine});
      process.stdout.write(JSON.stringify({repository:resolve(repository),[check?'stale':'written']:stale})+'\n');
      if(check&&stale.length)process.exitCode=1;
    }
  }catch(error){process.stderr.write(`project-session-bootstrap: ${error.message}\n`);process.exitCode=1;}
}
