# Architecture

## One app is one deployment boundary

Every `apps/<name>/` directory is a complete Mastra application. It owns its `package.json`, runtime dependencies, environment contract, source, tests, Mastra build output, and Dockerfile. Root configuration coordinates the workspace but does not own app-specific providers, prompts, tools, or runtime libraries.

Apps may not import another app's source. Repository tests enforce that boundary. Reusable runtime code belongs in a workspace package under `packages/` only after at least two apps demonstrate the same stable need. A consuming app must then declare the workspace dependency and import through the package's public exports.

## Identity and runtime contract

Each app defines `packageName`, `appId`, and `agentId` once in `src/config/app.ts`. Its Mastra registration, tests, image smoke harness, and CI use that app-owned metadata. Each current app registers exactly one agent in `src/mastra/index.ts`.

`mastra build` writes a self-contained server to the app's `.mastra/output`. The Docker build compiles that output inside Linux and copies only the selected app's generated server into a slim runtime image. The image runs as a non-root user and does not depend on a repository mount or sibling app source.

The black-box server contract is:

- `GET /health` reports liveness.
- `GET /api/agents` contains exactly the app-owned agent ID.
- `SIGTERM` stops the server within the smoke-test deadline.

These probes are model-free. They use a structural `MODEL_ID` value but do not call a model provider.

Local processes default to `127.0.0.1`. Images listen inside their container on `0.0.0.0`, while the smoke harness publishes the port only on host loopback. Application authentication is deferred, so an external deployment must put authenticated ingress in front of the Mastra server.

## Validation and affected-app CI

The root `check:repo` gate always validates shared tooling and boundary rules. The separate application matrix runs each selected package's `check` and `image:smoke`; CI never publishes or deploys an image.

Selection is conservative and dependency-aware:

- App-local source, configuration, manifest, or that app's lockfile importer selects only the owning app.
- A shared package change, including its lockfile importer, selects its transitive app dependents through declared workspace dependencies.
- Root build inputs, CI workflows, shared helpers, unknown paths, an unreadable lockfile, or an unavailable comparison base select all apps.
- Documentation-only changes produce a successful empty application matrix.
- A new app is selected. A deleted app is omitted because it cannot be built; a rename is treated as a deletion plus an addition.

The pnpm lockfile is one repository-wide file, but importer sections preserve narrow app dependency impact when the before and after graphs can be compared safely.

## Intentionally deferred

This foundation does not define production prompts, tools, provider choice, live-model evaluations, authentication, storage, memory, queues, long-running recovery, inter-agent communication, gateways, orchestration, registry publishing, release automation, hosting manifests, Kubernetes, or multi-architecture images. A custom readiness route should be added only when an app gains a required startup dependency. A generator should be added only after repeated manual additions reveal real drift.
