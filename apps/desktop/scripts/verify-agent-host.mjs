// ---------------------------------------------------------------------------
// verify-agent-host.mjs — end-to-end проверка dev-запуска клиента:
//   1) agent-host стартует под Electron БЕЗ fatal, реально грузит
//      `better-sqlite3` (SQLite-буфер, не in-memory), получает device-code и
//      показывает его в окне «Состояние агента» (скриншот);
//   2) после авторизации агент читает сим через `node-simconnect`: либо
//      «connected to simulator», либо честное «simulator not available» —
//      в обоих случаях БЕЗ ошибки резолва модуля.
//
// Локальный stub API отвечает на device-flow:
//   POST /v1/auth/device/code  → код
//   POST /v1/auth/device/token → 428 AUTHORIZATION_PENDING, пока `authorizeNow`,
//                                затем 200 с токенами
//
// Запуск: `pnpm --filter @flightlog/desktop verify:agent`.
// Требует собранный `out/` (pnpm --filter @flightlog/desktop build).
// ---------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';
import { _electron as electron } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const outDir = join(appRoot, 'out');
const shotDir = process.env.VERIFY_AGENT_OUT ?? resolve(appRoot, '../../docs/design/assets/desktop');
const shotPath = join(shotDir, 'agent-host-device-flow.png');
const userData = mkdtempSync(join(tmpdir(), 'flightlog-verify-agent-'));

if (!existsSync(join(outDir, 'main', 'agent-host.js'))) {
  console.error('[verify-agent] нет out/main/agent-host.js — сначала выполните build');
  process.exit(1);
}

// --- stub device-auth API ---------------------------------------------------
const deviceCode = {
  device_code: 'stub-device-code',
  user_code: 'WXYZ-1234',
  // same origin, что FLIGHTLOG_WEB_URL — чтобы device-flow предложил in-app approve
  verification_uri: 'http://127.0.0.1:9/device',
  interval: 1,
  expires_in: 600,
};

const tokens = {
  access_token: 'stub-access-token',
  device_token: 'stub-device-token',
  device_id: '11111111-1111-4111-8111-111111111111',
  expires_in: 3600,
};

// Переключается тестом: пока false — token endpoint держит AUTHORIZATION_PENDING,
// чтобы device-code успел отрисоваться и попасть на скриншот.
let authorizeNow = false;

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = (() => {
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return {};
      }
    })();
    if (req.method === 'POST' && req.url === '/v1/auth/device/code') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: deviceCode }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/auth/device/token') {
      if (!authorizeNow) {
        res.writeHead(428, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'AUTHORIZATION_PENDING' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: tokens }));
      return;
    }
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'STUB_UNAVAILABLE', request: body?.device_code ?? null }));
  });
});

await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
const port = server.address().port;
const apiUrl = `http://127.0.0.1:${port}`;

const failures = [];
const mainLogs = [];

const app = await electron.launch({
  executablePath: electronPath,
  // Свой userData: изолирует single-instance lock и safeStorage от других запусков.
  args: [appRoot, `--user-data-dir=${userData}`],
  cwd: appRoot,
  timeout: 90_000,
  env: {
    ...process.env,
    FLIGHTLOG_API_URL: apiUrl,
    FLIGHTLOG_WEB_URL: 'http://127.0.0.1:9',
    FLIGHTLOG_AGENT_AUTOSTART: '1',
    FLIGHTLOG_ALLOW_FILE_TOKEN_STORE: '1',
    FLIGHTLOG_DATA_DIR: userData,
    // ВАЖНО: FLIGHTLOG_AGENT_MEMORY_BUFFER не задаём — агент обязан поднять
    // реальный better-sqlite3-буфер, иначе тест бессмысленен.
  },
});

app.process().stdout?.on('data', (chunk) => mainLogs.push(chunk.toString('utf8')));
app.process().stderr?.on('data', (chunk) => mainLogs.push(chunk.toString('utf8')));

