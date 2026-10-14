-- P-C8 — مكتب الدعم والدخول المؤقّت (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
--
-- ثلاث حالات مختلفة العزل، وثلاث سياسات مختلفة:
--
--   1. `support_tickets` و`ticket_messages` **تخصّ عميلاً** (tenant_id إلزامي): العميل يرى
--      تذاكره ويقرأ ملاحظات المشغّل **خارج** الملاحظات الداخلية، والمشغّل يرى الجميع.
--   2. `support_sessions` (الدخول المؤقّت) صفُّ **منصة**: يقينُ من دخل باسم من، ولماذا،
--      وكَم دام. العميل يرى صفوفه (سجلّه حقّه)، والمشغّل يرى الجميع — كسياسة التدقيق.
--
-- وتعمداً **لا حذف** لأيٍّ من الثلاثة: ما قيل للعميل وما دخل به المشغّل أثرٌ لا يُمحى، ويُغلق
-- بالحالة (`closed`/`ended`) لا بالمسح.

-- -----------------------------------------------------------------------------
-- 1. support_tickets — تذكرةٌ واحدة لكل مشكلة
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_tickets (
  id                uuid PRIMARY KEY,
  tenant_id         uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  subject           text        NOT NULL CHECK (length(subject) BETWEEN 3 AND 200),
  status            text        NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  priority          text        NOT NULL DEFAULT 'normal'
                                CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  category          text        CHECK (category IS NULL OR length(category) BETWEEN 2 AND 60),
  assigned_to       uuid        REFERENCES users (id) ON DELETE SET NULL,
  opened_by         uuid        REFERENCES users (id) ON DELETE SET NULL,
  -- مقياس SLA: أول ردٍّ من المشغّل (لا كل رسالة)، ومهلته من الأولوية لحظة الفتح.
  first_response_at timestamptz,
  resolved_at       timestamptz,
  closed_at         timestamptz,
  sla_due_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz,
  CONSTRAINT support_tickets_closed_check CHECK (
    (status = 'closed') = (closed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS support_tickets_tenant_status_idx
  ON support_tickets (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_open_idx
  ON support_tickets (priority, created_at DESC)
  WHERE status IN ('open', 'pending');
CREATE INDEX IF NOT EXISTS support_tickets_assignee_idx
  ON support_tickets (assigned_to)
  WHERE assigned_to IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. ticket_messages — الرسائل والملاحظات الداخلية
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_messages (
  id            uuid PRIMARY KEY,
  ticket_id     uuid        NOT NULL REFERENCES support_tickets (id) ON DELETE CASCADE,
  -- منسوخٌ من التذكرة عمداً: كل رسالة تحمل عميلها، فيسهل فرض RLS عليها بلا انضمام.
  tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  author_user_id uuid       REFERENCES users (id) ON DELETE SET NULL,
  author_kind   text        NOT NULL CHECK (author_kind IN ('operator', 'customer', 'system')),
  -- **ملاحظة داخلية**: لا تُعرض للعميل رغم أن الصفّ صفُّه (تُفلتر في الاستعلام).
  is_internal   boolean     NOT NULL DEFAULT false,
  body          text        NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ticket_messages_ticket_idx
  ON ticket_messages (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS ticket_messages_tenant_idx
  ON ticket_messages (tenant_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 3. support_sessions — الدخول المؤقّت (break-glass) بمدّته وسببه
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_sessions (
  id               uuid PRIMARY KEY,
  tenant_id        uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  operator_user_id uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- العضوية التي دخل باسمها (مالك المنشأة) — الرمز يُصدر بـ`mid` لها.
  as_membership_id uuid        NOT NULL REFERENCES memberships (id) ON DELETE CASCADE,
  reason           text        NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  started_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  ended_at         timestamptz,
  CONSTRAINT support_sessions_duration_check CHECK (
    expires_at > started_at AND expires_at <= started_at + interval '60 minutes'
  )
);

CREATE INDEX IF NOT EXISTS support_sessions_tenant_idx
  ON support_sessions (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS support_sessions_operator_idx
  ON support_sessions (operator_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS support_sessions_active_idx
  ON support_sessions (expires_at) WHERE ended_at IS NULL;

-- -----------------------------------------------------------------------------
-- 4. العزل: سياسة العميل + سياسة المنصة، على الجداول الثلاثة
-- -----------------------------------------------------------------------------
ALTER TABLE support_tickets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets  FORCE ROW LEVEL SECURITY;
ALTER TABLE ticket_messages  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_messages  FORCE ROW LEVEL SECURITY;
ALTER TABLE support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sessions FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['support_tickets', 'ticket_messages', 'support_sessions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) '
      'WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      target
    );

    EXECUTE format('DROP POLICY IF EXISTS platform_admin_plane ON %I', target);
    EXECUTE format(
      'CREATE POLICY platform_admin_plane ON %I USING '
      '(COALESCE(current_setting(''app.is_platform_admin'', true), ''off'') = ''on'') WITH CHECK '
      '(COALESCE(current_setting(''app.is_platform_admin'', true), ''off'') = ''on'')',
      target
    );
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 5. المنح: erp_api يقرأ ويكتب ولا يحذف، وerp_migrator يملك كل شيء
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON support_tickets  TO erp_api;
GRANT SELECT, INSERT, UPDATE ON ticket_messages  TO erp_api;
GRANT SELECT, INSERT, UPDATE ON support_sessions TO erp_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON support_tickets  TO erp_migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_messages  TO erp_migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON support_sessions TO erp_migrator;

-- إدراج رمز الصلاحية idempotent (كأسلوب 0066/0070/0071): الفهرس في الكود هو المصدر،
-- والصفّ هنا ليبقى `permissions` مطابقاً له في قاعدةٍ أُنشئت من الترحيلات وحدها.
INSERT INTO permissions (code, module, description) VALUES
  ('console.support.manage', 'console',
   'Handle platform support tickets and break-glass tenant access.')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

-- PROJECT_CONTRACT §13.4 — يُعاد التأكيد على كل ترحيل.
ALTER ROLE erp_api NOBYPASSRLS;
