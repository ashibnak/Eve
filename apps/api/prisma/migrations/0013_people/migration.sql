-- people core (ADR-008, build plan S4): the person register that org refers to.
-- One person record per company (product-owner decision, S4); identity fields are corrected in
-- place with an audit row, employment status is effective-dated history.
CREATE TABLE people_person (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL REFERENCES core_company (id),
  personnel_code  text        NOT NULL CHECK (personnel_code <> ''),
  first_name_fa   text        NOT NULL CHECK (first_name_fa <> ''),
  last_name_fa    text        NOT NULL CHECK (last_name_fa <> ''),
  first_name_en   text,
  last_name_en    text,
  hire_date       date        NOT NULL,
  contact_channel text        CHECK (contact_channel IN ('bale', 'sms')),
  contact_address text,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  -- Unique per company, not across the group (product-owner decision, S4).
  CONSTRAINT people_person_code_uq UNIQUE (company_id, personnel_code),
  CONSTRAINT people_person_contact_ck CHECK ((contact_channel IS NULL) = (contact_address IS NULL))
);

-- Employment status over time: [valid_from, valid_to), valid_to NULL = current.
CREATE TABLE people_employment_status (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid        NOT NULL REFERENCES people_person (id),
  company_id  uuid        NOT NULL REFERENCES core_company (id),
  status      text        NOT NULL CHECK (status IN ('active', 'on_leave', 'suspended', 'terminated')),
  valid_from  date        NOT NULL,
  valid_to    date,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT people_employment_status_period_ck CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT people_employment_status_no_overlap EXCLUDE USING gist (
    person_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  )
);
CREATE INDEX people_employment_status_company_idx ON people_employment_status (company_id, valid_from);

-- Nothing is deleted; a status period is only ever closed (CLAUDE.md rule 6).
REVOKE DELETE, TRUNCATE ON TABLE people_person, people_employment_status FROM eve_app;
REVOKE UPDATE ON TABLE people_employment_status FROM eve_app;
GRANT UPDATE (valid_to) ON TABLE people_employment_status TO eve_app;
