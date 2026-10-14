-- 0105 — employee mobile PWA (PHASE_09)
--
-- 0103 is Mudad/Moyasar and 0104 is the accounting assistant, so this phase uses 0105.
-- Fingerprint attendance_logs stay untouched. Mobile punches live in employee_attendance
-- so a GPS row cannot collide with a device fingerprint.

CREATE TABLE IF NOT EXISTS employee_geofences (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  lat numeric(9, 6) NOT NULL,
  lng numeric(9, 6) NOT NULL,
  radius_meters integer NOT NULL DEFAULT 200,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_geofences_lat_check CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT employee_geofences_lng_check CHECK (lng BETWEEN -180 AND 180),
  CONSTRAINT employee_geofences_radius_check CHECK (radius_meters BETWEEN 1 AND 50000)
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_geofences_branch_key
  ON employee_geofences (tenant_id, branch_id);

CREATE TABLE IF NOT EXISTS employee_attendance (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  type text NOT NULL,
  at timestamptz NOT NULL,
  lat numeric(9, 6) NOT NULL,
  lng numeric(9, 6) NOT NULL,
  selfie_file_id uuid,
  status text NOT NULL,
  distance_meters integer,
  client_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_attendance_type_check CHECK (type IN ('check_in', 'check_out')),
  CONSTRAINT employee_attendance_status_check CHECK (status IN ('valid', 'outside_geofence')),
  CONSTRAINT employee_attendance_lat_check CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT employee_attendance_lng_check CHECK (lng BETWEEN -180 AND 180)
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_attendance_client_key
  ON employee_attendance (tenant_id, employee_id, client_id)
  WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS employee_attendance_day_idx
  ON employee_attendance (tenant_id, employee_id, at DESC);

CREATE TABLE IF NOT EXISTS employee_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  starts_on date,
  ends_on date,
  reason text NOT NULL DEFAULT '',
  file_id uuid,
  data jsonb NOT NULL DEFAULT '{}',
  approver_membership_id uuid REFERENCES memberships(id) ON DELETE SET NULL,
  decision_note text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_requests_type_check CHECK (type IN ('leave', 'permission', 'custody', 'advance')),
  CONSTRAINT employee_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS employee_requests_status_idx
  ON employee_requests (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS employee_requests_employee_idx
  ON employee_requests (tenant_id, employee_id, created_at DESC);

CREATE TABLE IF NOT EXISTS employee_push_subscriptions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth_secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_push_subscriptions_endpoint_key
  ON employee_push_subscriptions (tenant_id, endpoint);

CREATE TABLE IF NOT EXISTS employee_push_outbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  membership_id uuid REFERENCES memberships(id) ON DELETE SET NULL,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_push_outbox_status_check CHECK (status IN ('queued', 'delivered'))
);

CREATE INDEX IF NOT EXISTS employee_push_outbox_user_idx
  ON employee_push_outbox (tenant_id, user_id, created_at DESC);

ALTER TABLE employee_geofences ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_geofences FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_attendance FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_push_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_push_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_push_outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_geofences_tenant_isolation ON employee_geofences;
CREATE POLICY employee_geofences_tenant_isolation ON employee_geofences
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS employee_attendance_tenant_isolation ON employee_attendance;
CREATE POLICY employee_attendance_tenant_isolation ON employee_attendance
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS employee_requests_tenant_isolation ON employee_requests;
CREATE POLICY employee_requests_tenant_isolation ON employee_requests
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS employee_push_subscriptions_tenant_isolation ON employee_push_subscriptions;
CREATE POLICY employee_push_subscriptions_tenant_isolation ON employee_push_subscriptions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS employee_push_outbox_tenant_isolation ON employee_push_outbox;
CREATE POLICY employee_push_outbox_tenant_isolation ON employee_push_outbox
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  employee_geofences, employee_attendance, employee_requests, employee_push_subscriptions, employee_push_outbox
  TO erp_api;
GRANT ALL PRIVILEGES ON
  employee_geofences, employee_attendance, employee_requests, employee_push_subscriptions, employee_push_outbox
  TO erp_migrator;

INSERT INTO permissions (code, module, description) VALUES
  ('employee.self.view', 'employee', 'Read own attendance, requests, payslips and custodies.'),
  ('employee.self.manage', 'employee', 'Punch attendance and submit own employee requests.'),
  ('employee.team.approve', 'employee', 'Approve or reject team leave, permission, custody and advance requests.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

COMMENT ON TABLE employee_attendance IS
  'PHASE_09: mobile check-in/out. outside_geofence is stored and alerts a manager.';
COMMENT ON TABLE employee_requests IS
  'PHASE_09: leave, permission, custody and advance. Approved leave is what HRM lists.';

ALTER ROLE erp_api NOBYPASSRLS;
