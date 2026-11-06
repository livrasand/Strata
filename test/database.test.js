import test from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyDatabase,
  deleteRecord,
  getRecord,
  listKeys,
  setRecord
} from "../src/database.js";

test("stores and retrieves values", () => {
  const database = createEmptyDatabase();
  setRecord(database, "name", "livrasand");
  assert.equal(getRecord(database, "name"), "livrasand");
});

test("returns null for missing keys", () => {
  assert.equal(getRecord(createEmptyDatabase(), "missing"), null);
});

test("expires records using TTL", () => {
  const database = createEmptyDatabase();
  setRecord(database, "temporary", "value", 1);
  database.records.temporary.expiresAt = Date.now() - 1;
  assert.equal(getRecord(database, "temporary"), null);
  assert.deepEqual(listKeys(database), []);
});

test("deletes records", () => {
  const database = createEmptyDatabase();
  setRecord(database, "name", "livrasand");
  assert.equal(deleteRecord(database, "name"), true);
  assert.equal(getRecord(database, "name"), null);
  assert.equal(deleteRecord(database, "name"), false);
});
