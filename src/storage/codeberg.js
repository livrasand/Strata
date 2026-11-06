import { unzipSync } from "../zip.js";
import {
  applyJournalOperation,
  createEmptyDatabase,
  normalizeDatabase
} from "../database.js";
import {
  journalFileName,
  parseJournalFileName,
  validateJournalOp
} from "../journal.js";

const COMPACT_CHUNK = 100;

export class CodebergStorage {
  constructor({
    apiUrl = "https://codeberg.org/api/v1",
    owner,
    repo,
    branch = "main",
    file = "snapshot.json",
    journalDir,
    token,
    concurrency = 8
  }) {
    if (!owner || !repo || !token) {
      throw new Error("CODEBERG_OWNER, CODEBERG_REPO and CODEBERG_TOKEN are required.");
    }

    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.token = token;
    this.snapshotFile = file.replace(/^\/+/, "");
    this.journalDir = journalDir ?? defaultJournalDir(this.snapshotFile);
    this.snapshotUrl = this.contentsUrl(this.snapshotFile);
    this.changesUrl = this.apiUrl + "/repos/" + this.repoUrl() + "/contents";
    this.archiveUrl =
      this.apiUrl + "/repos/" + this.repoUrl() + "/archive/"
      + encodeURIComponent(this.branch) + ".zip";
    this.concurrency = Math.max(1, Number(concurrency) || 8);
  }

