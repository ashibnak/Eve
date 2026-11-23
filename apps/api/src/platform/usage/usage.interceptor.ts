import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { finalize, type Observable } from 'rxjs';
import { currentActor } from '../context/request-context';
import { UsageService } from './usage.service';

/** `/api/v1/<module>/...` → `<module>` (e.g. `platform`, `org`, `auth`). */
export function moduleOf(path: string): string {
  return /^\/api\/v1\/([a-z0-9_-]+)/.exec(path)?.[1] ?? 'unknown';
}

/**
 * Counts every authenticated request per module and marks the user active for the day.
 * Counting never fails or slows the request: it runs after the handler and only logs errors.
 */
@Injectable()
export class UsageInterceptor implements NestInterceptor {
  private readonly logger = new Logger(UsageInterceptor.name);

  constructor(private readonly usage: UsageService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const actor = currentActor();
    if (context.getType() !== 'http' || actor?.kind !== 'user') return next.handle();
    const module = moduleOf(context.switchToHttp().getRequest<Request>().path);
    return next.handle().pipe(
      finalize(() => {
        this.usage.recordRequest(actor.id, module).catch((error: unknown) => {
          this.logger.error(`Usage counter failed: ${String(error)}`);
        });
      }),
    );
  }
}
