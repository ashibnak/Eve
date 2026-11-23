import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { PrismaService } from '../db/prisma.service';
import { parseInput } from '../http/validation';
import { CurrentSession, Public } from './auth.guard';
import { type AuthenticatedSession, AuthService } from './auth.service';
import { clearSessionCookie, readCookie, SESSION_COOKIE, setSessionCookie } from './session-cookie';

const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
const CodeBody = z.object({ code: z.string().min(1).max(12) });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  /** Step 1: password. Sets a pending-session cookie and sends the one-time code. */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { username, password } = parseInput(LoginBody, body);
    const { token, sentTo } = await this.auth.verifyPassword(username, password);
    setSessionCookie(res, token);
    return { stage: 'code_sent', sentTo };
  }

  /** Step 2: one-time code. Activates the session and rotates its token. */
  @Public()
  @Post('code')
  @HttpCode(200)
  async code(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { code } = parseInput(CodeBody, body);
    const pending = readCookie(req, SESSION_COOKIE) ?? '';
    const { session, token } = await this.auth.verifyOtp(pending, code.trim());
    setSessionCookie(res, token);
    return { id: session.userId, username: session.username };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentSession() session: AuthenticatedSession,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(session);
    clearSessionCookie(res);
  }

  /** The signed-in user and their active role grants. */
  @Get('me')
  async me(@CurrentSession() session: AuthenticatedSession) {
    const roles = await this.prisma.authRoleAssignment.findMany({
      where: { userId: session.userId, revokedAt: null },
      select: { role: true, scopeKind: true, companyId: true, unitId: true },
      orderBy: { createdAt: 'asc' },
    });
    return { id: session.userId, username: session.username, roles };
  }
}
