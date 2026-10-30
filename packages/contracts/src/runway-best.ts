import { z } from 'zod';

import { airportIcaoSchema } from './primitives.js';

export const runwayBestQuerySchema = z
  .object({
    airport: z
      .string()
      .trim()
      .toUpperCase()
      .pipe(airportIcaoSchema),
    runway: z
      .string()
      .trim()
      .toUpperCase()
      .min(1)
      .max(8),
  })
  .strict();
export type RunwayBestQuery = z.output<typeof runwayBestQuerySchema>;

export const runwayBestSchema = z
  .object({
    best_score: z.number().int().min(0).max(100).nullable(),
    landings: z.number().int().nonnegative(),
  })
  .strict();
export type RunwayBest = z.output<typeof runwayBestSchema>;

export const friendRequestCountSchema = z
  .object({
    count: z.number().int().nonnegative(),
  })
  .strict();
export type FriendRequestCount = z.output<typeof friendRequestCountSchema>;
