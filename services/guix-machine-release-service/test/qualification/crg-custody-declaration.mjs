// The exact first-consumer declaration, not an alternate machine inventory.
import assert from 'node:assert/strict';import fs from 'node:fs';
const machine=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
assert.equal(machine.repository,'emsenn/cold-red-gate');
assert.deepEqual(machine.preActivation,[],'CRG must not mutate live state before writer quiescence');
assert.deepEqual(machine.custodyTransition.writerUnits,[machine.unit]);
assert.deepEqual(machine.custodyTransition.settlements,['journal','receiving','queue/handling']);
assert.ok(machine.custodyTransition.converter.endsWith('/file-journal-store-by-kind.mjs'));
assert.equal(machine.custodyTransition.receive.timeoutSeconds,300);
assert.equal(machine.custodyTransition.receive.memoryMax,'512M');
assert.equal(machine.custodyTransition.receive.expect,'native-activitypub-custody.v1');
assert.equal(machine.custodyTransition.receive.arguments[1],'{stateRoot}/activitypub-native');
console.log('Actual CRG declaration has no pre-quiescence state mutation; original receiver bounds retained');