try {
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(3_000);

  // Ждём device-code от реального device-flow (api → agent-host → main).
  let deviceState = null;
  for (let i = 0; i < 40; i += 1) {
    deviceState = await app.evaluate(() => globalThis.__flightlogDeviceState?.() ?? null);
    if (deviceState?.pending && deviceState?.userCode) break;
    await page.waitForTimeout(500);
  }

  const diagnostics = await app.evaluate(() => ({
    agentRunning: globalThis.__flightlogAgentRunning === true,
    statusCount: globalThis.__flightlogStatusCount ?? 0,
    device: globalThis.__flightlogDeviceState?.() ?? null,
  }));

  if (!deviceState?.pending || deviceState.userCode !== deviceCode.user_code) {
    failures.push(`device-code не получен (state=${JSON.stringify(deviceState)})`);
  }
  if (!diagnostics.agentRunning) failures.push('агент не запущен');

  // Реальный SQLite-буфер: файл outbox создаётся только если better-sqlite3
  // успешно загрузился в Electron (иначе был бы fatal Cannot find module / ABI).
  const agentDir = join(userData, 'agent');
  const outboxFiles = existsSync(agentDir)
    ? readdirSync(agentDir).filter((name) => name.startsWith('agent-outbox.sqlite'))
    : [];
  if (outboxFiles.length === 0) {
    failures.push('SQLite-outbox не создан — better-sqlite3 не загрузился');
  }

  let logs = mainLogs.join('');
  if (/agent-host fatal/.test(logs)) failures.push('agent-host сообщил fatal');
  if (/Cannot find module 'better-sqlite3'/.test(logs)) failures.push('Cannot find module better-sqlite3');
  if (/NODE_MODULE_VERSION|was compiled against a different/.test(logs)) {
    failures.push('несовпадение ABI нативного модуля');
  }

  // Скриншот окна «Состояние агента» с кодом подтверждения (пока pending).
  await app.evaluate(() => globalThis.__flightlogOpenStatus?.());
  await page.waitForTimeout(600);
  const statusPage = app.windows().find((candidate) => candidate.url().includes('status.html'));
  if (statusPage) {
    await statusPage.waitForLoadState('domcontentloaded').catch(() => undefined);
    await statusPage.waitForTimeout(400);
    mkdirSync(shotDir, { recursive: true });
    await statusPage.screenshot({ path: shotPath });
  } else {
    failures.push('окно статуса не найдено');
  }

  // --- Фаза 2: авторизация → чтение сима через node-simconnect -------------
  authorizeNow = true;

  // Допустимы оба честных исхода: сим найден («connected to simulator») либо
  // не запущен («simulator not available») — в обоих случаях `node-simconnect`
  // загрузился. Отдельно ловим именно ошибку резолва модуля.
  let simReached = false;
  for (let i = 0; i < 60; i += 1) {
    logs = mainLogs.join('');
    if (/connected to simulator \(read-only\)|simulator not available/.test(logs)) {
      simReached = true;
      break;
    }
    if (/Cannot find (package|module) 'node-simconnect'/.test(logs)) break;
    await page.waitForTimeout(500);
  }

  if (!simReached) {
    failures.push('агент не дошёл до чтения сима (ни connected, ни simulator not available)');
  }
  if (/Cannot find (package|module) 'node-simconnect'/.test(logs)) {
    failures.push('node-simconnect не резолвится из agent-host');
  }
  const simConnected = /connected to simulator \(read-only\)/.test(logs);
  const deviceAfterAuth = await app.evaluate(
    () => globalThis.__flightlogDeviceState?.() ?? null,
  );
  if (deviceAfterAuth?.pending) {
    failures.push('device-flow не завершился после авторизации');
  }

  const summary = {
    ok: failures.length === 0,
    apiUrl,
    dataDir: userData,
    diagnostics,
    outboxFiles,
    simConnected,
    screenshot: statusPage ? shotPath : null,
    failures,
    mainLogs: failures.length > 0 || process.env.VERIFY_AGENT_VERBOSE === '1' ? logs : undefined,
  };
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  failures.push(`verify crashed: ${error instanceof Error ? error.message : String(error)}`);
  console.log(
    JSON.stringify(
      { ok: false, failures, mainLogs: mainLogs.join('').slice(0, 8_000) },
      null,
      2,
    ),
  );
} finally {
  await app.close().catch(() => undefined);
  await new Promise((resolveClose) => server.close(resolveClose));
}

process.exitCode = failures.length === 0 ? 0 : 1;
