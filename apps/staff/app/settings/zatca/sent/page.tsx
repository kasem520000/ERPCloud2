'use client';

import { useCallback, useEffect, useState } from 'react';

import { DataTable, Notice } from '../../../../components/data-view';
import { Screen } from '../../../../components/screen';
import { ApiError } from '../../../../lib/api';
import { filingDetail, filingsPage, retryFiling, zatcaChain, type ChainState, type FilingDetail, type FilingRow } from '../../../../lib/einvoice';
import { dateTime } from '../../../../lib/lookups';

/**
 * 🧾 الفواتير المرفوعة على موقع الضرائب — the window, ported from
 * `Desktop_ERP/SmartAuditERP/Form_WPF/frmSentEinvoice.xaml` (358 lines) and `.xaml.cs`
 * (304 lines), with the grid columns of its ZATCA sister window
 * `Form_WPF/frmInvsSyncStatusZatca.xaml` (559 lines) — because the desktop's sent-invoice
 * window is ETA's, while this one lists what the Saudi authority answered.
 *
 * The labels are the desktop's own, in its own order:
 *
 *   🧾 الفواتير المرفوعة على موقع الضرائب · حجم الصفحة · رقم الصفحة · 🔍 عرض ·
 *   📋 قائمة الفواتير المرفوعة · UUID · Public URL · 📄 بيانات الفاتورة · 🖨️ طباعة ·
 *   🔍 تفاصيل · 📌 انقر على صف لتحديد UUID والرابط العام
 *   + from `frmInvsSyncStatusZatca`: 🔄 حالة المزامنة ZATCA · ✅ مرسل · ❌ غير مرسل ·
 *     🔵 الكل · م · رقم الفاتورة · نوع الفاتورة · التاريخ · العميل · الصافي · الرسالة ·
 *     الفرع · المستخدم · «تم الترحيل zatca» / «فشل الترحيل zatca» (`frmInvSale.xaml.cs`
 *     L1502-L1512)
 *
 * Three differences from the desktop, all of them forced by the platform:
 *   1. «Public URL» stays empty for ZATCA. The authority answers with a cleared document,
 *      not with a portal link — the field exists because the window does, and it fills
 *      itself the day an authority publishes one (ETA does, in part four).
 *   2. ❌ رفض الفاتورة and 🚫 إلغاء الفاتورة are ETA calls (`sendEinvoice.reject_invoice` /
 *      `cancel_invoice`). ZATCA has no such call: a correction is a credit note, filed as a
 *      381 that names the invoice it corrects. The correction path is therefore a link to
 *      the sales return, not a button that deletes anything at the authority.
 *   3. Paging is done by the API (رقم الصفحة / حجم الصفحة are sent as parameters) instead of
 *      being a string pasted into a URL, and the page keeps its own selection so «📄 بيانات
 *      الفاتورة» opens for the row you clicked.
 */

const STATUS_LABELS: Record<string, string> = {
  prepared: 'مُجهَّزة (لم تُرسل)',
  signed: 'موقّعة (بانتظار الربط)',
  reported: 'مُبلَّغ — تم الترحيل zatca',
  cleared: 'مُصادق — تم الترحيل zatca',
  failed: 'فشل الترحيل zatca',
  pending: 'قيد الإرسال',
  not_implemented: 'غير مدعوم',
};

const PROFILE_LABELS: Record<string, string> = {
  standard: 'ضريبية (0100000)',
  simplified: 'مبسّطة (0200000)',
};

const KIND_LABELS: Record<string, string> = {
  sale: 'مبيعات',
  sale_return: 'مرتجع مبيعات',
  credit_note: 'إشعار دائن',
  debit_note: 'إشعار مدين',
  contracting: 'مقاولة',
  quotation: 'عرض سعر',
};

const REASON_LABELS: Record<string, string> = {
  NO_CREDENTIALS: 'لم تُرفع بيانات الاعتماد بعد — الفاتورة مُجهَّزة ورمز QR للمرحلة الأولى صالح.',
  NO_GATEWAY_CONFIGURED: 'الفاتورة موقّعة، لكن لا توجد شهادة (CSID) للإرسال بها.',
  LINK_PAUSED: 'الربط موقوف — شغّله من إعدادات الربط الضريبي.',
};

