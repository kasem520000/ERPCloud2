'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../../components/data-view';
import { Screen } from '../../../../components/screen';
import { ApiError, apiData, apiFetch, apiPost } from '../../../../lib/api';
import { dateTime, money } from '../../../../lib/lookups';
import { useSession } from '../../../../lib/session';
import { useQuery } from '../../../../lib/use-query';

/**
 * 📦 منتجات متجر سلة — `Form_WPF/FrmSallah.xaml` («تكامل Salla API») و`Home.xaml` L395
 * («المنتجات»).
 *
 * The window has two buttons that do work — «📦 جلب المنتجات» و«➕ إضافة منتج» — and this
 * screen is both of them, plus what `Class/ProductsManager.cs` can do and the window never
 * calls: `PUT products/{id}` و`DELETE products/{id}`.
 *
 * Two tables: الأصناف محلياً وحالة مزامنتها، و«📦 منتجات المتجر» كما جُلبت.
 */
type Connection = { id: string; storeId: string };
type Product = {
  itemId: string;
  sku: string;
  nameAr: string;
  categoryName: string | null;
  salePrice: string | null;
  showInPos: boolean;
  connectionId: string | null;
  remoteId: string | null;
  status: string | null;
  diffFlags: string[] | null;
  attempts: number | null;
  syncedAt: string | null;
};
type StoreProduct = {
  id: string;
  remoteId: string;
  sku: string;
  name: string;
  price: string;
  quantity: string;
  status: string;
  currency: string;
  syncedAt: string;
};
type ExportLog = { id: string; itemId: string | null; action: string; status: string; error: string | null; createdAt: string };
type PullResult = { data: StoreProduct[]; count: number; message: string };
type PushResult = { data: { itemId: string; remoteId: string }; message: string };

const STATUS_LABELS: Record<string, string> = { synced: 'مطابق', changed: 'يحتاج تصدير', pending: 'لم يُصدَّر', failed: 'فشل' };
const FLAG_LABELS: Record<string, string> = { name: 'الاسم', price: 'السعر', cost: 'التكلفة', qty: 'الكمية' };

/** `{ data, count, message }` — the sentence is part of the answer, so it is read raw. */
async function callRaw<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
  return apiFetch<T>(path, { method: init.method, body: init.body === undefined ? undefined : JSON.stringify(init.body) }) as Promise<T>;
}

