import test from "node:test";
import assert from "node:assert/strict";
import { WriteQueue } from "../src/writeQueue.js";

async function waitUntil(condition, { timeout = 2000, step = 10 } = {}) {
  const started = Date.now();
  while (!condition() && Date.now() - started < timeout) {
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  if (!condition()) {
    throw new Error("waitUntil: condition not met before timeout.");
  }
}

const quietQueueOptions = { debounceMs: 5, intervalMs: 5 };

test("mutations that arrive together are coalesced into a single commit", async () => {
  const commits = [];
  const queue = new WriteQueue({
    commit: async () => commits.push(Date.now()),
    ...quietQueueOptions
  });

  queue.markDirty();
  queue.markDirty();
  queue.markDirty();

  assert.equal(commits.length, 0);

  await waitUntil(() => queue.snapshot().flushes === 1);
  await queue.settled();

  assert.equal(commits.length, 1);
  assert.equal(queue.snapshot().pending, false);
});

test("marks pending work without committing before the debounce", async () => {
  const commits = [];
  const queue = new WriteQueue({
    commit: async () => commits.push(Date.now()),
    debounceMs: 60,
    intervalMs: 60
  });

  queue.markDirty();

  assert.equal(queue.snapshot().pending, true);
  assert.equal(commits.length, 0);

  await queue.settled(1500);
  assert.equal(commits.length, 1);
});

test("flushNow publishes pending changes immediately", async () => {
  const commits = [];
  const queue = new WriteQueue({
    commit: async () => commits.push(Date.now()),
    debounceMs: 50_000,
    intervalMs: 50_000
  });

  queue.markDirty();
  await queue.flushNow();

  assert.equal(commits.length, 1);
  assert.equal(queue.snapshot().pending, false);
});

test("retries automatically after a 409 conflict", async () => {
  let calls = 0;
  const queue = new WriteQueue({
    commit: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("Codeberg API returned 409: conflict");
        error.status = 409;
        throw error;
      }
    },
    ...quietQueueOptions
  });

  queue.markDirty();

  await waitUntil(() => queue.snapshot().flushes === 1);
  await queue.settled();

  assert.equal(calls, 2, "the second attempt succeeds after the conflict");
  assert.equal(queue.snapshot().conflicts, 1);
  assert.equal(queue.snapshot().flushes, 1);
});

test("a persistent failure leaves changes pending and programs the retry", async () => {
  const queue = new WriteQueue({
    commit: async () => {
      const error = new Error("Codeberg API returned 503: unavailable");
      error.status = 503;
      throw error;
    },
    ...{ debounceMs: 5, intervalMs: 50_000 },
    log: { error: () => {} }
  });

  queue.markDirty();

  await waitUntil(() => queue.snapshot().errors === 1);

  assert.equal(queue.snapshot().pending, true, "the changes remain pending to be retried.");
  assert.equal(queue.snapshot().conflicts, 0);
  assert.match(queue.snapshot().lastError, /503/);
});

test("requires a commit function", () => {
  assert.throws(() => new WriteQueue({}), /commit/);
});
