# syntax=docker/dockerfile:1.7

FROM node:22.13.0-bookworm-slim AS build

RUN npm install --global pnpm@10.32.1

WORKDIR /workspace

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/researcher-agent/package.json apps/researcher-agent/package.json
COPY apps/writer-agent/package.json apps/writer-agent/package.json

RUN pnpm install --frozen-lockfile --filter @mastra-agents/researcher-agent...

COPY tsconfig.base.json ./
COPY apps/researcher-agent apps/researcher-agent

RUN pnpm --filter @mastra-agents/researcher-agent run build

FROM node:22.13.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4111

WORKDIR /app

COPY --from=build --chown=node:node /workspace/apps/researcher-agent/.mastra/output/ ./

USER node
EXPOSE 4111

CMD ["node", "index.mjs"]
