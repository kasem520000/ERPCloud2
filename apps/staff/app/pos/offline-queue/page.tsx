'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { removeOfflineInvoice, listOfflineInvoices, type OfflineQueueRecord } from '../../../lib/offline-db';
import { retryOfflineConflict, startOfflineAutoSync, syncOfflineInvoices } from '../../../lib/sync-engine';

const money = (value: string | number | undefined) =>
  Number(value ?? 0).toLocaleString('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function OfflineQueuePage() {
  const [rows, setRows] = useState<OfflineQueueRecord[]>([]);
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string }>();

  async function reload() {
    setRows(await listOfflineInvoices());
  }

  useEffect(() => {
    setOnline(navigator.onLine);
    void reload();
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const stop = startOfflineAutoSync(() => void reload());
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      stop();
    };
  }, []);

  const pending = rows.filter((row) => row.status === 'pending');
  const conflicts = rows.filter((row) => row.status === 'conflict');
  const synced = rows.filter((row) => row.status === 'synced');

  async function syncNow() {
    setBusy(true);
    try {
      const result = await syncOfflineInvoices();
      await reload();
      setNotice({
        kind: result.conflicts ? 'danger' : 'ok',
        text: result.processed
          ? `تمت مزامنة ${result.synced} فاتورة وظهر ${result.conflicts} تعارض.`
          : 'لا توجد فواتير معلقة.',
      });
    } catch {
      setNotice({ kind: 'info', text: 'تعذر الاتصال. بقيت الفواتير في الطابور ولم تفقد.' });
    } finally {
      setBusy(false);
    }
  }

  async function retry(row: OfflineQueueRecord) {
    setBusy(true);
    try {
      const result = await retryOfflineConflict(row.offlineId);
      await reload();
      const current = result.results?.find((item) => item.offlineId === row.offlineId);
      setNotice({
        kind: current?.status === 'synced' ? 'ok' : 'danger',
        text:
          current?.status === 'synced'
            ? `تم الترحيل بالرقم ${current.number ?? 'الحقيقي'}.`
            : `ما زال التعارض: ${current?.message ?? current?.errorCode ?? 'راجع الكمية أو البيانات'}.`,
      });
    } catch {
      setNotice({ kind: 'info', text: 'تعذر إعادة المحاولة الآن.' });
    } finally {
      setBusy(false);
    }
  }

  async function discard(row: OfflineQueueRecord) {
    await removeOfflineInvoice(row.offlineId);
    await reload();
    setNotice({ kind: 'ok', text: 'أزيلت النسخة المحلية. لم يُنشأ مستند خادم.' });
  }

  return (
    <Screen
      title="طابور POS أوفلاين"
      subtitle="كل فاتورة لها نتيجة مستقلة؛ تعارض المخزون لا يوقف بقية الدفعة"
      crumbs={['المبيعات', 'POS أوفلاين']}
      actions={
        <>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-bold ${online ? 'bg-ok-soft text-ok-ink' : 'bg-danger-soft text-danger-ink'}`}
          >
            {online ? '🟢 متصل' : '🔴 أوفلاين'}
          </span>
          <Link className="btn sm" href="/pos/offline">
            العودة إلى POS
          </Link>
          <button className="btn primary sm" type="button" disabled={busy || !online} onClick={syncNow}>
            مزامنة الآن
          </button>
        </>
      }
    >
      {notice ? <Notice notice={notice} /> : null}
      <div className="grid cols-3">
        <div className="stat-card">
          <span>معلقة</span>
          <strong>{pending.length}</strong>
          <small>تنتظر الاتصال</small>
        </div>
        <div className="stat-card">
          <span>تعارض</span>
          <strong className="text-danger">{conflicts.length}</strong>
          <small>تحتاج حلاً قبل الترحيل</small>
        </div>
        <div className="stat-card">
          <span>مُرحّلة</span>
          <strong className="text-ok">{synced.length}</strong>
          <small>تحمل رقماً حقيقياً</small>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>الفواتير المحلية</h2>
          <span className="muted small">المزامنة التلقائية كل 10 ثوانٍ عند الاتصال</span>
        </div>
        {!rows.length ? (
          <div className="state">
            <strong>الطابور فارغ</strong>
            <span>الفواتير التي تنشئها دون شبكة ستظهر هنا.</span>
            <Link className="btn" href="/pos/offline">
              فتح POS أوفلاين
            </Link>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>المعرّف المؤقت</th>
                  <th>التسلسل</th>
                  <th>الأصناف</th>
                  <th>الإجمالي</th>
                  <th>الحالة</th>
                  <th>التفصيل / الإجراء</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.offlineId}>
                    <td dir="ltr">
                      <strong>{row.offlineId}</strong>
                      <br />
                      <span className="muted small">{new Date(row.createdAt).toLocaleString('ar')}</span>
                    </td>
                    <td dir="ltr">{row.sequenceNo}</td>
                    <td>{row.payload.lines.length}</td>
                    <td>
                      {money(
                        row.payload.lines.reduce(
                          (sum, line) => sum + Number(line.unitPrice) * Number(line.quantity),
                          0,
                        ),
                      )}
                    </td>
                    <td>
                      <span
                        className={`badge ${row.status === 'synced' ? 'posted' : row.status === 'conflict' ? 'danger' : 'draft'}`}
                      >
                        {row.status === 'synced'
                          ? `مُرحّلة ${row.number ?? ''}`
                          : row.status === 'conflict'
                            ? 'تعارض'
                            : 'معلقة'}
                      </span>
                    </td>
                    <td>
                      {row.status === 'conflict' ? (
                        <>
                          <span className="text-danger-ink">
                            {row.message ?? row.errorCode ?? 'تحتاج مراجعة'}
                          </span>
                          <div className="toolbar" style={{ marginTop: 6 }}>
                            <button
                              className="btn sm primary"
                              type="button"
                              disabled={busy || !online}
                              onClick={() => retry(row)}
                            >
                              إعادة المحاولة
                            </button>
                            <button
                              className="btn sm"
                              type="button"
                              disabled={busy}
                              onClick={() => discard(row)}
                            >
                              حذف المحلية
                            </button>
                          </div>
                        </>
                      ) : row.status === 'synced' ? (
                        <span className="text-ok-ink">تم الترحيل بنجاح</span>
                      ) : (
                        <span className="muted">ستتم المحاولة تلقائياً</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="card subtle">
        <strong>حل التعارض</strong>
        <p className="muted">
          عند نفاد المخزون يظهر الرمز STOCK_INSUFFICIENT. صحّح الكمية أو حدّث حزمة المخزون ثم اضغط «إعادة
          المحاولة». لا يتأثر باقي الطابور.
        </p>
      </div>
    </Screen>
  );
}
