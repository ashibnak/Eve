import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ChannelRegistry, maskAddress } from '../channels/channel';
import { ConfigService } from '../config/config.service';
import { SettingsRegistry } from '../config/settings';
import { Clock } from '../context/clock';
import { runAs } from '../context/request-context';
import { TxRunner } from '../context/tx-runner';
import { PrismaService } from '../db/prisma.service';
import { AuthSettings, PENDING_SESSION_SECONDS } from './auth.settings';
import {
  dummyPasswordHash,
  hexEquals,
  newOtpCode,
  newSessionToken,
  otpHash,
  sha256Hex,
  verifyPassword,
} from './crypto';

/** The system actor that records login activity before a user is authenticated. */
const AUTH_ACTOR = { kind: 'system', id: 'auth' } as const;

/** Refresh `last_seen_at` at most this often, to avoid a write on every request. */
const LAST_SEEN_RESOLUTION_MS = 60_000;

export interface PasswordStepResult {
  /** Opaque session token for the cookie; the session waits for the one-time code. */
  token: string;
  /** Where the code went, masked, e.g. `…4567`. */
  sentTo: string;
}

export interface AuthenticatedSession {
  sessionId: string;
  userId: string;
  username: string;
}

/** The activated session and its new token: the token is rotated when the code is verified. */
export interface LoginResult {
  session: AuthenticatedSession;
  token: string;
}

export class AccountLockedException extends HttpException {
  constructor(readonly until: Date) {
    super({ error: 'account_locked', lockedUntil: until.toISOString() }, HttpStatus.LOCKED);
  }
}

function invalid(error: string): UnauthorizedException {
  return new UnauthorizedException({ error });
}

const seconds = (n: number) => n * 1000;

