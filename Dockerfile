# syntax=docker/dockerfile:1

# ---- dependencies: production only, exactly as locked ---------------------------------------
FROM oven/bun:1.4.4-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime ------------------------------------------------------------------------------------
# Bun runs the TypeScript sources directly (no build step). tsconfig.json must ship: Bun reads
# experimentalDecorators / emitDecoratorMetadata from it, and NestJS dependency injection needs both.
FROM oven/bun:1.4.4-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tools ./tools

USER bun
EXPOSE 3000

# Exec form: Bun is PID 1 and receives SIGTERM, which triggers the graceful shutdown (drain the SQS consumer,
# finish the outbox batch). `docker stop` waits for it (see stop_grace_period in docker-compose.yml).
CMD ["bun", "src/main.ts"]
