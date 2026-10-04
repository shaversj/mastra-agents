# Mastra Agents

A pnpm workspace for Mastra agents that build, validate, and deploy independently. Each directory under `apps/` is one deployment unit with its own manifest, runtime configuration, tests, generated server, and container image.

The reference apps are `@mastra-agents/researcher-agent` and `@mastra-agents/writer-agent`. `@mastra-agents/incident-triage-agent` is the stateful pattern, with independently deployable API and worker roles in one image.

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
pnpm --filter @mastra-agents/incident-triage-agent --fail-if-no-match run check
```

Default checks are model-free: they validate configuration, registration, operational endpoints, authorization boundaries, and graceful shutdown without sending a model request or requiring a provider credential. The incident app has separate real-Postgres, image, and opt-in live-certification tiers documented in its app README.

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

The repository builds and smokes local images only. It does not publish images, create releases, or deploy infrastructure. The reference servers do not yet implement application authentication; never expose them publicly without authenticated ingress. The incident app authenticates its own routes, but should still be deployed behind private, authenticated ingress.

## Project guides

- [Architecture](docs/architecture.md) explains deployment boundaries, ownership, generated artifacts, and affected-app CI.
- [Adding an agent](docs/adding-agent.md) is the checklist for creating another independent app.
- [Incident triage agent](apps/incident-triage-agent/README.md) documents its stateful operating and safety contract.
