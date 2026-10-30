import { z } from 'zod';

export const healthResponseSchema = z
  .object({
    status: z.enum(['ok', 'degraded', 'down']),
    version: z.string(),
  })
  .strict();
export type HealthResponse = z.output<typeof healthResponseSchema>;
