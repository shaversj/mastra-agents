# Mastra Agents

A pnpm workspace for Mastra agents that build, validate, and deploy independently. Each directory under `apps/` is one deployment unit with its own manifest, runtime configuration, tests, generated server, and container image.

The reference apps are `@mastra-agents/researcher-agent` and `@mastra-agents/writer-agent`.

## Prerequisites

- Node.js 22.13.0 (see `.node-version`)
- pnpm 10.32.1
- Docker for image builds and container smoke tests

## Install and validate

```sh
pnpm install --frozen-lockfile
pnpm check:repo
pnpm check
```

`check:repo` validates root formatting, linting, types, package boundaries, smoke helpers, and CI selection without building every app. `check` runs that gate and then each app's complete check, including its generated-server smoke test.

Run only one app's checks with a fail-safe workspace filter:

```sh
pnpm --filter @mastra-agents/researcher-agent --fail-if-no-match run check
pnpm --filter @mastra-agents/writer-agent --fail-if-no-match run check
```

All scaffold checks are model-free: they validate configuration, registration, `/health`, `/api/agents`, and graceful shutdown without sending a model request or requiring a provider credential.

## Run an app locally

Copy the app's `.env.example` to an uncommitted `.env`, or supply the values in your shell. The default host is loopback-only.

```sh
MODEL_ID=openai/gpt-4o-mini pnpm --filter @mastra-agents/researcher-agent --fail-if-no-match run dev
```

To prove the generated production server independently:

```sh
pnpm --filter @mastra-agents/researcher-agent --fail-if-no-match run build
pnpm --filter @mastra-agents/researcher-agent --fail-if-no-match run test:server
```

To build and smoke the app's non-root Linux image:

```sh
pnpm --filter @mastra-agents/researcher-agent --fail-if-no-match run image:smoke
```

The repository builds and smokes local images only. It does not publish images, create releases, or deploy infrastructure. The Mastra servers do not yet implement application authentication; never expose an image publicly without authenticated ingress in front of it.

## Project guides

- [Architecture](docs/architecture.md) explains deployment boundaries, ownership, generated artifacts, and affected-app CI.
- [Adding an agent](docs/adding-agent.md) is the checklist for creating another independent app.
