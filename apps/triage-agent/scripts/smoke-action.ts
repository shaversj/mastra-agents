import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const fixtureRoot = await mkdtemp(join(tmpdir(), 'triage-action-smoke-'));

try {
  if (Number(process.versions.node.split('.')[0]) !== 24) {
    throw new Error('Action smoke test requires Node 24');
  }
  const applicationRoot = fileURLToPath(new URL('..', import.meta.url));
  const fixtureBundleDirectory = join(fixtureRoot, 'dist');
  const fixtureEventDirectory = join(fixtureRoot, 'event');
  await mkdir(fixtureBundleDirectory, { recursive: true });
  await mkdir(fixtureEventDirectory, { recursive: true });
  await Promise.all([
    copyFile(join(applicationRoot, 'action.yml'), join(fixtureRoot, 'action.yml')),
    copyFile(join(applicationRoot, 'dist/index.mjs'), join(fixtureBundleDirectory, 'index.mjs')),
    copyFile(
      join(applicationRoot, 'tests/fixtures/action/event.json'),
      join(fixtureEventDirectory, 'event.json'),
    ),
    copyFile(
      join(applicationRoot, 'tests/fixtures/action/fake-transport.json'),
      join(fixtureRoot, 'fake-transport.json'),
    ),
  ]);

  const { stderr, stdout } = await execFileAsync(process.execPath, [join('dist', 'index.mjs')], {
    cwd: fixtureRoot,
    env: {
      GITHUB_DELIVERY: 'smoke-delivery',
      GITHUB_EVENT_NAME: 'issues',
      GITHUB_EVENT_PATH: join(fixtureRoot, 'event', 'event.json'),
      GITHUB_REPOSITORY: 'example/widgets',
      GITHUB_RUN_ID: '100',
      GITHUB_SERVER_URL: 'https://github.com',
      PATH: process.env.PATH,
      TRIAGE_ACTION_FAKE_TRANSPORT: join(fixtureRoot, 'fake-transport.json'),
    },
  });

  if (stderr) throw new Error(`Action wrote to stderr: ${stderr}`);
  const result = JSON.parse(stdout) as Record<string, unknown>;
  if (
    result.status !== 'noop' ||
    result.reasonCode !== 'duplicate_event' ||
    result.appId !== 'triage-agent'
  ) {
    throw new Error('Action bundle did not reach the expected fake-GitHub outcome');
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
