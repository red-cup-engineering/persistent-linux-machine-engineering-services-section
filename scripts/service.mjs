import { executeJavascriptNodeCommand } from "@red-cup-engineering/execute-javascript-node-command-service";

/**
 * An in-process FIFO: `enqueue(task)` runs `task` only after every task
 * enqueued before it has settled (resolved or rejected), and returns
 * exactly `task`'s own outcome. A rejected task never wedges the queue —
 * the tasks enqueued after it still run once their turn comes.
 *
 * This serializes calls that share one queue instance inside one process;
 * it has no effect across two separate processes and makes no claim about
 * cross-process or cross-host coordination.
 */
export function createLinuxMachineCommandExecutionQueue() {
  let tail = Promise.resolve();
  return {
    enqueue(task) {
      const started = tail.then(() => task());
      tail = started.then(
        () => undefined,
        () => undefined,
      );
      return started;
    },
  };
}

/**
 * Runs one JavascriptNodeCommandExecutionRequest@1 through the house's typed
 * command-execution boundary (admission is composed inside
 * executeJavascriptNodeCommand itself), queued behind `queue` so it never
 * spawns concurrently with another call sharing that same queue. Resolves
 * to the immutable JavascriptNodeCommandExecutionReceipt@1 with one
 * additional `durationMs` this function measured around the call (not part
 * of the receipt's own typed contract).
 * @param {{enqueue: (task: () => unknown) => Promise<unknown>}} queue
 * @param {object} request An exact JavascriptNodeCommandExecutionRequest@1.
 */
export function serializeLinuxMachineCommandExecution(queue, request) {
  return queue.enqueue(() => {
    const startedAt = performance.now();
    const receipt = executeJavascriptNodeCommand(request);
    return { ...receipt, durationMs: Math.round(performance.now() - startedAt) };
  });
}
