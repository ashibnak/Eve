-- Which person a login is, per company (decision 2026-11-25: link by company + personnel code,
-- set by the people data owner; one login per person per company). Needed to know someone's team
-- and their own manager. Links are ended, never deleted.
CREATE TABLE people_user_link (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth_user (id),
  company_id uuid        NOT NULL REFERENCES core_company (id),
  person_id  uuid        NOT NULL REFERENCES people_person (id),
  linked_at  timestamptz NOT NULL,
  ended_at   timestamptz,
  CONSTRAINT people_user_link_period_ck CHECK (ended_at IS NULL OR ended_at >= linked_at)
);
CREATE UNIQUE INDEX people_user_link_user_uq ON people_user_link (user_id, company_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX people_user_link_person_uq ON people_user_link (person_id) WHERE ended_at IS NULL;

REVOKE DELETE, TRUNCATE ON TABLE people_user_link FROM eve_app;
REVOKE UPDATE ON TABLE people_user_link FROM eve_app;
GRANT UPDATE (ended_at) ON TABLE people_user_link TO eve_app;
