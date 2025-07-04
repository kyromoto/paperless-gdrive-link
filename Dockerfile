FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json .
COPY src src

RUN npm ci
RUN npm run build



FROM node:18-alpine AS production

WORKDIR /app

COPY package*.json .
COPY --from=builder /app/build ./build

RUN npm ci --only=production && npm cache clean --force

ENV NODE_ENV=production

CMD ["node", "build/main.js"]