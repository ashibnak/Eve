import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  hexEquals,
  newOtpCode,
  newSessionToken,
  otpHash,
  verifyPassword,
} from './crypto';

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterY', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('x', 'md5$abc')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });
});

describe('tokens and codes', () => {
  it('makes 256-bit session tokens', () => {
    expect(Buffer.from(newSessionToken(), 'base64url')).toHaveLength(32);
  });

  it('makes six-digit codes', () => {
    for (let i = 0; i < 200; i += 1) expect(newOtpCode()).toMatch(/^\d{6}$/);
  });

  it('binds a code to its session', () => {
    expect(otpHash('s1', '123456')).not.toBe(otpHash('s2', '123456'));
    expect(hexEquals(otpHash('s1', '123456'), otpHash('s1', '123456'))).toBe(true);
    expect(hexEquals(otpHash('s1', '123456'), otpHash('s1', '123457'))).toBe(false);
  });
});
