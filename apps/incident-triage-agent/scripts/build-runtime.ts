import { build } from 'esbuild';

await build({
  entryPoints: {
    'app-worker': 'src/worker/main.ts',
    migrations: 'scripts/run-migrations.ts',
    role: 'scripts/run-role.ts',
  },
  bundle: true,
  format: 'esm',
  outdir: '.mastra/output',
  outExtension: { '.js': '.mjs' },
  packages: 'external',
  platform: 'node',
  sourcemap: true,
  target: 'node22',
});
