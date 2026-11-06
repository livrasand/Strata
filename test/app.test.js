import test from "node:test";
import assert from "node:assert/strict";

import { createApp, createServerlessHandler, LONG_MODE, SERVERLESS_MODE } from "../src/app.js";

class MemoryStorage {
  constructor({ occupiedSeqs = [] } = {}) {
    this.ops = new Map();
    this.snapshot = null;
    this.snapshotSha = 0;
    for (const seq of occupiedSeqs) {
      this.ops.set(seq, { op: "set", key: `pre:${seq}`, value: seq, seq, timestamp: 1 });
    }
  }

  async load() {
    const database = {
      version: 1,
      updatedAt: new Date().toISOString(),
      records: {},
      journalSeq: 0
    };

    let journalSeq = 0;
    for (const op of [...this.ops.values()].sort((a, b) => a.seq - b.seq)) {
      if (op.op === "set") {
        database.records[op.key] = op.expiresAt
          ? { value: op.value, expiresAt: op.expiresAt }
          : { value: op.value };
      } else {
        delete database.records[op.key];
      }
      journalSeq = Math.max(journalSeq, op.seq);
    }

    database.journalSeq = journalSeq;
    if (this.snapshot?.journalSeq > journalSeq) {
      Object.assign(database.records, this.snapshot.records);
      journalSeq = this.snapshot.journalSeq;
      database.journalSeq = journalSeq;
    }

    this.loadedCount = (this.loadedCount ?? 0) + 1;
    return { database, journalSeq, snapshotSha: this.snapshot ? "sha" : null };
  }

  async appendJournalOp(op, { strict = false } = {}) {
    if (strict && this.ops.has(op.seq)) {
      const error = new Error(`Journal sequence ${op.seq} already exists.`);
      error.status = 409;
      error.conflict = true;
      throw error;
    }

    this.ops.set(op.seq, op);
    this.appendCount = (this.appendCount ?? 0) + 1;
    return { name: String(op.seq) };
  }

  async saveSnapshot(database, metadata) {
    this.snapshot = {
      version: 1,
      updatedAt: new Date().toISOString(),
      ...metadata,
      records: { ...database.records }
    };
    this.snapshotSha += 1;
    this.snapshotCount = (this.snapshotCount ?? 0) + 1;
    return { sha: `sha-${this.snapshotSha}` };
  }
}

function handler(app) {
  return (path, options) => app.handle(new Request(`https://example.test${path}`, options));
}

test("serverless mode commits the journal before answering and marks the write as persisted", async () => {
  const storage = new MemoryStorage();
  const app = createApp({ env: {}, storage, mode: SERVERLESS_MODE });
  const call = handler(app);

  const put = await call("/kv/name", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "livrasand" })
  });
  assert.equal(put.status, 200);
  const body = await put.json();
  assert.equal(body.ok, true);
  assert.equal(body.seq, 1);
  assert.equal(body.queued, false);
  assert.equal(body.persisted, true);

  assert.equal(storage.ops.get(1).key, "name");
  assert.equal(storage.ops.get(1).value, "livrasand");

  const get = await call("/kv/name");
  assert.equal((await get.json()).value, "livrasand");

  const coldStorage = storage;
  const coldApp = createApp({ env: {}, storage: coldStorage, mode: SERVERLESS_MODE });
  const cold = await handler(coldApp)("/kv/name");
  assert.equal((await cold.json()).value, "livrasand");

  const health = await call("/health");
  const healthBody = await health.json();
  assert.equal(healthBody.mode, "serverless");
  assert.equal(healthBody.journal.seq, 1);
});

test("serverless mode retries after a seq conflict and still persists with the next sequence", async () => {
  const storage = new MemoryStorage({ occupiedSeqs: [1] });
  const app = createApp({ env: {}, storage, mode: SERVERLESS_MODE });
  const call = handler(app);

  const put = await call("/kv/name", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "second" })
  });
  const body = await put.json();
  assert.equal(body.ok, true);
  assert.equal(body.seq, 2, "the conflicting seq is skipped after reloading");

  const get = await call("/kv/name");
  assert.equal((await get.json()).value, "second");

  const pre = storage.ops.get(1);
  assert.equal(pre.key, "pre:1", "the pre-existing op stays untouched");
});

