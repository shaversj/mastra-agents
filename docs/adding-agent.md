# Add an Independently Deployable Agent

Use an existing app as the structural reference, but keep the new app's identity, dependencies, configuration, and implementation local to its directory.

## 1. Create the app boundary

Create `apps/<agent-name>/` with:

- `package.json` with a unique `@mastra-agents/<agent-name>` name, pinned toolchain, app-owned dependencies, and the same lifecycle scripts as the reference apps
- `tsconfig.json` and `.prettierignore`
- `.env.example` listing required variable names and safe examples, never credentials
- `src/config/app.ts` with unique `packageName`, `appId`, and `agentId` metadata plus startup validation
- `src/mastra/index.ts` with direct `new Mastra()` configuration
- `src/mastra/agents/<agent>.ts` with the app's agent definition
- `scripts/preflight.ts` and `scripts/smoke-generated-server.ts`
- focused configuration and registration tests under `tests/`
- a multi-stage `Dockerfile` that builds from the workspace root and copies only this app's `.mastra/output` into a non-root runtime image

Do not import source from another `apps/*` directory. Keep a dependency local to this manifest unless two or more apps share a stable runtime contract; only then extract a `packages/*` workspace with public exports and declare it explicitly in each consumer.

## 2. Preserve the script contract

The package must expose `dev`, `format:check`, `lint`, `typecheck`, `test`, `build`, `start`, `config:check`, `preflight`, `preflight:built`, `test:server`, `image:build`, `image:smoke`, `check`, and `check:configured`. Stateful apps should add an explicit real-database test tier rather than making the default check depend on Docker.

Update the image tag and the `--app` argument in the image scripts. The directory name, `appId`, smoke argument, and CI matrix app value must agree. The package name and registered `agentId` must also be unique.

## 3. Prove the boundary

With Node 22.13.0, pnpm 10.32.1, and Docker available, run:

```sh
pnpm install --frozen-lockfile
pnpm check:repo
pnpm --filter @mastra-agents/<agent-name> --fail-if-no-match run check
pnpm --filter @mastra-agents/<agent-name> --fail-if-no-match run image:smoke
```

The focused check must validate configuration and registration, build `.mastra/output`, pass Mastra preflight, probe `/health` and `/api/agents`, and stop cleanly after `SIGTERM`. The image smoke must do the same without a repository mount, while running non-root and publishing only to host loopback. Neither check may make a model request or require a live provider credential.

Also run `pnpm check` before merging to prove aggregate workspace discovery.

## 4. Confirm CI discovery and safety

No central app registry should need editing: `scripts/affected-apps.mts` discovers app workspaces from their manifests. Confirm its fixture tests still pass and that the new app appears in the matrix for an app-local change. If the app consumes a shared workspace package, add a fixture proving that source and pnpm lockfile-importer changes select it transitively.

Update `README.md` or `docs/architecture.md` only when the operating contract changes. Record validation evidence in the pull request. Images are built and smoked but are not published or deployed by this repository. Reference apps do not implement application authentication, so do not expose them publicly without authenticated ingress. A stateful app must additionally define migration ordering, readiness semantics, durable retry ownership, process shutdown behavior, and retention before it is considered deployable. Keep those decisions local until a second app proves a stable shared contract.
