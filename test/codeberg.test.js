import test from "node:test";
import assert from "node:assert/strict";
import { CodebergStorage } from "../src/storage/codeberg.js";
import { buildStoredZip } from "./zipFixture.js";

const OPTIONS = {
  apiUrl: "https://codeberg.example/api/v1",
  owner: "livr-strata",
  repo: "db",
  branch: "main",
  file: "data/snapshot.json",
  journalDir: "data/journal",
  token: "test-token"
};

const CHANGES_URL = `${OPTIONS.apiUrl}/repos/${OPTIONS.owner}/${OPTIONS.repo}/contents`;
const JOURNAL_URL = `${OPTIONS.apiUrl}/repos/${OPTIONS.owner}/${OPTIONS.repo}/contents/${OPTIONS.journalDir}?ref=main`;
const ARCHIVE_URL = `${OPTIONS.apiUrl}/repos/${OPTIONS.owner}/${OPTIONS.repo}/archive/main.zip`;

// Mirrors the threshold in codeberg.js: batches below it skip the archive.
const ARCHIVE_MIN_OPS = 16;

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

function rawResponse(buffer) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buffer,
    text: async () => ""
  };
}

function stubFetch(route) {
  const calls = [];

  const handler = (url, options = {}) => {
    const call = {
      href: String(url),
      method: options.method ?? "GET",
      body: typeof options.body === "string" ? JSON.parse(options.body) : null
    };
    calls.push(call);
    return route(call);
  };

  return { calls, handler };
}

function op(seq) {
  return { seq, op: "set", key: `k${seq}`, value: seq, timestamp: 1793900000 + seq };
}

test("readJournalOps downloads the pending journal in a single archive request (batch)", async () => {
  const names = Array.from({ length: ARCHIVE_MIN_OPS }, (_, i) =>
    `${String(i + 1).padStart(6, "0")}.json`);
  const zip = buildStoredZip(new Map([
    ["db-main/data/snapshot.json", Buffer.from('{"journalSeq":0}\n', "utf8")],
    ...names.map((name, i) => [
      `db-main/data/journal/${name}`,
      Buffer.from(`${JSON.stringify(op(i + 1))}\n`, "utf8")
    ]),
    ["db-main/data/journal/notes.txt", Buffer.from("not a journal entry\n", "utf8")]
  ]));

  const { calls, handler } = stubFetch(() => rawResponse(zip));

  const original = globalThis.fetch;
  try {
    globalThis.fetch = handler;

    const storage = new CodebergStorage(OPTIONS);
    const reversed = names.slice().reverse();
    const loaded = await storage.readJournalOps(reversed);

    assert.deepEqual(
      loaded.map((entry) => entry.seq),
      names.map((_, i) => i + 1),
      "operations come back sorted by seq regardless of request order"
    );
    assert.equal(loaded[1].value, 2);

    assert.equal(calls.length, 1, "a single HTTP request for the whole batch");
    assert.equal(calls[0].href, ARCHIVE_URL);
    assert.equal(calls[0].method, "GET");
  } finally {
    globalThis.fetch = original;
  }
});

test("readJournalOps falls back to individual requests when the archive is unavailable", async () => {
  const names = Array.from({ length: ARCHIVE_MIN_OPS }, (_, i) =>
    `${String(i + 1).padStart(6, "0")}.json`);
  const fileResponse = (seq) =>
    jsonResponse(200, {
      name: `${String(seq).padStart(6, "0")}.json`,
      sha: `sha${seq}`,
      content: Buffer.from(`${JSON.stringify(op(seq))}\n`).toString("base64")
    });

  const { calls, handler } = stubFetch((call) => {
    if (call.href === ARCHIVE_URL) {
      return jsonResponse(404, { message: "archive not available" });
    }
    const match = /\/journal\/(\d{6})\.json/.exec(call.href);
    if (match) return fileResponse(Number(match[1]));
    return jsonResponse(404, { message: "not found" });
  });

  const original = globalThis.fetch;
  try {
    globalThis.fetch = handler;

    const storage = new CodebergStorage(OPTIONS);
    const loaded = await storage.readJournalOps(names.slice().reverse());

    assert.deepEqual(loaded.map((entry) => entry.seq), names.map((_, i) => i + 1));

    const individual = calls.filter((call) => /\/journal\/\d{6}\.json/.test(call.href));
    assert.equal(individual.length, names.length, "one per-file request per entry after the archive failed");
    assert.ok(calls.some((call) => call.href === ARCHIVE_URL));
  } finally {
    globalThis.fetch = original;
  }
});

test("readJournalOps reads small batches file-by-file without touching the archive", async () => {
  const fileResponse = (seq) =>
    jsonResponse(200, {
      name: `${String(seq).padStart(6, "0")}.json`,
      sha: `sha${seq}`,
      content: Buffer.from(`${JSON.stringify(op(seq))}\n`).toString("base64")
    });

  const { calls, handler } = stubFetch((call) => {
    const match = /\/journal\/(\d{6})\.json/.exec(call.href);
    if (match) return fileResponse(Number(match[1]));
    return jsonResponse(404, { message: "not found" });
  });

  const original = globalThis.fetch;
  try {
    globalThis.fetch = handler;

    const storage = new CodebergStorage(OPTIONS);
    const loaded = await storage.readJournalOps(["000002.json", "000001.json"]);

    assert.deepEqual(loaded.map((entry) => entry.seq), [1, 2]);
    assert.ok(!calls.some((call) => call.href === ARCHIVE_URL), "the archive endpoint is not requested for small batches");
  } finally {
    globalThis.fetch = original;
  }
});