test("serverless mode rejects file storage and deletes persist before answering", async () => {
  assert.throws(
    () => createServerlessHandler({ STORAGE: "file", DATABASE_FILE: "./data/x.json" }),
    /STORAGE=codeberg/
  );
  assert.throws(
    () => createServerlessHandler({}),
    /STORAGE=codeberg/
  );

  const storage = new MemoryStorage();
  const app = createApp({ env: {}, storage, mode: SERVERLESS_MODE });
  const call = handler(app);

  await call("/kv/name", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "x" })
  });

  const deleted = await call("/kv/name", { method: "DELETE" });
  const deletedBody = await deleted.json();
  assert.equal(deletedBody.ok, true);
  assert.equal(deletedBody.persisted, true);
  assert.equal(storage.ops.get(2).op, "delete");
  const gone = await call("/kv/name");
  assert.equal(gone.status, 404);

  const missing = await call("/kv/nope", { method: "DELETE" });
  assert.equal(missing.status, 404);
  const missingBody = await missing.json();
  assert.equal(missingBody.ok, false);
  assert.equal(missingBody.persisted, false);
  assert.equal(storage.ops.size, 2, "no journal entry is written for missing keys");
});

test("serverless mode keeps TTL metadata in the committed journal operation", async () => {
  const storage = new MemoryStorage();
  const app = createApp({ env: {}, storage, mode: SERVERLESS_MODE });
  const call = handler(app);

  await call("/kv/session", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: { user: "livrasand" }, ttl: 60 })
  });

  const op = storage.ops.get(1);
  assert.ok(Number.isFinite(op.expiresAt));
  assert.ok(op.expiresAt > Date.now(), "the TTL is embedded in the journal entry");

  const get = await call("/kv/session");
  assert.deepEqual((await get.json()).value, { user: "livrasand" });
});

test("API_TOKEN protects the API with a Bearer token and leaves /health open", async () => {
  const storage = new MemoryStorage();
  const app = createApp({ env: { API_TOKEN: "s3cr3t-token" }, storage });
  const call = handler(app);

  const putBody = {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "livrasand" })
  };

  const health = await call("/health");
  assert.equal(health.status, 200);
  const preflight = await call("/kv/name", { method: "OPTIONS" });
  assert.equal(preflight.status, 204);

  const missing = await call("/kv/name", putBody);
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { error: "Unauthorized" });

  const wrong = await call("/kv/name", {
    ...putBody,
    headers: { ...putBody.headers, Authorization: "Bearer nope" }
  });
  assert.equal(wrong.status, 401);

  const scheme = await call("/kv/name", {
    ...putBody,
    headers: { ...putBody.headers, Authorization: "s3cr3t-token" }
  });
  assert.equal(scheme.status, 401);

  const put = await call("/kv/name", {
    ...putBody,
    headers: { ...putBody.headers, Authorization: "Bearer s3cr3t-token" }
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).ok, true);

  const keys = await call("/keys");
  assert.equal(keys.status, 401);
  const keysOk = await call("/keys", {
    headers: { Authorization: "Bearer s3cr3t-token" }
  });
  assert.deepEqual((await keysOk.json()).keys, ["name"]);
});

test("no API_TOKEN means the API is open by default", async () => {
  const app = createApp({ env: {}, storage: new MemoryStorage() });
  const call = handler(app);

  const put = await call("/kv/name", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "x" })
  });
  assert.equal(put.status, 200);
});

test("the root path serves the landing page", async () => {
  const app = createApp({ env: {}, storage: new MemoryStorage() });
  const call = handler(app);

  const page = await call("/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const html = await page.text();
  assert.match(html, /<html/);
  assert.match(html, /Strata/);
});

test("long mode keeps the immediate-response queue semantics", async () => {
  const storage = new MemoryStorage();
  const app = createApp({ env: {}, storage, mode: LONG_MODE });
  const call = handler(app);

  const put = await call("/kv/name", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "livrasand" })
  });
  const body = await put.json();
  assert.equal(body.queued, true);
  assert.equal(body.seq, 1);
  assert.equal(storage.appendCount, undefined, "the journal is not touched during the request");
  assert.equal(app.sync.pendingOps.length, 1);

  const flushed = await app.flushNow();
  assert.equal(flushed.ok, true);
  assert.equal(storage.ops.get(1).value, "livrasand");

  const health = await call("/health");
  const healthBody = await health.json();
  assert.equal(healthBody.mode, "long");
  assert.equal(healthBody.journal.pendingOps, 0);
});
