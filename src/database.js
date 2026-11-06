export function createEmptyDatabase() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    records: {}
  };
}

export function normalizeDatabase(database) {
  if (!database || typeof database !== "object" || Array.isArray(database)) {
    throw new Error("Database must be a JSON object.");
  }

  if (database.version !== 1 || !database.records || typeof database.records !== "object") {
    throw new Error("Unsupported database format.");
  }

  return {
    version: 1,
    updatedAt: database.updatedAt ?? new Date().toISOString(),
    records: database.records,
    ...(Number.isFinite(database.journalSeq) ? { journalSeq: database.journalSeq } : {})
  };
}

export function isExpired(record, now = Date.now()) {
  return Number.isFinite(record?.expiresAt) && record.expiresAt <= now;
}

export function getRecord(database, key, now = Date.now()) {
  const record = database.records[key];

  if (!record || isExpired(record, now)) {
    return null;
  }

  return record.value;
}

export function setRecord(database, key, value, ttlSeconds) {
  const record = { value };

  if (ttlSeconds !== undefined && ttlSeconds !== null) {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error("ttl must be a positive number of seconds.");
    }

    record.expiresAt = Date.now() + ttlSeconds * 1000;
  }

  database.records[key] = record;
  database.updatedAt = new Date().toISOString();
}

export function deleteRecord(database, key) {
  const existed = Object.hasOwn(database.records, key);
  delete database.records[key];

  if (existed) {
    database.updatedAt = new Date().toISOString();
  }

  return existed;
}

export function listKeys(database, now = Date.now()) {
  return Object.entries(database.records)
    .filter(([, record]) => !isExpired(record, now))
    .map(([key]) => key);
}

export function applyJournalOperation(database, op) {
  const { op: kind, key, timestamp } = op ?? {};

  if (!key || typeof key !== "string") {
    throw new Error("Journal operation requires a string key.");
  }

  const updatedAt = Number.isFinite(timestamp)
    ? new Date(timestamp * 1000).toISOString()
    : new Date().toISOString();

  if (kind === "set") {
    if (!Object.hasOwn(op, "value")) {
      throw new Error("Journal 'set' operation requires a value.");
    }

    const record = op.expiresAt === undefined
      ? { value: op.value }
      : { value: op.value, expiresAt: op.expiresAt };

    database.records[key] = record;
    database.updatedAt = updatedAt;
    return true;
  }

  if (kind === "delete") {
    const existed = Object.hasOwn(database.records, key);
    delete database.records[key];

    if (existed) {
      database.updatedAt = updatedAt;
    }

    return existed;
  }

  throw new Error(`Unknown journal operation: ${kind}`);
}
