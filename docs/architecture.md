# Architecture

## One app is one deployment boundary

Every `apps/<name>/` directory is a complete Mastra application. It owns its `package.json`, runtime dependencies, environment contract, source, tests, Mastra build output, and Dockerfile. Root configuration coordinates the workspace but does not own app-specific providers, prompts, tools, or runtime libraries.

Apps may not import another app's source. Repository tests enforce that boundary. Reusable runtime code belongs in a workspace package under `packages/` only after at least two apps demonstrate the same stable need. A consuming app must then declare the workspace dependency and import through the package's public exports.

## Identity and runtime contract

Each app defines `packageName`, `appId`, and `agentId` once in `src/config/app.ts`. Its Mastra registration, tests, image smoke harness, and CI use that app-owned metadata. The reference apps register one agent each. The incident app also registers its durable workflow and deterministic release scorer.

`mastra build` writes a self-contained server to the app's `.mastra/output`. The Docker build compiles that output inside Linux and copies only the selected app's generated server into a slim runtime image. The image runs as a non-root user and does not depend on a repository mount or sibling app source.

The black-box server contract is:

- `GET /health` reports liveness.
- `GET /api/agents` contains exactly the app-owned agent ID.
- `SIGTERM` stops the server within the smoke-test deadline.

These probes are model-free. They use a structural `MODEL_ID` value but do not call a model provider.

Local processes default to `127.0.0.1`. Images listen inside their container on `0.0.0.0`, while smoke harnesses publish ports only on host loopback. The reference apps require authenticated external ingress. The incident app adds JWT-protected operations, signed replay-resistant intake, and migration-aware readiness.

## Stateful API and worker pattern

`incident-triage-agent` remains one app and one release artifact while exposing separate `api`, `worker`, and one-shot `migrate` roles. Postgres owns delivery idempotency, case state, evidence, leases, approval permits, audit, and certification records. Mastra owns workflow run state, suspension and resume, traces, datasets, experiment results, and scorer output. Stable identifiers link the stores; neither store duplicates the other's payloads.

The migration job must finish before API and workers become ready. Workers use fenced leases and deterministic workflow run IDs, stop claiming new work after `SIGTERM`, and drain the current operation before exit. The image contains generated runtime output, production dependencies, and SQL migrations only; it runs as the non-root `node` user.

## Validation and affected-app CI

The root `check:repo` gate always validates shared tooling and boundary rules. The separate application matrix runs each selected package's `check` and `image:smoke`; CI never publishes or deploys an image.

Selection is conservative and dependency-aware:

- App-local source, configuration, manifest, or that app's lockfile importer selects only the owning app.
- A shared package change, including its lockfile importer, selects its transitive app dependents through declared workspace dependencies.
- Root build inputs, CI workflows, shared helpers, unknown paths, an unreadable lockfile, or an unavailable comparison base select all apps.
- Documentation-only changes produce a successful empty application matrix.
- A new app is selected. A deleted app is omitted because it cannot be built; a rename is treated as a deletion plus an addition.

The pnpm lockfile is one repository-wide file, but importer sections preserve narrow app dependency impact when the before and after graphs can be compared safely.

## Intentionally deferred for the reference apps

The reference apps do not define production prompts, tools, authentication, storage, queues, or long-running recovery. The incident app supplies an app-local pattern for those requirements without turning them into premature shared infrastructure. Registry publishing, release automation, production actuation, hosting manifests, Kubernetes, and multi-architecture images remain deferred.
