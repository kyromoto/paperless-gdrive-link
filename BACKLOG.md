# Backlog

## Feature — Admin Web UI (Bull Board)

**Ziel:** Einfache, auth-freie Admin-Oberfläche unter `/admin/queues`, auf der aktive, wartende, abgeschlossene und fehlgeschlagene Jobs beider Queues sichtbar sind.

**Umsetzung:**
- Pakete `@bull-board/express` und `@bull-board/api` installieren
- `ExpressAdapter` + `createBullBoard` in `src/main.ts` einbinden, Queue-Instanzen (`collect-changes`, `process-changes`) als `BullMQAdapter` registrieren
- Router unter `/admin/queues` mounten (vor anderen Routes)
- Queue-Instanzen ggf. aus dem lokalen Scope herauslösen, damit sie dem Board-Setup zugänglich sind

**Hinweis:** Kein Auth vorgesehen — nur für internes/lokales Deployment gedacht.
