-- org: Module 1 (spec 1.1 §3, §10). Single time axis (ADR-009): every changing fact is a row with
-- [valid_from, valid_to) and an exclusion constraint against overlap; rows are closed, never
-- deleted (CLAUDE.md rule 6). Identity tables hold what never changes (stable id, system code).

-- Company details owned by org, keyed by the platform company id.
CREATE TABLE org_company (
  company_id   uuid        PRIMARY KEY REFERENCES core_company (id),
  name_fa      text        NOT NULL CHECK (name_fa <> ''),
  name_en      text,
  -- Prefix of system codes, e.g. FNP → FNP-U0001, FNP-P00001 (decision 2026-11-25).
  code_prefix  text        NOT NULL UNIQUE CHECK (code_prefix ~ '^[A-Z0-9]{2,10}$'),
  -- Legal identity, validated with the company's jurisdiction pack (ADR-010).
  legal_fields jsonb       NOT NULL DEFAULT '{}'::jsonb,
  next_unit_no     integer NOT NULL DEFAULT 1,
  next_position_no integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);

-- Unit levels are defined per company (spec §12), e.g. معاونت، مدیریت، اداره، تیم.
CREATE TABLE org_unit_level (
  id         uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid    NOT NULL REFERENCES org_company (company_id),
  name_fa    text    NOT NULL,
  name_en    text,
  rank       integer NOT NULL CHECK (rank >= 1),
  CONSTRAINT org_unit_level_rank_uq UNIQUE (company_id, rank)
);

CREATE TABLE org_unit (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid        NOT NULL REFERENCES org_company (company_id),
  code       text        NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT org_unit_code_uq UNIQUE (company_id, code)
);

