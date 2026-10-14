import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

interface ActionManifest {
  runs?: { main?: string; using?: string };
}

describe('Action bundle contract', () => {
  it('targets the committed Node 24 entrypoint', async () => {
    const actionPath = fileURLToPath(new URL('../action.yml', import.meta.url));
    const manifest = parseYaml(await readFile(actionPath, 'utf8')) as ActionManifest;

    expect(manifest.runs).toEqual({ main: 'dist/index.mjs', using: 'node24' });
  });
});
