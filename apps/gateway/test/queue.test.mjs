import assert from 'node:assert/strict';
import test from 'node:test';
import { FairQueue } from '../dist/queue.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('The queue did not reach the expected state.');
}

test('queued generations rotate between workspaces', async () => {
  const queue = new FairQueue(1, 10, 5_000);
  const started = [];
  const gates = new Map();
  const start = (workspaceId, label) => {
    const gate = deferred();
    gates.set(label, gate);
    return queue.run(workspaceId, new AbortController().signal, async () => {
      started.push(label);
      await gate.promise;
    });
  };

  const tasks = [
    start('workspace-a', 'a1'),
    start('workspace-a', 'a2'),
    start('workspace-a', 'a3'),
    start('workspace-b', 'b1'),
    start('workspace-b', 'b2')
  ];
  await waitFor(() => started.length === 1 && queue.stats.waiting === 4);

  for (const expected of ['a1', 'a2', 'b1', 'a3', 'b2']) {
    await waitFor(() => started.at(-1) === expected);
    gates.get(expected).resolve();
    if (expected !== 'b2') await waitFor(() => started.at(-1) !== expected);
  }

  await Promise.all(tasks);
  assert.deepEqual(started, ['a1', 'a2', 'b1', 'a3', 'b2']);
  assert.deepEqual(queue.stats, { active: 0, waiting: 0 });
});

test('a cancelled queued request is removed without blocking later work', async () => {
  const queue = new FairQueue(1, 10, 5_000);
  const activeGate = deferred();
  const first = queue.run('workspace-a', new AbortController().signal, () => activeGate.promise);
  const controller = new AbortController();
  const cancelled = queue.run('workspace-b', controller.signal, async () => undefined);
  const laterStarted = deferred();
  const later = queue.run('workspace-c', new AbortController().signal, async () => laterStarted.resolve());
  await waitFor(() => queue.stats.waiting === 2);
  controller.abort();

  await assert.rejects(cancelled, /cancelled/i);
  activeGate.resolve();
  await first;
  await laterStarted.promise;
  await later;
  assert.deepEqual(queue.stats, { active: 0, waiting: 0 });
});
