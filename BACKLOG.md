# Backlog

## RC#4 — Startup-Overlap: HTTP-Server vor vollständigem initialen Scan oben

**Datei:** `src/main.ts` — Reihenfolge um Zeile 327–351

**Problem:** Der HTTP-Server und die DriveMonitors starten, während `processChangesQueue.addBulk(processingJobs)` noch läuft. Google Drive kann in diesem Fenster einen Webhook senden, der einen `collect-changes`-Job auslöst. Dieser läuft parallel zum Startup-Scan und reiht dieselben Dateien ein zweites Mal in `process-changes` ein. Dank RC#2-Fix (deterministischer jobId) werden Duplikate von BullMQ zwar abgewiesen, solange der erste Job noch `waiting` oder `active` ist — aber es ist kein sauberes Design.

**Fix-Ansatz:** `await processChangesQueue.addBulk(processingJobs)` abwarten, dann HTTP-Server starten, dann `monitor.start()`. Aktuell ist die Reihenfolge: addBulk → server.listen → monitor.start, was bereits fast korrekt ist. Sicherstellen, dass `addBulk` wirklich abgeschlossen ist, bevor `app.listen` gerufen wird.

---

## Feature — Admin Web UI (Bull Board)

**Ziel:** Einfache, auth-freie Admin-Oberfläche unter `/admin/queues`, auf der aktive, wartende, abgeschlossene und fehlgeschlagene Jobs beider Queues sichtbar sind.

**Umsetzung:**
- Pakete `@bull-board/express` und `@bull-board/api` installieren
- `ExpressAdapter` + `createBullBoard` in `src/main.ts` einbinden, Queue-Instanzen (`collect-changes`, `process-changes`) als `BullMQAdapter` registrieren
- Router unter `/admin/queues` mounten (vor anderen Routes)
- Queue-Instanzen ggf. aus dem lokalen Scope herauslösen, damit sie dem Board-Setup zugänglich sind

**Hinweis:** Kein Auth vorgesehen — nur für internes/lokales Deployment gedacht.
