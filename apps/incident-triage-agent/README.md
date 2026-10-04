# Incident Triage Agent

A durable, evidence-grounded Mastra workflow for incident triage. The app accepts authenticated incident deliveries, records immutable evidence, produces structured decisions, suspends before governed mitigation, and resumes only through a single-use approval permit. It never executes production mitigation: approved actions are recorded as simulations.

## Runtime roles

One image supports three process roles through `PROCESS_ROLE`:

- `api` serves liveness, readiness, signed intake, authenticated case inspection, and approval routes.
- `worker` leases outbox work, starts or resumes Mastra workflow runs, and drains its current lease on `SIGTERM`.
- `migrate` applies checksum-protected Postgres migrations and exits. Run it before API and worker rollout.

`GET /health` is liveness. `GET /readyz` returns 200 only when Postgres is reachable and all app migrations are present. Mastra's `/api/*` routes and app case routes require JWT authentication. `POST /incidents` instead requires an HMAC signature and replay-resistant delivery identity. Do not expose this service through unauthenticated public ingress.

## Local operation

Copy `.env.example` to an uncommitted `.env`, then start the complete stack:

```sh
docker compose up --build
```

The compose stack runs Postgres 17, migrations, API, and worker. For host-based development, apply migrations and start each role explicitly:

```sh
PROCESS_ROLE=migrate pnpm build && pnpm start
PROCESS_ROLE=api pnpm start
PROCESS_ROLE=worker pnpm start
```

The deployment contract is the same: one migration job, at least one API replica, and at least one worker replica using the same image digest and database.

## Validation tiers

```sh
pnpm check
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/incident_triage_test pnpm test:postgres
pnpm image:smoke
LIVE_MODEL_EXPERIMENTS=true pnpm certify
```

The default check is model-free. Postgres tests and image smoke are explicit integration tiers. Image smoke enables the guarded fixture model only inside its isolated Docker network and proves a signed delivery reaches a completed case without provider credentials or outbound model traffic. Live certification is opt-in and uses Mastra datasets, experiments, and the deterministic composite scorer; a perfect score is necessary but a named human reviewer still makes the release decision.

## Recovery and retention

Delivery identity, attempt leases, outbox rows, workflow run IDs, permits, and audit records make retries observable and idempotent. Failed leases become claimable after expiry. Operators should inspect the case timeline and reason codes before retrying a terminal case; never edit ledger or audit rows in place.

Evidence and traces use the configured short retention windows. Governance records, permit audits, capsules, and certification decisions use the longer governance window. Cleanup is an operator-controlled maintenance action and must preserve sealed manifests and audit references.

## Safety boundary

Mitigation suggestions must come from the versioned catalog and policy. Approval is bound to the case version, attempt, Mastra run, suspended step, evidence digest, decision artifacts, and governance versions. HTTP workflow-resume endpoints are denied; only the worker may resume a consumed permit after revalidation. Certification mode bypasses permit creation but remains action-disabled. Production actuation, broad arbitrary tools, and silent fallback to a live model are prohibited.
