import type { INestApplication } from '@nestjs/common';
import { requestContextMiddleware } from './request-context.middleware';

/** HTTP setup shared by main.ts and integration tests. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  app.use(requestContextMiddleware);
  app.enableShutdownHooks();
}
