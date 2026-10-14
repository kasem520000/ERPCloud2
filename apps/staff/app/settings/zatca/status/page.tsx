'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DataTable, Notice } from '../../../../components/data-view';
import { Empty, Loading, Screen } from '../../../../components/screen';
import { syncEinvoices, type SyncReport } from '../../../../lib/einvoice';
import { money } from '../../../../lib/lookups';
import {
  exportReport,
  openPrintable,
  runReport,
  saveExport,
  type ReportResult,
} from '../../../../lib/reports';

/**
 * 🔄 مزامنة الفواتير - ZATCA — the port of
 * `Desktop_ERP/SmartAuditERP/Form_WPF/frmInvsSyncStatusZatca.xaml` (559 lines) and
 * `.xaml.cs` (1165 lines).
 *
 * The window is the desktop's answer to «which of my invoices did ZATCA take?»: a grid of
 * every posted invoice with ✅ مرسل / ❌ لم يُرسل painted from `Inv.ZatcaSent`, the
 * authority's own «الرسالة» beside it, 🔍 خيارات البحث down the right-hand side, and
 * 🔄 مزامنة ZATCA underneath — which files every row the clerk ticked.
 *
 * The labels are the desktop's own, in its own order:
 *
 *   🔄 مزامنة الفواتير - ZATCA · 🔍 خيارات البحث · 🔄 حالة المزامنة ZATCA ·
 *   🔵 الكل · ✅ مرسل · ❌ غير مرسل · 📋 نوع الفاتورة · الكل · 📅 الفترة الزمنية ·
 *   📌 كل الفترة · من · إلى · 🔍 عرض النتائج · 🔄 مزامنة ZATCA ·
 *   م · ID · الفرع · نوع الفاتورة · رقم الفاتورة · التاريخ · العميل · المستخدم ·
 *   الصافي · الرسالة · حالة المزامنة · تفاصيل · 🔍 تفاصيل ·
 *   📊 تصدير Excel · 🖨️ طباعة · 👁️ معاينة · ✖ خروج
 *
 * Four differences from the desktop, all of them forced by the platform:
 *   1. The grid is a registered report (`einvoice-sync-status`), so 🖨️ طباعة و👁️ معاينة
 *      print the same rows through the same print engine every `frmRpt*` window uses —
 *      the desktop prints `Reports/rptInvSumByClient.repx`. 📊 تصدير Excel therefore
 *      produces a real workbook instead of the CSV the desktop writes behind that label.
 *   2. The desktop binds everything to `MainClass.BranchNo`, the branch of the machine it
 *      runs on. Here the branch is a filter, because a cloud tenant sees all of them.
 *   3. Picking «أندرويد» in the desktop adds no condition at all — index 4 falls through
 *      its `switch` (L913-L920) — so the window shows every invoice. Kept, quirk included.
 *   4. ✖ خروج closes a WPF window; here it goes back to ⚙️ إعدادات الربط الضريبي.
 */

const REPORT_KEY = 'einvoice-sync-status';

/** 🔄 حالة المزامنة ZATCA — the three radios of the search panel (L470-L478). */
const SYNC_FILTERS = [
  { value: '', labelAr: '🔵 الكل', hint: '' },
  { value: 'sent', labelAr: '✅ مرسل', hint: '' },
  { value: 'unsent', labelAr: '❌ غير مرسل', hint: '' },
];

/** 📋 نوع الفاتورة — `cmbInvType` as `LoadInvTypes` fills it (L87-L105). */
const INVOICE_TYPES = [
  { value: 'sale', labelAr: 'مبيعات' },
  { value: 'pos', labelAr: 'نقطة بيع' },
  { value: 'notice', labelAr: 'إشعار' },
  { value: 'contracting', labelAr: 'مقاولات' },
  { value: 'android', labelAr: 'أندرويد' },
];

type Row = Record<string, string>;

/** 🔄 مزامنة ZATCA works on the invoice id, which the grid carries in a hidden column. */
const invoiceId = (row: Row): string => row.invoice_id ?? row.id ?? '';

