import { parseActionInputs } from './inputs.js';
import { preflightAction, type RepositoryVisibility } from './preflight.js';
import { appMetadata } from '../config/app.js';

function repositoryVisibility(value: string | undefined): RepositoryVisibility {
  if (value === 'public' || value === 'private' || value === 'internal') {
    return value;
  }
  return 'unknown';
}

export function runAction(environment: NodeJS.ProcessEnv = process.env): void {
  const inputs = parseActionInputs(environment);
  const preflight = preflightAction(inputs, {
    repositoryVisibility: repositoryVisibility(environment.TRIAGE_REPOSITORY_VISIBILITY),
    route: 'model',
  });

  process.stdout.write(
    `${JSON.stringify({ appId: appMetadata.appId, route: preflight.route, status: 'ready' })}\n`,
  );
}

try {
  runAction();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Action failed'}\n`);
  process.exitCode = 1;
}