CREATE TABLE org_unit_version (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id                uuid        NOT NULL REFERENCES org_unit (id),
  company_id             uuid        NOT NULL REFERENCES org_company (company_id),
  legacy_code            text,
  name_fa                text        NOT NULL CHECK (name_fa <> ''),
  name_en                text,
  level_id               uuid        REFERENCES org_unit_level (id),
  parent_unit_id         uuid        REFERENCES org_unit (id),
  cost_center            text,
  location               text,
  supervisor_position_id uuid,
  status                 text        NOT NULL CHECK (status IN ('active', 'closed')),
  valid_from             date        NOT NULL,
  valid_to               date,
  recorded_at            timestamptz NOT NULL,
  CONSTRAINT org_unit_version_period_ck CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT org_unit_version_no_overlap EXCLUDE USING gist (
    unit_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);
CREATE INDEX org_unit_version_company_idx ON org_unit_version (company_id, valid_from);
CREATE INDEX org_unit_version_parent_idx ON org_unit_version (parent_unit_id);

CREATE TABLE org_position (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid        NOT NULL REFERENCES org_company (company_id),
  code       text        NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT org_position_code_uq UNIQUE (company_id, code)
);

ALTER TABLE org_unit_version
  ADD CONSTRAINT org_unit_version_supervisor_fk FOREIGN KEY (supervisor_position_id) REFERENCES org_position (id);

CREATE TABLE org_position_version (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id uuid         NOT NULL REFERENCES org_position (id),
  company_id  uuid         NOT NULL REFERENCES org_company (company_id),
  legacy_code text,
  title_fa    text         NOT NULL CHECK (title_fa <> ''),
  title_en    text,
  unit_id     uuid         NOT NULL REFERENCES org_unit (id),
  -- Job from the grading module (R3); empty until then.
  job_id      text,
  type        text         NOT NULL CHECK (type IN ('approved', 'project', 'temporary')),
  fte         numeric(4,3) NOT NULL CHECK (fte > 0 AND fte <= 1),
  supervisory boolean      NOT NULL,
  status      text         NOT NULL CHECK (status IN ('active', 'frozen', 'closed')),
  source      text         NOT NULL CHECK (source IN ('official', 'proposed')),
  valid_from  date         NOT NULL,
  valid_to    date,
  recorded_at timestamptz  NOT NULL,
  CONSTRAINT org_position_version_period_ck CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT org_position_version_no_overlap EXCLUDE USING gist (
    position_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);
CREATE INDEX org_position_version_company_idx ON org_position_version (company_id, valid_from);
CREATE INDEX org_position_version_unit_idx ON org_position_version (unit_id);

-- Reporting lines run between positions, not people (spec §3).
CREATE TABLE org_reporting_line (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL REFERENCES org_company (company_id),
  from_position_id uuid        NOT NULL REFERENCES org_position (id),
  to_position_id   uuid        NOT NULL REFERENCES org_position (id),
  kind             text        NOT NULL CHECK (kind IN ('direct', 'dotted', 'project')),
  valid_from       date        NOT NULL,
  valid_to         date,
  recorded_at      timestamptz NOT NULL,
  CONSTRAINT org_reporting_line_period_ck CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT org_reporting_line_not_self_ck CHECK (from_position_id <> to_position_id),
  -- At most one direct line per position per day (R2's "exactly one" is checked by the rule, S6).
  CONSTRAINT org_reporting_line_one_direct EXCLUDE USING gist (
    from_position_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&) WHERE (kind = 'direct'),
  CONSTRAINT org_reporting_line_no_duplicate EXCLUDE USING gist (
    from_position_id WITH =, to_position_id WITH =, kind WITH =, daterange(valid_from, valid_to, '[)') WITH &&)
);
CREATE INDEX org_reporting_line_to_idx ON org_reporting_line (to_position_id, kind);
CREATE INDEX org_reporting_line_company_idx ON org_reporting_line (company_id, kind);

-- Person on a position. person_id refers to the people module (no cross-module foreign key).
CREATE TABLE org_assignment (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid         NOT NULL REFERENCES org_company (company_id),
  person_id    uuid         NOT NULL,
  position_id  uuid         NOT NULL REFERENCES org_position (id),
  kind         text         NOT NULL CHECK (kind IN ('primary', 'acting', 'temporary_supervision', 'project')),
  time_share   numeric(4,3) NOT NULL CHECK (time_share > 0 AND time_share <= 1),
  source       text         NOT NULL CHECK (source IN ('import', 'correction', 'change_request', 'personnel_action')),
  -- Change request, personnel action or import id that created it.
  action_ref   text,
  order_number text,
  valid_from   date         NOT NULL,
  valid_to     date,
  recorded_at  timestamptz  NOT NULL,
  CONSTRAINT org_assignment_period_ck CHECK (valid_to IS NULL OR valid_to > valid_from),
  -- R3 (first half): one primary assignment per person at a time.
  CONSTRAINT org_assignment_one_primary_per_person EXCLUDE USING gist (
    person_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&) WHERE (kind = 'primary')
);
CREATE INDEX org_assignment_position_idx ON org_assignment (position_id, kind);
CREATE INDEX org_assignment_person_idx ON org_assignment (person_id);
CREATE INDEX org_assignment_company_idx ON org_assignment (company_id, valid_from);

-- R15: a supervisory position has at most one primary incumbent at a time (spec §5, B3).
-- Concurrent writes on one position are serialized by a transaction advisory lock (the app role
-- cannot lock rows FOR UPDATE on tables it may not update).
CREATE FUNCTION org_check_r15() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  clash uuid;
BEGIN
  IF TG_TABLE_NAME = 'org_assignment' THEN
    IF NEW.kind <> 'primary' THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('org_r15:' || NEW.position_id::text));
    SELECT a.id INTO clash
    FROM org_assignment a
    JOIN org_position_version v ON v.position_id = a.position_id AND v.supervisory
    WHERE a.position_id = NEW.position_id AND a.id <> NEW.id AND a.kind = 'primary'
      AND daterange(a.valid_from, a.valid_to, '[)') && daterange(NEW.valid_from, NEW.valid_to, '[)')
      AND daterange(v.valid_from, v.valid_to, '[)')
          && (daterange(a.valid_from, a.valid_to, '[)') * daterange(NEW.valid_from, NEW.valid_to, '[)'))
    LIMIT 1;
  ELSE -- a position version that is (or becomes) supervisory
    IF NOT NEW.supervisory THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('org_r15:' || NEW.position_id::text));
    SELECT a.id INTO clash
    FROM org_assignment a
    JOIN org_assignment b ON b.position_id = a.position_id AND b.id <> a.id AND b.kind = 'primary'
    WHERE a.position_id = NEW.position_id AND a.kind = 'primary'
      AND daterange(a.valid_from, a.valid_to, '[)') && daterange(b.valid_from, b.valid_to, '[)')
      AND (daterange(a.valid_from, a.valid_to, '[)') * daterange(b.valid_from, b.valid_to, '[)'))
          && daterange(NEW.valid_from, NEW.valid_to, '[)')
    LIMIT 1;
  END IF;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'R15: supervisory position % would have two primary incumbents at once', NEW.position_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER org_assignment_r15 BEFORE INSERT OR UPDATE ON org_assignment
  FOR EACH ROW EXECUTE FUNCTION org_check_r15();
CREATE TRIGGER org_position_version_r15 BEFORE INSERT OR UPDATE ON org_position_version
  FOR EACH ROW EXECUTE FUNCTION org_check_r15();

-- Nothing is deleted; versions and assignments are only closed (valid_to).
REVOKE DELETE, TRUNCATE ON TABLE org_company, org_unit_level, org_unit, org_unit_version, org_position,
  org_position_version, org_reporting_line, org_assignment FROM eve_app;
REVOKE UPDATE ON TABLE org_unit, org_unit_version, org_position, org_position_version,
  org_reporting_line, org_assignment FROM eve_app;
GRANT UPDATE (valid_to) ON TABLE org_unit_version, org_position_version, org_reporting_line, org_assignment TO eve_app;
