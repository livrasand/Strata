<div align="center">

# Strata

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Flivrasand%2Fstrata&env=STORAGE,CODEBERG_API,CODEBERG_OWNER,CODEBERG_REPO,CODEBERG_BRANCH,CODEBERG_FILE,CODEBERG_TOKEN,API_TOKEN,CORS_ORIGIN&envDescription=Environment%20variables%20needed%20to%20configure%20Strata&envLink=https%3A%2F%2Fgithub.com%2Flivrasand%2Fstrata%2Fblob%2Fmain%2FREADME.md)

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/livrasand/strata)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/livrasand/strata)

**The free key-value database that won't bill you when it becomes your product's backbone.**

Strata is a lightweight, Git-backed KV store for serverless and self-hosted
applications — no usage quotas, no connection caps, no pricing tiers. Setup
takes a few more minutes than a managed Redis, but what you get back is a
database that lives in your own repository: versioned, auditable and yours.

Built to be the starter database you can ship on with $0. When your software
grows and starts generating income, migrating to Redis — or any database you
prefer — is a straightforward export, not a rewrite.

</div>

## 👋 Introduction

Strata is a lightweight key-value store backed by Git (Codeberg) with an operation journal, periodic snapshots and an asynchronous publish queue. It runs on your own infrastructure and keeps data versioned and auditable.

- **Self-hosted**: runs on your own server or serverless platform
- **Git-backed**: every change is committed to a Git repository
- **Serverless-ready**: Vercel, Netlify and other serverless platforms
- **No database required**: Codeberg (or any Git host) is the storage
- **REST API**: simple HTTP API for get/set/delete/list

## 🚀 Get started

Get Strata up and running…

