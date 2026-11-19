CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_records (
  event_id            TEXT PRIMARY KEY,
  principal           TEXT NOT NULL,
  bank_id             TEXT NOT NULL,
  occurred_at         TIMESTAMPTZ,
  recorded_at         TIMESTAMPTZ NOT NULL,
  valid_from          TIMESTAMPTZ,
  valid_to            TIMESTAMPTZ,
  content             TEXT NOT NULL,
  scene               TEXT,
  raw_pointer         TEXT,
  dedupe_fingerprint  TEXT NOT NULL,
  state               TEXT NOT NULL,
  accepted_at         TIMESTAMPTZ NOT NULL,
  visible_at          TIMESTAMPTZ,
  provenance          JSONB,
  vector              JSONB,
  archive_reason      TEXT,
  mental_model        TEXT,
  facts               JSONB,
  contract_version    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_records_bank_state
  ON memory_records (bank_id, state);

CREATE INDEX IF NOT EXISTS idx_memory_records_recorded_at
  ON memory_records (recorded_at DESC);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  event_id             TEXT PRIMARY KEY
                       REFERENCES memory_records(event_id) ON DELETE CASCADE,
  embedding            vector(16),
  dim                  INTEGER NOT NULL,
  quantization_version TEXT NOT NULL,
  contract_version     TEXT NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_audit_log (
  id               TEXT PRIMARY KEY,
  at               TIMESTAMPTZ NOT NULL,
  event            TEXT NOT NULL,
  principal        TEXT,
  bank_id          TEXT,
  operation        TEXT,
  request_id       TEXT,
  payload          JSONB,
  contract_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_audit_at
  ON memory_audit_log (at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_audit_principal_bank
  ON memory_audit_log (principal, bank_id, at DESC);
