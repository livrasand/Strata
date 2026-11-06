import { createServer as createHttpServer } from "node:http";
import { Readable } from "node:stream";
import { FileStorage, CodebergStorage, createApp, createStorage, LONG_MODE } from "./app.js";

export { FileStorage, CodebergStorage, createStorage };

async function toWebRequest(request) {
  const origin = `http://${request.headers.host ?? "localhost"}`;

  const method = request.method === "HEAD" ? "GET" : request.method;
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : Readable.toWeb(request);
  const headers = new Headers(request.headers);
  if (method !== "GET" && method !== "HEAD" && body !== undefined) {
    return new Request(new URL(request.url, origin), { method, headers, body, duplex: "half" });
  }

  return new Request(new URL(request.url, origin), { method, headers });
}

async function respond(response, webResponse) {
  const headers = {};
  for (const [key, value] of webResponse.headers) {
    headers[key] = value;
  }

  response.writeHead(webResponse.status, headers);

  if (!webResponse.body) {
    return response.end();
  }

  response.flushHeaders();
  for await (const chunk of webResponse.body) {
    response.write(chunk);
  }
  response.end();
}

export function createServer({ storage, env = process.env, mode = LONG_MODE } = {}) {
  const app = createApp({ env, storage, mode });

  const server = createHttpServer(async (request, response) => {
    try {
      const webRequest = await toWebRequest(request);
      const webResponse = await app.handle(webRequest);
      await respond(response, webResponse);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });

  server.app = app;
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 8787);

  server.listen(port, host, () => {
    console.log(`KV server listening on http://${host}:${port}`);
    console.log(
      `Write queue: debounce ${process.env.WRITE_QUEUE_DEBOUNCE_MS ?? 2000} ms, ` +
      `interval ${process.env.WRITE_QUEUE_INTERVAL_MS ?? 5000} ms, ` +
      `snapshot every ${process.env.JOURNAL_SNAPSHOT_EVERY ?? 10} operations, ` +
      `journal compaction ${process.env.JOURNAL_COMPACT === "false" ? "disabled" : "enabled"}.`
    );
  });

  async function shutdown() {
    console.log("Shutting down: flushing pending operations...");
    try {
      await server.app.flushNow();
      console.log("Pending operations flushed.");
    } finally {
      server.close();
      process.exit(0);
    }
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