test("listJournalMeta falls back to the git trees API when the contents listing fails", async () => {
  const rootTree = jsonResponse(200, {
    tree: [
      { type: "blob", path: "snapshot.json", sha: "snapsha" },
      { type: "tree", path: "data", sha: "datasha" }
    ]
  });
  const dataTree = jsonResponse(200, {
    tree: [{ type: "tree", path: "journal", sha: "journalsha" }]
  });
  const journalTree = jsonResponse(200, {
    tree: [
      { type: "blob", path: "000001.json", sha: "sha1" },
      { type: "blob", path: "000002.json", sha: "sha2" },
      { type: "blob", path: "notes.txt", sha: "notesha" },
      { type: "tree", path: "sub", sha: "subsha" }
    ]
  });

  const { calls, handler } = stubFetch((call) => {
    if (/\/contents\/data\/journal\?ref=main$/.test(call.href)) {
      // Simulate the Gitea contents-listing hang: gateway timeout.
      return jsonResponse(504, { message: "gateway timeout" });
    }
    if (/\/git\/trees\/main$/.test(call.href)) return rootTree;
    if (/\/git\/trees\/datasha$/.test(call.href)) return dataTree;
    if (/\/git\/trees\/journalsha$/.test(call.href)) return journalTree;
    return jsonResponse(404, { message: "not found" });
  });

  const original = globalThis.fetch;
  try {
    globalThis.fetch = handler;

    const storage = new CodebergStorage(OPTIONS);
    const meta = await storage.listJournalMeta();

    assert.deepEqual(
      meta.map((entry) => entry.name),
      ["000001.json", "000002.json"],
      "journal entries listed via git trees, sorted by seq"
    );
    assert.deepEqual(
      meta.map((entry) => entry.sha),
      ["sha1", "sha2"],
      "blob shas are preserved so compactJournal can delete them"
    );
    assert.ok(calls.some((call) => /\/git\/trees\/main$/.test(call.href)));
    assert.ok(calls.some((call) => /\/git\/trees\/journalsha$/.test(call.href)));
  } finally {
    globalThis.fetch = original;
  }
});

test("listJournalMeta returns [] when the journal directory does not exist", async () => {
  const { calls, handler } = stubFetch((call) => {
    if (/\/contents\/data\/journal\?ref=main$/.test(call.href)) {
      return jsonResponse(404, { message: "directory not found" });
    }
    return jsonResponse(404, { message: "not found" });
  });

  const original = globalThis.fetch;
  try {
    globalThis.fetch = handler;

    const storage = new CodebergStorage(OPTIONS);
    const meta = await storage.listJournalMeta();
    assert.deepEqual(meta, [], "a missing journal dir means no pending ops");
    assert.ok(!calls.some((call) => /\/git\/trees\//.test(call.href)), "404 short-circuits without the trees fallback");
  } finally {
    globalThis.fetch = original;
  }
});

test("compactJournal deletes consolidated entries in a single multi-delete commit", async () => {
  const listing = jsonResponse(200, [
    { name: "000001.json", sha: "sha1" },
    { name: "000002.json", sha: "sha2" },
    { name: "000003.json", sha: "sha3" },
    { name: "notes.txt", sha: "notesha" }
  ]);

  const { calls, handler } = stubFetch((call) => {
    if (call.method === "POST" && call.href === CHANGES_URL) {
      return jsonResponse(201, { files: [] });
    }
    if (call.href === JOURNAL_URL) return listing;
    return jsonResponse(404, { message: "unexpected request" });
  });

  const original = globalThis.fetch;
  try {
    globalThis.fetch = handler;

    const storage = new CodebergStorage(OPTIONS);
    const removed = await storage.compactJournal(3);

    assert.equal(removed, 3);

    assert.ok(calls.some((call) => call.href === JOURNAL_URL), "the journal directory is listed first");

    const postings = calls.filter((call) => call.method === "POST" && call.href === CHANGES_URL);
    assert.equal(postings.length, 1, "one multi-delete commit, not one per file");

    const payload = postings[0].body;
    assert.equal(payload.branch, "main");
    assert.match(payload.message, /compact/);
    assert.deepEqual(
      payload.files.map((entry) => ({ operation: entry.operation, path: entry.path, sha: entry.sha })),
      [
        { operation: "delete", path: "data/journal/000001.json", sha: "sha1" },
        { operation: "delete", path: "data/journal/000002.json", sha: "sha2" },
        { operation: "delete", path: "data/journal/000003.json", sha: "sha3" }
      ]
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("compactJournal chunks large deletions (100 files per commit)", async () => {
  const total = 102;
  const listing = jsonResponse(
    200,
    Array.from({ length: total }, (_, index) => ({
      name: `${String(index + 1).padStart(6, "0")}.json`,
      sha: `sha-${index + 1}`
    }))
  );

  const { calls, handler } = stubFetch((call) => {
    if (call.method === "POST" && call.href === CHANGES_URL) return jsonResponse(201, {});
    if (call.href === JOURNAL_URL) return listing;
    return jsonResponse(404, { message: "unexpected request" });
  });

  const original = globalThis.fetch;
  try {
    globalThis.fetch = handler;

    const storage = new CodebergStorage(OPTIONS);
    const removed = await storage.compactJournal(total);

    assert.equal(removed, total);

    const postings = calls.filter((call) => call.method === "POST" && call.href === CHANGES_URL);
    assert.equal(postings.length, 2, "ceil(102 / 100) commits");
    assert.equal(postings[0].body.files.length, 100);
    assert.equal(postings[1].body.files.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});
