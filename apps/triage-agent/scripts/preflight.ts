import { parseActionInputs } from '../src/action/inputs.js';
import { preflightAction } from '../src/action/preflight.js';

const inputs = parseActionInputs();
const route = 'model';
preflightAction(inputs, {
  repositoryVisibility: 'public',
  route,
});

process.stdout.write(`Configuration valid for ${route} route\n`);
