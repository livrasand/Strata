import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "../src/zip.js";
import { buildStoredZip, buildDeflateZip, buildZip } from "./zipFixture.js";

test("unzipSync decodes stored and deflated entries", () => {
  const stored = unzipSync(
    buildStoredZip(
      new Map([
        ["a.txt", Buffer.from("hello stored", "utf8")],
        ["data/b.json", Buffer.from('{"value":120}', "utf8")]
      ])
    )
  );

  assert.equal(stored.get("a.txt").toString("utf8"), "hello stored");
  assert.equal(stored.get("data/b.json").toString("utf8"), '{"value":120}');
  assert.equal(stored.size, 2);

  const deflated = unzipSync(
    buildDeflateZip(new Map([["journal/000001.json", Buffer.from('{"seq":1}', "utf8")]]))
  );

  assert.equal(deflated.get("journal/000001.json").toString("utf8"), '{"seq":1}');
});

test("unzipSync skips directory entries and tolerates custom folder prefixes", () => {
  const entries = new Map([
    ["repo-main/data/journal/", Buffer.alloc(0)],
    ["repo-main/data/journal/000001.json", Buffer.from('{"seq":1}', "utf8")]
  ]);

  const archive = unzipSync(buildZip(entries, { method: 0 }));

  assert.equal(archive.size, 1);
  assert.equal(archive.get("repo-main/data/journal/000001.json").toString("utf8"), '{"seq":1}');
});

test("unzipSync rejects a buffer that is not a ZIP archive", () => {
  assert.throws(() => unzipSync(Buffer.from("this is not a zip file at all")), /ZIP/);
});

test("unzipSync decodes archives produced by the zip utility (when available)", (t) => {
  const available = spawnSync("zip", ["-v"]).status === 0;
  if (!available) t.skip("zip utility not available on this platform");

  const dir = mkdtempSync(join(tmpdir(), "zip-real-"));
  try {
    mkdirSync(join(dir, "payload"), { recursive: true });
    writeFileSync(join(dir, "payload", "000001.json"), '{"seq":1,"op":"set","key":"name","value":"livrasand"}\n');
    writeFileSync(join(dir, "payload", "readme.txt"), "strata journal fixture\n");

    const creation = spawnSync("zip", ["-q", "-X", "out.zip", "-r", "payload"], { cwd: dir });
    assert.equal(creation.status, 0, "zip produced an archive");

    const archive = unzipSync(readFileSync(join(dir, "out.zip")));
    assert.ok(archive.get("payload/000001.json"));
    assert.ok(archive.get("payload/readme.txt"));
    assert.equal(
      archive.get("payload/000001.json").toString("utf8"),
      '{"seq":1,"op":"set","key":"name","value":"livrasand"}\n'
    );
    assert.equal(archive.get("payload/readme.txt").toString("utf8"), "strata journal fixture\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
