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

/**
 * The stored state. An HTTP request opens it in middleware before anyone is authenticated; the
 * auth guard then sets the actor. Until then `currentContext()` refuses, so no write can be
 * anonymous.
 */
interface ContextState extends Omit<RequestContext, 'actor'> {
  actor: platformV1.Actor | null;
}

const storage = new AsyncLocalStorage<ContextState>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

/** Opens a context for an HTTP request whose actor is not known yet (see `setActor`). */
export function runUnauthenticated<T>(context: Omit<RequestContext, 'actor'>, fn: () => T): T {
  return storage.run({ ...context, actor: null }, fn);
}

/** Records the authenticated actor of the current request; it can be set only once. */
export function setActor(actor: platformV1.Actor): void {
  const state = storage.getStore();
  if (!state) throw new Error('No request context to authenticate');
  if (state.actor && state.actor.id !== actor.id) throw new Error('Request actor already set');
  state.actor = actor;
}

/**
 * Runs `fn` as another actor, e.g. the system acting during login. Inside a context it stays in
 * the same flow (same correlation and request ids); outside one it starts a new flow.
 */
export function runAs<T>(actor: platformV1.Actor, fn: () => T): T {
  const state = storage.getStore() ?? {
    source: 'manual' as const,
    correlationId: randomUUID(),
    causationId: null,
    requestId: null,
    actionId: null,
  };
  return storage.run({ ...state, actor }, fn);
}

/** The current context. Throws outside one or before authentication: writes are never anonymous. */
export function currentContext(): RequestContext {
  const state = storage.getStore();
  if (!state) throw new Error('No request context: run this inside runWithContext()');
  if (!state.actor) throw new Error('Request is not authenticated');
  return { ...state, actor: state.actor };
}

/** The current actor, or null when unauthenticated or outside a context. */
export function currentActor(): platformV1.Actor | null {
  return storage.getStore()?.actor ?? null;
}

export function newCorrelationId(): string {
  return randomUUID();
}