/** ✅ مرسل / ❌ غير مرسل — the two states `frmInvsSyncStatusZatca` filters on. */
const SYNC_FILTERS = [
  { value: '', labelAr: '🔵 الكل' },
  { value: 'cleared', labelAr: '✅ مرسل (مُصادق)' },
  { value: 'reported', labelAr: '✅ مرسل (مُبلَّغ)' },
  { value: 'failed', labelAr: '❌ غير مرسل' },
  { value: 'signed', labelAr: 'موقّعة (بانتظار الربط)' },
  { value: 'prepared', labelAr: 'مُجهَّزة' },
];

const sent = (status: string) => status === 'cleared' || status === 'reported';

function messageOf(row: FilingRow): string {
  const response = row.response ?? {};
  if (row.error) return row.error;
  if (response.errorMessages && response.errorMessages.length > 0) return response.errorMessages.join(' · ');
  if (response.message) return REASON_LABELS[response.reason ?? ''] ?? response.message;
  if (row.authorityStatus) return row.authorityStatus;
  return '—';
}

/** 🖨️ طباعة — the document, as the tenant prints it, in a new tab. */
function printInvoice(invoiceId: string) {
  window.open(`/print/sales-invoice/${invoiceId}`, '_blank', 'noopener,noreferrer');
}

