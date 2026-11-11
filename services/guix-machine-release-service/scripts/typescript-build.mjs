/** Admit only the already-supported direct TypeScript recipe. A package may
 * declare its Node-only build separately from checks for other runtimes. The
 * caller supplies the frozen workspace compiler and fixed argv; no script text
 * is executed, parsed, expanded or delegated to a package manager. */
export function hasTypeScriptBuild(manifest){
  return manifest.scripts?.build==='tsc -p tsconfig.build.json'
    ||manifest.scripts?.['build:node']==='tsc -p tsconfig.build.json';
}
