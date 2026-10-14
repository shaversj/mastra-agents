import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const fixtureRoot = await mkdtemp(join(tmpdir(), 'triage-action-smoke-'));

try {
  const sourceBundle = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
  const fixtureBundleDirectory = join(fixtureRoot, 'dist');
  const fixtureBundle = join(fixtureBundleDirectory, 'index.mjs');
  await mkdir(fixtureBundleDirectory, { recursive: true });
  await copyFile(sourceBundle, fixtureBundle);

  const { stderr, stdout } = await execFileAsync(process.execPath, [fixtureBundle], {
    cwd: fixtureRoot,
    env: {
      INPUT_ANTHROPIC_API_KEY: 'fixture-provider-token',
      INPUT_READ_TOKEN: 'fixture-read-token',
      INPUT_TRIAGE_SKILL: '.agents/skills/triage',
      INPUT_WRITE_TOKEN: 'fixture-write-token',
      TRIAGE_REPOSITORY_VISIBILITY: 'public',
    },
  });

  if (stderr) {
    throw new Error(`Action wrote to stderr: ${stderr}`);
  }
  const result = JSON.parse(stdout) as Record<string, unknown>;
  if (result.status !== 'ready' || result.appId !== 'triage-agent') {
    throw new Error('Action bundle did not reach the expected fixture outcome');
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
