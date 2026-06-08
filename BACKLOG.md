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

## Refactoring — Lesbarkeit `main.ts`

Fünf unabhängige Verbesserungen, können einzeln umgesetzt werden.

### 1. IIFE → benannte `main()`-Funktion
Anonymes `(async () => { ... })()` durch `async function main() { ... }` + `main()` ersetzen. Macht den Einstiegspunkt sofort erkennbar und erlaubt Top-Level-Typen außerhalb des Blocks.

### 2. `addExitCallback` ans Ende verschieben
Der Callback (Zeile 43) referenziert `logger`, `server`, `redisConnection` und `monitors`, die erst weiter unten deklariert werden. Callback nach allen Deklarationen platzieren oder in eine `setupShutdownHandler(logger, server, redisConnection, monitors)`-Funktion auslagern.

### 3. Worker-Event-Listener-Muster extrahieren
Die `.on("active"/"completed"/"failed")`-Blöcke für alle drei Worker sind fast identisch (~50 Zeilen, Zeilen 182–253). Eine Hilfsfunktion `attachWorkerLogging(worker, queue, getLabel)` würde das auf ~10 Zeilen reduzieren.

### 4. Tippfehler `"unkown"` → `"unknown"` beheben
Kommt 4× in `main.ts` vor (Zeilen 184, 185, 203, 204, 213, 226).

### 5. Startup-Scan in Hilfsfunktion auslagern
Der verschachtelte Block `processingJobs` (Zeilen 299–313) mit doppeltem `await Promise.all(...).flat()` in eine Funktion `collectOutstandingJobs(processors, queueName)` extrahieren.
