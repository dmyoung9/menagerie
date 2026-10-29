import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'menagerie-browser-'));
const env = Object.fromEntries(
  ['PATH', 'LANG', 'LC_ALL', 'TZ'].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
for (const [key, name] of Object.entries({
  HOME: 'home',
  XDG_CONFIG_HOME: 'config',
  XDG_DATA_HOME: 'data',
  XDG_STATE_HOME: 'state',
  XDG_CACHE_HOME: 'cache',
  TMPDIR: 'tmp',
})) {
  env[key] = join(root, name);
  mkdirSync(env[key]);
}
env.MENAGERIE_FIXTURE_ENV_DIR = root;
const server = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    '--host',
    '127.0.0.1',
    '--port',
    '8049',
    '--strictPort',
    '--mode',
    'fixture',
  ],
  { env, stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.kill(signal));
server.on('error', () => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = 1;
});
server.on('exit', (code) => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = code ?? 1;
});
