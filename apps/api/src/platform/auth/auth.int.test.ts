import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import {
  asUser,
  createPlatform,
  ensureTimeZone,
  type Platform,
  uniqueUsername,
} from '../../../test/platform';
import { AccountLockedException } from './auth.service';
import { AuthSettings } from './auth.settings';
import { SystemAdminRole } from './roles';

const PASSWORD = 'a-long-enough-password';
const MINUTE = 60_000;

describe('auth: password + one-time code', () => {
  let platform: Platform;

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    await ensureTimeZone(platform);
    // The tests below assume the product-owner defaults; other test files share this database.
    const policy = [
      [AuthSettings.otpTtlSeconds, 120],
      [AuthSettings.otpMaxAttempts, 5],
      [AuthSettings.passwordMaxFailures, 5],
      [AuthSettings.lockoutSeconds, 900],
      [AuthSettings.sessionIdleSeconds, 1_800],
      [AuthSettings.sessionAbsoluteSeconds, 43_200],
      [AuthSettings.passwordMinLength, 12],
    ] as const;
    for (const [setting, value] of policy) {
      await asUser(() =>
        platform.config.set({ setting, companyId: null, value, reason: 'test policy' }),
      );
    }
  });

  afterAll(() => platform.close());

  async function newUser(address = `09${Math.floor(Math.random() * 1e9)}`) {
    const username = uniqueUsername();
    const { result } = await asUser(() =>
      platform.users.create({
        username,
        password: PASSWORD,
        contactChannel: 'stub',
        contactAddress: address,
        reason: 'test user',
      }),
    );
    return { ...result, address };
  }

  function lastCode(address: string): string {
    const message = platform.stubChannel.lastTo(address);
    if (!message?.params.code) throw new Error('no code sent');
    return message.params.code;
  }

  async function login(username: string, address: string) {
    const { token } = await platform.auth.verifyPassword(username, PASSWORD);
    return platform.auth.verifyOtp(token, lastCode(address));
  }

  it('signs in with the right password and code, and rotates the session token', async () => {
    const user = await newUser();
    const step1 = await platform.auth.verifyPassword(user.username, PASSWORD);
    expect(step1.sentTo).toBe(`…${user.address.slice(-4)}`);
    expect(await platform.auth.authenticate(step1.token)).toBeNull(); // code not entered yet

    const { session, token } = await platform.auth.verifyOtp(step1.token, lastCode(user.address));
    expect(session).toMatchObject({ userId: user.id, username: user.username });
    expect(token).not.toBe(step1.token);
    expect(await platform.auth.authenticate(token)).toMatchObject({ userId: user.id });
    expect(await platform.auth.authenticate(step1.token)).toBeNull();
  });

  it('accepts usernames case-insensitively', async () => {
    const user = await newUser();
    await expect(
      platform.auth.verifyPassword(user.username.toUpperCase(), PASSWORD),
    ).resolves.toBeDefined();
  });

  it('gives the same answer for an unknown user and a wrong password', async () => {
    const user = await newUser();
    await expect(platform.auth.verifyPassword('nobody.here', PASSWORD)).rejects.toMatchObject({
      response: { error: 'invalid_credentials' },
    });
    await expect(
      platform.auth.verifyPassword(user.username, 'wrong-password'),
    ).rejects.toMatchObject({
      response: { error: 'invalid_credentials' },
    });
  });

  it('locks the account after 5 wrong passwords and unlocks after 15 minutes', async () => {
    const user = await newUser();
    for (let i = 0; i < 5; i += 1) {
      await expect(platform.auth.verifyPassword(user.username, `wrong-${i}`)).rejects.toThrow();
    }
    // Locked: the right password is told so; a wrong one learns nothing.
    await expect(platform.auth.verifyPassword(user.username, PASSWORD)).rejects.toBeInstanceOf(
      AccountLockedException,
    );
    await expect(platform.auth.verifyPassword(user.username, 'wrong')).rejects.toMatchObject({
      response: { error: 'invalid_credentials' },
    });

    platform.clock.advance(15 * MINUTE + 1_000);
    await expect(login(user.username, user.address)).resolves.toMatchObject({
      session: { userId: user.id },
    });

    const audits = await platform.prisma.auditLog.findMany({ where: { entityId: user.id } });
    expect(audits.map((a) => a.action)).toContain('platform.auth.account.lock');
    expect(
      JSON.stringify(audits, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toMatch(/scrypt\$/); // no password hash in the audit log
  });

  it('counts concurrent wrong passwords without losing any', async () => {
    const user = await newUser();
    await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) => platform.auth.verifyPassword(user.username, `bad-${i}`)),
    );
    const row = await platform.prisma.authUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.failedPasswordAttempts).toBe(4);
  });

  it('cancels the login after 5 wrong codes', async () => {
    const user = await newUser();
    const { token } = await platform.auth.verifyPassword(user.username, PASSWORD);
    const code = lastCode(user.address);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i += 1) {
      await expect(platform.auth.verifyOtp(token, wrong)).rejects.toMatchObject({
        response: { error: 'invalid_code' },
      });
    }
    await expect(platform.auth.verifyOtp(token, wrong)).rejects.toMatchObject({
      response: { error: 'code_attempts_exhausted' },
    });
    await expect(platform.auth.verifyOtp(token, code)).rejects.toMatchObject({
      response: { error: 'login_expired' },
    });
  });

  it('rejects a code after 2 minutes', async () => {
    const user = await newUser();
    const { token } = await platform.auth.verifyPassword(user.username, PASSWORD);
    platform.clock.advance(2 * MINUTE + 1_000);
    await expect(platform.auth.verifyOtp(token, lastCode(user.address))).rejects.toMatchObject({
      response: { error: 'code_expired' },
    });
  });

  it('ends a session after 30 idle minutes', async () => {
    const user = await newUser();
    const { token } = await login(user.username, user.address);
    platform.clock.advance(29 * MINUTE);
    expect(await platform.auth.authenticate(token)).not.toBeNull();
    platform.clock.advance(31 * MINUTE);
    expect(await platform.auth.authenticate(token)).toBeNull();
  });

  it('ends an active session after 12 hours however busy', async () => {
    const user = await newUser();
    const { token } = await login(user.username, user.address);
    for (let elapsed = 0; elapsed < 12 * 60; elapsed += 20) {
      expect(await platform.auth.authenticate(token)).not.toBeNull();
      platform.clock.advance(20 * MINUTE);
    }
    expect(await platform.auth.authenticate(token)).toBeNull();
  });

  it('logs out', async () => {
    const user = await newUser();
    const { session, token } = await login(user.username, user.address);
    await asUser(() => platform.auth.logout(session), { actor: { kind: 'user', id: user.id } });
    expect(await platform.auth.authenticate(token)).toBeNull();
  });
});

