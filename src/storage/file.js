import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

export class FileStorage {
  constructor(snapshotFile = "./data/snapshot.json", { journalDir } = {}) {
    this.snapshotFile = resolve(snapshotFile);
    this.journalDir = resolve(journalDir ?? join(dirname(this.snapshotFile), "journal"));
  }

  async readSnapshot() {
    try {
      const content = await readFile(this.snapshotFile, "utf8");
      return { database: normalizeDatabase(JSON.parse(content)) };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async listJournal() {
    try {
      const names = await readdir(this.journalDir);
      return names
        .filter((name) => parseJournalFileName(name) !== null)
        .sort((a, b) => parseJournalFileName(a) - parseJournalFileName(b));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async readJournalOp(name) {
    return JSON.parse(await readFile(join(this.journalDir, name), "utf8"));
  }

  async readJournalOps(names) {
    const ops = await Promise.all(names.map((name) => this.readJournalOp(name)));
    return ops.sort((a, b) => a.seq - b.seq);
  }

  async compactJournal(uptoSeq) {
    const doomed = (await this.listJournal())
      .map((name) => ({ name, seq: parseJournalFileName(name) }))
      .filter((entry) => entry.seq !== null && entry.seq <= uptoSeq);

    await Promise.all(
      doomed.map((entry) =>
        unlink(join(this.journalDir, entry.name)).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        })
      )
    );

    return doomed.length;
  }

  async appendJournalOp(op, { strict = false } = {}) {
    validateJournalOp(op);
    const name = journalFileName(op.seq);
    const target = join(this.journalDir, name);

    if (strict) {
      try {
        await readFile(target, "utf8");
        const conflict = new Error(`Journal sequence ${op.seq} already exists: ${name}`);
        conflict.status = 409;
        conflict.conflict = true;
        throw conflict;
      } catch (error) {
        if (error.conflict) throw error;
        if (error.code !== "ENOENT") throw error;
      }
    }

    await mkdir(this.journalDir, { recursive: true });
    await writeFile(target, `${JSON.stringify(op, null, 2)}\n`, "utf8");
    return { name };
  }

  async saveSnapshot(database, metadata = {}) {
    await mkdir(dirname(this.snapshotFile), { recursive: true });
    const snapshot = normalizeDatabase({ ...database, ...metadata });
    await writeFile(this.snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    return {};
  }

  async load() {
    const snapshot = await this.readSnapshot();
    const database = snapshot ? snapshot.database : createEmptyDatabase();
    let journalSeq = database.journalSeq ?? 0;

    const pending = (await this.listJournal())
      .map((name) => ({ name, seq: parseJournalFileName(name) }))
      .filter((entry) => entry.seq > journalSeq);

    if (pending.length > 0) {
      for (const op of await this.readJournalOps(pending.map((entry) => entry.name))) {
        applyJournalOperation(database, op);
        if (op.seq > journalSeq) journalSeq = op.seq;
      }
    }

    database.journalSeq = journalSeq;
    return { database, journalSeq, snapshotSha: null };
  }
}
