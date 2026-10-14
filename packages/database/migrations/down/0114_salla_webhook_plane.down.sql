-- Rollback for 0114 — تُرفع سياسة مستوى المنصّة وحدها؛ سياسة العزل الأصلية
-- (`salla_connections_tenant_isolation` من 0018) لم تُلمس، فالحالة السابقة تعود بدقّة.
DROP POLICY IF EXISTS platform_admin_plane ON salla_connections;
