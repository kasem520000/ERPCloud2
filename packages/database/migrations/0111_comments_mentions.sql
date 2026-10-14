-- Future enhancement 15 — comments on a document head, with mentions.
-- 0109 is the marketplace, so this is 0111.
-- A comment is not a chat room and not a line-level note.

CREATE TABLE IF NOT EXISTS comments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body text NOT NULL,
  parent_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  is_resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  resolved_by uuid,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comments_body_check CHECK (char_length(body) BETWEEN 1 AND 4000),
  CONSTRAINT comments_entity_type_check CHECK (
    entity_type IN ('sales_invoice', 'purchase_invoice', 'party', 'employee', 'project')
  )
);

CREATE INDEX IF NOT EXISTS comments_thread_idx ON comments (tenant_id, entity_type, entity_id, created_at);

CREATE TABLE IF NOT EXISTS comment_mentions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  comment_id uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  mentioned_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_read boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS comment_mentions_once_key ON comment_mentions (comment_id, mentioned_user_id);
CREATE INDEX IF NOT EXISTS comment_mentions_inbox_idx ON comment_mentions (tenant_id, mentioned_user_id, is_read);

ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON comments;
CREATE POLICY tenant_isolation ON comments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE comment_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_mentions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON comment_mentions;
CREATE POLICY tenant_isolation ON comment_mentions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON comments, comment_mentions TO erp_api;
GRANT ALL PRIVILEGES ON comments, comment_mentions TO erp_migrator;

INSERT INTO permissions (code, module, description) VALUES
  ('comment.view', 'comments', 'Read comments on a document the caller can already see.'),
  ('comment.manage', 'comments', 'Write, edit, resolve or delete a comment, and mention a colleague.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_code)
SELECT DISTINCT rp.role_id, 'comment.view'
FROM role_permissions rp
WHERE rp.permission_code IN ('sales.view', 'purchase.view', 'parties.view', 'hrm.view', 'projects.view', 'tenant.manage')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT DISTINCT rp.role_id, 'comment.manage'
FROM role_permissions rp
WHERE rp.permission_code IN (
  'sales.invoice.create', 'purchase.invoice.create', 'parties.manage', 'hrm.manage', 'projects.manage', 'tenant.manage'
)
ON CONFLICT DO NOTHING;

COMMENT ON TABLE comments IS
  'FE-15: a comment on a document head. Replies are one level. No line comments and no general chat.';
COMMENT ON TABLE comment_mentions IS
  'FE-15: a mention creates an in-app notification and a comment.mention email. Read state is per recipient.';

ALTER ROLE erp_api NOBYPASSRLS;
