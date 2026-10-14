import { parseActionInputs } from '../src/action/inputs.js';
import { preflightAction } from '../src/action/preflight.js';

const inputs = parseActionInputs();
const result = preflightAction(inputs, {
  repositoryVisibility: 'public',
  route: 'model',
});

process.stdout.write(`Configuration valid for ${result.route} route\n`);
