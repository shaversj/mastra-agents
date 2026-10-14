import { dirname } from 'node:path';

export const trustedExecutableDirectories = [
  ...new Set([dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin']),
];
const fixedExecutablePath = trustedExecutableDirectories.join(':');

const prohibitedGitEnvironment = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_ASKPASS',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_DIR',
  'GIT_EXEC_PATH',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_WORK_TREE',
] as const;

export const trustedExecutablePath = fixedExecutablePath;

export function assertSafeGitEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (
    Object.keys(environment).some(
      (name) =>
        prohibitedGitEnvironment.includes(name as (typeof prohibitedGitEnvironment)[number]) ||
        /^GIT_CONFIG_(?:KEY|VALUE)_/u.test(name),
    )
  ) {
    throw new Error('UNSAFE_GIT_ENVIRONMENT');
  }
}

export function secureGitEnvironment(): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    HOME: '/nonexistent',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: fixedExecutablePath,
  };
}
