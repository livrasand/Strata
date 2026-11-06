import { createHash, timingSafeEqual } from "node:crypto";
import { FileStorage } from "./storage/file.js";
import { CodebergStorage } from "./storage/codeberg.js";
import { WriteQueue } from "./writeQueue.js";
import { homepage } from "./homepage.js";
import {
  deleteRecord,
  getRecord,
  listKeys,
  setRecord
} from "./database.js";
import { validateJournalOp } from "./journal.js";

export const LONG_MODE = "long";
export const SERVERLESS_MODE = "serverless";

const MUTATION_CONFLICT_RETRIES = 5;

export { FileStorage, CodebergStorage };

export function createStorage(env = process.env) {
  if (env.STORAGE === "codeberg") {
    return new CodebergStorage({
      apiUrl: env.CODEBERG_API,
      owner: env.CODEBERG_OWNER,
      repo: env.CODEBERG_REPO,
      branch: env.CODEBERG_BRANCH,
      file: env.CODEBERG_FILE,
      journalDir: env.CODEBERG_JOURNAL,
      token: env.CODEBERG_TOKEN,
      concurrency: env.CODEBERG_JOURNAL_CONCURRENCY
    });
  }

  return new FileStorage(env.DATABASE_FILE ?? "./data/database.json");
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function createApp({ env = process.env, storage, mode = LONG_MODE, log = console } = {}) {
  if (storage === undefined) storage = createStorage(env);
  if (mode !== LONG_MODE && mode !== SERVERLESS_MODE) {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  const serverless = mode === SERVERLESS_MODE;
  const snapshotEvery = positiveNumber(env.JOURNAL_SNAPSHOT_EVERY ?? env.SNAPSHOT_OPS, 10);
  const compactJournalEnabled = env.JOURNAL_COMPACT !== "false";
  const cacheTtlMs = serverless ? positiveNumber(env.SERVERLESS_CACHE_MS, 0) : Number.POSITIVE_INFINITY;

  const sync = {
    database: null,
    journalSeq: 0,
    snapshotSha: null,
    snapshotBasis: 0,
    pendingOps: [],
    opsSinceSnapshot: 0,
    loadedAt: 0
  };

  async function commit() {
    if (!sync.database) return;

    while (sync.pendingOps.length > 0) {
      const op = sync.pendingOps[0];
      await storage.appendJournalOp(op);
      sync.pendingOps.shift();
      sync.opsSinceSnapshot += 1;
    }

    if (sync.opsSinceSnapshot > 0 && sync.opsSinceSnapshot >= snapshotEvery) {
      const snapshotSeq = sync.journalSeq;
      const metadata = snapshotSeq > 0 ? { journalSeq: snapshotSeq } : {};
      const saved = await storage.saveSnapshot(sync.database, metadata, sync.snapshotSha);
      if (saved.sha !== undefined) sync.snapshotSha = saved.sha;
      sync.opsSinceSnapshot = 0;

      if (compactJournalEnabled && snapshotSeq > 0 && typeof storage.compactJournal === "function") {
        try {
          const removed = await storage.compactJournal(snapshotSeq);
          if (removed > 0) {
            log.log(`[journal] compaction: ${removed} entries up to seq ${snapshotSeq} removed.`);
          }
        } catch (error) {
          log.error(`[journal] compaction deferred to the next snapshot: ${error.message}`);
        }
      }
    }
  }

  const queue = new WriteQueue({
    commit,
    debounceMs: positiveNumber(env.WRITE_QUEUE_DEBOUNCE_MS, 2000),
    intervalMs: positiveNumber(env.WRITE_QUEUE_INTERVAL_MS, 5000),
    log
  });

  async function ensureLoaded() {
    if (sync.database) return sync;

    const loaded = await storage.load();
    sync.database = loaded.database;
    sync.journalSeq = loaded.journalSeq;
    sync.snapshotSha = loaded.snapshotSha ?? null;

    return sync;
  }

  let lock = Promise.resolve();
  function withLock(task) {
    const run = lock.then(task, task);
    lock = run.catch(() => {});
    return run;
  }

  async function ensureFresh({ force = false } = {}) {
    if (!force && sync.database && Date.now() - sync.loadedAt < cacheTtlMs) return sync;

    const loaded = await storage.load();
    sync.database = loaded.database;
    sync.journalSeq = loaded.journalSeq;
    sync.snapshotSha = loaded.snapshotSha ?? null;
    if (sync.snapshotBasis === 0 || sync.database.journalSeq > sync.snapshotBasis) {
      sync.snapshotBasis = sync.database.journalSeq;
    }
    sync.pendingOps = [];
    sync.opsSinceSnapshot = 0;
    sync.loadedAt = Date.now();
    return sync;
  }

  async function denseSnapshot() {
    if (sync.journalSeq - sync.snapshotBasis < snapshotEvery) return;

    const snapshotSeq = sync.journalSeq;
    const metadata = snapshotSeq > 0 ? { journalSeq: snapshotSeq } : {};
    const saved = await storage.saveSnapshot(sync.database, metadata, sync.snapshotSha);
    if (saved.sha !== undefined) sync.snapshotSha = saved.sha;
    sync.snapshotBasis = snapshotSeq;

    if (compactJournalEnabled && snapshotSeq > 0 && typeof storage.compactJournal === "function") {
      try {
        const removed = await storage.compactJournal(snapshotSeq);
        if (removed > 0) {
          log.log(`[journal] compaction: ${removed} entries up to seq ${snapshotSeq} removed.`);
        }
      } catch (error) {
        log.error(`[journal] compaction deferred: ${error.message}`);
      }
    }
  }

  async function serverlessMutation(kind, key, body) {
    return withLock(async () => {
      for (let attempt = 1; attempt <= MUTATION_CONFLICT_RETRIES; attempt += 1) {
        await ensureFresh({ force: true });

        if (kind === "delete" && !Object.hasOwn(sync.database.records, key)) {
          return { ok: false, key };
        }

        const seq = sync.journalSeq + 1;
        const op = { seq, op: kind, key, timestamp: Math.floor(Date.now() / 1000) };

        if (kind === "set") {
          setRecord(sync.database, key, body.value, body.ttl);
          op.value = body.value;
          const record = sync.database.records[key];
          if (Number.isFinite(record.expiresAt)) {
            op.expiresAt = record.expiresAt;
          }
        } else {
          deleteRecord(sync.database, key);
        }

        validateJournalOp(op);

        try {
          await storage.appendJournalOp(op, { strict: true });
          sync.journalSeq = op.seq;
          sync.database.journalSeq = op.seq;
          sync.loadedAt = Date.now();
          await denseSnapshot();
          return { ok: true, seq };
        } catch (error) {
          if (error.conflict || error.status === 409 || error.status === 422) {
            continue;
          }

          throw error;
        }
      }

      const exhausted = new Error("Journal conflicts exhausted, try again.");
      exhausted.status = 409;
      throw exhausted;
    });
  }

  function corsHeaders() {
    return {
      "Access-Control-Allow-Origin": env.CORS_ORIGIN ?? "*",
      "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };
  }

  function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...corsHeaders()
      }
    });
  }

  function authorize(request) {
    const expected = env.API_TOKEN;
    if (!expected) return true;

    const header = request.headers.get("authorization");
    const supplied = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1] ?? "";
    const a = createHash("sha256").update(supplied).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
  }

  async function readBody(request) {
    const text = await request.text();

    if (text.length > 1024 * 1024) {
      const error = new Error("Request body exceeds 1 MB.");
      error.status = 413;
      throw error;
    }

    if (text.trim().length === 0) return {};

    try {
      return JSON.parse(text);
    } catch {
      const error = new Error("Invalid JSON body.");
      error.status = 400;
      throw error;
    }
  }

  function healthBody() {
    if (serverless) {
      return {
        ok: true,
        mode,
        storage: env.STORAGE ?? "file",
        journal: {
          seq: sync.journalSeq,
          pendingOps: 0,
          opsSinceSnapshot: Math.max(0, sync.journalSeq - sync.snapshotBasis),
          snapshotEvery
        },
        queue: {
          pending: false,
          enqueued: sync.journalSeq,
          flushes: sync.journalSeq,
          conflicts: 0,
          errors: 0,
          lastFlushAt: sync.loadedAt ? new Date(sync.loadedAt).toISOString() : null,
          lastError: null
        }
      };
    }

    return {
      ok: true,
      mode,
      storage: env.STORAGE ?? "file",
      journal: {
        seq: sync.journalSeq,
        pendingOps: sync.pendingOps.length,
        opsSinceSnapshot: sync.opsSinceSnapshot,
        snapshotEvery
      },
      queue: queue.snapshot()
    };
  }

  async function handle(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (url.pathname === "/health" && request.method === "GET") {
        if (serverless) await ensureFresh();
        else await ensureLoaded();
        return jsonResponse(200, healthBody());
      }

      if (url.pathname === "/" && request.method === "GET") {
        return new Response(await homepage(), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=300",
            ...corsHeaders()
          }
        });
      }

      if (!authorize(request)) {
        return jsonResponse(401, { error: "Unauthorized" });
      }

      if (url.pathname === "/keys" && request.method === "GET") {
        await (serverless ? ensureFresh({ force: true }) : ensureLoaded());
        return jsonResponse(200, { keys: listKeys(sync.database) });
      }

      if (parts[0] !== "kv" || parts.length !== 2) {
        return jsonResponse(404, { error: "Not found" });
      }

      const key = decodeURIComponent(parts[1]);

      if (request.method === "GET") {
        await (serverless ? ensureFresh({ force: true }) : ensureLoaded());
        const value = getRecord(sync.database, key);
        if (value === null) return jsonResponse(404, { error: "Key not found" });
        return jsonResponse(200, { key, value });
      }

      if (request.method === "PUT") {
        const body = await readBody(request);
        if (
          !body || typeof body !== "object" || Array.isArray(body) ||
          !Object.hasOwn(body, "value")
        ) {
          return jsonResponse(400, { error: "Body must contain a value property." });
        }

        if (serverless) {
          const result = await serverlessMutation("set", key, body);
          return jsonResponse(200, { ok: true, key, seq: result.seq, queued: false, persisted: true });
        }

        const state = await ensureLoaded();
        setRecord(state.database, key, body.value, body.ttl);
        const record = state.database.records[key];
        const op = {
          seq: state.journalSeq + 1,
          op: "set",
          key,
          timestamp: Math.floor(Date.now() / 1000)
        };
        op.value = record.value;
        if (Number.isFinite(record.expiresAt)) {
          op.expiresAt = record.expiresAt;
        }

        state.journalSeq = op.seq;
        state.database.journalSeq = op.seq;
        state.pendingOps.push(op);
        queue.markDirty();

        return jsonResponse(200, { ok: true, key, seq: op.seq, queued: true });
      }

      if (request.method === "DELETE") {
        if (serverless) {
          const result = await serverlessMutation("delete", key);
          if (!result.ok) {
            return jsonResponse(404, { ok: false, key, queued: false, persisted: false });
          }
          return jsonResponse(200, { ok: true, key, seq: result.seq, queued: false, persisted: true });
        }

        const state = await ensureLoaded();
        const deleted = deleteRecord(state.database, key);
        if (deleted) {
          const op = {
            seq: state.journalSeq + 1,
            op: "delete",
            key,
            timestamp: Math.floor(Date.now() / 1000)
          };
          state.journalSeq = op.seq;
          state.database.journalSeq = op.seq;
          state.pendingOps.push(op);
          queue.markDirty();
          return jsonResponse(200, { ok: true, key, seq: op.seq, queued: true });
        }
        return jsonResponse(404, { ok: false, key, queued: false });
      }

      return jsonResponse(405, { error: "Method not allowed" });
    } catch (error) {
      if (!error.status || error.status >= 500) {
        log.error?.(`[${mode}] ${request.method} ${url.pathname}: ${error.message}`);
      }

      const status =
        error.status === 400 ? 400 :
        error.status === 409 ? 409 :
        error.status === 413 ? 413 :
        500;
      return jsonResponse(status, { error: error.message });
    }
  }

  return {
    mode,
    storage,
    handle,
    sync,
    flushNow: () => queue.flushNow()
  };
}

export function createServerlessHandler(env = process.env) {
  const app = createApp({ env, mode: SERVERLESS_MODE });

  if (app.storage instanceof FileStorage) {
    throw new Error(
      "Serverless deployments cannot use a local file as the backing store. " +
      "Set STORAGE=codeberg with CODEBERG_OWNER, CODEBERG_REPO and CODEBERG_TOKEN."
    );
  }

  return function serverlessHandler(request) {
    return app.handle(request);
  };
}
