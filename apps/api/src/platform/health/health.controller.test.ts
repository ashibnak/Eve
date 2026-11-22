import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../db/prisma.service';
import { HealthController } from './health.controller';

function controllerWith(queryRaw: () => Promise<unknown>): HealthController {
  return new HealthController({ $queryRaw: vi.fn(queryRaw) } as unknown as PrismaService);
}

describe('HealthController', () => {
  it('reports ok when the database answers', async () => {
    await expect(controllerWith(async () => [{ '?column?': 1 }]).check()).resolves.toEqual({
      status: 'ok',
      db: 'ok',
    });
  });

  it('fails with 503 when the database is unreachable', async () => {
    const check = controllerWith(async () => {
      throw new Error('connection refused');
    }).check();
    await expect(check).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