export default function SentEinvoicesPage() {
  const [rows, setRows] = useState<FilingRow[]>([]);
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalRows, setTotalRows] = useState(0);
  const [pages, setPages] = useState(1);
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState<FilingRow | undefined>();
  const [detail, setDetail] = useState<FilingDetail | undefined>();
  const [chain, setChain] = useState<ChainState | undefined>();
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string } | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await filingsPage({ status: status || undefined, from: from || undefined, to: to || undefined, pageNo, pageSize });
      setRows(page.items);
      setTotalRows(page.total);
      setPages(page.pages);
      setChain(await zatcaChain());
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [pageNo, pageSize, status, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  async function show(row: FilingRow) {
    setSelected(row);
    setDetail(undefined);
    setBusy('detail');
    try {
      setDetail(await filingDetail(row.id));
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy('');
    }
  }

  async function retry(row: FilingRow) {
    setBusy('retry');
    setNotice(undefined);
    try {
      const next = await retryFiling(row.id);
      setNotice({ kind: sent(next.status) ? 'ok' : 'warn', text: sent(next.status) ? 'تم ارسال الفاتورة بنجاح' : `الحالة الآن: ${STATUS_LABELS[next.status] ?? next.status}` });
      setDetail(undefined);
      await load();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy('');
    }
  }

  function downloadXml(name: string, xml: string | null) {
    if (!xml) return;
    const url = URL.createObjectURL(new Blob([xml], { type: 'application/xml;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  return (
    <Screen
      title="🧾 الفواتير المرفوعة على موقع الضرائب"
      subtitle="كل فاتورة أُرسلت إلى هيئة الزكاة والضريبة: حالتها عند الهيئة، وتجزئتها، ومكانها في السلسلة، والوثيقة التي أُرسلت والتي عادت مُصادَقة."
      crumbs={['الإعدادات', 'إعدادات الربط الضريبي', 'الفواتير المرفوعة']}
      actions={
        <>
          <span className="chip">الإجمالي: {totalRows}</span>
          {chain && (
            <span className="chip">
              آخر تجزئة: <span dir="ltr">{chain.lastHash.slice(0, 12)}…</span> · العدّاد: {chain.counter}
            </span>
          )}
        </>
      }
    >
      <Notice notice={notice} />

      {/* ═══ Toolbar — 🔍 خيارات البحث ═══ */}
      <div className="card">
        <div className="toolbar">
          <label className="field">
            <span>حجم الصفحة:</span>
            <input
              type="number"
              min={1}
              max={100}
              style={{ width: 90 }}
              value={pageSize}
              onChange={(event) => setPageSize(Math.max(1, Math.min(100, Number(event.target.value) || 20)))}
            />
          </label>
          <label className="field">
            <span>رقم الصفحة:</span>
            <input
              type="number"
              min={1}
              max={pages}
              style={{ width: 90 }}
              value={pageNo}
              onChange={(event) => setPageNo(Math.max(1, Math.min(pages, Number(event.target.value) || 1)))}
            />
          </label>
          <label className="field">
            <span>🔄 حالة المزامنة ZATCA</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              {SYNC_FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.labelAr}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>من</span>
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="field">
            <span>إلى</span>
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <button type="button" className="btn primary" disabled={loading} onClick={() => void load()}>
            🔍 عرض
          </button>
        </div>
      </div>

      {/* ═══ The grid ═══ */}
      <div className="card">
        <h3>📋 قائمة الفواتير المرفوعة</h3>
        {loading && rows.length === 0 && <p className="muted">جارٍ التحميل…</p>}
        <DataTable
          rows={rows}
          rowKey={(row) => row.id}
          columns={[
            { key: 'index', header: 'م', cell: (row, index) => (pageNo - 1) * pageSize + index + 1 },
            { key: 'number', header: 'رقم الفاتورة', cell: (row) => row.invoice?.number ?? '—' },
            { key: 'kind', header: 'نوع الفاتورة', cell: (row) => KIND_LABELS[row.invoice?.kind ?? ''] ?? (row.invoice?.kind ?? '—') },
            { key: 'date', header: 'التاريخ', cell: (row) => dateTime(row.submittedAt ?? row.createdAt) },
            { key: 'party', header: 'العميل', cell: (row) => row.invoice?.partyName ?? '—' },
            { key: 'branch', header: 'الفرع', cell: (row) => row.invoice?.branchName ?? '—' },
            { key: 'user', header: 'المستخدم', cell: (row) => row.invoice?.createdByName ?? '—' },
            { key: 'total', header: 'الصافي', cell: (row) => (row.invoice?.total ? Number(row.invoice.total).toFixed(2) : '—') },
            {
              key: 'status',
              header: 'حالة المزامنة',
              cell: (row) => (
                <span className="chip">
                  {sent(row.status) ? '✅' : row.status === 'failed' ? '❌' : '⏳'} {STATUS_LABELS[row.status] ?? row.status}
                  {row.chainIndex ? ` · ${row.chainIndex}` : ''}
                </span>
              ),
            },
            { key: 'profile', header: 'الصنف', cell: (row) => PROFILE_LABELS[String(row.response?.profile ?? '')] ?? row.response?.profile ?? '—' },
            { key: 'message', header: 'الرسالة', cell: (row) => messageOf(row) },
            {
              key: 'actions',
              header: 'تفاصيل',
              cell: (row) => (
                <button type="button" className="btn" disabled={busy !== ''} onClick={() => void show(row)}>
                  🔍 تفاصيل
                </button>
              ),
            },
          ]}
        />
        <div className="toolbar">
          <button type="button" className="btn" disabled={pageNo <= 1 || loading} onClick={() => setPageNo(pageNo - 1)}>
            → السابق
          </button>
          <span className="chip">
            صفحة {pageNo} من {pages}
          </span>
          <button type="button" className="btn" disabled={pageNo >= pages || loading} onClick={() => setPageNo(pageNo + 1)}>
            التالي ←
          </button>
          <button type="button" className="btn" disabled={loading} onClick={() => void load()}>
            🔄 تحديث
          </button>
        </div>
      </div>

      {/* ═══ Selected row — UUID + Public URL ═══ */}
      {selected && (
        <div className="card">
          <h3>📄 بيانات الفاتورة</h3>
          <div className="form-grid">
            <label className="field wide">
              <span>UUID</span>
              <input readOnly dir="ltr" value={selected.uuid ?? '—'} />
            </label>
            <label className="field wide">
              <span>Public URL</span>
              <input readOnly dir="ltr" value="—" />
            </label>
            <label className="field">
              <span>حالة الهيئة</span>
              <input readOnly value={selected.authorityStatus ?? '—'} />
            </label>
            <label className="field">
              <span>المحاولات</span>
              <input readOnly value={selected.attempts} />
            </label>
          </div>
          <p className="small muted">
            📌 انقر على صف لتحديد UUID والرابط العام · الرابط العام لا تصدره هيئة الزكاة — يظهر هنا متى أصدرته الجهة
            (الضرائب المصرية تفعل ذلك).
          </p>
          <div className="toolbar">
            <button type="button" className="btn" onClick={() => printInvoice(selected.invoiceId)}>
              🖨️ طباعة
            </button>
            {!sent(selected.status) && (
              <button type="button" className="btn" disabled={busy !== ''} onClick={() => void retry(selected)}>
                🔁 إعادة الإرسال
              </button>
            )}
            {busy === 'retry' && <span className="chip">…</span>}
          </div>

          {busy === 'detail' && <p className="muted">جارٍ تحميل الوثيقة…</p>}

          {detail && (
            <>
              <h3>🔗 السلسلة — مكان الفاتورة</h3>
              <div className="form-grid">
                <label className="field wide">
                  <span>الرقم التسلسلي للفاتورة (ICV)</span>
                  <input readOnly value={detail.document.counter ?? '—'} />
                </label>
                <label className="field wide">
                  <span>تجزئة الفاتورة السابقة (PIH)</span>
                  <input readOnly dir="ltr" value={detail.chain.previousHash ?? '—'} />
                </label>
                <label className="field wide">
                  <span>تجزئة هذه الفاتورة (Hash)</span>
                  <input readOnly dir="ltr" value={detail.chain.hash ?? '—'} />
                </label>
              </div>

              <h3>🏷️ رمز الاستجابة السريعة — الوسوم الثمانية</h3>
              <DataTable
                rows={detail.qr.tags}
                rowKey={(tag) => String(tag.tag)}
                columns={[
                  { key: 'tag', header: 'الوسم', cell: (tag) => tag.tag },
                  { key: 'labelAr', header: 'المحتوى', cell: (tag) => tag.labelAr },
                  { key: 'bytes', header: 'الحجم', cell: (tag) => `${tag.bytes} بايت` },
                  { key: 'value', header: 'القيمة', cell: (tag) => <span dir="ltr">{tag.value.length > 60 ? `${tag.value.slice(0, 60)}…` : tag.value}</span> },
                ]}
              />

              <h3>📄 الوثيقة</h3>
              <div className="toolbar">
                <button type="button" className="btn" onClick={() => downloadXml(`zatca-${detail.submission.uuid ?? detail.submission.id}.xml`, detail.document.xml)}>
                  تنزيل الوثيقة المرسلة (UBL)
                </button>
                {detail.document.clearedXml && (
                  <button type="button" className="btn" onClick={() => downloadXml(`zatca-cleared-${detail.submission.uuid ?? detail.submission.id}.xml`, detail.document.clearedXml)}>
                    تنزيل الوثيقة المُصادَقة
                  </button>
                )}
              </div>
              {detail.document.clearedXml ? (
                <p className="small muted">
                  ✅ الفاتورة ضريبية: أعادت الهيئة وثيقة مُصادَقة، ورمز الاستجابة السريعة مقروء منها لا من وثيقتنا.
                </p>
              ) : (
                <p className="small muted">الفاتورة مبسّطة: تُبلَّغ ولا تُصادَق، فلا تعود وثيقة من الهيئة.</p>
              )}
              {detail.authority.warnings.length > 0 && <p className="alert warn">تحذيرات الهيئة: {detail.authority.warnings.join(' · ')}</p>}
              {detail.authority.errors.length > 0 && <p className="alert danger">أخطاء الهيئة: {detail.authority.errors.join(' · ')}</p>}
              <label className="field wide">
                <span>الوثيقة المرسلة</span>
                <textarea readOnly rows={8} dir="ltr" value={detail.document.xml ?? ''} />
              </label>
            </>
          )}
        </div>
      )}
    </Screen>
  );
}
