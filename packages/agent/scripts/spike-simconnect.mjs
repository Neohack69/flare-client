/**
 * CD-1 (Spike S2) — тонкий launcher для ручного Go/No-Go харнесса.
 *
 * Запуск (после сборки пакета):
 *   node packages/agent/scripts/spike-simconnect.mjs
 * или одной командой (сборка + запуск):
 *   pnpm --filter @flightlog/agent spike:simconnect
 *
 * Строго read-only; в CI не запускается.
 */
const distUrl = new URL('../dist/cli/spike-simconnect.js', import.meta.url);

try {
  await import(distUrl.href);
} catch (error) {
  if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
    console.error(
      '[spike] Не найден собранный харнесс. Соберите пакет: pnpm --filter @flightlog/agent build',
    );
  } else {
    console.error('[spike] Не удалось запустить CD-1 харнесс:', error);
  }
  process.exit(1);
}
