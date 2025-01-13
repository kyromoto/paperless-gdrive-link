FROM denoland/deno:alpine-1.40.2

WORKDIR /app

# Cache-Verzeichnis für Deno
ENV DENO_DIR=/app/cache

# Default Port setzen (wird durch ENV Variable überschrieben wenn gesetzt)
ENV HTTP_PORT=3000

# Kopiere deno.json und deno.lock für reproduzierbare Builds
COPY deno.json deno.lock* ./

# Cache dependencies based on deno.json and lock file
RUN deno cache --lock=deno.lock main.ts

# Kopiere den Rest der Anwendung
COPY . .

# Port für die Anwendung
EXPOSE ${HTTP_PORT}

# Starte die Anwendung
CMD ["task", "start"]