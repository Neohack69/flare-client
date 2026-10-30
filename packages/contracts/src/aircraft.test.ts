import { describe, expect, it } from 'vitest';

import { AIRCRAFT_ICAO_ALIASES, canonicalAircraftIcao } from './aircraft.js';

describe('canonicalAircraftIcao (ICAO Doc 8643)', () => {
  it('B77F → B77L (внутренний код SimBrief, не ICAO)', () => {
    expect(AIRCRAFT_ICAO_ALIASES['B77F']).toBe('B77L');
    expect(canonicalAircraftIcao('B77F')).toBe('B77L');
    expect(canonicalAircraftIcao('b77f')).toBe('B77L');
    expect(canonicalAircraftIcao('  B77f  ')).toBe('B77L');
  });

  it('канонические/неизвестные коды не меняет (trim + upper)', () => {
    expect(canonicalAircraftIcao('B77L')).toBe('B77L');
    expect(canonicalAircraftIcao('b738')).toBe('B738');
    expect(canonicalAircraftIcao('ZZZZ')).toBe('ZZZZ');
  });
});
