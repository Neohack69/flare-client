import { resolve } from 'node:path';

import { defineConfig } from 'electron-vite';

/**
 * electron-vite: main + preload + renderer (локальные страницы клиента).
 * Сайт в окне клиента НЕ загружается (T-CLIENT2): renderer — только
 * `status.html` (окно привязки/статуса) и `about.html`.
 * Agent-host собирается отдельно в CJS скриптом `scripts/build-host.mjs`
 * (esbuild, lazy `better-sqlite3`, external native-модули) — ADR-0011 §10.2.
 */
export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      // out/main содержит agent-host.js (esbuild, scripts/build-host.mjs).
      // Не очищаем каталог, иначе dev-сборка удаляет host и агент не стартует.
      emptyOutDir: false,
      externalizeDeps: { exclude: ['@flightlog/agent', '@flightlog/contracts', '@flightlog/i18n', 'zod'] },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        // electron-updater не бандлим: тянет CJS-дерево и грузится лениво.
        external: ['electron-updater'],
        // Main берёт из `@flightlog/agent` только leaf-значения из `sim/source`
        // (`SIM_SOURCE_ENV`, `KNOWN_SIM_SOURCE_PREFERENCES`, дефолт) и логгер.
        // Barrel `@flightlog/agent` реэкспортирует side-effect-модули (реестр
        // источников, SQLite-buffer) — без этого Rollup затянул бы
        // `better-sqlite3` в процесс main. Помечаем модули агента
        // side-effect-free: остаются лишь явно импортированные функции
        // (agent-runtime живёт ТОЛЬКО в agent-host, ADR-0011 §10.2).
        treeshake: {
          moduleSideEffects: (id) =>
            !/node_modules[\\/]@flightlog[\\/]agent|packages[\\/]agent[\\/]dist/.test(id),
        },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      externalizeDeps: { exclude: ['@flightlog/contracts', 'zod'] },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          status: resolve(__dirname, 'src/renderer/status.html'),
          about: resolve(__dirname, 'src/renderer/about.html'),
        },
      },
    },
  },
});
