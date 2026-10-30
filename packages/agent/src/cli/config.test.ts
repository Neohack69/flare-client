import { describe, expect, it } from 'vitest';

import { ConfigError, loadAgentConfig } from './config.js';

const OPTIONS = { platform: 'win32', hostname: 'test-pc', homeDir: 'C:\\Users\\tester' };

describe('loadAgentConfig', () => {
  it('применяет безопасные дефолты', () => {
    const config = loadAgentConfig({}, OPTIONS);

    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.platform).toBe('win32');
    expect(config.clientName).toBe('Flare Agent @ test-pc');
    expect(config.aircraftIcao).toBeNull();
    expect(config.protocol).toBe('sunrise');
    expect(config.maxSampleHz).toBe(20);
    expect(config.loadQuarantineS).toBe(4);
    expect(config.heartbeatIntervalMs).toBe(60_000);
    expect(config.logLevel).toBe('info');
    expect(config.tokenStorePath).toContain('agent-tokens.json');
    expect(config.outboxPath).toContain('agent-outbox.sqlite');
  });

  it('читает и валидирует значения из env', () => {
    const config = loadAgentConfig(
      {
        API_URL: 'https://api.example.com/',
        TOKEN_STORE_PATH: 'C:\\tokens\\agent.json',
        AGENT_OUTBOX_PATH: 'C:\\tokens\\outbox.sqlite',
        AIRCRAFT_ICAO: 'b738',
        SIMCONNECT_PROTOCOL: 'kittyhawk',
        AGENT_MAX_SAMPLE_HZ: '20',
        AGENT_SYNC_INTERVAL_MS: '5000',
        AGENT_HEARTBEAT_INTERVAL_MS: '15000',
        AGENT_LOAD_QUARANTINE_S: '7',
        AGENT_LOG_LEVEL: 'debug',
      },
      OPTIONS,
    );

    expect(config.apiUrl).toBe('https://api.example.com');
    expect(config.tokenStorePath).toBe('C:\\tokens\\agent.json');
    expect(config.outboxPath).toBe('C:\\tokens\\outbox.sqlite');
    expect(config.aircraftIcao).toBe('B738');
    expect(config.protocol).toBe('kittyhawk');
    expect(config.maxSampleHz).toBe(20);
    expect(config.syncIntervalMs).toBe(5000);
    expect(config.heartbeatIntervalMs).toBe(15000);
    expect(config.loadQuarantineS).toBe(7);
    expect(config.logLevel).toBe('debug');
  });

  it('игнорирует пустые строки как отсутствующие значения', () => {
    const config = loadAgentConfig({ API_URL: '   ', AIRCRAFT_ICAO: '' }, OPTIONS);
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.aircraftIcao).toBeNull();
  });

  it('бросает ConfigError на некорректный API_URL', () => {
    expect(() => loadAgentConfig({ API_URL: 'not-a-url' }, OPTIONS)).toThrow(ConfigError);
    expect(() => loadAgentConfig({ API_URL: 'ftp://api.test' }, OPTIONS)).toThrow(ConfigError);
  });

  it('бросает ConfigError на некорректный AIRCRAFT_ICAO', () => {
    expect(() => loadAgentConfig({ AIRCRAFT_ICAO: 'TOOLONG' }, OPTIONS)).toThrow(ConfigError);
    expect(() => loadAgentConfig({ AIRCRAFT_ICAO: 'B-738' }, OPTIONS)).toThrow(ConfigError);
  });

  it('бросает ConfigError на числа вне диапазона', () => {
    expect(() => loadAgentConfig({ AGENT_SYNC_INTERVAL_MS: '0' }, OPTIONS)).toThrow(ConfigError);
    expect(() => loadAgentConfig({ AGENT_MAX_SAMPLE_HZ: '999' }, OPTIONS)).toThrow(ConfigError);
    expect(() => loadAgentConfig({ AGENT_RECONNECT_BASE_MS: 'abc' }, OPTIONS)).toThrow(ConfigError);
  });

  it('бросает ConfigError на неизвестный протокол', () => {
    expect(() => loadAgentConfig({ SIMCONNECT_PROTOCOL: 'fs2020' }, OPTIONS)).toThrow(ConfigError);
  });

  it('строит данные под AGENT_DATA_DIR', () => {
    const config = loadAgentConfig({ AGENT_DATA_DIR: 'D:\\flightlog' }, OPTIONS);
    expect(config.tokenStorePath).toContain('flightlog');
    expect(config.tokenStorePath).toContain('agent-tokens.json');
    expect(config.outboxPath).toContain('agent-outbox.sqlite');
  });

  it('CD-6.1: source/version из env с безопасными дефолтами', () => {
    const defaults = loadAgentConfig({}, OPTIONS);
    expect(defaults.source).toBe('agent');
    expect(defaults.version).toBeTruthy();

    const overridden = loadAgentConfig(
      { AGENT_SOURCE: 'electron', AGENT_VERSION: '0.2.0' },
      OPTIONS,
    );
    expect(overridden.source).toBe('electron');
    expect(overridden.version).toBe('0.2.0');
  });

  it('CD-6.2/CD-3.4: machine_id из env и лимиты буфера', () => {
    const config = loadAgentConfig(
      {
        FLIGHTLOG_MACHINE_ID: 'machine-abcdefghijkl',
        AGENT_BUFFER_RETENTION_DAYS: '3',
        AGENT_BUFFER_MAX_PENDING: '1000',
      },
      OPTIONS,
    );
    expect(config.machineId).toBe('machine-abcdefghijkl');
    expect(config.bufferRetentionDays).toBe(3);
    expect(config.bufferMaxPending).toBe(1000);
  });

  it('бросает ConfigError на слишком длинный origin', () => {
    expect(() => loadAgentConfig({ AGENT_SOURCE: 'x'.repeat(65) }, OPTIONS)).toThrow(ConfigError);
    expect(() => loadAgentConfig({ AGENT_VERSION: 'v'.repeat(65) }, OPTIONS)).toThrow(ConfigError);
  });
});
