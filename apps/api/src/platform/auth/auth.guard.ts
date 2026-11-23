import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { setActor } from '../context/request-context';
import { type AuthenticatedSession, AuthService } from './auth.service';
import { readCookie, SESSION_COOKIE } from './session-cookie';

const PUBLIC_KEY = 'eve:public';

/** Marks a route as reachable without a session (login, health). Everything else requires one. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

interface AuthenticatedRequest extends Request {
  eveSession?: AuthenticatedSession;
}

/** The session of the current request (only on non-public routes). */
export const CurrentSession = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const session = ctx.switchToHttp().getRequest<AuthenticatedRequest>().eveSession;
  if (!session) throw new UnauthorizedException();
  return session;
});

/** Global guard: resolves the session cookie and sets the request's actor. Deny by default. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readCookie(req, SESSION_COOKIE);
    const session = token ? await this.auth.authenticate(token) : null;
    if (!session) throw new UnauthorizedException({ error: 'not_authenticated' });
    req.eveSession = session;
    setActor({ kind: 'user', id: session.userId });
    return true;
  }
}
