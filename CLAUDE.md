# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # run with tsx watch (hot-reload), reads .env automatically
npm run build      # compile TypeScript to ./build/

npx biome check          # lint + format check
npx biome lint           # lint only
npx biome format         # show format diff (read-only)
npx biome format --write # apply formatting
```

There is no test suite.

Required env vars (put in `.env` for dev):
- `CONFIG_PATH` — path to YAML config file (e.g. `config/config.yml`)
- `LOG_LEVEL` — `trace | debug | info | warning | error | fatal` (default: `info`)
- `NODE_ENV` — `development | production` (default: `development`)

## Architecture

**Purpose:** Bridges Google Drive and Paperless-ngx. Files dropped into a Drive "src folder" are downloaded, uploaded to Paperless-ngx, and moved to a Drive "dst folder".

### Config model (`src/types.ts`)

Three top-level entities defined in the YAML config and validated with Zod:
- `DriveAccount` — Google service account credentials + channel expiry settings
- `PaperlessEndpoint` — Paperless-ngx server URL + basic auth credentials
- `Account` — joins one `DriveAccount` + one `PaperlessEndpoint` with a src and dst Drive folder ID

Multiple accounts can be configured; each gets its own `DriveMonitor` and `FileProcessor`.

### Processing pipeline

```
Google Drive (src folder)
    │
    ▼ [files.watch webhook channel]
DriveMonitor  ──delayed job──▶  renew-channel Queue  (BullMQ/Redis)
    │                               jobId = "renew-channel-{accountId}" ← fires 30s before expiry
    │ Google Drive sends HTTP POST
    ▼
POST /webhook  (controllers.ts)
    │  validates X-Goog-Channel-Id against active monitors
    ▼
collect-changes Queue  (BullMQ/Redis)
    │  jobId = "collect-changes-{accountId}"  ← deterministic, prevents duplicate concurrent jobs
    ▼
collect-changes Worker  (queue-processor.ts)
    │  calls Drive changes.list API, uses change token from disk
    │  writes updated change token to {data_path}/tokens/
    ▼
process-changes Queue  (BullMQ/Redis, one job per file)
    ▼
process-changes Worker
    │  1. download file from Drive → FileStore (local temp, {data_path}/files/)
    │  2. POST to Paperless-ngx /api/documents/post_document/
    │  3. Move file in Drive: removeParents=src, addParents=dst
    ▼
Done
```

On startup, all files currently in the src folder are scanned and queued directly into `process-changes` (bypassing collect), so nothing is missed while the app was offline. Stale `renew-channel` delayed jobs from the previous run are drained before `monitor.start()` is called, to avoid spurious double-starts after a restart.

### Key components

| File | Role |
|---|---|
| `src/main.ts` | Wires everything together; owns queue/worker setup and startup scan |
| `src/drive-monitor.ts` | Manages one Google Drive webhook channel per account; schedules renewal via BullMQ delayed job 30s before expiry |
| `src/file-processor.ts` | `getUnprocessedFiles()` + `processFile()` — the core business logic |
| `src/file-store.ts` | Thin wrapper around local filesystem for buffering files between download and upload |
| `src/lib.ts` | `listFilesRecursive`, `listChangesRecursive` (manages change token), `getDriveClient` |
| `src/queue-processor.ts` | BullMQ job handler functions (thin adapters into `FileProcessor`) |
| `src/queue-utils.ts` | `attachWorkerLogging` (worker event listeners) + `collectOutstandingJobs` (startup scan helper) |
| `src/controllers.ts` | Express route handlers for `/webhook` and `/health` |
| `src/config-repository.ts` | Reads/writes the YAML config file; parses with Zod |
| `src/repositories.ts` | `ConfigRepository` interface — abstracts config read access |
| `src/env.ts` | Validates and exports env vars via Zod — **throws at import time** if `CONFIG_PATH` is missing |

### Important invariants

- The `collect-changes` jobId is `collect-changes-${accountId}` (deterministic). This prevents concurrent collect jobs for the same account from racing on the Drive change token. Do not change it to a random ID.
- The `process-changes` jobId is `process-changes-${accountId}-${fileId}` (deterministic). This prevents the same file from being downloaded/uploaded to Paperless twice concurrently (FileStore collision). Do not change it to a random ID.
- The `renew-channel` jobId is `renew-channel-${accountId}` (deterministic). `monitor.start()` removes any existing job with this ID before adding a new one, so each account always has at most one pending renewal. The queue is drained on startup to clear stale jobs from the previous process.
- The Drive change token is persisted to disk at `{data_path}/tokens/{accountId}.{folderId}.change-token.txt`. If the token file is missing, the app bootstraps a fresh one from `changes.getStartPageToken`.
- `process-changes` worker runs with concurrency 1 by default. Increasing it risks concurrent FileStore access for the same file (same `{accountId}_{fileId}` path).
- `@logtape/redaction` automatically strips JWTs and private keys from logs. Do not bypass the logger for sensitive config fields.

## Diagrams

[`app-sequence.mermaid`](app-sequence.mermaid) is the authoritative flow diagram. **Update it whenever the processing pipeline changes** (queue names, jobId scheme, step order, new/removed actors). It reflects the current state including RC fixes.

## Backlog

Open work items are tracked in [`BACKLOG.md`](BACKLOG.md). Read it before working on race conditions or the DriveMonitor.
