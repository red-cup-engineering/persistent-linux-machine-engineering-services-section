import {isCliEntry} from './cli-entry.mjs';
import {readFileSync} from 'node:fs';
import {trustedSourceVerifierSource} from './verify-release-source.mjs';

const INDENT='          ';
const START='# Controller bootstrap (projected', END='# End controller bootstrap.';
const unprojected="printf '%s\\n' 'Unprojected controller bootstrap refused; use the owning projector.' >&2; exit 1";

/** One trusted implementation serves machine, ordinary controller and diagnostics.
 * The generated function is outside every selected/reused source checkout. */
export function releaseSourceVerifierShell(){return [
  'verify_release_source() {',
  '  [ "$#" -eq 8 ] || { echo "Invalid trusted source verification request." >&2; return 1; }',
  '  local verification_node verification_git',
  '  verification_node="$(command -v node)"; verification_git="$(command -v git)"',
  '  [[ "$verification_node" = /* && "$verification_git" = /* ]] && [ -x "$verification_node" ] && [ -x "$verification_git" ] || return 1',
  '  env -i SOURCE_DIRECTORY="$1" SOURCE_REPOSITORY="$2" SOURCE_COMMIT="$3" SOURCE_TREE="$4" SOURCE_DEFINITION="$5" SOURCE_KIND="$6" SOURCE_POLICY="$7" SOURCE_CHANNELS="$8" RECEIVING_GIT="$verification_git" PATH="$(dirname "$verification_node"):/usr/bin:/bin" NODE_DISABLE_COMPILE_CACHE=1 "$verification_node" --no-addons --no-global-search-paths --input-type=module - <<\'CONTROLLER_SOURCE_VERIFICATION\'',
  trustedSourceVerifierSource(),
  'const env=process.env;',
  'if(!["machine","controller"].includes(env.SOURCE_KIND))throw new Error("Invalid trusted source kind");',
  'const controller=env.SOURCE_KIND==="controller";',
  'const identity={repository:env.SOURCE_REPOSITORY,commit:env.SOURCE_COMMIT,tree:env.SOURCE_TREE,...(controller?{}:{definition:env.SOURCE_DEFINITION})};',
  'await verifyTrustedSource(env.SOURCE_DIRECTORY,identity,{gitExecutable:env.RECEIVING_GIT,channelsBlob:env.SOURCE_CHANNELS,controller,sourcePolicy:env.SOURCE_POLICY});',
  'CONTROLLER_SOURCE_VERIFICATION',
  '}',
].join('\n');}

/** Explicit existing reader credentials; ambient Git configuration is excluded. */
export function releaseSourceReaderShell(){return [
  'source_git=(env -i HOME="$HOME" PATH="$PATH" GH_CONFIG_DIR="${GH_CONFIG_DIR:-$HOME/.config/gh}" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1)',
  'for key in GH_TOKEN GITHUB_TOKEN; do [[ ! -v $key ]] || source_git+=("$key=${!key}"); done',
  'source_git+=("$git_reader" -c core.hooksPath=/dev/null -c credential.helper= -c \'credential.helper=!gh auth git-credential\')',
].join('\n');}

/** Generate the current complete bootstrap. Deferred invocation lets the full
 * caller reuse this trusted verifier before lease and before source acquisition. */
export function controllerBootstrap(bootstrap=readFileSync(new URL('./controller-bootstrap.sh',import.meta.url),'utf8'),options={}) {
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['defer','controller'].includes(key))
    ||options.defer!==undefined&&typeof options.defer!=='boolean')throw new Error('unknown controller bootstrap generation option');
  const fixed=options.controller;
  if(fixed!==undefined&&(!fixed||typeof fixed!=='object'||Array.isArray(fixed)||Object.keys(fixed).sort().join(',')!=='commit,repository,tree'
    ||fixed.repository!=='red-cup-engineering/guix-machine-release-service'
    ||[fixed.commit,fixed.tree].some(value=>typeof value!=='string'||!/^[a-f0-9]{40}$/.test(value)||/^0+$/.test(value))))
    throw new Error('standalone native caller needs the exact reviewed controller identity');
  const lines=bootstrap.trimEnd().split('\n');
  if(!lines[0].startsWith(START)||lines.at(-1)!==END||lines.filter(line=>line===unprojected).length!==1)
    throw new Error('expected the current unprojected bootstrap template');
  let body=lines.slice(1,-1).filter(line=>line!==unprojected).join('\n').replace('echo "RELEASE_CONTROLLER=$service" >> "$GITHUB_ENV"',
    'echo "RELEASE_CONTROLLER=$service" >> "$GITHUB_ENV"; RELEASE_CONTROLLER="$service"');
  if(fixed){
    const start=body.indexOf('controller_top='),end=body.indexOf('controller_path=.');
    if(start<0||end<start)throw new Error('controller discovery template is unread');
    body=body.slice(0,start)+`# Standalone target: the committed caller binds its reviewed controller, not a source inventory.\ncontroller_commit=${fixed.commit}\ncontroller_expected_tree=${fixed.tree}\n`+body.slice(end);
    body=body.replace('verify_release_source "$controller_root"',
      '[ "$controller_tree" = "$controller_expected_tree" ] || { echo "release controller tree differs from its reviewed identity" >&2; return 1; }\nverify_release_source "$controller_root"');
  }
  return [lines[0],`# Invocation: ${options.defer?'deferred':'immediate'}`,releaseSourceVerifierShell(),
    'configure_release_source_reader() {',releaseSourceReaderShell(),'}',
    'resolve_release_controller() {',body,'}',...(options.defer?[]:['resolve_release_controller']),END].join('\n');
}

/** Replace exactly one current bootstrap. Preserve its explicit invocation
 * contract; old owner-map/Python fragments are not executable authority. */
export function projectControllerBootstrap(workflow,bootstrap) {
  const start=workflow.indexOf(INDENT+START),end=workflow.indexOf(INDENT+END);
  if(start<0||end<start||workflow.indexOf(INDENT+START,start+1)>=0||workflow.indexOf(INDENT+END,end+1)>=0
    ||workflow.slice(start,end).includes('\n      - '))throw new Error('expected exactly one current controller bootstrap');
  const previous=workflow.slice(start,end),modes=[...previous.matchAll(/^          # Invocation: (.+)$/gm)].map(match=>match[1]);
  if(previous.includes('# Standalone target:'))throw new Error('native caller requires the complete committed consumer projection');
  if(modes.length>1||modes.some(mode=>!['immediate','deferred'].includes(mode)))throw new Error('unknown controller bootstrap invocation contract');
  const block=controllerBootstrap(bootstrap,{defer:modes[0]==='deferred'}).split('\n').map(line=>line?INDENT+line:'').join('\n');
  return workflow.slice(0,start)+block+workflow.slice(end+INDENT.length+END.length);
}

if(isCliEntry(import.meta.url)){
  if(process.argv.length!==3)throw new Error('usage: project-controller-bootstrap.mjs <existing-release.yml>');
  process.stdout.write(projectControllerBootstrap(readFileSync(process.argv[2],'utf8')));
}
