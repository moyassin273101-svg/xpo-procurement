-- شركة إكس: طلبات الشراء والفواتير. المراحل والأدوار مطابقة لـ src/xpo/engine.js

CREATE TABLE vendors (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  vat_number TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('engineer','pm','cfo','ceo','finance','ops','procurement','supplier','admin')),
  project       TEXT,                       -- engineer / pm
  vendor_id     INT REFERENCES vendors(id), -- supplier
  password_hash TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (role NOT IN ('engineer','pm') OR project IS NOT NULL),
  CHECK (role <> 'supplier' OR vendor_id IS NOT NULL)
);

CREATE TABLE budgets (
  id          SERIAL PRIMARY KEY,
  project     TEXT NOT NULL,
  fiscal_year INT NOT NULL,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  UNIQUE (project, fiscal_year)
);

CREATE TABLE requests (
  id            SERIAL PRIMARY KEY,
  no            TEXT NOT NULL UNIQUE,
  requester_id  INT NOT NULL REFERENCES users(id),
  project       TEXT NOT NULL,
  vendor_id     INT NOT NULL REFERENCES vendors(id),
  item          TEXT NOT NULL,
  qty           NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  vat_included  BOOLEAN NOT NULL,
  total         NUMERIC(14,2) NOT NULL CHECK (total > 0),
  quote_ref     TEXT NOT NULL,
  quotes_count  INT NOT NULL DEFAULT 1,
  notes         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  stages        TEXT[] NOT NULL,            -- subset/prefix of {pm,cfo,ceo}
  grouping      JSONB,                      -- {combinedTotal, relatedNos, overridden}
  dup_confirmed TEXT[],                     -- request numbers the requester confirmed are not duplicates
  flags         TEXT[] NOT NULL DEFAULT '{}', -- split, dup, after_reject, missing_cfo, missing_ceo, near_threshold, no_approver
  legacy        JSONB,                      -- original Excel row for imported requests
  dispatched_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ
);
CREATE INDEX requests_status_idx ON requests(status);
CREATE INDEX requests_requester_idx ON requests(requester_id, created_at);
CREATE INDEX requests_project_idx ON requests(project);

CREATE TABLE delegations (
  id         SERIAL PRIMARY KEY,
  from_id    INT NOT NULL REFERENCES users(id),
  to_id      INT NOT NULL REFERENCES users(id),
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (from_id <> to_id)
);

CREATE TABLE approvals (
  id            SERIAL PRIMARY KEY,
  request_id    INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL CHECK (stage IN ('pm','cfo','ceo')),
  user_id       INT NOT NULL REFERENCES users(id),
  on_behalf_of  INT REFERENCES users(id),
  delegation_id INT REFERENCES delegations(id),
  decision      TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  comment       TEXT NOT NULL DEFAULT '',
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX approvals_request_idx ON approvals(request_id);

CREATE TABLE invoices (
  id           SERIAL PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,         -- INV-0001
  po_no        TEXT NOT NULL,
  project      TEXT NOT NULL DEFAULT '',
  vendor       TEXT NOT NULL,
  invoice_no   TEXT NOT NULL DEFAULT '',
  vat_no       TEXT NOT NULL DEFAULT '',
  subtotal     NUMERIC(14,2),
  vat          NUMERIC(14,2),
  amount       NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  qty          NUMERIC(14,3),
  date         DATE,
  source       TEXT NOT NULL DEFAULT 'manual',
  extracted_by TEXT,
  raw          TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review','posted','rejected')),
  verdict      TEXT NOT NULL CHECK (verdict IN ('clean','review','blocked')),
  flags        JSONB NOT NULL DEFAULT '[]',
  override     JSONB,
  reject_reason TEXT,
  created_by   INT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_by    INT REFERENCES users(id),
  posted_at    TIMESTAMPTZ
);
CREATE INDEX invoices_po_idx ON invoices(po_no);

-- Hash-chained, append-only audit log (SHA-256)
CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL,
  actor_id   INT REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  data       JSONB NOT NULL DEFAULT '{}',
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE
);
CREATE INDEX audit_entity_idx ON audit_log(entity, entity_id);

CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