  repoUrl() {
    return `${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  contentsUrl(path) {
    return `${this.apiUrl}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${path
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/")}`;
  }

  async request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        Authorization: `token ${this.token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      }
    });

    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`Codeberg API returned ${response.status}: ${body}`);
      error.status = response.status;
      throw error;
    }

    return response.status === 204 ? null : response.json();
  }

  async requestRaw(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `token ${this.token}`,
        ...options.headers
      }
    });

    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`Codeberg API returned ${response.status}: ${body}`);
      error.status = response.status;
      throw error;
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async readSnapshot() {
    const url = new URL(this.snapshotUrl);
    url.searchParams.set("ref", this.branch);

    try {
      const file = await this.request(url);
      if (!file.content) {
        throw new Error("Codeberg returned an empty snapshot.");
      }

      const decoded = Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8");
      return { database: normalizeDatabase(JSON.parse(decoded)), sha: file.sha };
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async listJournalMeta() {
    const url = new URL(this.contentsUrl(this.journalDir));
    url.searchParams.set("ref", this.branch);

    try {
      const entries = await this.request(url);
      if (!Array.isArray(entries)) return [];

      return entries
        .map((entry) => ({ name: entry.name, sha: entry.sha }))
        .filter((entry) => parseJournalFileName(entry.name) !== null)
        .sort((a, b) => parseJournalFileName(a.name) - parseJournalFileName(b.name));
    } catch (error) {
      if (error.status === 404) return [];
      throw error;
    }
  }

  async listJournal() {
    return (await this.listJournalMeta()).map((entry) => entry.name);
  }

  async readJournalOp(name) {
    const url = new URL(this.contentsUrl(`${this.journalDir}/${name}`));
    url.searchParams.set("ref", this.branch);

    const file = await this.request(url);
    if (!file.content) {
      throw new Error(`Codeberg returned an empty journal entry: ${name}`);
    }

    const decoded = Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8");
    return JSON.parse(decoded);
  }

  async readJournalOpsIndividually(names) {
    const results = new Array(names.length);
    let cursor = 0;

    const workers = Array.from(
      { length: Math.min(this.concurrency, names.length) },
      async () => {
        while (cursor < names.length) {
          const index = cursor;
          cursor += 1;
          results[index] = await this.readJournalOp(names[index]);
        }
      }
    );

    await Promise.all(workers);
    return results.sort((a, b) => a.seq - b.seq);
  }

  async readJournalOps(names) {
    if (names.length === 0) return [];

    try {
      const archive = await this.requestRaw(this.archiveUrl);
      const entries = unzipSync(archive);
      const ops = [];

      for (const name of names) {
        const entry = findZipEntry(entries, `${this.journalDir}/${name}`);
        if (!entry) {
          throw new Error(`Archive does not contain journal entry: ${name}`);
        }
        ops.push(JSON.parse(entry.toString("utf8")));
      }

      return ops.sort((a, b) => a.seq - b.seq);
    } catch (error) {
      return this.readJournalOpsIndividually(names);
    }
  }

  async compactJournal(uptoSeq) {
    const doomed = (await this.listJournalMeta()).filter((entry) => {
      const seq = parseJournalFileName(entry.name);
      return seq !== null && seq <= uptoSeq;
    });

    if (doomed.length === 0) return 0;

    let removed = 0;

    for (let offset = 0; offset < doomed.length; offset += COMPACT_CHUNK) {
      const chunk = doomed.slice(offset, offset + COMPACT_CHUNK);
      const payload = {
        message: `journal: compact ${chunk.length} consolidated entries (up to seq ${uptoSeq})`,
        branch: this.branch,
        files: chunk.map((entry) => ({
          operation: "delete",
          path: `${this.journalDir}/${entry.name}`,
          sha: entry.sha
        }))
      };

      const result = await this.request(this.changesUrl, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      removed += chunk.length;
    }

    return removed;
  }

  async appendJournalOp(op, { strict = false } = {}) {
    validateJournalOp(op);

    const name = journalFileName(op.seq);
    const payload = {
      message: `journal: ${op.op} ${op.key} (seq ${op.seq})`,
      content: Buffer.from(`${JSON.stringify(op, null, 2)}\n`).toString("base64"),
      branch: this.branch
    };

    const url = this.contentsUrl(`${this.journalDir}/${name}`);

    try {
      await this.request(url, { method: "POST", body: JSON.stringify(payload) });
    } catch (error) {
      if (error.status !== 409 && error.status !== 422) {
        throw error;
      }

      if (strict) {
        if (await this.journalOpExists(name)) {
          const conflict = new Error(`Journal sequence ${op.seq} already exists: ${name}`);
          conflict.status = 409;
          conflict.conflict = true;
          throw conflict;
        }
      }

    }

    return { name };
  }

  async journalOpExists(name) {
    const url = new URL(this.contentsUrl(`${this.journalDir}/${name}`));
    url.searchParams.set("ref", this.branch);

    try {
      await this.request(url);
      return true;
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }

  async saveSnapshot(database, metadata = {}, previousSha = null) {
    const snapshot = normalizeDatabase({ ...database, ...metadata });
    let sha = previousSha;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const payload = {
        message: `Snapshot (${snapshot.updatedAt}, journal seq ${snapshot.journalSeq ?? 0})`,
        content: Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`).toString("base64"),
        branch: this.branch
      };

      if (sha) {
        payload.sha = sha;
      }

      try {
        const result = await this.request(this.snapshotUrl, {
          method: sha ? "PUT" : "POST",
          body: JSON.stringify(payload)
        });
        return { sha: result?.content?.sha ?? undefined };
      } catch (error) {
        if (error.status !== 409 && error.status !== 422) {
          throw error;
        }

        sha = (await this.readSnapshot())?.sha ?? null;
      }
    }

    const exhausted = new Error("Snapshot save exhausted conflict attempts.");
    exhausted.status = 409;
    throw exhausted;
  }

  async load() {
    let base = await this.readSnapshot();

    if (!base) {
      const url = new URL(this.contentsUrl("database.json"));
      url.searchParams.set("ref", this.branch);
      try {
        const legacyFile = await this.request(url);
        const decoded = Buffer.from(legacyFile.content.replace(/\s/g, ""), "base64").toString("utf8");
        base = { database: normalizeDatabase(JSON.parse(decoded)), sha: legacyFile.sha };
      } catch (error) {
        if (error.status !== 404) throw error;
        base = null;
      }
    }

    const database = base?.database ?? createEmptyDatabase();
    let journalSeq = database.journalSeq ?? 0;

    const pending = (await this.listJournalMeta())
      .map((entry) => ({ ...entry, seq: parseJournalFileName(entry.name) }))
      .filter((entry) => entry.seq > journalSeq);

    if (pending.length > 0) {
      for (const op of await this.readJournalOps(pending.map((entry) => entry.name))) {
        applyJournalOperation(database, op);
        if (op.seq > journalSeq) journalSeq = op.seq;
      }
    }

    database.journalSeq = journalSeq;
    return { database, journalSeq, snapshotSha: base?.sha ?? null };
  }
}

function findZipEntry(entries, path) {
  if (entries.has(path)) return entries.get(path);

  const suffix = `/${path}`;
  for (const [entryPath, content] of entries) {
    if (entryPath.endsWith(suffix)) return content;
  }

  return null;
}

function defaultJournalDir(snapshotFile) {
  const dir = snapshotFile.includes("/")
    ? snapshotFile.slice(0, snapshotFile.lastIndexOf("/"))
    : "";
  return dir ? `${dir}/journal` : "journal";
}
