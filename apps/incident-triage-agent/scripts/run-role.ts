const role = process.env.PROCESS_ROLE?.trim() || 'api';
const roleModules: Record<string, string> = {
  api: './index.mjs',
  migrate: './migrations.mjs',
  worker: './app-worker.mjs',
};
const modulePath = roleModules[role];
if (!modulePath) throw new Error('PROCESS_ROLE must be api, worker, or migrate');

if (role === 'api') {
  await import(modulePath);
} else if (role === 'worker') {
  const module = (await import(modulePath)) as { runWorker(): Promise<void> };
  await module.runWorker();
} else if (role === 'migrate') {
  const module = (await import(modulePath)) as { runMigrations(): Promise<void> };
  await module.runMigrations();
}

export {};
