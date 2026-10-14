-- Future enhancement 16 — Kanban, Gantt and time on a project.
-- 0110 is the CRM migration, so this is 0112.
-- Columns are project stages. There is no resource workload and no MS Project export.

CREATE TABLE IF NOT EXISTS project_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage_id uuid NOT NULL REFERENCES project_stages(id) ON DELETE RESTRICT,
  boq_term_id uuid REFERENCES boq_terms(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  assignee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'todo',
  priority text NOT NULL DEFAULT 'normal',
  start_date date,
  due_date date,
  estimated_hours numeric(20, 4) NOT NULL DEFAULT 0,
  actual_hours numeric(20, 4) NOT NULL DEFAULT 0,
  expense_amount numeric(20, 4) NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_tasks_title_check CHECK (char_length(title) BETWEEN 1 AND 160),
  CONSTRAINT project_tasks_status_check CHECK (status IN ('todo', 'in_progress', 'done')),
  CONSTRAINT project_tasks_priority_check CHECK (priority IN ('low', 'normal', 'high')),
  CONSTRAINT project_tasks_dates_check CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date),
  CONSTRAINT project_tasks_hours_check CHECK (estimated_hours >= 0 AND actual_hours >= 0 AND expense_amount >= 0)
);

CREATE INDEX IF NOT EXISTS project_tasks_board_idx
  ON project_tasks (tenant_id, project_id, stage_id, sort_order);
CREATE INDEX IF NOT EXISTS project_tasks_term_idx ON project_tasks (tenant_id, boq_term_id);

CREATE TABLE IF NOT EXISTS project_time_logs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  hours numeric(20, 4) NOT NULL,
  log_date date NOT NULL DEFAULT CURRENT_DATE,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_time_logs_hours_check CHECK (hours > 0 AND hours <= 24)
);

CREATE INDEX IF NOT EXISTS project_time_logs_task_idx
  ON project_time_logs (tenant_id, task_id, log_date);

CREATE TABLE IF NOT EXISTS project_dependencies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'finish_to_start',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_dependencies_kind_check CHECK (kind = 'finish_to_start'),
  CONSTRAINT project_dependencies_self_check CHECK (task_id <> depends_on_task_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS project_dependencies_once_key
  ON project_dependencies (task_id, depends_on_task_id);
CREATE INDEX IF NOT EXISTS project_dependencies_task_idx
  ON project_dependencies (tenant_id, task_id);

ALTER TABLE project_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON project_tasks;
CREATE POLICY tenant_isolation ON project_tasks
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE project_time_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_time_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON project_time_logs;
CREATE POLICY tenant_isolation ON project_time_logs
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE project_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_dependencies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON project_dependencies;
CREATE POLICY tenant_isolation ON project_dependencies
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON project_tasks, project_time_logs, project_dependencies TO erp_api;
GRANT ALL PRIVILEGES ON project_tasks, project_time_logs, project_dependencies TO erp_migrator;

INSERT INTO permissions (code, module, description) VALUES
  ('projects.tasks.view', 'projects', 'Read project tasks, the board, the Gantt and the BOQ comparison.'),
  ('projects.tasks.manage', 'projects', 'Create tasks, move a Kanban card, and edit dates or dependencies.'),
  ('projects.time_logs.manage', 'projects', 'Log hours on a project task.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_code)
SELECT DISTINCT rp.role_id, 'projects.tasks.view'
FROM role_permissions rp
WHERE rp.permission_code IN ('projects.view', 'tenant.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT DISTINCT rp.role_id, 'projects.tasks.manage'
FROM role_permissions rp
WHERE rp.permission_code IN ('projects.manage', 'tenant.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT DISTINCT rp.role_id, 'projects.time_logs.manage'
FROM role_permissions rp
WHERE rp.permission_code IN ('projects.manage', 'tenant.manage')
ON CONFLICT DO NOTHING;

-- A task is a document a colleague can comment on. The five phase-15 types stay.
ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_entity_type_check;
ALTER TABLE comments ADD CONSTRAINT comments_entity_type_check CHECK (
  entity_type IN ('sales_invoice', 'purchase_invoice', 'party', 'employee', 'project', 'project_task')
);

COMMENT ON TABLE project_tasks IS
  'FE-16: a task on a project stage. actual_hours is the sum of time logs. No workload planning.';
COMMENT ON TABLE project_time_logs IS
  'FE-16: hours logged on a task. Cost is hours times the assignee hourly value plus expenses.';
COMMENT ON TABLE project_dependencies IS
  'FE-16: finish-to-start only. The critical path is the longest chain, computed in the application.';

ALTER ROLE erp_api NOBYPASSRLS;
