# @flightlog/agent

Тонкий **read-only** модуль SimConnect для MSFS 2024: детект рейса/посадки,
локальный durable-буфер телеметрии (T8/T9), офлайн-синхронизация через device
flow (T10) и runnable CLI-сервис (T83).

## Запуск агента (CLI)

### Что нужно

- **Node.js >= 20.17** (требование `node-simconnect`; политика репозитория — Node 20).
- Запущенный **Microsoft Flight Simulator 2024** (иначе агент не упадёт — будет
  периодически ретраить подключение).
- Запущенный API (`API_URL`) хотя бы один раз для первичной авторизации устройства.
- Собранные зависимости монорепо: `pnpm install && pnpm build` (или
  `pnpm --filter @flightlog/agent... build`).

### Команды

```bash
pnpm --filter @flightlog/agent build      # tsc → dist/
pnpm --filter @flightlog/agent start      # node dist/main.js
# алиас:
pnpm --filter @flightlog/agent agent:run

# Ручной/диагностический синк outbox (без подключения к симу):
pnpm --filter @flightlog/agent sync       # алиас: flush
```

После `pnpm build` доступны bin'ы: `flightlog-agent` и `flightlog-agent-sync`.

### Ручной синк (`sync`/`flush`)

```bash
pnpm --filter @flightlog/agent sync
```

Одноразово выгружает **все** pending-рейсы из SQLite-outbox
(upsert flight → батчи track/events → `/complete`) и выходит с JSON-статусом:
сколько синхронизировано и сколько осталось. Симулятор не требуется.

```json
{"status":"ok","synced":{"flights":1,"points":3432,"events":19},
 "remaining":{"flights":0,"points":0,"events":0}}
```

`status:"pending"` (ненулевой код возврата) означает, что что-то осталось —
обычно нет сети/API или истёк device-токен. Команда удобна, чтобы «добить»
зависшие после аварийного завершения рейсы, не запуская запись.



После `pnpm build` доступен и bin: `flightlog-agent`.

### Переменные окружения

| Переменная                | Дефолт                                   | Назначение                                                        |
| ------------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| `API_URL`                 | `http://localhost:3000`                  | Базовый URL API (`/v1/...`).                                      |
| `TOKEN_STORE_PATH`        | `~/.flightlog/agent-tokens.json`         | Файл device-токенов (0600, атомарная запись).                     |
| `AGENT_DATA_DIR`          | `~/.flightlog`                           | Каталог данных по умолчанию (токены + outbox).                    |
| `AGENT_OUTBOX_PATH`       | `<AGENT_DATA_DIR>/agent-outbox.sqlite`   | Durable-буфер SQLite (outbox).                                    |
| `AIRCRAFT_ICAO`           | —                                        | Fallback-тип ВС, если `ATC MODEL/TYPE` пуст (напр. `B738`).       |
| `SIMCONNECT_PROTOCOL`     | `sunrise`                                | `sunrise` (MSFS 2024) \| `kittyhawk` \| `fsx_sp2`.                |
| `AGENT_MAX_SAMPLE_HZ`     | `10`                                     | Верхний предел частоты исходящих сэмплов.                         |
| `AGENT_SYNC_INTERVAL_MS`  | `30000`                                  | Период фоновой синхронизации outbox → API.                        |
| `AGENT_CONNECT_POLL_MS`   | `1000`                                   | Период проверки живого соединения с симом.                        |
| `AGENT_RECONNECT_BASE_MS` | `5000`                                   | Базовый backoff реконнекта/ретрая авторизации.                    |
| `AGENT_RECONNECT_MAX_MS`  | `60000`                                  | Cap backoff.                                                      |
| `AGENT_SHUTDOWN_FLUSH_MS` | `15000`                                  | Таймаут финального синка при shutdown (`0` — не ждать).           |
| `AGENT_CLIENT_NAME`       | `Flare Agent @ <hostname>`               | Имя устройства в device flow.                                 |
| `AGENT_LOG_LEVEL`         | `info`                                   | `debug` \| `info` \| `warn` \| `error` \| `silent`.              |

Неизвестное/некорректное значение (URL, ICAO, протокол, число) → агент завершается
с кодом `2` и понятной ошибкой в логе.

### Что происходит по шагам

1. **Конфиг** читается из env; открывается SQLite-outbox.
2. **Device flow** (если нет сохранённого токена): агент печатает
   `verification_uri` и `user_code`, открывает в браузере страницу и опрашивает
   `POST /v1/auth/device/token`. После подтверждения токены сохраняются локально.
   Если API недоступен — ретраит с backoff, не падает.
3. **Подключение к симу** через `node-simconnect` (protocol `SunRise`), **строго
   read-only**: только `addToDataDefinition` + `requestDataOnSimObject`. Если сим
   не запущен — понятный лог `simulator not available ... will retry` и ретрай.
4. **Стартовый синк**: сразу после авторизации (но **до/независимо** от
   подключения к симу) выгружается весь накопленный outbox — лог
   `sync completed {"reason":"startup",...}`. Даже если MSFS не запущен, зависшие
   после предыдущей сессии рейсы догружаются.
5. **Периодический синк**: интервал (`AGENT_SYNC_INTERVAL_MS`) работает всегда и
   не зависит от наличия активного рейса/сима — лог
   `sync completed {"reason":"interval",...}`. Если предыдущий flush ещё идёт,
   запросы не теряются, а коалесцируются в один отложенный прогон.
6. **Запись рейса**: детект старта (двигатель/скорость), фазы, адаптивный
   сэмплинг 1 Гц / 10 Гц в окне касания, touchdown/bounce → SQLite-outbox.
   По завершении — лог `flight_completed`.
