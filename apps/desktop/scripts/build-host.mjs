import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const outfile = resolve(appRoot, 'out/main/agent-host.js');

mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(appRoot, 'src/agent-host/index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  sourcemap: true,
  logLevel: 'info',
  // Нативные модули остаются внешними и загружаются динамически (LGPL §«подмена»).
  external: ['electron', 'better-sqlite3', 'node-simconnect'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
});
