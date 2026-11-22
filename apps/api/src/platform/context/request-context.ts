import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { platformV1 } from '@eve/contracts';

/**
 * Who is acting, why, and as part of which flow. Every write path reads it to fill the audit
 * row and the event envelope (CLAUDE.md rules 9-10). Set per HTTP request, job or CLI run.
 */
export interface RequestContext {
  readonly actor: platformV1.Actor;
  readonly source: platformV1.AuditSource;
  /** Shared by every audit row and event of one business flow (ADR-006). */
  readonly correlationId: string;
  /** The event or command that triggered this work; null at the start of a flow. */
  readonly causationId: string | null;
  readonly requestId: string | null;
  /** Workflow action / change request / approval this work belongs to, if any. */
  readonly actionId: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current context. Throws when called outside one: writes must never be anonymous. */
export function currentContext(): RequestContext {
  const context = storage.getStore();
  if (!context) throw new Error('No request context: run this inside runWithContext()');
  return context;
}

export function newCorrelationId(): string {
  return randomUUID();
}
