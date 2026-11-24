import { z } from 'zod';
import { defineSetting } from '../config/settings';

/** Upper bound the HTTP layer enforces before reading an upload at all. */
export const HARD_MAX_BYTES = 200 * 1024 * 1024;

/** Upload limits and retention per customer (engineering defaults and product-owner decision, S3). */
export const ImportSettings = {
  maxBytes: defineSetting({
    key: 'platform.import_max_bytes',
    schema: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(HARD_MAX_BYTES),
    scope: 'customer',
    default: 20 * 1024 * 1024,
  }),
  maxRows: defineSetting({
    key: 'platform.import_max_rows',
    schema: z.number().int().min(100).max(500_000),
    scope: 'customer',
    default: 50_000,
  }),
  /** Days after which discarded or abandoned imports lose their file and staged rows (S3: 30). */
  retentionDays: defineSetting({
    key: 'platform.import_retention_days',
    schema: z.number().int().min(1).max(365),
    scope: 'customer',
    default: 30,
  }),
} as const;
