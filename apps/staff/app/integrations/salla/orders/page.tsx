'use client';

import Link from 'next/link';
import { useState } from 'react';

import { DataTable, QueryView } from '../../../../components/data-view';
import { Screen } from '../../../../components/screen';
import { ApiError, apiData, apiDelete, apiFetch, apiPut } from '../../../../lib/api';
import { dateTime, money, statusLabel } from '../../../../lib/lookups';
import { useSession } from '../../../../lib/session';
import { useQuery } from '../../../../lib/use-query';

/**
 * 📋 إدارة الطلبات — `Home.xaml` L396 and the «📋 جلب الطلبات» button of
 * `Form_WPF/FrmSallah.xaml`.
 *
 * Every طلب that arrives becomes a فاتورة مبيعات (`orderType = 'salla'`), whether it came
 * in as a webhook or was pulled by `OrdersManager.GetOrders()`. The remote number is the
 * guard: a طلب that is already here is skipped, and `PUT orders/{id}/status` بـ`{ status }`
 * sends the new state back to the store.
 *
 * Orders that came in by webhook before this part have no mirror (`orderId` is null) — they
 * are invoices like any other, and only their فاتورة can be opened.
 */
type Connection = { id: string; storeId: string };
type Order = {
  id: string;
  orderId: string | null;
  number: string | null;
  remoteId: string | null;
  remoteStatus: string | null;
  status: string;
  customer: string | null;
  mobile: string | null;
  total: string;
  paymentStatus: string;
  createdAt: string;
};
type PullResult = { data: Array<Record<string, unknown>>; count: number; created: number; skipped: string[]; message: string };

const REMOTE_STATUS_LABELS: Record<string, string> = {
  pending: 'قيد المراجعة',
  processing: 'قيد التجهيز',
  delivered: 'تم التسليم',
  canceled: 'مُلغى',
  completed: 'مكتمل',
};

/** `{ data, count, message }` — read raw, so the window's sentence reaches the operator. */
async function callRaw<T>(path: string, method: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) }) as Promise<T>;
}

export default function SallaOrdersPage() {
  const { can } = useSession();
  const canManage = can('salla.integration.manage');

  const orders = useQuery<Order[]>(() => apiData<Order[]>('/integrations/salla/orders'), []);
  const connections = useQuery<Connection[]>(() => apiData<Connection[]>('/integrations/salla/connections'), []);
  const [connectionId, setConnectionId] = useState('');
  const [status, setStatus] = useState('delivered');
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
      orders.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  /** «📋 جلب الطلبات» — one فاتورة for every طلب that is not here yet. */
  function pull() {
    return run(async () => {
      const result = await callRaw<PullResult>('/integrations/salla/orders/pull', 'POST', { connectionId: activeConnection });
      setNotice({ kind: 'ok', text: `${result.message} أُنشئ: ${result.created} · مُتجاوَز: ${result.skipped?.length ?? 0}` });
    }, '');
  }

  function remove(row: Order) {
    if (!window.confirm(`سيُحذف الطلب ${row.remoteId ?? row.number ?? ''} ومعه فاتورته المسوّدة.\n\nهل أنت متأكد؟`)) return;
    return run(() => apiDelete(`/integrations/salla/orders/${row.orderId}`), 'تم حذف الطلب');
  }

  return (
    <Screen
      title="📋 إدارة طلبات سلة"
      subtitle="«📋 جلب الطلبات» من `FrmSallah`: كل طلبٍ وارد يصبح فاتورة مبيعات — رقمه عند المتجر هو ما يمنع استيراده مرّتين."
      crumbs={['المستودعات', 'متجر سلة']}
      actions={
        canManage ? (
          <button type="button" className="btn primary" disabled={busy || !activeConnection} onClick={pull}>
            📋 جلب الطلبات
          </button>
        ) : undefined
      }
    >
      {canManage && (
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
          <label className="field">
            <span>الحالة المُرسَلة إلى المتجر</span>
            <select className="input" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="delivered">تم التسليم</option>
              <option value="processing">قيد التجهيز</option>
              <option value="canceled">مُلغى</option>
            </select>
          </label>
          <span className="muted small">`PUT orders/{'{id}'}/status` بـ`{'{ status }'}` كما في `OrdersManager.UpdateOrderStatus()`.</span>
        </div>
      )}
      {notice && <p className={notice.kind === 'ok' ? 'alert ok' : 'alert danger'}>{notice.text}</p>}

      <QueryView
        query={orders}
        empty="لا توجد طلبات واردة"
        emptyDetail="سجّل عنوان الويب هوك في لوحة سلة، أو اضغط «📋 جلب الطلبات» ليستوردها النظام من المتجر."
      >
        {(rows) => (
          <div className="card">
            <DataTable
              columns={[
                { key: 'number', header: 'رقم الفاتورة', align: 'ltr', cell: (row: Order) => row.number ?? 'مسودة' },
                { key: 'remote', header: 'رقم الطلب', align: 'ltr', cell: (row: Order) => row.remoteId ?? '—' },
                { key: 'remoteStatus', header: 'الحالة عند المتجر', cell: (row: Order) => REMOTE_STATUS_LABELS[row.remoteStatus ?? ''] ?? row.remoteStatus ?? '—' },
                { key: 'created', header: 'وقت الطلب', cell: (row: Order) => dateTime(row.createdAt) },
                { key: 'customer', header: 'العميل', cell: (row: Order) => row.customer ?? '—' },
                { key: 'mobile', header: 'الجوال', align: 'ltr', cell: (row: Order) => row.mobile ?? '—' },
                { key: 'total', header: 'الإجمالي', align: 'num', cell: (row: Order) => money(row.total) },
                { key: 'status', header: 'حالة الفاتورة', cell: (row: Order) => statusLabel(row.status) },
                { key: 'payment', header: 'السداد', cell: (row: Order) => statusLabel(row.paymentStatus) },
                {
                  key: 'actions',
                  header: '',
                  cell: (row: Order) => (
                    <div className="row" style={{ gap: 4 }}>
                      <Link className="btn sm" href={`/sales/invoices/${row.id}`}>
                        فتح الفاتورة
                      </Link>
                      {canManage && row.orderId && (
                        <>
                          <button
                            type="button"
                            className="btn sm"
                            disabled={busy}
                            onClick={() => run(() => apiPut(`/integrations/salla/orders/${row.orderId}/status`, { status }), 'تم تحديث حالة الطلب')}
                          >
                            تحديث الحالة
                          </button>
                          <button type="button" className="btn sm danger" disabled={busy} onClick={() => remove(row)}>
                            🗑️ حذف
                          </button>
                        </>
                      )}
                    </div>
                  ),
                },
              ]}
              rows={rows}
              rowKey={(row) => row.id}
            />
          </div>
        )}
      </QueryView>
    </Screen>
  );
}
