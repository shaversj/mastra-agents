# Mastra triage agent

`@mastra-agents/triage-agent` is an independently deployable GitHub Action that reproduces the issue-triage lifecycle of [`withastro/triagebot-action`](https://github.com/withastro/triagebot-action/tree/51d30da13c0bd571a3822fc56882de40fead0086) with Mastra agents and typed workflows. It can classify issues, reproduce and diagnose bugs in an isolated workspace, publish a proposed fix branch, and optionally open a pull request. It never merges a pull request or writes to the default branch.

The first release supports public repositories only. Model-capable routes fail before provider or mutation work when GitHub reports `private` or `internal` visibility.

## Install by immutable revision

Pin the Action to a reviewed commit in production. The example below uses an immutable commit that contains the deployable Action runtime; update it only after reviewing a newer app artifact.

```yaml
name: Issue triage

on:
  issues:
    types: [opened, reopened, closed]
  issue_comment:
    types: [created]

permissions:
  actions: read
  contents: write
  issues: write
  pull-requests: write

concurrency:
  group: triage-${{ github.repository }}-${{ github.event.issue.number }}
  cancel-in-progress: false

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Check out the reported revision without persisted credentials
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Install the Linux sandbox
        run: sudo apt-get update && sudo apt-get install --yes bubblewrap

      - name: Run Mastra triage
        uses: shaversj/mastra-agents/apps/triage-agent@66309dfb2c0d6eabd65e542d753172e293f2edad
        with:
          read-token: ${{ github.token }}
          write-token: ${{ github.token }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          triage-skill: .agents/skills/triage
```

After the app has a reviewed major release tag, `shaversj/mastra-agents/apps/triage-agent@triage-agent-v1` is the convenience form. A tag is mutable; use a full commit SHA when supply-chain immutability matters.

## Repository preparation

Create all ten lifecycle labels before enabling the Action. Their defaults are:

- `triage: needs triage`
- `triage: not actionable`
- `triage: needs reproduction`
- `triage: skipped`
- `triage: unable to reproduce`
- `triage: unable to fix`
- `triage: failed`
- `triage: fix pending`
- `triage: fix rejected`
- `triage: fix verified`

The Action also expects a project-owned triage skill at the directory given by `triage-skill`; that directory must contain a regular, non-symlinked `SKILL.md`. Put repository-specific reproduce, test, scope, and validation instructions there. If `auto-pr-on-fix` is enabled, or maintainers will confirm proposals, configure `pr-skill` when custom PR-writing guidance is required.

Only Git-tracked files are copied into the writable model workspace. Repositories that need additional offline dependencies can prepare bounded, credential-free, symlink-free trees before this Action and list their repository-relative paths in `prepared-dependency-paths`. Those trees are copied to a read-only sandbox mount, count against the 256 MiB workspace ceiling, and are rejected if missing or escaping the checkout. The Action never installs dependencies or enables network access inside the sandbox. An optional `build-command` runs there before the model; its output becomes the baseline and is not proposed as a fix.

## Activation and retry behavior

`activation-policy: automatic-public` is the compatibility default. Supported open and reopen events start a fresh generation after deduplication and preflight, including when the reporter is not a collaborator.

`activation-policy: trusted` is the hardened option. A model route runs only when the triggering actor has `OWNER`, `MEMBER`, or `COLLABORATOR` association. On a retriable issue, a new trusted maintainer comment activates retriage. On `triage: needs triage`, a trusted maintainer comment starts a new generation and resets both the failure and model-event budgets. Ordinary comments stay in the existing generation. Each generation allows at most three failures and `max-model-events` model-invoking events, which defaults to four.

The workflow-level concurrency group prevents routine overlap. The Action also uses an action-owned per-issue Git ref as a compare-and-swap lease, checks the exact workflow run and attempt before stale takeover, and fences every external mutation. Keep both protections; consumer concurrency alone is not the correctness boundary.

## Publication credentials and branch safety

The default `publication-token-kind: github-token` uses the job's `GITHUB_TOKEN`. GitHub does not recursively start ordinary `push` and `pull_request` workflows for writes made with that token, which is the safer default for model-authored proposal branches.

Use a GitHub App token or PAT only when downstream workflow execution is intentional. Set all three inputs together:

```yaml
publication-token-kind: workflow-triggering
allow-downstream-workflows: 'true'
safe-downstream-ci: 'true'
write-token: ${{ steps.app-token.outputs.token }}
```

That declaration means every workflow that can run on `triagebot/fix-*` has been reviewed to use GitHub-hosted runners, read-only or least-privilege permissions, no privileged secrets, no environment approvals, and no unsafe execution of branch-controlled workflow code. The Action rejects a partial opt-in.

Proposal branches are limited to `triagebot/fix-<issue>`. Updates require matching action-authored provenance and use `force-with-lease` against the observed remote SHA. Existing foreign branches or pull requests are conflicts, not takeover targets. Exact admitted files are staged; `.github/workflows`, `.github/actions`, Git metadata, environment files, package-manager credential files, symlinks, binaries, and credential-like content cannot be published. Open pull-request branches are retained. Closing the issue cleans up only a proven action-owned unused branch.

## Confirmation, pull requests, and previews

By default, a verified change becomes `triage: fix pending`. The issue author or an `OWNER`, `MEMBER`, or `COLLABORATOR` may confirm or reject only the exact proposal ID and current remote SHA. A confirmation creates one action-authored pull request and moves the issue to `triage: fix verified`. `auto-pr-on-fix: true` skips the confirmation wait but preserves the same branch, SHA, actor-independent safety, and never-merge boundary.

`preview-command` is an optional changed-code inspection command. It runs after branch publication inside the same secret-free, network-disabled sandbox and must emit at most 8 KiB of strict JSON:

```json
{ "artifactId": "project-specific-artifact-id" }
```

Changed code never receives GitHub, provider, or preview credentials. The internal preview boundary accepts only allowlisted HTTPS result hosts from a separate metadata-only launcher with no checkout mount. The first Action release does not expose a network launcher input, so local inspection cannot publish a URL; missing or failed preview publication is nonfatal and the exact branch and SHA remain available for testing. `preview-allowed-hosts` reserves the approved host list for a trusted launcher integration.

## Models, data, and observability

Configure one supported provider for both model IDs:

- Anthropic: `anthropic-api-key`
- OpenAI: `openai-api-key`
- Cloudflare Workers AI: `cloudflare-api-key` and `cloudflare-account-id`, with `cloudflare-workers-ai/...` model IDs

The default models are `anthropic/claude-opus-4-6` for coding work and `anthropic/claude-sonnet-4-6` for classification. Public issue text and the credential-free repository workspace are sent to the configured model provider. Inputs, outputs, prompts, diffs, repository contents, and secrets are hidden from Mastra tracing; only bounded reason codes and stable metadata reach the job summary.

## Validation and release

Default validation is deterministic and provider-free:

```sh
pnpm --filter @mastra-agents/triage-agent --fail-if-no-match run check
pnpm --filter @mastra-agents/triage-agent --fail-if-no-match run eval:fixtures
pnpm --filter @mastra-agents/triage-agent --fail-if-no-match run artifact:smoke
```

The registered `triage-release-gate/v1` scorer checks lifecycle transitions, evidence provenance, actor and SHA binding, branch scope, idempotency, publication credentials, and the no-merge/default-write policy. Paid live experiments are separate and explicit:

```sh
LIVE_MODEL_EXPERIMENTS=true MODEL_ID=anthropic/claude-sonnet-4-6 \
  pnpm --filter @mastra-agents/triage-agent --fail-if-no-match run eval:live
```

Move `triage-agent-v1` only after the app check, fixture evals, Node 24 artifact smoke, and a clean rebuild of `dist/index.mjs` pass on the commit being tagged. Tag movement is a maintainer release action; repository CI does not publish or deploy it.

## Deliberate differences from the reference Action

- Mastra owns one coding agent, two event-scoped workflows, and one deterministic scorer under stable IDs.
- The first release is public-repository-only and adds an optional trusted-activation mode.
- GitHub comments, labels, pull requests, and action-owned Git refs are the only durable cross-run state; there is no database or Mastra memory.
- Reproduction and editing run in a credential-free, offline native sandbox with bounded tools and final diff admission.
- Preview inspection is generic rather than Astro-specific, and v1 leaves networked preview publication to a future trusted launcher.
- The default publication token is intentionally non-recursive; elevated publication requires an explicit downstream-CI safety declaration.
- Pull-request-close cleanup is not automatic in v1. Issue-close cleanup remains conservative and never deletes a branch backing an open pull request.
