import { describe, expect, it } from 'vitest';

import { registerSchema } from './auth.js';
import { meUpdateSchema } from './me.js';
import { displayNameSchema } from './primitives.js';

describe('displayNameSchema (ADR-0020 §2.1 / IDN-07)', () => {
  it('сворачивает пробелы и trim', () => {
    expect(displayNameSchema.parse('  Ace   Pilot  ')).toBe('Ace Pilot');
    expect(displayNameSchema.parse('Neo\t\nHack')).toBe('Neo Hack');
  });

  it('отклоняет пустое после trim / только пробелы', () => {
    expect(displayNameSchema.safeParse('').success).toBe(false);
    expect(displayNameSchema.safeParse('   ').success).toBe(false);
    expect(displayNameSchema.safeParse('\t\n').success).toBe(false);
  });

  it('max 64 символа после нормализации', () => {
    expect(displayNameSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(displayNameSchema.safeParse('a'.repeat(65)).success).toBe(false);
    expect(displayNameSchema.parse(`  ${'b'.repeat(64)}  `)).toBe('b'.repeat(64));
  });

  it('отклоняет control characters (\\p{Cc})', () => {
    expect(displayNameSchema.safeParse('Ace\u0000Pilot').success).toBe(false);
    expect(displayNameSchema.safeParse('Ace\u0007Pilot').success).toBe(false);
    expect(displayNameSchema.safeParse('Ace\u001FPilot').success).toBe(false);
  });

  it('отклоняет bidi overrides / isolates', () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE
    expect(displayNameSchema.safeParse('Ace\u202EPilot').success).toBe(false);
    // U+202A LEFT-TO-RIGHT EMBEDDING
    expect(displayNameSchema.safeParse('\u202AAdmin').success).toBe(false);
    // U+2066 LEFT-TO-RIGHT ISOLATE … U+2069 POP DIRECTIONAL ISOLATE
    expect(displayNameSchema.safeParse('Ace\u2066Pilot\u2069').success).toBe(false);
  });

  it('принимает Unicode-буквы, пробел, пунктуацию и эмодзи (вкл. ZWJ)', () => {
    expect(displayNameSchema.parse('Игорь Левин')).toBe('Игорь Левин');
    expect(displayNameSchema.parse("O'Neill")).toBe("O'Neill");
    expect(displayNameSchema.parse('Ace-01_v2.')).toBe('Ace-01_v2.');
    // семейство эмодзи через ZWJ — не запрещаем U+200D
    expect(displayNameSchema.parse('Pilot\u200D✈️')).toBe('Pilot\u200D✈️');
  });
});

describe('displayNameSchema wired into register + meUpdate', () => {
  it('registerSchema нормализует и режет bidi', () => {
    const ok = registerSchema.parse({
      email: 'pilot@example.com',
      password: 'longenough',
      display_name: '  Ace   Pilot  ',
      handle: 'acepilot',
    });
    expect(ok.display_name).toBe('Ace Pilot');
    expect(
      registerSchema.safeParse({
        email: 'pilot@example.com',
        password: 'longenough',
        display_name: 'Ace\u202EPilot',
        handle: 'acepilot',
      }).success,
    ).toBe(false);
  });

  it('meUpdateSchema нормализует и режет control', () => {
    expect(meUpdateSchema.parse({ display_name: '  Neo\tHack  ' }).display_name).toBe('Neo Hack');
    expect(meUpdateSchema.safeParse({ display_name: 'Ace\u0000' }).success).toBe(false);
    expect(meUpdateSchema.safeParse({ display_name: '   ' }).success).toBe(false);
  });
});
