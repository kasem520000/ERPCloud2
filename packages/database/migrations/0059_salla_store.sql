-- Phase 09 part eight — 🛒 متجر سلة (Salla) — the four buttons of `FrmSallah` get
-- somewhere to put what they pull.
--
-- `Form_WPF/FrmSallah.xaml` («تكامل Salla API» — لوحته «🛒 تكامل منصة Salla») is four
-- buttons and nothing else:
--
--   «📦 جلب المنتجات»  → productsManager.GetProducts()   → «تم جلب {n} منتج.»
--   «📋 جلب الطلبات»   → ordersManager.GetOrders()       → «تم جلب {n} طلب.»
--   «➕ إضافة منتج»    → productsManager.CreateProduct() → «تم إضافة المنتج بنجاح.»
--   «📥 جلب الطلبات (2)» → `await Task.Run(() => { })`   → «جلب الطلبات (2) — يمكن
--                                                          تخصيصه لاحقاً.»
--
-- and the three menu items of `Home.xaml` L394 («متجر سلة»: المنتجات · إدارة الطلبات ·
-- ربط المستودعات) have **empty handlers** (`{ }`) — the windows they would open
-- (`FrmSallaProducts` · `FrmOrderSalla` · `FrmSallaBranchMapping`) are commented out at
-- `Home.xaml.cs` L257–L261 and absent from the tree. So the desktop's Salla work is a
-- client and a demo window: it counts what it pulls and forgets it.
--
-- The clients it uses, and the shapes they speak:
--
--   Class/SallaAPI.cs        `https://api.salla.dev/admin/v2` · Bearer · GET/POST/PUT/DELETE
--                            · «خطأ في الطلب: {status} - {body}»
--   Class/ProductsManager.cs products · products/{id} · POST products · PUT products/{id}
--                            · DELETE products/{id}
--   Class/OrdersManager.cs   orders · orders/{id} · PUT orders/{id}/status بـ`{ status }`
--   Class/CustomersManager.cs customers · customers/{id}
--   Class/SallaAuth.cs       POST https://accounts.salla.sa/oauth2/token
--                            (grant_type=authorization_code · client_id · client_secret ·
--                             code · redirect_uri) · «خطأ في الحصول على Access Token: …»
--
-- «➕ إضافة منتج» in the window posts a fixed object — `{ name = "اسم المنتج", price = 100,
-- quantity = 50, description = "وصف المنتج" }` — so the push here builds the same four
-- keys from a real صنف instead of a literal.
--
-- Two tables this part adds, because the desktop's counts need somewhere to live:
-- `salla_products` (ما جُلب من المتجر) و`salla_orders` (كل طلبٍ وارد، برقمه البعيد، حتى
-- لا يُستورد مرّتين).

CREATE TABLE IF NOT EXISTS salla_products (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES salla_connections(id) ON DELETE CASCADE,
  remote_id text NOT NULL,
  sku text,
  name text,
  price numeric(20, 4) NOT NULL DEFAULT 0,
  quantity numeric(20, 4) NOT NULL DEFAULT 0,
  status text,
  currency text NOT NULL DEFAULT 'SAR',
  payload jsonb NOT NULL DEFAULT '{}',
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS salla_products_remote_key
  ON salla_products (tenant_id, connection_id, remote_id);
CREATE INDEX IF NOT EXISTS salla_products_connection_idx
  ON salla_products (tenant_id, connection_id, synced_at);

COMMENT ON COLUMN salla_products.remote_id IS 'رقم المنتج في المتجر — `products[].id` من `ProductsManager.GetProducts()`';
COMMENT ON COLUMN salla_products.payload IS 'المنتج كما أرسله المتجر، بلا تنقيح — المرجع عند الخلاف';

-- كل طلبٍ وارد من المتجر: رقمه البعيد هو مفتاح عدم التكرار، و`orderType = ''salla''`
-- على فاتورة المبيعات هو أثره في المحاسبة.
CREATE TABLE IF NOT EXISTS salla_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES salla_connections(id) ON DELETE CASCADE,
  remote_id text NOT NULL,
  number text,
  remote_status text,
  customer_name text,
  customer_mobile text,
  currency text NOT NULL DEFAULT 'SAR',
  total numeric(20, 4) NOT NULL DEFAULT 0,
  placed_at timestamptz,
  branch_id uuid,
  warehouse_id uuid,
  sales_invoice_id uuid,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  deleted_by uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS salla_orders_remote_key
  ON salla_orders (tenant_id, connection_id, remote_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS salla_orders_connection_idx
  ON salla_orders (tenant_id, connection_id, placed_at);

COMMENT ON COLUMN salla_orders.remote_id IS 'رقم الطلب في المتجر — `orders[].id` من `OrdersManager.GetOrders()`؛ به يُعرف أن الطلب استُورد';
COMMENT ON COLUMN salla_orders.remote_status IS 'حالة الطلب عند المتجر — تُحدَّث بـ`PUT orders/{id}/status` بـ`{ status }`';
COMMENT ON COLUMN salla_orders.sales_invoice_id IS 'فاتورة المبيعات التي صارت هذا الطلب (`orderType = ''salla''`)';

DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['salla_products', 'salla_orders'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
  EXECUTE format(
    'CREATE POLICY %I_tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
    t, t
  );
END LOOP; END $$;