- […with Docker Compose](#with-docker-compose)
- […with Docker](#with-docker)
- […without Docker](#without-docker)
- […with Netlify](#with-netlify)
- […with Vercel](#with-vercel)
- […with Heroku](#with-heroku)
- […with Render](#with-render)

And configure Strata and your server correctly…

- […with environment variables](#environment-variables)
- […with a token](#authentication)
- […with CORS headers](#cors-headers)

And understand how Strata behaves on each platform…

- [Deployment modes](#deployment-modes)
- [Serverless semantics](#serverless-semantics)
- [Long-lived semantics](#long-lived-semantics)

## With Docker Compose

```sh
cp .env.example .env
docker-compose up
```

## With Docker

```sh
docker build -t strata .
docker run -p 8787:8787 --env-file .env strata
```

## Without Docker

```sh
cp .env.example .env
npm install
npm start
```

By default Strata uses `./data/database.json` as local storage.

## With Netlify

1. Deploy to Netlify using the button above.
2. Set `STORAGE=codeberg` and the Codeberg environment variables.
3. Netlify uses `netlify/functions/api.js` as the entry point.

## With Vercel

1. Deploy to Vercel using the button above.
2. Set `STORAGE=codeberg` and the Codeberg environment variables.
3. Vercel uses `api/index.js` as the entry point; `vercel.json` routes all paths to it.

## With Heroku

Deploy with the `app.json` manifest. Set the Codeberg environment variables in the Heroku dashboard.

## With Render

Deploy with `render.yaml`. Set the Codeberg environment variables marked `sync: false`.

## Deployment modes

Strata ships a single framework-free core (`src/app.js`) that talks the Web
Standard `Request`/`Response` API, plus thin adapters per platform:

```
src/app.js              ← core: routing, storages, journal, write queue
src/server.js           ← Node.js adapter (long-lived mode)
src/serverless.js       ← shared serverless core (strict mode)
api/index.js            ← Vercel adapter (5 lines)
netlify/functions/api.js ← Netlify adapter (5 lines)
Dockerfile              ← Node adapter packaged for Docker
```

Two operating modes exist because of what the compute can promise:

|  | Long-lived (Node, Docker, Heroku, Render) | Serverless (Vercel, Netlify) |
|---|---|---|
| Mode name | `long` | `serverless` |
| Reads | In-memory, no reload after boot | Revalidated against the backing store per request |
| Writes | Asynchronous write queue (respond instantly, publish in the background) | Committed to the journal **before** answering |
| `STORAGE=file` | allowed (with a volume) | rejected |

## Serverless semantics

Serverless platforms freeze and evict instances at any moment and can run
several instances concurrently, so the async queue is not safe there:

1. **`STORAGE=codeberg` is required.** Serverless instances have no persistent
   disk; `STORAGE=file` fails fast with an error explaining this.
2. **Mutations commit before responding.** A `PUT`/`DELETE` publishes the
   journal op to Codeberg and only then answers with `persisted: true`
   (`queued` is always `false` in this mode).
3. **Seq conflicts retry automatically.** If another instance claimed
   `journal/000007.json` first, Strata reloads the state, re-derives the next
   sequence and retries (up to 5 attempts, then `409`).
4. **State is revalidated per request.** Every `GET`/`PUT`/`DELETE` re-checks
   the backing store so concurrent instances always see fresh data. Set
   `SERVERLESS_CACHE_MS` to cache the loaded state for a few milliseconds when
   consecutive requests land on the same warm instance (default `0`).

Vercel / Netlify quick start:

1. Deploy with the buttons above (or `vercel` / `netlify deploy`).
2. In the dashboard, set `STORAGE=codeberg`, `CODEBERG_OWNER`, `CODEBERG_REPO`
   and `CODEBERG_TOKEN` (access token with read + write scope).
3. `API_TOKEN` optional: requests then need `Authorization: Bearer <secret>`.

## Long-lived semantics

Node, Docker, Heroku, Render and Railway keep the original behaviour:

- Reads come from memory (no network round-trip per `GET`).
- `PUT`/`DELETE` answer instantly with `queued: true`; the WriteQueue publishes
  journal ops in the background (debounce 2000 ms / interval 5000 ms by
  default) and snapshots + compacts every `JOURNAL_SNAPSHOT_EVERY` operations.
- `STORAGE=file` with a persistent disk/volume works. Docker Compose mounts
  `./data` as a volume so the local storage survives restarts.

## Environment variables

| Variable | Description |
|---|---|
| `STORAGE` | `file` or `codeberg` (required `codeberg` on serverless) |
| `DATABASE_FILE` | Local snapshot path when `STORAGE=file` |
| `CODEBERG_API` | Codeberg API base URL |
| `CODEBERG_OWNER` | Repository owner |
| `CODEBERG_REPO` | Repository name |
| `CODEBERG_BRANCH` | Branch (default `main`) |
| `CODEBERG_FILE` | Snapshot file path (default `snapshot.json`) |
| `CODEBERG_TOKEN` | Codeberg access token (read + write) |
| `API_TOKEN` | Optional secret to protect the API |
| `CORS_ORIGIN` | Optional exact origin of your app |
| `HOST` / `PORT` | Server bind address (default `127.0.0.1` / `8787`) |
| `WRITE_QUEUE_DEBOUNCE_MS` | Long mode: idle time before publishing a burst (default `2000`) |
| `WRITE_QUEUE_INTERVAL_MS` | Long mode: minimum rest between publish cycles (default `5000`) |
| `JOURNAL_SNAPSHOT_EVERY` | Ops published before a new snapshot (default `10`) |
| `JOURNAL_COMPACT` | Set `false` to keep journal entries after snapshotting |
| `SERVERLESS_CACHE_MS` | Serverless mode: state cache TTL in ms (default `0` = revalidate always) |

## API

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health and journal status (never requires authentication) |
| GET | `/` | Landing page |
| GET | `/keys` | List keys |
| GET | `/kv/:key` | Get value |
| PUT | `/kv/:key` | Set value (JSON body with `value`, optional `ttl`) |
| DELETE | `/kv/:key` | Delete value |

## Authentication

Set the `API_TOKEN` environment variable to a long random secret and Strata
requires it on every endpoint except `/health`:

```sh
curl -X PUT https://your-strata.example/kv/name \
  -H "Authorization: Bearer s3cr3t-token" \
  -H "Content-Type: application/json" \
  -d '{"value":"livrasand"}'
```

- Requests without the header, without the `Bearer` scheme, or with a wrong
  token answer `401 {"error":"Unauthorized"}`.
- `OPTIONS` preflight requests stay open so browsers can negotiate CORS.
- `/health` stays open because load balancers, Docker and uptime monitors use
  it as a healthcheck.
- Tokens are compared timing-safely (hash + constant-time comparison).
- If `API_TOKEN` is unset, the API is open by default.

Generate a secret:

```sh
openssl rand -hex 32
```

## CORS headers

For a public API, set `CORS_ORIGIN` to the exact origin of your application.

## Tests

```sh
npm test
```