export default function ZatcaSyncStatusPage() {
  const [status, setStatus] = useState('');
  const [allTypes, setAllTypes] = useState(true);
  const [type, setType] = useState('');
  const [allPeriod, setAllPeriod] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [report, setReport] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'warn'; text: string } | null>(null);

  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [lastSync, setLastSync] = useState<SyncReport | null>(null);

  const filters = useCallback(
    () => ({
      ...(status ? { status } : {}),
      ...(allTypes ? {} : type ? { kind: type } : {}),
      ...(allPeriod ? {} : { ...(from ? { from } : {}), ...(to ? { to } : {}) }),
    }),
    [allTypes, allPeriod, from, status, to, type],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await runReport(REPORT_KEY, filters());
      setReport(next);
      setSelected([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'تعذّر تحميل الفواتير');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  // 🔍 عرض النتائج is a button in the desktop, and the filters only apply when it is
  // pressed — the grid below may well disagree with the boxes above it until then. The one
  // exception is the first paint, which runs the search so the window does not open empty.
  const firstPaint = useRef(true);
  useEffect(() => {
    if (!firstPaint.current) return;
    firstPaint.current = false;
    void load();
  }, [load]);

  const rows = useMemo<Row[]>(() => report?.rows ?? [], [report]);
  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((row) => row !== id) : [...current, id]));
  }

  /** 🔄 مزامنة ZATCA — «هل انت متأكد من مزامنة الفواتير المختارة ؟» (L445). */
  async function sync() {
    if (selected.length === 0) {
      setNotice({ kind: 'warn', text: 'لا توجد صفوف محددة.' });
      return;
    }
    if (!window.confirm('هل انت متأكد من مزامنة الفواتير المختارة ؟')) return;
    setBusy('sync');
    setNotice(null);
    try {
      const outcome = await syncEinvoices(selected);
      setLastSync(outcome);
      setNotice({
        kind: outcome.failed === 0 && outcome.sent > 0 ? 'ok' : 'warn',
        text: outcome.message,
      });
      await load();
    } catch (cause) {
      setNotice({ kind: 'danger', text: cause instanceof Error ? cause.message : 'تعذّرت المزامنة' });
    } finally {
      setBusy('');
    }
  }

  /** 🖨️ طباعة · 👁️ معاينة — the report, printed through 🖨️ إعدادات الطباعة. */
  async function print(preview: boolean) {
    setBusy(preview ? 'preview' : 'print');
    setNotice(null);
    try {
      const produced = await exportReport(REPORT_KEY, filters(), 'pdf');
      if (!openPrintable(produced.content, { print: !preview })) {
        setNotice({ kind: 'warn', text: 'تعذّر فتح نافذة الطباعة — اسمح بالنوافذ المنبثقة لهذا الموقع ثم أعد المحاولة.' });
      }
    } catch (cause) {
      setNotice({ kind: 'danger', text: cause instanceof Error ? cause.message : 'تعذّرت الطباعة' });
    } finally {
      setBusy('');
    }
  }

  /** 📊 تصدير Excel — a real workbook, not the CSV the desktop writes behind this label. */
  async function exportExcel() {
    setBusy('export');
    setNotice(null);
    try {
      const produced = await exportReport(REPORT_KEY, filters(), 'xlsx');
      saveExport(produced);
      setNotice({ kind: 'ok', text: `تم تصدير ${produced.rows} سجلاً إلى الملف ${produced.filename}` });
    } catch (cause) {
      setNotice({ kind: 'danger', text: cause instanceof Error ? cause.message : 'تعذّر التصدير' });
    } finally {
      setBusy('');
    }
  }

  return (
    <Screen
      title="🔄 مزامنة الفواتير - ZATCA"
      subtitle="كل فاتورةٍ مرحَّلة وحالة مزامنتها مع هيئة الزكاة والضريبة: ما قُبل وما لم يُقبل، ورسالة الهيئة نصّاً، ثم 🔄 مزامنة ZATCA تُرسل ما تختاره."
      crumbs={['الإعدادات', 'إعدادات الربط الضريبي', 'مزامنة الفواتير']}
      actions={
        <>
          <span className="chip">العدد: {report?.rowCount ?? 0}</span>
          <Link className="btn" href="/settings/zatca/sent">
            🧾 الفواتير المرفوعة
          </Link>
        </>
      }
    >
      <Notice notice={notice ?? undefined} />

      {/* ═══ 🔍 خيارات البحث ═══ */}
      <div className="card">
        <div className="toolbar">
          <span className="chip">🔍 خيارات البحث</span>

          {/* 🔄 حالة المزامنة ZATCA */}
          <label className="field">
            <span>🔄 حالة المزامنة ZATCA</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              {SYNC_FILTERS.map((filter) => (
                <option key={filter.value || 'all'} value={filter.value}>
                  {filter.labelAr}
                </option>
              ))}
            </select>
          </label>

          {/* 📋 نوع الفاتورة — «الكل» disables the combo, exactly as `ckAllInvs` does. */}
          <label className="field">
            <span>📋 نوع الفاتورة</span>
            <div className="toolbar">
              <label className="field">
                <input type="checkbox" checked={allTypes} onChange={(event) => setAllTypes(event.target.checked)} />
                <span>الكل</span>
              </label>
              <select value={type} disabled={allTypes} onChange={(event) => setType(event.target.value)}>
                <option value="">—</option>
                {INVOICE_TYPES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.labelAr}
                  </option>
                ))}
              </select>
            </div>
          </label>

          {/* 📅 الفترة الزمنية */}
          <label className="field">
            <span>📅 الفترة الزمنية</span>
            <div className="toolbar">
              <label className="field">
                <input type="checkbox" checked={allPeriod} onChange={(event) => setAllPeriod(event.target.checked)} />
                <span>📌 كل الفترة</span>
              </label>
              <input type="date" value={from} disabled={allPeriod} onChange={(event) => setFrom(event.target.value)} aria-label="من" />
              <input type="date" value={to} disabled={allPeriod} onChange={(event) => setTo(event.target.value)} aria-label="إلى" />
            </div>
          </label>

          <button type="button" className="btn primary" disabled={loading} onClick={() => void load()}>
            🔍 عرض النتائج
          </button>
        </div>
      </div>

      {error ? <p className="alert danger">{error}</p> : null}

      {/* ═══ The grid ═══ */}
      <div className="card">
        {loading && !report ? (
          <Loading rows={5} />
        ) : rows.length === 0 ? (
          <Empty title="لا توجد عمليات بالجدول" detail="جرّب «📌 كل الفترة» أو «🔵 الكل»." />
        ) : (
          <DataTable
            rows={rows}
            rowKey={(row) => invoiceId(row)}
            columns={[
              {
                key: 'pick',
                header: 'تحديد',
                cell: (row) => {
                  const id = invoiceId(row);
                  return <input type="checkbox" checked={selected.includes(id)} onChange={() => toggle(id)} aria-label={`تحديد ${row.number ?? id}`} />;
                },
              },
              { key: 'seq', header: 'م', cell: (row) => row.seq },
              { key: 'id', header: 'ID', cell: (row) => <span dir="ltr">{String(row.id ?? '').slice(0, 8)}…</span>, align: 'ltr' },
              { key: 'branch_name', header: 'الفرع', cell: (row) => row.branch_name },
              { key: 'kind_name', header: 'نوع الفاتورة', cell: (row) => row.kind_name },
              { key: 'number', header: 'رقم الفاتورة', cell: (row) => row.number },
              { key: 'issued_at', header: 'التاريخ', cell: (row) => <span dir="ltr">{row.issued_at}</span>, align: 'ltr' },
              { key: 'party_name', header: 'العميل', cell: (row) => row.party_name },
              { key: 'user_name', header: 'المستخدم', cell: (row) => row.user_name },
              { key: 'net', header: 'الصافي', cell: (row) => money(row.net), align: 'num' },
              { key: 'message', header: 'الرسالة', cell: (row) => row.message || '—' },
              {
                key: 'sync_status',
                header: 'حالة المزامنة',
                cell: (row) => (
                  <span className="chip" style={(row.sync_status ?? '').startsWith('✅') ? { background: 'var(--ok)', color: 'var(--on-accent)' } : { background: 'var(--danger)', color: 'var(--on-accent)' }}>
                    {row.sync_status}
                  </span>
                ),
              },
              {
                key: 'details',
                header: 'تفاصيل',
                cell: (row) => (
                  <Link className="btn" href={`/sales/invoices/${invoiceId(row)}`}>
                    🔍 تفاصيل
                  </Link>
                ),
              },
            ]}
          />
        )}

        {/* ✓ تحديد الكل — `SelectionMode="MultipleRow"` of the desktop's grid. */}
        {rows.length > 0 ? (
          <div className="toolbar">
            <label className="field">
              <input
                type="checkbox"
                checked={selected.length > 0 && selected.length === rows.length}
                onChange={(event) => setSelected(event.target.checked ? rows.map(invoiceId) : [])}
              />
              <span>تحديد الكل</span>
            </label>
            <span className="chip">المحدَّد: {selected.length}</span>
          </div>
        ) : null}

        {/* 💰 ملخص الصافي — `RecalculateNetSummary` (L329-L345), three cards not one. */}
        {report && rows.length > 0 ? (
          <div className="toolbar">
            {report.grandTotal.map((card) => (
              <span className="chip" key={card.key}>
                {card.labelAr}: {money(card.amount)}
              </span>
            ))}
          </div>
        ) : null}

        <div className="toolbar">
          <button type="button" className="btn" disabled={busy !== '' || rows.length === 0} onClick={() => void exportExcel()}>
            {busy === 'export' ? 'جارٍ التصدير…' : '📊 تصدير Excel'}
          </button>
          <button type="button" className="btn" disabled={busy !== '' || rows.length === 0} onClick={() => void print(false)}>
            {busy === 'print' ? 'جارٍ التجهيز…' : '🖨️ طباعة'}
          </button>
          <button type="button" className="btn" disabled={busy !== '' || rows.length === 0} onClick={() => void print(true)}>
            {busy === 'preview' ? 'جارٍ التجهيز…' : '👁️ معاينة'}
          </button>
          <button type="button" className="btn primary" disabled={busy !== ''} onClick={() => void sync()}>
            {busy === 'sync' ? 'جارٍ المزامنة…' : `🔄 مزامنة ZATCA${selected.length > 0 ? ` (${selected.length})` : ''}`}
          </button>
          <Link className="btn" href="/settings/zatca">
            ✖ خروج
          </Link>
        </div>
      </div>

      {/* ═══ What 🔄 مزامنة ZATCA answered, row by row ═══ */}
      {lastSync ? (
        <div className="card">
          <h3>🔄 مزامنة ZATCA — النتيجة</h3>
          <p className="muted">
            {lastSync.message} · البيئة: {lastSync.environment === 'simulation' ? '🧪 محاكاة' : lastSync.environment}
          </p>
          <DataTable
            rows={lastSync.results}
            rowKey={(row) => row.invoiceId}
            columns={[
              { key: 'number', header: 'رقم الفاتورة', cell: (row) => row.number ?? '—' },
              {
                key: 'outcome',
                header: 'النتيجة',
                cell: (row) => (row.outcome === 'sent' ? '✅ مرسل' : row.outcome === 'failed' ? '❌ فشل' : '⏭️ مُتجاوَزة'),
              },
              { key: 'status', header: 'الحالة', cell: (row) => row.status ?? '—' },
              { key: 'authority', header: 'كلمة الهيئة', cell: (row) => row.authorityStatus ?? '—' },
              { key: 'message', header: 'الرسالة', cell: (row) => row.message ?? '—' },
            ]}
          />
        </div>
      ) : null}
    </Screen>
  );
}
