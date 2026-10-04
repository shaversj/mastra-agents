# syntax=docker/dockerfile:1.7

FROM node:22.13.0-bookworm-slim AS build

RUN npm install --global pnpm@10.32.1
WORKDIR /workspace

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/incident-triage-agent/package.json apps/incident-triage-agent/package.json
RUN pnpm install --frozen-lockfile --filter @mastra-agents/incident-triage-agent...

COPY tsconfig.base.json ./
COPY apps/incident-triage-agent apps/incident-triage-agent
RUN pnpm --filter @mastra-agents/incident-triage-agent run build
RUN mkdir -p /runtime \
    && cp -R apps/incident-triage-agent/.mastra/output/. /runtime/ \
    && mkdir -p /runtime/migrations \
    && cp apps/incident-triage-agent/src/persistence/migrations/*.sql /runtime/migrations/

FROM node:22.13.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4111 \
    PROCESS_ROLE=api \
    APP_MIGRATIONS_DIR=/app/migrations

WORKDIR /app
COPY --from=build --chown=node:node /runtime/ ./

USER node
EXPOSE 4111
CMD ["node", "role.mjs"]
