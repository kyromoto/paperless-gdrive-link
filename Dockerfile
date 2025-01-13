FROM denoland/deno:alpine-1.40.2

WORKDIR /app

# Cache-Verzeichnis für Deno
ENV DENO_DIR=/app/cache

# Kopiere den Rest der Anwendung
COPY . .

# Cache dependencies based on deno.json and lock file
RUN deno cache app/main.ts

# Starte die Anwendung
CMD ["task", "start"]