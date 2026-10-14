-- Down for 0059_salla_store.sql — 🛒 متجر سلة: ما جُلب من المنتجات والطلبات.
--
-- What is lost: مرآة منتجات المتجر (`salla_products`)، ومرآة طلباته (`salla_orders`) —
-- الأرقام البعيدة وحالات الطلبات وارتباط كل طلبٍ بفاتورته.
--
-- What stays: every فاتورة مبيعات أُنشئت من طلب (`orderType = 'salla'`) — هي وثيقة
-- محاسبية قائمة بذاتها، والطلب مرآةٌ لها لا العكس. والمتجر نفسه (`salla_connections`)
-- وربط مستودعاته (`salla_branch_mappings`) وحالة مزامنة الأصناف (`salla_item_sync`)
-- وسجل التصدير (`salla_export_log`) لم تُمسَّ؛ فمن يعيد الترحيل يستطيع أن يجلب المنتجات
-- والطلبات من جديد، وإن تُرِك أثر الطلبات فواتيرها.
--
-- Nothing that existed before this migration is touched.

DROP TABLE IF EXISTS salla_orders;
DROP TABLE IF EXISTS salla_products;
