# Backlog

## Feature — Admin Web UI (Bull Board)

**Ziel:** Einfache, auth-freie Admin-Oberfläche unter `/admin/queues`, auf der aktive, wartende, abgeschlossene und fehlgeschlagene Jobs beider Queues sichtbar sind.

**Umsetzung:**
- Pakete `@bull-board/express` und `@bull-board/api` installieren
- `ExpressAdapter` + `createBullBoard` in `src/main.ts` einbinden, Queue-Instanzen (`collect-changes`, `process-changes`) als `BullMQAdapter` registrieren
- Router unter `/admin/queues` mounten (vor anderen Routes)
- Queue-Instanzen ggf. aus dem lokalen Scope herauslösen, damit sie dem Board-Setup zugänglich sind

**Hinweis:** Kein Auth vorgesehen — nur für internes/lokales Deployment gedacht.

---

## Feature — Matrix-Benachrichtigung bei finalem Job-Fehler

**Ziel:** Wenn ein BullMQ-Job alle Retry-Versuche ausgeschöpft hat und final fehlschlägt, wird eine Nachricht an einen konfigurierten Matrix-Raum gesendet.

**Umsetzung (4 Dateien):**

1. **`src/types.ts`** — Optionalen `notifications.matrix`-Block zum `Server`-Zod-Schema hinzufügen:
   - `homeserver_url`, `access_token`, `room_id`

2. **`src/matrix-notifier.ts`** — Neue Datei (~30 Zeilen). Thin wrapper um die Matrix CS API (`PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}`), nutzt `axios`.

3. **`src/queue-utils.ts`** — `attachWorkerLogging` um optionalen 6. Parameter `onFinalFailure` erweitern. Finale Fehler erkennen via `job.attemptsMade >= (job.opts.attempts ?? 1)`. Im bestehenden `failed`-Handler aufrufen.

4. **`src/main.ts`** — `MatrixNotifier` instanziieren (falls konfiguriert), als `onFinalFailure`-Callback an alle drei `attachWorkerLogging`-Aufrufe übergeben.

**Nachrichtenformat:**
```
[paperfeed] Job final fehlgeschlagen
Queue: process-changes
Job: invoice.pdf (account: personal)
Fehler: HTTP 500 from Paperless
Versuche: 3/3
```

**Hinweis:** Credentials im YAML (konsistent mit Drive/Paperless). Plain `axios` statt Matrix SDK — für ein einziges `send` nicht nötig.

---

## Refactoring — Lesbarkeit `main.ts`

Zwei unabhängige Verbesserungen, können einzeln umgesetzt werden.

### 1. IIFE → benannte `main()`-Funktion
Anonymes `(async () => { ... })()` durch `async function main() { ... }` + `main()` ersetzen. Macht den Einstiegspunkt sofort erkennbar und erlaubt Top-Level-Typen außerhalb des Blocks.

### 2. `addExitCallback` ans Ende verschieben
Der Callback (Zeile 43) referenziert `logger`, `server`, `redisConnection` und `monitors`, die erst weiter unten deklariert werden. Callback nach allen Deklarationen platzieren oder in eine `setupShutdownHandler(logger, server, redisConnection, monitors)`-Funktion auslagern.
