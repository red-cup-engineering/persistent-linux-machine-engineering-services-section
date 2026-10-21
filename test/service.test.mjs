import assert from "node:assert/strict";
import test from "node:test";

import { createLinuxMachineCommandExecutionQueue, serializeLinuxMachineCommandExecution } from "../scripts/service.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("serializes two concurrent tasks in enqueue order, even when the later one would finish first if run concurrently", async () => {
  const queue = createLinuxMachineCommandExecutionQueue();
  const order = [];

  // `first` is enqueued first but sleeps; `second` is enqueued immediately
  // after with no delay. If the queue merely let both run concurrently,
  // `second` would append before `first` (it has nothing to wait on). A
  // real FIFO queue forces `second`'s body to not even start until `first`
  // has fully settled, so `second` is provably queued, not just called
  // later by coincidence of Promise microtask ordering.
  const first = queue.enqueue(async () => {
    await sleep(30);
    order.push("first");
    return "first";
  });
  const second = queue.enqueue(() => {
    order.push("second");
    return "second";
  });

  const results = await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"], "second must not run until first has settled");
  assert.deepEqual(results, ["first", "second"]);
});

test("three enqueued tasks run strictly one at a time, in order", async () => {
  const queue = createLinuxMachineCommandExecutionQueue();
  let active = 0;
  let maxActive = 0;
  const order = [];

  async function task(id, delayMs) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(delayMs);
    order.push(id);
    active -= 1;
    return id;
  }

  const results = await Promise.all([
    queue.enqueue(() => task(1, 20)),
    queue.enqueue(() => task(2, 1)),
    queue.enqueue(() => task(3, 10)),
  ]);

  assert.equal(maxActive, 1, "no two tasks are ever concurrently active");
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(results, [1, 2, 3]);
});

test("a rejected task does not wedge the queue for tasks enqueued after it", async () => {
  const queue = createLinuxMachineCommandExecutionQueue();
  const order = [];

  const failing = queue.enqueue(() => {
    order.push("failing");
    throw new Error("boom");
  });
  const after = queue.enqueue(() => {
    order.push("after");
    return "after";
  });

  await assert.rejects(failing, /boom/);
  assert.equal(await after, "after");
  assert.deepEqual(order, ["failing", "after"]);
});

test("returns each task's own resolved value, not the queue's internal bookkeeping", async () => {
  const queue = createLinuxMachineCommandExecutionQueue();
  assert.equal(await queue.enqueue(() => 1), 1);
  assert.equal(await queue.enqueue(() => 2), 2);
});

test("serializeLinuxMachineCommandExecution runs a real command through the typed boundary and adds durationMs", async () => {
  const queue = createLinuxMachineCommandExecutionQueue();
  const receipt = await serializeLinuxMachineCommandExecution(queue, {
    type: "JavascriptNodeCommandExecutionRequest",
    version: 1,
    command: process.execPath,
    arguments: ["-e", "process.stdout.write('ok')"],
    directory: process.cwd(),
    environment: null,
    input: null,
  });
  assert.equal(receipt.result.status, 0);
  assert.equal(receipt.result.stdout, "ok");
  assert.equal(typeof receipt.durationMs, "number");
});

test("two serialized command executions never run concurrently", async () => {
  const queue = createLinuxMachineCommandExecutionQueue();
  const startedAt = performance.now();
  const results = await Promise.all([
    serializeLinuxMachineCommandExecution(queue, {
      type: "JavascriptNodeCommandExecutionRequest",
      version: 1,
      command: process.execPath,
      arguments: ["-e", "setTimeout(() => process.stdout.write('a'), 40)"],
      directory: process.cwd(),
      environment: null,
      input: null,
    }),
    serializeLinuxMachineCommandExecution(queue, {
      type: "JavascriptNodeCommandExecutionRequest",
      version: 1,
      command: process.execPath,
      arguments: ["-e", "process.stdout.write('b')"],
      directory: process.cwd(),
      environment: null,
      input: null,
    }),
  ]);
  // If these ran concurrently, the second (no delay) would finish well
  // before the first (40ms delay) had even started, and total elapsed
  // time would be close to 40ms rather than roughly double it.
  assert.ok(performance.now() - startedAt >= 40, "second command must wait for the first to finish, not run in parallel");
  assert.equal(results[0].result.stdout, "a");
  assert.equal(results[1].result.stdout, "b");
});
