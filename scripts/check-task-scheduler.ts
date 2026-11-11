import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshTaskScheduler, type TaskSchedulerState } from "../lib/task-scheduler";

test("a dev reload replaces a legacy interval and sends subsequent queued documents to the latest worker", async () => {
  const callbacks = new Map<ReturnType<typeof setInterval>, () => void>();
  const removed: ReturnType<typeof setInterval>[] = [];
  const handle = () => ({ unref() {} }) as ReturnType<typeof setInterval>;
  const legacy = handle();
  let oldChatTurns = 0, documentTurns = 0;
  callbacks.set(legacy, () => { oldChatTurns++; });
  const state: TaskSchedulerState = { scenarioforgeScheduler: legacy, scenarioforgeTick: true };
  const clock = {
    setInterval(callback: () => void) { const timer = handle(); callbacks.set(timer, callback); return timer; },
    clearInterval(timer: ReturnType<typeof setInterval> | undefined) { if (timer) { removed.push(timer); callbacks.delete(timer); } },
  } as { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
  const errors: unknown[] = [];
  refreshTaskScheduler(state, async () => { documentTurns++; }, error => errors.push(error), true, clock);
  assert.deepEqual(removed, [legacy]);
  assert.equal(state.scenarioforgeTick, true, "hot reload must not reset an active worker's exclusion guard");
  assert.equal(callbacks.size, 1);
  callbacks.get(state.scenarioforgeScheduler!)!();
  await Promise.resolve();
  assert.equal(documentTurns, 1);
  assert.equal(oldChatTurns, 0);

  const currentTimer = state.scenarioforgeScheduler;
  let newDocumentTurns = 0;
  refreshTaskScheduler(state, async () => { newDocumentTurns++; }, error => errors.push(error), true, clock);
  assert.equal(state.scenarioforgeScheduler, currentTimer, "later reloads update the target without duplicating timers");
  callbacks.get(currentTimer!)!();
  await Promise.resolve();
  assert.equal(documentTurns, 1);
  assert.equal(newDocumentTurns, 1);
  assert.equal(errors.length, 0);
  refreshTaskScheduler(state, async () => {}, error => errors.push(error), false, clock);
  assert.equal(callbacks.size, 0);
  assert.equal(state.scenarioforgeScheduler, undefined);
});

test("replacing the scheduling callback leaves an already running turn intact and reports errors from its successor", async () => {
  let scheduled: (() => void) | undefined;
  const timer = { unref() {} } as ReturnType<typeof setInterval>;
  const clock = { setInterval(callback: () => void) { scheduled = callback; return timer; }, clearInterval() {} } as unknown as { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
  const state: TaskSchedulerState = {};
  const errors: unknown[] = [];
  let finish!: () => void;
  let completed = false;
  refreshTaskScheduler(state, () => new Promise<void>(resolve => { finish = () => { completed = true; resolve(); }; }), error => errors.push(error), true, clock);
  scheduled!();
  const failure = new Error("successor failed");
  refreshTaskScheduler(state, async () => { throw failure; }, error => errors.push(error), true, clock);
  finish();
  await Promise.resolve();
  assert.equal(completed, true);
  scheduled!();
  await Promise.resolve();
  assert.deepEqual(errors, [failure]);
});
