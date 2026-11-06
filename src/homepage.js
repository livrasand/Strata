import { readFile } from "node:fs/promises";

const pageUrl = new URL("../index.html", import.meta.url);
let cached;

const FALLBACK = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Strata</title></head>
<body style="background:#1d1e28;color:#78e2a0;font-family:monospace;padding:3rem">
<p>$ strata — Git-backed key-value store</p>
<p style="color:#999">The landing page could not be read from disk on this runtime.</p>
</body>
</html>`;

export async function homepage() {
  if (cached !== undefined) return cached;

  try {
    cached = await readFile(pageUrl, "utf8");
  } catch {
    cached = FALLBACK;
  }

  return cached;
}
