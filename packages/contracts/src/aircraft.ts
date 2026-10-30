import { z } from 'zod';
import { aircraftIcaoSchema } from './primitives.js';

/**
 * Визуально-техническая таксономия ВС (ADR-0009 §1). Единственный источник
 * истины для `aircraft.category`; клиент не классифицирует ICAO сам.
 */
export const aircraftCategorySchema = z.enum([
  'ga_single',
  'ga_twin',
  'turboprop',
  'bizjet',
  'narrowbody',
  'widebody',
  'very_large',
  'helicopter',
  'unknown',
]);
export type AircraftCategory = z.output<typeof aircraftCategorySchema>;

/**
 * Детерминированные псевдонимы ICAO-обозначений → канонический designator.
 *
 * `B77F` — внутренний код SimBrief (`inputs.list.json`), а не ICAO-обозначение:
 * по ICAO Doc 8643 `B77L` = Boeing 777-200LR **и** 777F (этот же код требует
 * VATSIM). Храним и показываем `B77L` везде; `B77F` принимаем только на входе.
 */
export const AIRCRAFT_ICAO_ALIASES: Readonly<Record<string, string>> = {
  B77F: 'B77L',
};

/**
 * Канонизирует ICAO-обозначение ВС: `trim` + `upper` + {@link AIRCRAFT_ICAO_ALIASES}.
 * Чистая и детерминированная; неизвестное значение возвращается без изменений,
 * поэтому применима и к уже каноническим кодам.
 */
export function canonicalAircraftIcao(icao: string): string {
  const normalized = icao.trim().toUpperCase();
  return AIRCRAFT_ICAO_ALIASES[normalized] ?? normalized;
}

export const engineTypeSchema = z.enum(['piston', 'turboprop', 'jet', 'turboshaft', 'unknown']);
export type EngineType = z.output<typeof engineTypeSchema>;

export const wingConfigSchema = z.enum([
  'high_wing',
  'low_wing',
  'mid_wing',
  'delta',
  'rotor',
  'unknown',
]);
export type WingConfig = z.output<typeof wingConfigSchema>;

/**
 * Закрытый набор ключей 3D-моделей (ADR-0009 §5.1). Объявлен один раз здесь,
 * чтобы серверный сид `aircraft.model_key` и клиентский реестр ассетов не разъехались.
 */
export const aircraftModelKeySchema = z.enum([
  'ga_single_c172',
  'ga_single_pa28',
  'ga_twin_pa34',
  'ga_twin_da42',
  'turboprop_c208',
  'turboprop_pc12',
  'turboprop_kingair',
  'turboprop_atr',
  'bizjet_c525',
  'bizjet_glf',
  'narrowbody_a320',
  'narrowbody_b738',
  'narrowbody_e190',
  'narrowbody_crj',
  'widebody_b747',
  'widebody_b777',
  'widebody_b763',
  'widebody_b787',
  'widebody_a330',
  'widebody_a350',
  'widebody_a380',
  'widebody_md11',
  'helicopter_b407',
  'helicopter_h125',
  'helicopter_r22',
  'helicopter_h145',
]);
export type AircraftModelKey = z.output<typeof aircraftModelKeySchema>;

/**
 * Метаданные типа ВС, вкладываемые в ответ рейса и отдаваемые каталогом
 * (api.md §3.2.2/§3.6, `aircraftSummarySchema`). URL 3D-ассетов здесь нет:
 * сервер не знает о клиентской библиотеке (ADR-0009 §7).
 */
export const aircraftSummarySchema = z
  .object({
    icao_type: aircraftIcaoSchema,
    manufacturer: z.string().nullable(),
    model: z.string().nullable(),
    category: aircraftCategorySchema,
    model_key: aircraftModelKeySchema.nullable(),
    length_m: z.number().finite().positive().nullable(),
    wingspan_m: z.number().finite().positive().nullable(),
    height_m: z.number().finite().positive().nullable(),
    engines: z.number().int().min(0).max(8).nullable(),
    engine_type: engineTypeSchema.nullable(),
    wing_config: wingConfigSchema.nullable(),
    vs_soft_fpm: z.number().int().nullable(),
    vs_hard_fpm: z.number().int().nullable(),
  })
  .strict();
export type AircraftSummary = z.output<typeof aircraftSummarySchema>;
export type AircraftSummaryInput = z.input<typeof aircraftSummarySchema>;