describe('users and role grants', () => {
  let platform: Platform;

  beforeAll(() => {
    platform = createPlatform(inject('db'));
  });

  afterAll(() => platform.close());

  const create = (overrides: Record<string, string> = {}) =>
    asUser(() =>
      platform.users.create({
        username: uniqueUsername(),
        password: PASSWORD,
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 'test',
        ...overrides,
      }),
    );

  it('enforces the password, username and channel rules', async () => {
    await expect(create({ password: 'short' })).rejects.toThrow('at least 12');
    await expect(create({ username: 'No Spaces!' })).rejects.toThrow('Username');
    await expect(create({ contactChannel: 'pigeon' })).rejects.toThrow('Unknown contact channel');
    const username = uniqueUsername();
    await create({ username });
    await expect(create({ username })).rejects.toThrow('already exists');
  });

  it('grants only registered roles with their allowed scopes', async () => {
    const { result: user } = await create();
    const grant = (role: string, scopeKind: 'customer' | 'company' | 'unit') =>
      asUser(() =>
        platform.users.grantRole({
          userId: user.id,
          role,
          scopeKind,
          companyId: null,
          unitId: null,
          reason: 't',
        }),
      );
    await expect(grant('wizard', 'customer')).rejects.toThrow('Unknown role');
    await expect(grant(SystemAdminRole.name, 'company')).rejects.toThrow('cannot be granted');
    await expect(grant('auditor', 'company')).rejects.toThrow('companyId is required');
    const first = (await grant('auditor', 'customer')).result;
    expect((await grant('auditor', 'customer')).result).toEqual(first); // idempotent
  });

  it('never revokes the last system administrator', async () => {
    const existing = await platform.prisma.authRoleAssignment.findMany({
      where: { role: SystemAdminRole.name, scopeKind: 'customer', revokedAt: null },
    });
    for (const grant of existing) {
      await asUser(() => platform.users.revokeRole(grant.id, 'cleanup')).catch(() => undefined);
    }
    const { result: user } = await create();
    const { result: grant } = await asUser(() =>
      platform.users.grantRole({
        userId: user.id,
        role: SystemAdminRole.name,
        scopeKind: 'customer',
        companyId: null,
        unitId: null,
        reason: 'admin',
      }),
    );
    const active = await platform.prisma.authRoleAssignment.count({
      where: { role: SystemAdminRole.name, scopeKind: 'customer', revokedAt: null },
    });
    if (active === 1) {
      await expect(asUser(() => platform.users.revokeRole(grant.id, 'oops'))).rejects.toThrow(
        'last system administrator',
      );
    }
  });
});