/**
 * Local login: password, then a one-time code sent through the user's channel (product-owner
 * decision: second factor for every user). Login activity is audited as the `auth` system actor.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly txRunner: TxRunner,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly channels: ChannelRegistry,
    private readonly clock: Clock,
    settings: SettingsRegistry,
  ) {
    settings.register(...Object.values(AuthSettings));
  }

  /** Step 1: checks the password and sends a one-time code. */
  async verifyPassword(usernameInput: string, password: string): Promise<PasswordStepResult> {
    const username = usernameInput.trim().toLowerCase();
    const user = await this.prisma.authUser.findUnique({ where: { username } });
    if (!user || user.status !== 'active') {
      await verifyPassword(password, await dummyPasswordHash());
      throw invalid('invalid_credentials');
    }

    const now = this.clock.now();
    const passwordOk = await verifyPassword(password, user.passwordHash);
    const locked = user.lockedUntil !== null && user.lockedUntil > now;
    if (locked) {
      // Only someone who knows the password learns that the account is locked.
      if (passwordOk) throw new AccountLockedException(user.lockedUntil as Date);
      throw invalid('invalid_credentials');
    }

    if (!passwordOk) {
      await this.recordFailedPassword(user.id);
      throw invalid('invalid_credentials');
    }

    const otpTtl = await this.config.get(AuthSettings.otpTtlSeconds);
    const token = newSessionToken();
    const code = newOtpCode();
    await runAs(AUTH_ACTOR, () =>
      this.txRunner.run(async (tx) => {
        await tx.authUser.update({
          where: { id: user.id },
          data: { failedPasswordAttempts: 0, lockedUntil: null, updatedAt: now },
        });
        const session = await tx.authSession.create({
          data: {
            tokenHash: sha256Hex(token),
            userId: user.id,
            stage: 'otp_pending',
            createdAt: now,
            lastSeenAt: now,
            expiresAt: new Date(now.getTime() + seconds(PENDING_SESSION_SECONDS)),
          },
          select: { id: true },
        });
        await tx.authOtp.create({
          data: {
            sessionId: session.id,
            codeHash: otpHash(session.id, code),
            createdAt: now,
            expiresAt: new Date(now.getTime() + seconds(otpTtl)),
          },
        });
        await this.audit.record(tx, {
          action: 'platform.auth.password.verify',
          entityType: 'auth_user',
          entityId: user.id,
          companyId: null,
          before: null,
          after: { sessionId: session.id, stage: 'otp_pending' },
          reason: 'password verified; one-time code sent',
        });
      }),
    );
    await this.channels.get(user.contactChannel).send(user.contactAddress, {
      template: 'auth.otp',
      params: { code, minutes: String(Math.ceil(otpTtl / 60)) },
      secretParams: ['code'],
    });
    return { token, sentTo: maskAddress(user.contactAddress) };
  }

  /** Step 2: checks the one-time code and activates the session. */
  async verifyOtp(token: string, code: string): Promise<LoginResult> {
    const now = this.clock.now();
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: { select: { id: true, username: true, status: true } } },
    });
    if (
      !session ||
      session.stage !== 'otp_pending' ||
      session.revokedAt ||
      session.expiresAt <= now
    ) {
      throw invalid('login_expired');
    }
    const otp = await this.prisma.authOtp.findFirst({
      where: { sessionId: session.id, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp || otp.expiresAt <= now) throw invalid('code_expired');

    const [maxAttempts, absolute] = await Promise.all([
      this.config.get(AuthSettings.otpMaxAttempts),
      this.config.get(AuthSettings.sessionAbsoluteSeconds),
    ]);
    if (otp.attempts >= maxAttempts) throw invalid('code_attempts_exhausted');
    const correct = /^\d{6}$/.test(code) && hexEquals(otp.codeHash, otpHash(session.id, code));

    if (!correct) {
      // Commit the failed attempt (and its audit row) first, then refuse: throwing inside the
      // transaction would roll the attempt back and the limit would never be reached.
      const exhausted = await runAs(AUTH_ACTOR, () =>
        this.txRunner.run(async (tx) => {
          const [row] = await tx.$queryRaw<{ attempts: number }[]>`
            UPDATE auth_otp SET attempts = attempts + 1 WHERE id = ${otp.id}::uuid
            RETURNING attempts`;
          const attempts = row?.attempts ?? otp.attempts + 1;
          const used = attempts >= maxAttempts;
          if (used) {
            await tx.authSession.update({ where: { id: session.id }, data: { revokedAt: now } });
          }
          await this.audit.record(tx, {
            action: 'platform.auth.otp.fail',
            entityType: 'auth_user',
            entityId: session.userId,
            companyId: null,
            before: { attempts: attempts - 1 },
            after: { attempts, sessionRevoked: used },
            reason: used ? 'too many wrong codes; login cancelled' : 'wrong one-time code',
          });
          return used;
        }),
      );
      throw invalid(exhausted ? 'code_attempts_exhausted' : 'invalid_code');
    }

    const activeToken = newSessionToken();
    const activated = await runAs({ kind: 'user', id: session.userId }, () =>
      this.txRunner.run(async (tx) => {
        // A code works once, even if two requests race with it.
        const consumed = await tx.authOtp.updateMany({
          where: { id: otp.id, consumedAt: null },
          data: { consumedAt: now },
        });
        if (consumed.count !== 1) return false;
        await tx.authSession.update({
          where: { id: session.id },
          data: {
            tokenHash: sha256Hex(activeToken),
            stage: 'active',
            lastSeenAt: now,
            expiresAt: new Date(now.getTime() + seconds(absolute)),
          },
        });
        await this.audit.record(tx, {
          action: 'platform.auth.login',
          entityType: 'auth_user',
          entityId: session.userId,
          companyId: null,
          before: { stage: 'otp_pending' },
          after: { sessionId: session.id, stage: 'active' },
          reason: 'one-time code verified',
        });
        return true;
      }),
    );
    if (!activated) throw invalid('code_expired');
    return {
      session: { sessionId: session.id, userId: session.userId, username: session.user.username },
      token: activeToken,
    };
  }

  /** Resolves a cookie token to an active session, enforcing idle and absolute expiry. */
  async authenticate(token: string): Promise<AuthenticatedSession | null> {
    const now = this.clock.now();
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: { select: { username: true, status: true } } },
    });
    if (
      !session ||
      session.stage !== 'active' ||
      session.revokedAt ||
      session.user.status !== 'active'
    ) {
      return null;
    }
    const idle = await this.config.get(AuthSettings.sessionIdleSeconds);
    if (session.expiresAt <= now || now.getTime() - session.lastSeenAt.getTime() > seconds(idle)) {
      return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_RESOLUTION_MS) {
      await this.prisma.authSession.update({
        where: { id: session.id },
        data: { lastSeenAt: now },
      });
    }
    return { sessionId: session.id, userId: session.userId, username: session.user.username };
  }

  /** Ends the session of the current user. */
  async logout(session: AuthenticatedSession): Promise<void> {
    const now = this.clock.now();
    await this.txRunner.run(async (tx) => {
      await tx.authSession.update({ where: { id: session.sessionId }, data: { revokedAt: now } });
      await this.audit.record(tx, {
        action: 'platform.auth.logout',
        entityType: 'auth_user',
        entityId: session.userId,
        companyId: null,
        before: { stage: 'active' },
        after: { sessionId: session.sessionId, revoked: true },
        reason: 'user logged out',
      });
    });
  }

  private async recordFailedPassword(userId: string): Promise<void> {
    const [maxFailures, lockout] = await Promise.all([
      this.config.get(AuthSettings.passwordMaxFailures),
      this.config.get(AuthSettings.lockoutSeconds),
    ]);
    const now = this.clock.now();
    await runAs(AUTH_ACTOR, () =>
      this.txRunner.run(async (tx) => {
        // Increment in SQL so concurrent wrong attempts are all counted.
        const [row] = await tx.$queryRaw<{ failures: number }[]>`
          UPDATE auth_user SET failed_password_attempts = failed_password_attempts + 1, updated_at = ${now}
          WHERE id = ${userId}::uuid
          RETURNING failed_password_attempts AS failures`;
        const failures = row?.failures ?? 1;
        const lock = failures >= maxFailures;
        const lockedUntil = lock ? new Date(now.getTime() + seconds(lockout)) : null;
        if (lock) {
          await tx.authUser.update({
            where: { id: userId },
            data: { failedPasswordAttempts: 0, lockedUntil },
          });
        }
        await this.audit.record(tx, {
          action: lock ? 'platform.auth.account.lock' : 'platform.auth.password.fail',
          entityType: 'auth_user',
          entityId: userId,
          companyId: null,
          before: { failedPasswordAttempts: failures - 1 },
          after: { failedPasswordAttempts: lock ? 0 : failures, lockedUntil },
          reason: lock ? `${failures} wrong passwords; account locked` : 'wrong password',
        });
      }),
    );
  }
}
