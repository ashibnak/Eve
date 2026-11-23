import { z } from 'zod';
import { defineSetting } from '../config/settings';

const seconds = (min: number, max: number) => z.number().int().min(min).max(max);

/**
 * Login policy. Defaults are the product-owner decisions of S1 (2026-11-22); each customer may
 * change them through the audited settings path.
 */
export const AuthSettings = {
  otpTtlSeconds: defineSetting({
    key: 'auth.otp_ttl_seconds',
    schema: seconds(30, 900),
    scope: 'customer',
    default: 120,
  }),
  otpMaxAttempts: defineSetting({
    key: 'auth.otp_max_attempts',
    schema: z.number().int().min(1).max(10),
    scope: 'customer',
    default: 5,
  }),
  passwordMaxFailures: defineSetting({
    key: 'auth.password_max_failures',
    schema: z.number().int().min(3).max(20),
    scope: 'customer',
    default: 5,
  }),
  lockoutSeconds: defineSetting({
    key: 'auth.lockout_seconds',
    schema: seconds(60, 86_400),
    scope: 'customer',
    default: 900,
  }),
  sessionIdleSeconds: defineSetting({
    key: 'auth.session_idle_seconds',
    schema: seconds(300, 86_400),
    scope: 'customer',
    default: 1_800,
  }),
  sessionAbsoluteSeconds: defineSetting({
    key: 'auth.session_absolute_seconds',
    schema: seconds(900, 7 * 86_400),
    scope: 'customer',
    default: 43_200,
  }),
  /** Not decided by the product owner; 12 is the engineering default (S1b note). */
  passwordMinLength: defineSetting({
    key: 'auth.password_min_length',
    schema: z.number().int().min(8).max(128),
    scope: 'customer',
    default: 12,
  }),
} as const;

/** How long a half-finished login (password ok, code not yet entered) stays usable. */
export const PENDING_SESSION_SECONDS = 600;
