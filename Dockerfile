FROM denoland/deno:2.1.4

WORKDIR /app

# Cache-Verzeichnis für Deno
ENV DENO_DIR=/app/cache

# Kopiere den Rest der Anwendung
COPY . .

# Cache dependencies based on deno.json and lock file
RUN deno cache app/main.ts

# Starte die Anwendung
CMD ["task", "start"]