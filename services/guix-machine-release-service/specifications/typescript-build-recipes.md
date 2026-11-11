# Bounded TypeScript build enrollment

Both ordinary change composition (`scripts/test-change.mjs`) and release
assembly (`scripts/assemble.mjs`) use `hasTypeScriptBuild` from
`scripts/typescript-build.mjs`. An admitted package is selected for the existing
TypeScript build step if either `scripts.build` or `scripts["build:node"]` is
exactly `tsc -p tsconfig.build.json`. The legacy `build` spelling remains valid,
including when another script is present or differs. If both match, the package
still builds once. All other script spellings and command values remain outside
this build enrollment; enrollment does not mean that such packages are refused
from the source graph.

The Node-only spelling admits the genuine `@lenticule-science/articulating`
0.2.0 package held at `services/articulation-services-section` in
`lenticule-science/semiotics-services-section` commit
`8215d225c9460f2e81622090bac769054d26f055` (manifest blob
`da9a332a0e5772148ecfcb2dda850c10376aa616`). Its broader checks and tests include
Forge. This enrollment builds only the declared TypeScript runtime outputs; it
does not run Forge or claim to qualify that package's EVM outputs.

Each existing caller retains dependency-first traversal, at-most-once builds,
its existing cycle behavior, its environment, and its interpreter
`process.execPath`. It directly invokes the compiler at
`WORKSPACE/node_modules/typescript/bin/tsc`, passing only `-p` and the package's
`tsconfig.build.json` path. Compiler failures still stop composition or assembly.
The exact workspace dependency lock and toolchain admission remain prerequisites.

No shell, package-manager script runner, pre/post-build lifecycle, check/test
script, command expansion, alternate compiler, dependency installation, source
selection or lock mutation is added. Extra whitespace, arguments, environment
prefixes, shell operators and alternate config paths do not match the recipe.

`test/typescript-build.test.mjs` covers the shared pure enrollment predicate and
executes both actual consumer paths using isolated committed-source/data
fixtures. Its inert compiler records interpreter, fixed argv and dependency
order, and supplies a deliberate failure control; it is not evidence that a
real TypeScript package compiled. Actual owner compilation, the complete frozen
source graph, exact Guix toolchain receiving and release/consumer receiving
remain separate required evidence before claiming a machine outcome.
