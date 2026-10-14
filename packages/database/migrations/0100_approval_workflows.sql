-- 0100 — sequential tenant-scoped approval workflow engine (Phase 04)
--
-- 0099 is already used by ecommerce stores/orders.  Approval steps and decisions use
-- parent-row RLS policies because their tenant is reached through the workflow/request.

CREATE TABLE IF NOT EXISTS approval_workflows (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity       text NOT NULL,
  name         text NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at   timestamptz,
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  version      integer NOT NULL DEFAULT 1,
  CONSTRAINT approval_workflows_entity_check
    CHECK (entity IN ('sales_invoice', 'purchase_invoice', 'voucher', 'expense', 'leave')),
  CONSTRAINT approval_workflows_tenant_name_key UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS approval_workflows_tenant_entity_idx
  ON approval_workflows(tenant_id, entity, is_active);

CREATE TABLE IF NOT EXISTS approval_steps (
  id                uuid PRIMARY KEY,
  workflow_id       uuid NOT NULL REFERENCES approval_workflows(id) ON DELETE CASCADE,
  step_order        integer NOT NULL,
  approver_role     text,
  approver_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  condition_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  action            text NOT NULL DEFAULT 'approve',
  is_required       boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_steps_order_check CHECK (step_order > 0),
  CONSTRAINT approval_steps_target_check CHECK (approver_role IS NOT NULL OR approver_user_id IS NOT NULL),
  CONSTRAINT approval_steps_action_check CHECK (action IN ('approve', 'notify')),
  CONSTRAINT approval_steps_workflow_order_key UNIQUE (workflow_id, step_order)
);

CREATE INDEX IF NOT EXISTS approval_steps_workflow_idx
  ON approval_steps(workflow_id, step_order);

CREATE TABLE IF NOT EXISTS approval_requests (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id         uuid NOT NULL REFERENCES approval_workflows(id) ON DELETE RESTRICT,
  entity_type         text NOT NULL,
  entity_id           uuid NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  current_step_order  integer,
  context_json        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz,
  CONSTRAINT approval_requests_entity_check
    CHECK (entity_type IN ('sales_invoice', 'purchase_invoice', 'voucher', 'expense', 'leave')),
  CONSTRAINT approval_requests_status_check
    CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_pending_entity_key
  ON approval_requests(tenant_id, entity_type, entity_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS approval_requests_tenant_status_idx
  ON approval_requests(tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS approval_requests_tenant_entity_idx
  ON approval_requests(tenant_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS approval_decisions (
  id          uuid PRIMARY KEY,
  request_id  uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  step_id     uuid NOT NULL REFERENCES approval_steps(id) ON DELETE RESTRICT,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision    text NOT NULL,
  comment     text,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_decisions_decision_check CHECK (decision IN ('approved', 'rejected')),
  CONSTRAINT approval_decisions_request_step_key UNIQUE (request_id, step_id)
);

CREATE INDEX IF NOT EXISTS approval_decisions_request_idx
  ON approval_decisions(request_id, decided_at);
CREATE INDEX IF NOT EXISTS approval_decisions_user_idx
  ON approval_decisions(user_id, decided_at);

-- RLS is deliberately enabled on every approval table.  Steps/decisions derive tenant
-- ownership through their parent instead of trusting a client-provided tenant column.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['approval_workflows', 'approval_steps', 'approval_requests', 'approval_decisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;

DROP POLICY IF EXISTS approval_workflows_tenant_isolation ON approval_workflows;
CREATE POLICY approval_workflows_tenant_isolation ON approval_workflows
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS approval_requests_tenant_isolation ON approval_requests;
CREATE POLICY approval_requests_tenant_isolation ON approval_requests
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM approval_workflows workflow
       WHERE workflow.id = approval_requests.workflow_id
         AND workflow.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    )
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM approval_workflows workflow
       WHERE workflow.id = approval_requests.workflow_id
         AND workflow.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    )
  );

DROP POLICY IF EXISTS approval_steps_parent_tenant_isolation ON approval_steps;
CREATE POLICY approval_steps_parent_tenant_isolation ON approval_steps
  USING (EXISTS (
    SELECT 1 FROM approval_workflows workflow
     WHERE workflow.id = approval_steps.workflow_id
       AND workflow.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM approval_workflows workflow
     WHERE workflow.id = approval_steps.workflow_id
       AND workflow.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  ));

DROP POLICY IF EXISTS approval_decisions_parent_tenant_isolation ON approval_decisions;
CREATE POLICY approval_decisions_parent_tenant_isolation ON approval_decisions
  USING (EXISTS (
    SELECT 1 FROM approval_requests request
     WHERE request.id = approval_decisions.request_id
       AND request.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM approval_requests request
     WHERE request.id = approval_decisions.request_id
       AND request.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON approval_workflows, approval_steps, approval_requests, approval_decisions TO erp_api;
GRANT ALL PRIVILEGES ON approval_workflows, approval_steps, approval_requests, approval_decisions TO erp_migrator;

INSERT INTO permissions (code, module, description) VALUES
  ('approval.manage', 'approval', 'Create and maintain tenant approval workflows.'),
  ('approval.approve', 'approval', 'Review, approve and reject assigned approval requests.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;
