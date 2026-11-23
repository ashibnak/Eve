import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runUnauthenticated } from '../context/request-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Opens the request context for every HTTP request: request id, and the correlation id the
 * caller passes in `x-correlation-id` (so a multi-request flow shares one) or a new one.
 * The auth guard sets the actor afterwards.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = header(req, 'x-request-id')?.slice(0, 100) ?? randomUUID();
  const passed = header(req, 'x-correlation-id');
  const correlationId = passed && UUID.test(passed) ? passed.toLowerCase() : randomUUID();
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-correlation-id', correlationId);
  runUnauthenticated(
    { source: 'manual', correlationId, causationId: null, requestId, actionId: null },
    () => next(),
  );
}
