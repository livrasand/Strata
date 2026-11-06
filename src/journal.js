export const JOURNAL_ENTRY_PATTERN = /^\d+\.json$/;

export function journalFileName(seq) {
  const value = Number(seq);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("Journal sequence numbers must be positive integers.");
  }
  return `${String(value).padStart(6, "0")}.json`;
}

export function parseJournalFileName(name) {
  if (typeof name !== "string" || !JOURNAL_ENTRY_PATTERN.test(name)) return null;
  return Number(name.slice(0, -".json".length));
}

export function validateJournalOp(op) {
  if (!op || typeof op !== "object" || Array.isArray(op)) {
    throw new Error("Journal operation must be a JSON object.");
  }

  if (!Number.isInteger(op.seq) || op.seq < 1) {
    throw new Error("Journal operation requires a positive integer seq.");
  }

  if (op.op === "set") {
    if (!Object.hasOwn(op, "key")) {
      throw new Error("Journal 'set' operation requires a key.");
    }
    if (!Object.hasOwn(op, "value")) {
      throw new Error("Journal 'set' operation requires a value.");
    }
    if (op.expiresAt !== undefined && !Number.isFinite(op.expiresAt)) {
      throw new Error("Journal 'set' expiresAt must be a finite number.");
    }
    return;
  }

  if (op.op === "delete") {
    if (!Object.hasOwn(op, "key")) {
      throw new Error("Journal 'delete' operation requires a key.");
    }
    return;
  }

  throw new Error(`Unknown journal operation: ${op.op}`);
}
