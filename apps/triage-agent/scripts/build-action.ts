import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const entryPoint = fileURLToPath(new URL('../src/action/index.ts', import.meta.url));
const outputDirectory = fileURLToPath(new URL('../dist', import.meta.url));
const outputFile = `${outputDirectory}/index.mjs`;

await mkdir(outputDirectory, { recursive: true });
await build({
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  bundle: true,
  charset: 'utf8',
  entryPoints: [entryPoint],
  format: 'esm',
  legalComments: 'none',
  logLevel: 'info',
  minify: false,
  outfile: outputFile,
  packages: 'bundle',
  platform: 'node',
  sourcemap: false,
  target: 'node22',
  tsconfig: `${appRoot}/tsconfig.json`,
});

const bundled = await readFile(outputFile, 'utf8');
await writeFile(outputFile, bundled.replace(/[\t ]+$/gmu, ''), 'utf8');
