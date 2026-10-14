-- 0107 — supplier portal and simple e-sign (PHASE_11)
--
-- 0105 is the employee app and 0106 is warehouse bins, so this phase uses 0107.
-- The signature is a drawing plus a one-time code. It is not an XAdES signature.

CREATE TABLE IF NOT EXISTS supplier_portal_users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  email text NOT NULL,
  password_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS supplier_portal_users_email_key
  ON supplier_portal_users (tenant_id, email);
CREATE INDEX IF NOT EXISTS supplier_portal_users_party_idx
  ON supplier_portal_users (tenant_id, party_id);

CREATE TABLE IF NOT EXISTS supplier_portal_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES supplier_portal_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS supplier_portal_sessions_token_key
  ON supplier_portal_sessions (tenant_id, token_hash);

CREATE TABLE IF NOT EXISTS supplier_rfqs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  number text NOT NULL,
  title text NOT NULL,
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  offer numeric(20, 4),
  response_note text,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT supplier_rfqs_status_check CHECK (status IN ('open', 'responded', 'closed')),
  CONSTRAINT supplier_rfqs_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 160)
);

CREATE UNIQUE INDEX IF NOT EXISTS supplier_rfqs_number_key ON supplier_rfqs (tenant_id, number);
CREATE INDEX IF NOT EXISTS supplier_rfqs_party_idx ON supplier_rfqs (tenant_id, party_id, status);

CREATE TABLE IF NOT EXISTS supplier_invoice_uploads (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  reference_no text NOT NULL,
  declared_total numeric(20, 4) NOT NULL,
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'submitted',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_invoice_uploads_total_check CHECK (declared_total > 0)
);

CREATE INDEX IF NOT EXISTS supplier_invoice_uploads_party_idx
  ON supplier_invoice_uploads (tenant_id, party_id, created_at DESC);

CREATE TABLE IF NOT EXISTS esign_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  signer_name text NOT NULL DEFAULT '',
  signer_email text NOT NULL,
  token_hash text NOT NULL,
  otp_hash text NOT NULL,
  status text NOT NULL DEFAULT 'sent',
  signed_file_id uuid,
  signed_pdf bytea,
  signed_at timestamptz,
  expires_at timestamptz NOT NULL,
  ip text,
  payload text NOT NULL DEFAULT '{}',
  created_by uuid,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT esign_requests_status_check CHECK (status IN ('sent', 'viewed', 'signed', 'declined')),
  CONSTRAINT esign_requests_entity_check CHECK (entity_type IN ('sales_quotation', 'sales_invoice', 'contract'))
);

CREATE UNIQUE INDEX IF NOT EXISTS esign_requests_token_key ON esign_requests (tenant_id, token_hash);
CREATE INDEX IF NOT EXISTS esign_requests_entity_idx ON esign_requests (tenant_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS esign_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES esign_requests(id) ON DELETE CASCADE,
  event text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  ip text,
  CONSTRAINT esign_events_event_check CHECK (event IN ('sent', 'viewed', 'signed', 'declined'))
);

CREATE INDEX IF NOT EXISTS esign_events_request_idx ON esign_events (tenant_id, request_id, at DESC);

ALTER TABLE supplier_portal_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_portal_users FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_portal_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_portal_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_rfqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_rfqs FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_invoice_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_invoice_uploads FORCE ROW LEVEL SECURITY;
ALTER TABLE esign_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE esign_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE esign_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE esign_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS supplier_portal_users_tenant_isolation ON supplier_portal_users;
CREATE POLICY supplier_portal_users_tenant_isolation ON supplier_portal_users
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS supplier_portal_sessions_tenant_isolation ON supplier_portal_sessions;
CREATE POLICY supplier_portal_sessions_tenant_isolation ON supplier_portal_sessions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS supplier_rfqs_tenant_isolation ON supplier_rfqs;
CREATE POLICY supplier_rfqs_tenant_isolation ON supplier_rfqs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS supplier_invoice_uploads_tenant_isolation ON supplier_invoice_uploads;
CREATE POLICY supplier_invoice_uploads_tenant_isolation ON supplier_invoice_uploads
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS esign_requests_tenant_isolation ON esign_requests;
CREATE POLICY esign_requests_tenant_isolation ON esign_requests
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS esign_events_tenant_isolation ON esign_events;
CREATE POLICY esign_events_tenant_isolation ON esign_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  supplier_portal_users, supplier_portal_sessions, supplier_rfqs, supplier_invoice_uploads, esign_requests, esign_events
  TO erp_api;
GRANT ALL PRIVILEGES ON
  supplier_portal_users, supplier_portal_sessions, supplier_rfqs, supplier_invoice_uploads, esign_requests, esign_events
  TO erp_migrator;

INSERT INTO permissions (code, module, description) VALUES
  ('supplier_portal.access', 'supplier_portal', 'Invite suppliers and read their portal submissions.'),
  ('esign.manage', 'esign', 'Send a document for a simple drawn signature.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_code)
SELECT role_id, 'supplier_portal.access'
FROM role_permissions
WHERE permission_code IN ('parties.manage', 'purchase.invoice.create')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT role_id, 'esign.manage'
FROM role_permissions
WHERE permission_code = 'sales.invoice.create'
ON CONFLICT DO NOTHING;

COMMENT ON TABLE esign_requests IS
  'PHASE_11: drawn signature plus OTP. Not a legally qualified XAdES signature.';

ALTER ROLE erp_api NOBYPASSRLS;
