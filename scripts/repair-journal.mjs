#!/usr/bin/env node
// One-off maintenance for a repository whose journal was never snapshotted.
//
// Symptom: the Codeberg Contents API directory listing of the journal dir
// hangs and 504s (Gitea struggles with populated dirs), so every Strata
// `load()` dies and no snapshot is ever written — the journal keeps growing
// and the listing keeps getting worse.
//
// What this does:
//   1. loads the database (legacy database.json) and replays the journal ops
//   2. writes snapshot.json (CODEBERG_FILE)
//   3. deletes the journal entries up to the snapshot seq (compaction)
//
// After it runs, Strata's load() reads one snapshot file and finds an empty
// (or short) journal — fast and reliable again.
//
// Run it with a Codeberg token that has READ + WRITE scope:
//
//   CODEBERG_OWNER=livrasand CODEBERG_REPO=espresso-db \
//   CODEBERG_TOKEN=<write-token> node scripts/repair-journal.mjs
//
import { CodebergStorage } from "../src/storage/codeberg.js";

const env = process.env;

const storage = new CodebergStorage({
  apiUrl: env.CODEBERG_API,
  owner: env.CODEBERG_OWNER,
  repo: env.CODEBERG_REPO,
  branch: env.CODEBERG_BRANCH,
  file: env.CODEBERG_FILE,
  journalDir: env.CODEBERG_JOURNAL,
  token: env.CODEBERG_TOKEN,
  concurrency: env.CODEBERG_JOURNAL_CONCURRENCY,
  compactChunk: env.CODEBERG_COMPACT_CHUNK,
  // The listing can be slow on repos in this state; give it room.
  timeoutMs: env.CODEBERG_TIMEOUT_MS ?? "30000"
});

console.log("[repair] loading database + journal (this may take a while)…");
const { database, journalSeq, snapshotSha } = await storage.load();
const recordCount = Object.keys(database.records ?? {}).length;
console.log(`[repair] loaded ${recordCount} records, journal seq ${journalSeq}.`);

if (recordCount === 0 && journalSeq === 0) {
  console.log("[repair] nothing to do: empty database and journal.");
  process.exit(0);
}

console.log("[repair] writing snapshot…");
const existing = await storage.readSnapshot();
const saved = await storage.saveSnapshot(
  database,
  { journalSeq },
  existing?.sha ?? null
);
console.log(`[repair] snapshot written (sha ${saved.sha ?? "?"}).`);

console.log("[repair] compacting journal…");
const removed = await storage.compactJournal(journalSeq);
console.log(`[repair] removed ${removed} journal entries.`);

console.log("[repair] done. Deploy/restart Strata and verify /health.");
