-- 0025_marina_operations.sql
-- The three marina operations the desktop menu has but the API never had: preparing a
-- vessel for its booking, and closing the day.
--
-- `marina_preparations` is one row per booking (a booking is prepared once), holding the
-- pre-departure checklist and the return. It is deliberately a table rather than a
-- `metadata` blob on the booking: "which vessels are out right now" is an operational
-- question the harbour asks every hour, and that has to be an indexed status, not JSON.
--
-- `marina_day_closings` freezes a harbour day. Once `close_date` is closed for a branch,
-- the service refuses new bookings and new rental invoices dated that day, which is the
-- entire point of an إغلاق اليومية: the cash and the vessel movements for that date can
-- no longer change under the supervisor's feet.

CREATE TABLE IF NOT EXISTS marina_preparations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES marina_bookings(id) ON DELETE CASCADE,
  vessel_id uuid NOT NULL REFERENCES vessels(id),
  prepared_on date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'prepared',
  fuel_level text,
  life_jackets int NOT NULL DEFAULT 0,
  checklist jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  returned_at timestamptz,
  return_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CONSTRAINT marina_preparations_jackets_positive CHECK (life_jackets >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS marina_preparations_booking_key ON marina_preparations(tenant_id, booking_id);
CREATE INDEX IF NOT EXISTS marina_preparations_day_idx ON marina_preparations(tenant_id, prepared_on, status);

CREATE TABLE IF NOT EXISTS marina_day_closings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id),
  close_date date NOT NULL,
  bookings_count int NOT NULL DEFAULT 0,
  rentals_count int NOT NULL DEFAULT 0,
  rentals_total numeric(20,4) NOT NULL DEFAULT 0,
  additions_total numeric(20,4) NOT NULL DEFAULT 0,
  insurance_total numeric(20,4) NOT NULL DEFAULT 0,
  violations_total numeric(20,4) NOT NULL DEFAULT 0,
  notes text,
  closed_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS marina_day_closings_day_key ON marina_day_closings(tenant_id, branch_id, close_date);

ALTER TABLE marina_preparations ENABLE ROW LEVEL SECURITY;
ALTER TABLE marina_preparations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marina_preparations_tenant_isolation ON marina_preparations;
CREATE POLICY marina_preparations_tenant_isolation ON marina_preparations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE marina_day_closings ENABLE ROW LEVEL SECURITY;
ALTER TABLE marina_day_closings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marina_day_closings_tenant_isolation ON marina_day_closings;
CREATE POLICY marina_day_closings_tenant_isolation ON marina_day_closings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
