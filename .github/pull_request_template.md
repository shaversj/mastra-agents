## Summary

<!-- What changed, and which deployment boundary owns it? -->

## Affected applications

<!-- List the affected apps and the CI selection reason. Use "none" for documentation-only work. -->

- [ ] `researcher-agent`
- [ ] `writer-agent`
- [ ] Other / none:

## Validation proof

<!-- Record commands and results. Include focused checks for each affected app. -->

- [ ] `pnpm check:repo`
- [ ] Focused app `check`
- [ ] `pnpm check` when workspace-wide behavior changed
- [ ] App `image:smoke` when source, dependencies, runtime configuration, generated-server behavior, or Docker packaging changed

Evidence:

## Deployment and security impact

- [ ] I documented any architecture or operating-contract change.
- [ ] I reviewed environment, logs, build context, and image contents for secrets.
- [ ] I described any image, runtime, dependency, port, or ingress impact below.
- [ ] This change does not expose an unauthenticated Mastra server publicly. Any external exposure is protected by authenticated ingress.
- [ ] This pull request does not publish, release, or deploy an image unless that separate action is explicitly described and approved.

Deployment/security notes:
