import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyJournalOperation,
  createEmptyDatabase,
  getRecord,
  listKeys
} from "../src/database.js";
import {
  journalFileName,
  parseJournalFileName
} from "../src/journal.js";
import { FileStorage } from "../src/storage/file.js";
import { createServer } from "../src/server.js";

async function waitUntil(condition, { timeout = 5000, step = 10 } = {}) {
  const started = Date.now();
  while (!condition() && Date.now() - started < timeout) {
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  if (!condition()) {
    throw new Error("waitUntil: condition not met before timeout.");
  }
}

test("applies journal operations in order rebuilding the state", () => {
  const database = createEmptyDatabase();

  applyJournalOperation(database, { op: "set", key: "name", value: "livrasand", seq: 1, timestamp: 1793900000 });
  applyJournalOperation(database, { op: "set", key: "theme", value: "dark", seq: 2, timestamp: 1793900100 });
  applyJournalOperation(database, { op: "delete", key: "theme", seq: 3, timestamp: 1793900200 });
  applyJournalOperation(database, { op: "set", key: "visits", value: 120, seq: 4, timestamp: 1793900300 });

  assert.equal(getRecord(database, "name"), "livrasand");
  assert.equal(getRecord(database, "theme"), null);
  assert.equal(getRecord(database, "visits"), 120);
  assert.deepEqual(listKeys(database).sort(), ["name", "visits"]);
});

test("replayed TTL entries honor expiration", () => {
  const database = createEmptyDatabase();

  applyJournalOperation(database, {
    op: "set",
    key: "session:123",
    value: { user: "livrasand" },
    expiresAt: Date.now() - 1000,
    seq: 1,
    timestamp: 1793900000
  });

  assert.equal(getRecord(database, "session:123"), null);
  assert.deepEqual(listKeys(database), []);
});

test("rejects malformed operations", () => {
  const database = createEmptyDatabase();

  assert.throws(() => applyJournalOperation(database, { op: "set" }), /key/);
  assert.throws(() => applyJournalOperation(database, { op: "set", key: "k" }), /value/);
  assert.throws(() => applyJournalOperation(database, { op: "incr", key: "visits" }), /Unknown/);
});

test("journal file names sort as expected", () => {
  assert.equal(journalFileName(1), "000001.json");
  assert.equal(journalFileName(42), "000042.json");
  assert.equal(parseJournalFileName("000007.json"), 7);
  assert.equal(parseJournalFileName("snapshot.json"), null);
  assert.equal(parseJournalFileName("notes.txt"), null);
});

test("file storage loads snapshot + replays journal, and skips already-consolidated ops", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kv-journal-"));
  try {
    const storage = new FileStorage(join(dir, "snapshot.json"));

    const first = await storage.load();
    assert.deepEqual(first.database.records, {});
    assert.equal(first.journalSeq, 0);

    await storage.appendJournalOp({ op: "set", key: "name", value: "livrasand", seq: 1, timestamp: 1793900000 });
    await storage.appendJournalOp({ op: "set", key: "visits", value: 120, seq: 2, timestamp: 1793900100 });
    await storage.appendJournalOp({ op: "delete", key: "visits", value: undefined, seq: 3, timestamp: 1793900300 });

    assert.ok(existsSync(join(dir, "journal", "000001.json")), "the journal directory is created automatically");

    const replayed = await storage.load();
    assert.equal(getRecord(replayed.database, "name"), "livrasand");
    assert.equal(getRecord(replayed.database, "visits"), null, "the delete is applied");
    assert.equal(replayed.journalSeq, 3);

    await storage.saveSnapshot(replayed.database, { journalSeq: replayed.journalSeq });
    const after = await storage.load();

    assert.equal(getRecord(after.database, "name"), "livrasand");
    assert.equal(getRecord(after.database, "visits"), null);
    assert.equal(after.database.journalSeq, 3, "the sequence persists in the snapshot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the server publishes the first operation with seq 1 (regression: post-increment started at 0)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kv-server-"));
  try {
    const storage = new FileStorage(join(dir, "snapshot.json"));
    const server = createServer({
      storage,
      env: { WRITE_QUEUE_DEBOUNCE_MS: "10", WRITE_QUEUE_INTERVAL_MS: "10" }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/kv/name`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "livrasand" })
      });
      const body = await response.json();

      assert.equal(body.ok, true);
      assert.equal(body.seq, 1, "the first operation must be sequence 1");

      await waitUntil(() => existsSync(join(dir, "journal", "000001.json")));

      const op = JSON.parse(readFileSync(join(dir, "journal", "000001.json"), "utf8"));
      assert.equal(op.seq, 1);
      assert.equal(op.op, "set");
      assert.equal(op.key, "name");
      assert.equal(op.value, "livrasand");
    } finally {
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file storage readJournalOps reads a batch of operations in seq order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kv-batch-"));
  try {
    const storage = new FileStorage(join(dir, "snapshot.json"));

    await storage.appendJournalOp({ op: "set", key: "name", value: "livrasand", seq: 1, timestamp: 1793900000 });
    await storage.appendJournalOp({ op: "set", key: "visits", value: 120, seq: 2, timestamp: 1793900100 });
    await storage.appendJournalOp({ op: "set", key: "theme", value: "dark", seq: 3, timestamp: 1793900200 });

    const ops = await storage.readJournalOps(["000003.json", "000001.json", "000002.json"]);
    assert.deepEqual(ops.map((op) => op.seq), [1, 2, 3]);
    assert.equal(ops[0].value, "livrasand");
    assert.equal(ops[2].value, "dark");
    assert.deepEqual(await storage.readJournalOps([]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compaction removes consolidated entries and load stays consistent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kv-compact-"));
  try {
    const storage = new FileStorage(join(dir, "snapshot.json"));

    for (let seq = 1; seq <= 3; seq += 1) {
      await storage.appendJournalOp({
        op: "set",
        key: `k${seq}`,
        value: seq,
        seq,
        timestamp: 1793900000 + seq
      });
    }

    const loaded = await storage.load();
    assert.equal(loaded.journalSeq, 3);
    await storage.saveSnapshot(loaded.database, { journalSeq: 3 });

    const removed = await storage.compactJournal(3);
    assert.equal(removed, 3);
    assert.deepEqual(await storage.listJournal(), []);

    const after = await storage.load();
    assert.equal(getRecord(after.database, "k1"), 1);
    assert.equal(getRecord(after.database, "k3"), 3);
    assert.equal(after.journalSeq, 3);

    await storage.appendJournalOp({ op: "set", key: "k4", value: 4, seq: 4, timestamp: 1793900400 });

    const replayed = await storage.load();
    assert.equal(getRecord(replayed.database, "k4"), 4);
    assert.equal(replayed.journalSeq, 4);

    assert.equal(await storage.compactJournal(3), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the server compacts the journal after each snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kv-server-compact-"));
  try {
    const storage = new FileStorage(join(dir, "snapshot.json"));
    const server = createServer({
      storage,
      env: {
        WRITE_QUEUE_DEBOUNCE_MS: "10",
        WRITE_QUEUE_INTERVAL_MS: "10",
        JOURNAL_SNAPSHOT_EVERY: "2"
      }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const journalDir = join(dir, "journal");
    const baseURL = `http://127.0.0.1:${port}`;

    try {
      for (const key of ["alpha", "beta"]) {
        const response = await fetch(`${baseURL}/kv/${key}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: `v-${key}` })
        });
        const body = await response.json();
        assert.equal(body.ok, true);
      }

      await waitUntil(
        () => existsSync(journalDir) && readdirSync(journalDir).length === 0,
        { timeout: 10_000 }
      );

      const snapshot = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8"));
      assert.equal(snapshot.journalSeq, 2);
      assert.ok(snapshot.records.alpha);
      assert.ok(snapshot.records.beta);

      const health = await (await fetch(`${baseURL}/health`)).json();
      assert.equal(health.journal.seq, 2);
      assert.equal(health.journal.opsSinceSnapshot, 0);

      const read = await (await fetch(`${baseURL}/kv/alpha`)).json();
      assert.equal(read.value, "v-alpha");
    } finally {
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
