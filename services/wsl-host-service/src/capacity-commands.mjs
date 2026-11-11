// Command-level refusal of guest bytes as physical WSL backing capacity.
// Actual allocation remains the original backing-capacity observer's responsibility.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && !/[\0\r\n]/.test(value);
const call = (program, args) => execFileSync(program, args, {encoding:'utf8', cwd:'/', env:{...process.env,LC_ALL:'C'}, stdio:['ignore','pipe','pipe']}).trim();

export function capacityCommandDeclaration(parameters) {
  const d = parameters.linux?.capacityCommands;
  if (d === undefined) return null;
  assert.equal(d.mode, 'refuse-guest-capacity');
  assert.ok(absolute(d.shell) && /\/bash$/.test(d.shell) && absolute(d.dpkgDivert) && absolute(d.dpkgQuery));
  assert.ok(Array.isArray(d.capacityCommand) && d.capacityCommand.length > 0 && d.capacityCommand.every(x=>typeof x==='string' && !/[\0\r\n]/.test(x)));
  assert.ok(absolute(d.capacityCommand[0]));
  assert.ok(typeof d.basis === 'string' && d.basis.length > 0);
  assert.ok(Array.isArray(d.commands) && d.commands.length === 2);
  assert.deepEqual(d.commands.map(x=>x.kind).sort(), ['df','stat']);
  const paths = new Set();
  for (const c of d.commands) {
    assert.ok(absolute(c.path) && absolute(c.guestPath) && c.path !== c.guestPath);
    assert.equal(path.basename(c.path), c.kind);
    assert.ok(typeof c.package === 'string' && /^[a-z0-9][a-z0-9+.-]*$/.test(c.package));
    assert.match(c.originalSha256, /^[a-f0-9]{64}$/);
    for (const p of [c.path,c.guestPath]) { assert.ok(!paths.has(p)); paths.add(p); }
  }
  return d;
}

export function renderCapacityGuard(d, command) {
  const message = `Guest filesystem free blocks are not Windows-backed allocatable capacity. This command refuses to report them as disk availability. Use the native physical-capacity command: ${d.capacityCommand.map(x=>JSON.stringify(x)).join(' ')}. Explicit guest-only diagnostic (never physical admission): ${command.guestPath}`;
  const quoted = text => "'"+text.replaceAll("'", "'\\''")+"'";
  const refuse = `printf '%s\\n' ${quoted(message)} >&2\nexit 78`;
  if (command.kind==='df') return `#!${d.shell}\n# WSL host physical-capacity boundary; no synthetic guest numbers.\nif [ "$#" -eq 1 ]; then\n  case "$1" in --help|--version) exec -a ${quoted(command.kind)} ${quoted(command.guestPath)} "$@";; esac\nfi\n${refuse}\n`;
  return `#!${d.shell}\n# Ordinary file stat is unchanged; filesystem space is explicitly refused.\nconsume=no\nfor argument do\n  if [ "$consume" = yes ]; then consume=no; continue; fi\n  case "$argument" in\n    --) break;;\n    --f|--fi|--fil|--file|--file-|--file-s|--file-sy|--file-sys|--file-syst|--file-syste|--file-system)\n      ${refuse};;\n    --fo|--for|--form|--forma|--format|--p|--pr|--pri|--prin|--print|--printf|--c|--ca|--cac|--cach|--cache|--cached) consume=yes;;\n    --*) ;;\n    -*)\n      remaining=\${argument#-}\n      while [ -n "$remaining" ]; do\n        first=\${remaining%"\${remaining#?}"}\n        remaining=\${remaining#?}\n        case "$first" in\n          f) ${refuse};;\n          c) if [ -z "$remaining" ]; then consume=yes; fi; break;;\n        esac\n      done;;\n  esac\ndone\nexec -a ${quoted(command.kind)} ${quoted(command.guestPath)} "$@"\n`;
}

/** Whether file is a guard this service rendered, for any declaration: its interpreter line and boundary comment. */
function isCapacityGuard(d, file) {
  const head=fs.readFileSync(file,'utf8').slice(0,200);
  return [`#!${d.shell}
# WSL host physical-capacity boundary;`,`#!${d.shell}
# Ordinary file stat is unchanged;`].some(prefix=>head.startsWith(prefix));
}

function realParents(file, allowMissing = false) {
  let parent = path.dirname(file);
  for (;;) {
    try {
      const s=fs.lstatSync(parent);
      assert.ok(s.isDirectory() && !s.isSymbolicLink() && s.uid===0 && (s.mode&0o022)===0, `unsafe capacity command parent: ${parent}`);
    } catch (error) { if (!(allowMissing && error.code==='ENOENT')) throw error; }
    if (parent === '/') break;
    parent = path.dirname(parent);
  }
}
function image(file) {
  try {
    const s=fs.lstatSync(file);
    assert.ok(s.isFile() && !s.isSymbolicLink() && s.uid===0 && (s.mode&0o7777)===0o755, `unsafe capacity command image: ${file}`);
    return {device:s.dev,inode:s.ino,sha256:digest(fs.readFileSync(file))};
  } catch (error) { if(error.code==='ENOENT') return null; throw error; }
}

