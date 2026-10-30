import { describe, expect, it } from 'vitest';

import {
  AIRCRAFT_DB_VERSION,
  ATC_MODEL_TO_ICAO,
  normalizeAtcText,
  resolveAircraftIcao,
  selectAircraftModelRaw,
  UNKNOWN_AIRCRAFT_ICAO,
} from './aircraft-icao.js';

describe('resolveAircraftIcao (ADR-0008/T84)', () => {
  it('использует валидный ATC TYPE напрямую (высший приоритет)', () => {
    expect(resolveAircraftIcao({ atc_type: 'b738' })).toEqual({ icao: 'B738', source: 'atc_type' });
    expect(
      resolveAircraftIcao({
        atc_type: 'MD11',
        title: 'Boeing 737-800',
        atc_model: 'Boeing 737-800',
      }),
    ).toEqual({ icao: 'MD11', source: 'atc_type' });
  });

  it('маппит TITLE/ATC MODEL по справочнику (source=title)', () => {
    expect(resolveAircraftIcao({ atc_model: 'Boeing 737-800' })).toEqual({
      icao: 'B738',
      source: 'title',
    });
    expect(resolveAircraftIcao({ atc_model: '  airbus a320neo ' })).toEqual({
      icao: 'A20N',
      source: 'title',
    });
    expect(resolveAircraftIcao({ title: 'Cessna 172' })).toEqual({ icao: 'C172', source: 'title' });
    expect(resolveAircraftIcao({ title: 'Boeing 747-8' })).toEqual({
      icao: 'B748',
      source: 'title',
    });
  });

  it('TITLE имеет приоритет над ATC MODEL', () => {
    expect(
      resolveAircraftIcao({ title: 'Airbus A320neo', atc_model: 'Some Custom Plane' }),
    ).toEqual({ icao: 'A20N', source: 'title' });
  });

  it('эвристика разбирает MD-11F и другие длинные строки (source=heuristic)', () => {
    expect(resolveAircraftIcao({ atc_model: 'MD-11F' })).toEqual({
      icao: 'MD11',
      source: 'heuristic',
    });
    expect(resolveAircraftIcao({ title: 'McDonnell Douglas MD-11F' })).toEqual({
      icao: 'MD11',
      source: 'heuristic',
    });
    expect(resolveAircraftIcao({ atc_model: 'Boeing 737-900ER' })).toEqual({
      icao: 'B739',
      source: 'heuristic',
    });
    expect(resolveAircraftIcao({ atc_model: 'AIRBUS A320NEO Asobo' })).toEqual({
      icao: 'A20N',
      source: 'heuristic',
    });
  });

  it('различает близкие варианты моделей в эвристике', () => {
    expect(resolveAircraftIcao({ title: 'ATR 72-600 Asobo' })).toEqual({
      icao: 'AT76',
      source: 'heuristic',
    });
    expect(resolveAircraftIcao({ title: 'ATR 72-200' })).toEqual({
      icao: 'AT72',
      source: 'heuristic',
    });
    expect(resolveAircraftIcao({ title: 'Embraer 195' })).toEqual({
      icao: 'E195',
      source: 'heuristic',
    });
    expect(resolveAircraftIcao({ title: 'Boeing 787-10' })).toEqual({
      icao: 'B78X',
      source: 'title',
    });
  });

  it('нормализует строку TITLE (uppercase/пробелы) для справочника', () => {
    expect(normalizeAtcText('  Boeing   737-800 ')).toBe('BOEING 737-800');
    expect(ATC_MODEL_TO_ICAO['BOEING 737-800']).toBe('B738');
  });

  it('неизвестный тип → ZZZZ/unknown', () => {
    expect(resolveAircraftIcao({ atc_model: 'Some Custom Plane', atc_type: '' })).toEqual({
      icao: UNKNOWN_AIRCRAFT_ICAO,
      source: 'unknown',
    });
    expect(resolveAircraftIcao({ title: 'Totally Unknown Addon' })).toEqual({
      icao: 'ZZZZ',
      source: 'unknown',
    });
    expect(resolveAircraftIcao({})).toEqual({ icao: 'ZZZZ', source: 'unknown' });
  });

  describe('T-ICAO-BCS3 (Synaptic A220)', () => {
    it('пресет A220: числовой ATC TYPE "223" игнорируется → BCS3', () => {
      expect(
        resolveAircraftIcao({
          atc_type: '223',
          atc_model: 'A220-300',
          title: 'A220-300',
        }),
      ).toEqual({ icao: 'BCS3', source: 'title' });
    });

    it('регресс: ATC TYPE=AIRBUS + ATC MODEL=BCS3 по-прежнему даёт BCS3', () => {
      expect(
        resolveAircraftIcao({
          atc_type: 'AIRBUS',
          atc_model: 'BCS3',
          title: 'Synaptic Simulations A220-300',
        }),
      ).toEqual({ icao: 'BCS3', source: 'title' });
    });

    it('справочник знает аддон-значения A220 / A220-300 / 223 / BCS1', () => {
      expect(resolveAircraftIcao({ title: 'A220' })).toEqual({ icao: 'BCS3', source: 'title' });
      expect(resolveAircraftIcao({ atc_model: 'A220-300' })).toEqual({
        icao: 'BCS3',
        source: 'title',
      });
      expect(resolveAircraftIcao({ atc_type: '223', title: 'A220-300' })).toEqual({
        icao: 'BCS3',
        source: 'title',
      });
      expect(resolveAircraftIcao({ atc_model: 'BCS1' })).toEqual({ icao: 'BCS1', source: 'title' });
    });

    it('icao_type_designator из aircraft.cfg приоритетнее справочника/эвристики', () => {
      expect(
        resolveAircraftIcao({
          title: 'A220-300',
          atc_model: 'A220-300',
          icaoTypeDesignator: 'BCS3',
        }),
      ).toEqual({ icao: 'BCS3', source: 'aircraft_cfg' });
    });

    it('валидный ATC TYPE остаётся выше cfg-дизайнатора', () => {
      expect(resolveAircraftIcao({ atc_type: 'B738', icaoTypeDesignator: 'BCS3' })).toEqual({
        icao: 'B738',
        source: 'atc_type',
      });
    });

    it('пустой/мусорный cfg-дизайнатор не ломает fallback на эвристику', () => {
      expect(resolveAircraftIcao({ title: 'Airbus A320neo', icaoTypeDesignator: '??' })).toEqual({
        icao: 'A20N',
        source: 'title',
      });
    });
  });

  describe('ZZZZ sentinel never wins over ATC MODEL', () => {
    it('ignores atc_type=ZZZZ and resolves B77L from ATC MODEL', () => {
      expect(
        resolveAircraftIcao({
          atc_type: 'ZZZZ',
          atc_model: 'ATCCOM.AC_MODEL B77L.0.TEXT',
        }),
      ).toEqual({ icao: 'B77L', source: 'heuristic' });
    });

    it('keeps ZZZZ when no usable model exists', () => {
      expect(resolveAircraftIcao({ atc_type: 'ZZZZ' })).toEqual({
        icao: 'ZZZZ',
        source: 'unknown',
      });
    });

    it('does not change a valid ATC TYPE', () => {
      expect(resolveAircraftIcao({ atc_type: 'B752' })).toEqual({
        icao: 'B752',
        source: 'atc_type',
      });
    });
  });

  describe('R5.8: семейство Boeing 777', () => {
    it('валидный B77L из ATC TYPE/MODEL разрешается напрямую', () => {
      expect(resolveAircraftIcao({ atc_model: 'B77L' })).toEqual({
        icao: 'B77L',
        source: 'title',
      });
      expect(resolveAircraftIcao({ atc_type: 'B77L' })).toEqual({
        icao: 'B77L',
        source: 'atc_type',
      });
    });

    it('человекочитаемые варианты — по справочнику', () => {
      expect(resolveAircraftIcao({ atc_model: 'Boeing 777-200LR' })).toEqual({
        icao: 'B77L',
        source: 'title',
      });
      expect(resolveAircraftIcao({ title: 'Boeing 777-200ER' })).toEqual({
        icao: 'B772',
        source: 'title',
      });
      expect(resolveAircraftIcao({ title: 'Boeing 777-300' })).toEqual({
        icao: 'B773',
        source: 'title',
      });
      expect(resolveAircraftIcao({ title: 'Boeing 777-300ER' })).toEqual({
        icao: 'B77W',
        source: 'title',
      });
      expect(resolveAircraftIcao({ title: 'Boeing 777F' })).toEqual({
        icao: 'B77L',
        source: 'title',
      });
    });

    it('канонизирует B77F → B77L на всех путях (ICAO Doc 8643, VATSIM)', () => {
      expect(resolveAircraftIcao({ atc_model: 'B77F' })).toEqual({
        icao: 'B77L',
        source: 'title',
      });
      expect(resolveAircraftIcao({ atc_type: 'B77F' })).toEqual({
        icao: 'B77L',
        source: 'atc_type',
      });
      expect(resolveAircraftIcao({ icaoTypeDesignator: 'B77F' })).toEqual({
        icao: 'B77L',
        source: 'aircraft_cfg',
      });
      expect(resolveAircraftIcao({ title: 'PMDG 777F' })).toEqual({
        icao: 'B77L',
        source: 'heuristic',
      });
      expect(resolveAircraftIcao({ atc_model: 'B77L' })).toEqual({
        icao: 'B77L',
        source: 'title',
      });
    });

    it('длинные title аддонов (PMDG-класс) — по эвристике', () => {
      expect(resolveAircraftIcao({ title: 'PMDG 777-200LR' })).toEqual({
        icao: 'B77L',
        source: 'heuristic',
      });
      expect(resolveAircraftIcao({ title: 'Boeing 777-200 LR Asobo' })).toEqual({
        icao: 'B77L',
        source: 'heuristic',
      });
      expect(resolveAircraftIcao({ title: 'QualityWings 777-200ER' })).toEqual({
        icao: 'B772',
        source: 'heuristic',
      });
      expect(resolveAircraftIcao({ title: 'PMDG 777-300ER' })).toEqual({
        icao: 'B77W',
        source: 'heuristic',
      });
    });

    it('не путает 777-200 с 777-200LR', () => {
      expect(resolveAircraftIcao({ atc_model: '777-200' })).toEqual({
        icao: 'B772',
        source: 'heuristic',
      });
      expect(resolveAircraftIcao({ atc_model: '777-200LR' })).toEqual({
        icao: 'B77L',
        source: 'heuristic',
      });
    });
  });

  describe('X-Plane acf_ICAO: семейный код vs точный вариант (owner 2026-10-18)', () => {
    it('A320 + title A320neo → A20N (source=title)', () => {
      expect(resolveAircraftIcao({ atc_model: 'A320', title: 'A320neo' })).toEqual({
        icao: 'A20N',
        source: 'title',
      });
      expect(
        resolveAircraftIcao({
          atc_model: 'A320',
          title: 'Airbus A320neo Laminar Research',
        }),
      ).toEqual({ icao: 'A20N', source: 'title' });
    });

    it('A320 без варианта в title остаётся A320', () => {
      expect(resolveAircraftIcao({ atc_model: 'A320' })).toEqual({ icao: 'A320', source: 'title' });
      expect(resolveAircraftIcao({ atc_model: 'A320', title: 'Airbus A320' })).toEqual({
        icao: 'A320',
        source: 'title',
      });
    });

    it('точный A20N из сима не понижается до A320 по title', () => {
      expect(resolveAircraftIcao({ atc_model: 'A20N', title: 'Airbus A320' })).toEqual({
        icao: 'A20N',
        source: 'title',
      });
      expect(resolveAircraftIcao({ atc_model: 'A20N', title: 'Airbus A320neo' })).toEqual({
        icao: 'A20N',
        source: 'title',
      });
    });

    it('B738/B77W не затронуты семейным правилом', () => {
      expect(resolveAircraftIcao({ atc_model: 'B738', title: 'Boeing 737-800' })).toEqual({
        icao: 'B738',
        source: 'title',
      });
      expect(resolveAircraftIcao({ atc_model: 'B77W', title: 'Boeing 777-300ER' })).toEqual({
        icao: 'B77W',
        source: 'title',
      });
    });
  });

  it('возвращает версию справочника', () => {
    expect(AIRCRAFT_DB_VERSION).toMatch(/^\d{4}\.\d{2}\.\d+$/);
  });

  describe('selectAircraftModelRaw (T-D §5.6)', () => {
    it('приоритет ATC MODEL → TITLE → ATC TYPE, нормализация upper/trim', () => {
      expect(
        selectAircraftModelRaw({ atc_model: '  md-11f ', title: 'PMDG MD-11', atc_type: 'MD11' }),
      ).toBe('MD-11F');
      expect(selectAircraftModelRaw({ title: '  PMDG MD-11 ', atc_type: 'MD11' })).toBe(
        'PMDG MD-11',
      );
      expect(selectAircraftModelRaw({ atc_type: ' b738 ' })).toBe('B738');
    });

    it('пустые/пробельные строки игнорируются; всё пусто → null', () => {
      expect(selectAircraftModelRaw({ atc_model: '   ', title: '', atc_type: null })).toBeNull();
      expect(selectAircraftModelRaw({})).toBeNull();
    });

    it('обрезает строку до 128 символов (совместимость с ingest-схемой)', () => {
      const raw = selectAircraftModelRaw({ atc_model: 'x'.repeat(300) });
      expect(raw).toHaveLength(128);
    });
  });
});
