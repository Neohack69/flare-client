import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  XPlaneNonLoopbackError,
  isLoopbackHost,
  parseLoopbackUrl,
  toXPlaneWebSocketUrl,
} from './config.js';
import { isAllowedXPlaneDataref } from './datarefs.js';
import { XPlaneRestClient } from './http.js';
import { createXPlaneSimSource } from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_FILES = readdirSync(HERE).filter(
  (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
);

/**
 * Структурный read-only (ADR-0023 §2.4, AppSec §1.3/§5.2): в модуле нет ни одной
 * write-конструкции транспорта. Проверяется по исходникам, а не по дисциплине.
 *
 * Refinement: ADR перечисляет подстроку `/flight`; dataref'ы X-Plane
 * (`sim/flightmodel/...`) дают ложное срабатывание, поэтому запрещаем именно
 * write-эндпоинт `POST/PATCH /flight` (`/flight` не перед `model`).
 */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['write verb PATCH', /\bPATCH\b/],
  ['write verb POST', /\bPOST\b/],
  ['ws dataref_set_values', /dataref_set_values/],
  ['ws command_set_is_active', /command_set_is_active/],
  ['command endpoint', /\/command\//],
  ['flight endpoint', /\/flight(?![a-z0-9])/],
  ['udp DREF', /\bDREF\b/],
  ['udp CMND', /\bCMND\b/],
  ['udp SHUT', /\bSHUT\b/],
  ['udp QUIT', /\bQUIT\b/],
  ['udp PREL', /\bPREL\b/],
  ['udp FAIL', /\bFAIL\b/],
  ['udp RESE', /\bRESE\b/],
];

describe('structural read-only guard (xplane module source)', () => {
  it('модуль содержит исходники (sanity)', () => {
    expect(MODULE_FILES.length).toBeGreaterThan(5);
  });

  it('нет ни одной запрещённой write-конструкции', () => {
    for (const file of MODULE_FILES) {
      const source = readFileSync(join(HERE, file), 'utf8');
      for (const [label, pattern] of FORBIDDEN) {
        expect(pattern.test(source), `${file}: forbidden '${label}'`).toBe(false);
      }
    }
  });

  it('HTTP-клиент не задаёт HTTP-метод (только GET по умолчанию)', () => {
    const source = readFileSync(join(HERE, 'http.ts'), 'utf8');
    expect(source).not.toMatch(/\bmethod\s*:/);
  });

  it('HTTP-клиент не экспонирует generic request/send (только read-методы)', () => {
    const client = new XPlaneRestClient({ baseUrl: 'http://127.0.0.1:8086' });
    const methods = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(client)));
    for (const name of ['request', 'fetch', 'send', 'post', 'patch', 'put']) {
      expect(methods.has(name), `unexpected method '${name}'`).toBe(false);
    }
    for (const name of ['getCapabilities', 'findDataref', 'getDatarefValue']) {
      expect(methods.has(name)).toBe(true);
    }
  });

  it('messages.ts конструирует только subscribe/unsubscribe типы', () => {
    const source = readFileSync(join(HERE, 'messages.ts'), 'utf8');
    const literals = [...source.matchAll(/type:\s*'([^']+)'/g)].map((match) => match[1]);
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(['dataref_subscribe_values', 'dataref_unsubscribe_values']).toContain(literal);
    }
  });

  it('dataref-имена берутся только из allow-list таблицы', () => {
    expect(isAllowedXPlaneDataref('sim/network/peers')).toBe(false);
    expect(isAllowedXPlaneDataref('sim/aircraft/view/acf_livery')).toBe(false);
    expect(isAllowedXPlaneDataref('sim/aircraft/view/acf_tailnum')).toBe(false);
  });
});

describe('loopback-only guardrails', () => {
  it('isLoopbackHost: только 127.0.0.1 / ::1 / localhost', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });

  it('parseLoopbackUrl: не-loopback / неверная схема → отказ старта', () => {
    expect(() => parseLoopbackUrl('http://192.168.1.10:8086', ['http:'])).toThrow(
      XPlaneNonLoopbackError,
    );
    expect(() => parseLoopbackUrl('http://example.com:8086', ['http:'])).toThrow(
      XPlaneNonLoopbackError,
    );
    expect(() => parseLoopbackUrl('http://0.0.0.0:8086', ['http:'])).toThrow(
      XPlaneNonLoopbackError,
    );
    expect(() => parseLoopbackUrl('ftp://127.0.0.1:8086', ['http:'])).toThrow(
      XPlaneNonLoopbackError,
    );
    expect(parseLoopbackUrl('http://127.0.0.1:8086', ['http:']).hostname).toBe('127.0.0.1');
    expect(parseLoopbackUrl('http://localhost:8086', ['http:']).hostname).toBe('localhost');
  });

  it('toXPlaneWebSocketUrl: http → ws, путь /api/v3', () => {
    expect(toXPlaneWebSocketUrl('http://127.0.0.1:8086')).toBe('ws://127.0.0.1:8086/api/v3');
    expect(toXPlaneWebSocketUrl('http://localhost:8086/')).toBe('ws://localhost:8086/api/v3');
    expect(() => toXPlaneWebSocketUrl('http://10.0.0.2:8086')).toThrow(XPlaneNonLoopbackError);
  });

  it('XPlaneRestClient и фабрика источника отказывают на не-loopback URL', () => {
    expect(() => new XPlaneRestClient({ baseUrl: 'http://10.0.0.5:8086' })).toThrow(
      XPlaneNonLoopbackError,
    );
    expect(() =>
      createXPlaneSimSource({}, { AGENT_XP_WEB_URL: 'http://10.0.0.5:8086' }),
    ).toThrow(XPlaneNonLoopbackError);
  });

  it('фабрика источника собирается на дефолтах (loopback) без сети', () => {
    const source = createXPlaneSimSource({}, {});
    expect(source.id).toBe('xplane12');
    expect(source.readOnly).toBe(true);
    expect(source.connected).toBe(false);
    expect(source.capabilities).toMatchObject({ sim: 'xplane12', pauseDetection: 'direct' });
    // D1: окно касания пишется 20 Гц — транспорт не должен капить на 10.
    expect(source.capabilities.maxSampleHz).toBe(20);
  });
});
