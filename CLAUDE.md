# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # run with tsx watch (hot-reload), reads .env automatically
npm run build      # compile TypeScript to ./build/

npx biome check    # lint + format check
npx biome lint     # lint only
npx biome format   # format only
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
DriveMonitor  ──renewal task──▶  TaskScheduler (in-process, interval-based)
    │
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

On startup, all files currently in the src folder are scanned and queued directly into `process-changes` (bypassing collect), so nothing is missed while the app was offline.

### Key components

| File | Role |
|---|---|
| `src/main.ts` | Wires everything together; owns queue/worker setup and startup scan |
| `src/drive-monitor.ts` | Manages one Google Drive webhook channel per account; schedules renewal 30s before expiry |
| `src/task-scheduler.ts` | In-process scheduler using `setInterval`; used only for channel renewal |
| `src/file-processor.ts` | `getUnprocessedFiles()` + `processFile()` — the core business logic |
| `src/file-store.ts` | Thin wrapper around local filesystem for buffering files between download and upload |
| `src/lib.ts` | `listFilesRecursive`, `listChangesRecursive` (manages change token), `getDriveClient` |
| `src/queue-processor.ts` | BullMQ job handler functions (thin adapters into `FileProcessor`) |
| `src/controllers.ts` | Express route handlers for `/webhook` and `/health` |
| `src/config-repository.ts` | Reads/writes the YAML config file; parses with Zod |

### Important invariants

- The `collect-changes` jobId is `collect-changes-${accountId}` (deterministic). This prevents concurrent collect jobs for the same account from racing on the Drive change token. Do not change it to a random ID.
- The Drive change token is persisted to disk at `{data_path}/tokens/{accountId}.{folderId}.change-token.txt`. If the token file is missing, the app bootstraps a fresh one from `changes.getStartPageToken`.
- `process-changes` worker runs with concurrency 1 by default. Increasing it risks concurrent FileStore access for the same file (same `{accountId}_{fileId}` path).
- `@logtape/redaction` automatically strips JWTs and private keys from logs. Do not bypass the logger for sensitive config fields.
