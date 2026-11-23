-- Local authentication: password + one-time code as second factor (S1b).
-- Users are customer-level platform accounts; access is granted per role and scope.
CREATE TABLE auth_user (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  username                 text        NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{3,64}$'),
  password_hash            text        NOT NULL,
  status                   text        NOT NULL CHECK (status IN ('active', 'disabled')),
  -- Where one-time codes go: a platform Channel kind and the address on it.
  contact_channel          text        NOT NULL,
  contact_address          text        NOT NULL,
  failed_password_attempts integer     NOT NULL DEFAULT 0,
  locked_until             timestamptz,
  created_at               timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL
);

-- A session is referenced by an opaque cookie token; only its SHA-256 is stored.
CREATE TABLE auth_session (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   char(64)    NOT NULL UNIQUE,
  user_id      uuid        NOT NULL REFERENCES auth_user (id),
  stage        text        NOT NULL CHECK (stage IN ('otp_pending', 'active')),
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX auth_session_user_idx ON auth_session (user_id);

CREATE TABLE auth_otp (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid        NOT NULL REFERENCES auth_session (id),
  code_hash   char(64)    NOT NULL,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer     NOT NULL DEFAULT 0,
  consumed_at timestamptz
);
CREATE INDEX auth_otp_session_idx ON auth_otp (session_id, created_at);

-- Role grants with their scope (CLAUDE.md rule 11). Closed by revoked_at, never deleted.
CREATE TABLE auth_role_assignment (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth_user (id),
  role       text        NOT NULL,
  scope_kind text        NOT NULL CHECK (scope_kind IN ('customer', 'company', 'unit')),
  company_id uuid        REFERENCES core_company (id),
  -- org unit id (opaque to the platform); resolved through the unit-subtree port.
  unit_id    uuid,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT auth_role_assignment_scope_ck CHECK (
    (scope_kind = 'customer' AND company_id IS NULL AND unit_id IS NULL)
    OR (scope_kind = 'company' AND company_id IS NOT NULL AND unit_id IS NULL)
    OR (scope_kind = 'unit' AND company_id IS NOT NULL AND unit_id IS NOT NULL)
  )
);
CREATE INDEX auth_role_assignment_user_idx ON auth_role_assignment (user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX auth_role_assignment_active_uq
  ON auth_role_assignment (user_id, role, scope_kind, company_id, unit_id) NULLS NOT DISTINCT
  WHERE revoked_at IS NULL;

-- Sessions and codes are short-lived security state; the app never removes them.
REVOKE DELETE, TRUNCATE ON auth_user, auth_session, auth_otp, auth_role_assignment FROM eve_app;