7. **Синк**: батчи `POST /v1/flights`, `.../track/batch`, `.../events/batch`,
   затем `/complete`. Идемпотентно по
   `client_flight_id`/`client_point_id`/`client_event_id`. Ретраи HTTP ограничены
   (`maxAttempts`), чтобы один flush не «залипал»; дозаливка гарантируется
   следующим (interval/manual/shutdown) прогоном.
8. **Shutdown** (`Ctrl+C` / `SIGTERM`): рейс финализируется (`agent_stop`),
   выполняется финальный синк (с таймаутом), outbox закрывается.

## Библиотека SimConnect

Выбрана **`node-simconnect` 4.2.0**:

- официально поддерживает **MSFS 2024** (protocol `SunRise`, а также `KittyHawk`);
- реализация протокола SimConnect на чистом TypeScript (TCP / Windows named pipes),
  без нативных биндингов и без установки MSFS SDK — работает и в Node, и в Electron;
- требования `engines` — Node `>=20.17.0`, что совпадает с политикой репозитория (Node 20);
- альтернатива `msfs-simconnect` в npm отсутствует; C++/C# SDK-обёртки не вписываются
  в TS-монорепо.

`node-simconnect` импортируется **лениво** (`await import(...)` внутри `connect()`),
чтобы импорт пакета не тянул Windows-реестр и не мешал unit-тестам на моках.

## Жёсткие ограничения безопасности

- Только чтение SimVars (`addToDataDefinition` + `requestDataOnSimObject`).
- **Никаких** write-операций, pause/unpause или изменения состояния сима.
- Если нет уверенности, что подключение безопасно для активного полёта — работаем на
  `MockSimConnectAdapter`.
- Логи не содержат секретов: токены/пароли/`Authorization` вырезаются
  (`redactRecord`); `user_code` печатается намеренно (его пользователь вводит вручную).

## Модули

| Модуль                        | Назначение                                                                |
| ----------------------------- | ------------------------------------------------------------------------- |
| `sim/node-simconnect-adapter` | реальный read-only адаптер + `parseSample`, `SIMVAR_DEFINITION`           |
| `sim/mock-adapter`            | детерминированный mock для тестов                                         |
| `flight/phases`               | state machine `on_ground → taxi → takeoff → airborne → landing`           |
| `flight/touchdown`            | детект касания/отскока, метрики `LandingMetrics`, предпросмотр балла     |
| `flight/adaptive-sampler`     | 1 Гц круиз / 10 Гц окно `touchdown ± 30 c`, rolling-буфер 60 c (ADR-0003) |
| `flight/build`                | `TelemetrySample → TrackPoint/FlightEvent` со строгой валидацией          |
| `flight/recorder`             | оркестратор записи рейса (T8/T9)                                          |
| `buffer/sqlite-buffer`        | durable outbox на `better-sqlite3` (ADR-0007)                             |
| `sync/device-auth`            | OAuth device flow: `code` → поллинг `token` → `refresh` (T10)             |
| `sync/uploader`               | батчевая идемпотентная загрузка outbox → API (T10)                        |
| `sync/outbox-syncer`          | сериализация/коалесинг flush'ей, `sync completed {reason}`, счётчики      |
| `cli/config`                  | env → типизированный `AgentConfig`                                        |
| `cli/logger`                  | консольный logger с редактированием секретов                              |
| `cli/runtime`                 | жизненный цикл агента: авторизация, реконнект, flush, shutdown (T83)      |
| `cli/manual-sync`             | одноразовый синк outbox (без сима) для CLI `sync`/`flush`                 |
| `cli/sync`                    | entrypoint ручного синка (`pnpm --filter @flightlog/agent sync`)          |
| `main`                        | runnable entrypoint (`pnpm --filter @flightlog/agent start`)             |

`host/bootstrap.bootstrapOutboxSync` собирает только синк-стек (SQLite-буфер,
токены, uploader, syncer) — им пользуется CLI `sync`, поэтому ручная выгрузка
идёт ровно по тому же пути, что и фоновая.

## Проверка буфера и синка

Локальный outbox — SQLite-файл `AGENT_OUTBOX_PATH`. Быстрая сводка:

```bash
pnpm --filter @flightlog/agent buffer:stats
```

Скрипт read-only и печатает счётчики `outbox_flights/points/events`, число
незалитых строк (`synced_at IS NULL`) и последние 10 рейсов. Любым sqlite-клиентом
можно выполнить, например:

```sql
SELECT client_flight_id, status, ended_at, synced_at FROM outbox_flights;
SELECT COUNT(*) FROM outbox_points WHERE synced_at IS NULL;   -- незалитые точки
```

`pending_points > 0` после рейса означает, что данные ещё не ушли на API (нет сети/
авторизации) — они не потеряются и будут дозалиты следующим flush'ем (при
следующем запуске агента, по таймеру или вручную через `sync`).

## Тесты и проверки

```bash
pnpm --filter @flightlog/agent test
pnpm --filter @flightlog/agent typecheck
pnpm --filter @flightlog/agent lint
```

Тесты используют только моки (`MockSimConnectAdapter`, `:memory:`/temp SQLite,
управляемый `sleep`) и **не требуют запущенного симулятора**. CLI-логика
(`cli/config`, `cli/logger`, `cli/runtime`) покрыта тестами с моками recorder/
adapter/uploader/auth.

## Live smoke (read-only)

После `pnpm --filter @flightlog/agent build`:

```bash
pnpm --filter @flightlog/agent live-smoke
```

Скрипт читает несколько кадров SimVars и завершается; никаких write-операций.
Требует запущенного MSFS 2024 с доступным SimConnect-эндпоинтом (named pipe или порт).
