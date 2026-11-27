-- Issued documents (S11): one row per PDF the platform printed. Insert-only: a document is never
-- changed or deleted; a mistaken one is superseded by its owning module (e.g. a revoked letter).

CREATE TABLE doc_document (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL REFERENCES core_company (id),
  -- Template and jurisdiction layout, each with the exact version it was printed with.
  template_id      text        NOT NULL,
  template_version integer     NOT NULL CHECK (template_version > 0),
  layout_id        text        NOT NULL,
  layout_version   integer     NOT NULL CHECK (layout_version > 0),
  language         text        NOT NULL CHECK (language IN ('fa', 'en')),
  -- Number from the owning module's register, if it numbers its documents.
  number           text,
  issued_on        date        NOT NULL,
  -- SHA-256 of the canonical inputs (data + letterhead + versions): same inputs, same document.
  inputs_hash      char(64)    NOT NULL,
  file_ref         char(64)    NOT NULL,
  file_size        integer     NOT NULL CHECK (file_size > 0),
  issued_at        timestamptz NOT NULL,
  actor_kind       text        NOT NULL,
  actor_id         text        NOT NULL,
  source           text        NOT NULL CHECK (source IN ('manual', 'file', 'agent', 'workflow')),
  correlation_id   uuid        NOT NULL
);
CREATE INDEX doc_document_company_idx ON doc_document (company_id, issued_at DESC);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE doc_document FROM eve_app;