export function planCapacityCommands(parameters, ports={}) {
  const d=capacityCommandDeclaration(parameters);
  if (!d) return {component:'capacity-commands',declared:false,current:true,commands:[]};
  const run=ports.run??call;
  image(fs.realpathSync(d.shell)); // package-managed system interpreter, no incidental Guix root
  const commands=d.commands.map(c=>{
    realParents(c.path); realParents(c.guestPath,true);
    const owner=run(d.dpkgDivert,['--listpackage',c.path]);
    const target=run(d.dpkgDivert,['--truename',c.path]);
    const ownership=run(d.dpkgQuery,['-S',c.path]).split('\n');
    assert.deepEqual(ownership,owner==='LOCAL' ? [`local diversion from: ${c.path}`,`local diversion to: ${c.guestPath}`,`${c.package}: ${c.path}`] : [`${c.package}: ${c.path}`], 'package ownership changed');
    const installed=image(c.path), guest=image(c.guestPath);
    assert.ok(installed,'original command missing');
    assert.ok(!owner || (owner==='LOCAL' && target===c.guestPath),'competing package diversion');
    const guardSha256=digest(renderCapacityGuard(d,c));
    const diverted=owner==='LOCAL' && target===c.guestPath && guest?.sha256===c.originalSha256;
    const current=diverted && installed.sha256===guardSha256;
    // A guard rendered from an earlier declaration (its parameters path moved) is this service's own image over the kept original.
    const staleGuard=diverted && !current && isCapacityGuard(d,c.path);
    if (!current && !staleGuard) {
      assert.equal(installed.sha256,c.originalSha256,'unreceived command replacement');
      assert.ok(!guest || (guest.sha256===c.originalSha256 && guest.device===installed.device && guest.inode===installed.inode),'unreceived guest diagnostic');
    }
    return {...c,current,staleGuard,installed,guest,diversionOwner:owner,guardSha256};
  });
  return {component:'capacity-commands',declared:true,current:commands.every(c=>c.current),commands};
}

export function applyCapacityCommands(parameters, ports={}) {
  assert.equal(process.getuid(),0,'capacity command installation requires native system ownership');
  const d=capacityCommandDeclaration(parameters);
  assert.ok(d,'capacity commands must be declared');
  const before=planCapacityCommands(parameters,ports), run=ports.run??call, changed=[];
  for (const c of before.commands.filter(c=>!c.current)) {
    fs.mkdirSync(path.dirname(c.guestPath),{recursive:true,mode:0o755});
    realParents(c.guestPath);
    const temporary=path.join(path.dirname(c.path),`.${path.basename(c.path)}.wsl-host-${randomBytes(12).toString('hex')}`);
    let ownedTemporary=false;
    try {
      const fd=fs.openSync(temporary,'wx',0o755); ownedTemporary=true;
      try {fs.writeFileSync(fd,renderCapacityGuard(d,c));fs.fchmodSync(fd,0o755);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      const now=image(c.path);
      assert.deepEqual(now,c.installed,'original command changed before custody');
      if (!c.staleGuard) { // a stale guard already sits over the diverted original; only the guard is re-rendered
        if (!c.guest) fs.linkSync(c.path,c.guestPath); // same data, no binary copy
        assert.deepEqual(image(c.guestPath),c.installed,'original diagnostic custody changed');
        if (!c.diversionOwner) run(d.dpkgDivert,['--local','--no-rename','--add','--divert',c.guestPath,c.path]);
      }
      assert.equal(run(d.dpkgDivert,['--listpackage',c.path]),'LOCAL');
      assert.equal(run(d.dpkgDivert,['--truename',c.path]),c.guestPath);
      assert.deepEqual(image(c.path),c.installed,'original command changed before selection');
      fs.renameSync(temporary,c.path); ownedTemporary=false;
      for (const parent of new Set([path.dirname(c.path),path.dirname(c.guestPath)])) {
        const fd=fs.openSync(parent,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      }
      changed.push(c.path);
    } finally {
      if (ownedTemporary) {
        const remaining=image(temporary);
        if (remaining?.sha256===c.guardSha256) fs.unlinkSync(temporary);
      }
    }
  }
  const after=planCapacityCommands(parameters,ports);
  return {...after,changed,converged:after.current};
}

// Deliberate owner rollback, never an omission-triggered apply action.
export function restoreCapacityCommands(parameters, ports={}) {
  assert.equal(process.getuid(),0,'capacity command restoration requires native system ownership');
  const d=capacityCommandDeclaration(parameters), before=planCapacityCommands(parameters,ports), run=ports.run??call;
  assert.ok(before.declared,'rollback requires the original declared command tuples');
  const restored=[];
  for (const c of before.commands) {
    assert.deepEqual(image(c.path),c.installed,'guard changed before restoration');
    if (!c.current && !c.guest && !c.diversionOwner) continue; // exact already restored tuple
    assert.ok(c.guest,'original diagnostic missing before restoration');
    assert.deepEqual(image(c.guestPath),c.guest,'original image changed before restoration');
    if (c.current) {
      const temporary=path.join(path.dirname(c.path),`.${path.basename(c.path)}.wsl-restore-${randomBytes(12).toString('hex')}`);
      fs.linkSync(c.guestPath,temporary);
      try { fs.renameSync(temporary,c.path); }
      finally { const left=image(temporary);if(left && left.device===c.guest.device && left.inode===c.guest.inode)fs.unlinkSync(temporary); }
      const fd=fs.openSync(path.dirname(c.path),'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    }
    if(c.diversionOwner) run(d.dpkgDivert,['--local','--no-rename','--remove','--divert',c.guestPath,c.path]);
    assert.equal(run(d.dpkgDivert,['--listpackage',c.path]),'');
    assert.deepEqual(image(c.path),c.guest);
    assert.deepEqual(image(c.guestPath),c.guest);
    fs.unlinkSync(c.guestPath); // exact extra link, same original bytes remain at command path
    for(const parent of new Set([path.dirname(c.path),path.dirname(c.guestPath)])) {
      const fd=fs.openSync(parent,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    }
    restored.push(c.path);
  }
  return {component:'capacity-commands',restored,physicalRecoveryClaim:false};
}
