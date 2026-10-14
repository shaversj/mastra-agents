import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const entryPoint = fileURLToPath(new URL('../src/action/index.ts', import.meta.url));
const outputDirectory = fileURLToPath(new URL('../dist', import.meta.url));

await mkdir(outputDirectory, { recursive: true });
await build({
  bundle: true,
  charset: 'utf8',
  entryPoints: [entryPoint],
  format: 'esm',
  legalComments: 'none',
  logLevel: 'info',
  minify: false,
  outfile: `${outputDirectory}/index.mjs`,
  packages: 'bundle',
  platform: 'node',
  sourcemap: false,
  target: 'node22',
  tsconfig: `${appRoot}/tsconfig.json`,
});