export default function SallaProductsPage() {
  const { can } = useSession();
  const canManage = can('salla.integration.manage');

  const products = useQuery<Product[]>(() => apiData<Product[]>('/integrations/salla/products'), []);
  const connections = useQuery<Connection[]>(() => apiData<Connection[]>('/integrations/salla/connections'), []);
  const logs = useQuery<ExportLog[]>(() => apiData<ExportLog[]>('/integrations/salla/export-log'), []);
  const catalog = useQuery<StoreProduct[]>(() => apiData<StoreProduct[]>('/integrations/salla/catalog'), []);
  const [connectionId, setConnectionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  const connectionRows = connections.data ?? [];
  const activeConnection = connectionId || connectionRows[0]?.id || '';

  async function run(action: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: okText });
      products.reload();
      catalog.reload();
      logs.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  /** «📦 جلب المنتجات» — what the store has, mirrored here. */
  function pull() {
    return run(async () => {
      const result = await callRaw<PullResult>('/integrations/salla/products/pull', { method: 'POST', body: { connectionId: activeConnection } });
      setNotice({ kind: 'ok', text: result.message });
    }, '');
  }

  /** ➕ إضافة منتج — a real صنف, not the window's fixed literal. */
  function push(row: Product) {
    return run(async () => {
      const result = await callRaw<PushResult>('/integrations/salla/products/push', {
        method: 'POST',
        body: { connectionId: activeConnection, itemId: row.itemId },
      });
      setNotice({ kind: 'ok', text: result.message });
    }, '');
  }

  function queue(row: Product) {
    return run(() => apiPost('/integrations/salla/export-queue', { connectionId: activeConnection, itemId: row.itemId, action: 'update' }), `تمت إضافة ${row.nameAr} إلى طابور التصدير.`);
  }

  return (
    <Screen
      title="📦 منتجات متجر سلة"
      subtitle="«📦 جلب المنتجات» و«➕ إضافة منتج» من `FrmSallah`: ما في المتجر، وما يحتاج تصديراً من أصنافك."
      crumbs={['المستودعات', 'متجر سلة']}
      actions={
        <div className="row" style={{ gap: 6 }}>
          {canManage && (
            <button type="button" className="btn primary" disabled={busy || !activeConnection} onClick={pull}>
              📦 جلب المنتجات
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={busy || !activeConnection}
            onClick={() => run(() => apiPost('/integrations/salla/export-next', {}), 'تم تنفيذ أول عملية في طابور التصدير.')}
          >
            تنفيذ التصدير التالي
          </button>
        </div>
      }
    >
      <div className="card toolbar">
        <label className="field">
          <span>المتجر</span>
          <select className="input" value={activeConnection} onChange={(event) => setConnectionId(event.target.value)}>
            {connectionRows.length === 0 ? <option value="">لا يوجد متجر مرتبط</option> : null}
            {connectionRows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.storeId}
              </option>
            ))}
          </select>
        </label>
        <span className="muted small">المنتجات تُجلب من المتجر، والأصناف تُصدَّر إليه — وكل محاولة تُسجَّل في سجل التصدير أسفل الشاشة.</span>
      </div>
      <Notice notice={notice} />

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="group-label" style={{ margin: 0 }}>الأصناف محلياً</span>
        <span className="muted">عدد السجلات: {products.data?.length ?? 0}</span>
      </div>
      <QueryView query={products} empty="لا توجد أصناف" emptyDetail="أضف أصنافاً من دليل المواد أولاً.">
        {(rows) => (
          <div className="card">
            <DataTable
              columns={[
                { key: 'sku', header: 'الرمز', align: 'ltr', cell: (row: Product) => row.sku },
                { key: 'name', header: 'الصنف', cell: (row: Product) => row.nameAr },
                { key: 'category', header: 'المجموعة', cell: (row: Product) => row.categoryName ?? '—' },
                { key: 'price', header: 'سعر البيع', align: 'num', cell: (row: Product) => money(row.salePrice) },
                { key: 'status', header: 'حالة المزامنة', cell: (row: Product) => STATUS_LABELS[row.status ?? 'pending'] ?? row.status },
                {
                  key: 'diff',
                  header: 'التغييرات',
                  cell: (row: Product) => (row.diffFlags?.length ? row.diffFlags.map((flag) => FLAG_LABELS[flag] ?? flag).join('، ') : '—'),
                },
                { key: 'remote', header: 'رقمه في المتجر', align: 'ltr', cell: (row: Product) => row.remoteId ?? '—' },
                { key: 'synced', header: 'آخر مزامنة', cell: (row: Product) => dateTime(row.syncedAt) },
                {
                  key: 'actions',
                  header: '',
                  cell: (row: Product) => (
                    <div className="row" style={{ gap: 4 }}>
                      {canManage && (
                        <button type="button" className="btn sm" disabled={busy || !activeConnection} onClick={() => push(row)}>
                          ➕ إضافة منتج
                        </button>
                      )}
                      <button type="button" className="btn sm" disabled={busy || !activeConnection} onClick={() => queue(row)}>
                        أضف للطابور
                      </button>
                      {canManage && row.remoteId && (
                        <>
                          <button
                            type="button"
                            className="btn sm"
                            disabled={busy || !activeConnection}
                            onClick={() =>
                              run(
                                async () => {
                                  const result = await callRaw<PushResult>(`/integrations/salla/products/${row.remoteId}`, {
                                    method: 'PUT',
                                    body: { connectionId: activeConnection, itemId: row.itemId },
                                  });
                                  setNotice({ kind: 'ok', text: result.message });
                                },
                                '',
                              )
                            }
                          >
                            ✏️ تحديث
                          </button>
                          <button
                            type="button"
                            className="btn sm danger"
                            disabled={busy || !activeConnection}
                            onClick={() =>
                              run(
                                async () => {
                                  const result = await callRaw<{ message: string }>(
                                    `/integrations/salla/products/${row.remoteId}?connectionId=${activeConnection}&itemId=${row.itemId}`,
                                    { method: 'DELETE' },
                                  );
                                  setNotice({ kind: 'ok', text: result.message });
                                },
                                '',
                              )
                            }
                          >
                            🗑️ احذف من المتجر
                          </button>
                        </>
                      )}
                    </div>
                  ),
                },
              ]}
              rows={rows}
              rowKey={(row) => row.itemId}
            />
          </div>
        )}
      </QueryView>

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="group-label" style={{ margin: 0 }}>📦 منتجات المتجر</span>
        <span className="muted">عدد السجلات: {catalog.data?.length ?? 0}</span>
      </div>
      <QueryView
        query={catalog}
        empty="لم تُجلب منتجات المتجر بعد"
        emptyDetail="اضغط «📦 جلب المنتجات» ليجلبها `ProductsManager.GetProducts()` ويحفظها هنا."
      >
        {(rows) => (
          <div className="card">
            <DataTable
              columns={[
                { key: 'remote', header: 'الرقم', align: 'ltr', cell: (row: StoreProduct) => row.remoteId },
                { key: 'sku', header: 'الرمز', align: 'ltr', cell: (row: StoreProduct) => row.sku || '—' },
                { key: 'name', header: 'المنتج', cell: (row: StoreProduct) => row.name },
                { key: 'price', header: 'السعر', align: 'num', cell: (row: StoreProduct) => money(row.price) },
                { key: 'qty', header: 'الكمية', align: 'num', cell: (row: StoreProduct) => money(row.quantity) },
                { key: 'status', header: 'الحالة', cell: (row: StoreProduct) => row.status || '—' },
                { key: 'synced', header: 'وقت الجلب', cell: (row: StoreProduct) => dateTime(row.syncedAt) },
              ]}
              rows={rows}
              rowKey={(row) => row.id}
            />
          </div>
        )}
      </QueryView>

      <div className="card">
        <h3>سجل التصدير</h3>
        <QueryView query={logs} empty="لا توجد عمليات تصدير بعد">
          {(rows) => (
            <DataTable
              columns={[
                { key: 'created', header: 'الوقت', cell: (row: ExportLog) => dateTime(row.createdAt) },
                { key: 'action', header: 'العملية', cell: (row: ExportLog) => row.action },
                { key: 'status', header: 'الحالة', cell: (row: ExportLog) => (row.status === 'sent' ? 'تم الإرسال' : row.status === 'queued' ? 'في الطابور' : row.status) },
                { key: 'error', header: 'الخطأ', cell: (row: ExportLog) => row.error ?? '—' },
              ]}
              rows={rows}
              rowKey={(row) => row.id}
            />
          )}
        </QueryView>
      </div>
    </Screen>
  );
}
