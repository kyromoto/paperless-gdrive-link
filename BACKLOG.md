# Backlog

## RC#3 — DriveMonitor.start() nicht idempotent

**Datei:** `src/drive-monitor.ts` — Methode `start()` (Zeile 45)

**Problem:** Kein Guard gegen parallele Aufrufe. Wenn `start()` erneut gerufen wird (z.B. langsamer API-Call + Renewal-Event), werden zwei Drive-Channels geöffnet. `this.channelId` wird vom letzten Caller überschrieben, der orphante Channel kann nie gestoppt werden. Jeder `start()`-Aufruf registriert einen weiteren Renewal-Task im TaskScheduler → exponentielles Wachstum.

**Fix-Ansatz:** `isStarting: boolean`-Flag setzen, bevor der `files.watch`-Call abgesetzt wird, und am Ende (finally) zurücksetzen. Alternativ: alten Channel vor dem neuen `files.watch` via `this.stop()` explizit schließen.

---

## RC#4 — Startup-Overlap: HTTP-Server vor vollständigem initialen Scan oben

**Datei:** `src/main.ts` — Reihenfolge um Zeile 327–351

**Problem:** Der HTTP-Server und die DriveMonitors starten, während `processChangesQueue.addBulk(processingJobs)` noch läuft. Google Drive kann in diesem Fenster einen Webhook senden, der einen `collect-changes`-Job auslöst. Dieser läuft parallel zum Startup-Scan und reiht dieselben Dateien ein zweites Mal in `process-changes` ein. Dank RC#2-Fix (deterministischer jobId) werden Duplikate von BullMQ zwar abgewiesen, solange der erste Job noch `waiting` oder `active` ist — aber es ist kein sauberes Design.

**Fix-Ansatz:** `await processChangesQueue.addBulk(processingJobs)` abwarten, dann HTTP-Server starten, dann `monitor.start()`. Aktuell ist die Reihenfolge: addBulk → server.listen → monitor.start, was bereits fast korrekt ist. Sicherstellen, dass `addBulk` wirklich abgeschlossen ist, bevor `app.listen` gerufen wird.
