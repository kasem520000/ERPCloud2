'use client';

import { useState } from 'react';

import { DataTable, Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { apiPost } from '../../../lib/api';
import { dateTime, money, shortDate } from '../../../lib/lookups';

type Mismatch = { id: string; number: string | null; status: string; kind: string; stored_total: string; line_total: string; repairable: boolean };
type Unposted = { id: string; number: string | null; status: string; total: string };
type Gap = { prefix: string; first_seq: string; last_seq: string; issued: number; missing: number };
type StaleDraft = { id: string; number: string | null; created_at: string; total: string };

type MaintenanceRun = {
  id: string;
  mode: string;
  createdAt: string;
  findings: {
    totalsMismatch: Mismatch[];
    postedWithoutJournal: Unposted[];
    numberingGaps: Gap[];
    staleDrafts: StaleDraft[];
    counts: { totalsMismatch: number; repairableTotals: number; postedWithoutJournal: number; numberingGaps: number; staleDrafts: number };
  };
  applied: { repairedDraftTotals?: Array<{ id: string; from: string; to: string }> };
};

/**
 * صيانة الفواتير.
 *
 * A scan, then a very narrow repair. The scan looks for the four things that actually go
 * wrong: a header total that disagrees with its own lines, a posted invoice with no
 * journal entry behind it, a hole in a numbering series, and drafts nobody finished.
 *
 * The repair rewrites **draft** totals only. A posted invoice has left the building — it
 * has been printed, sent, possibly reported to ZATCA — so this screen reports it and
 * leaves the correction to a credit note. A maintenance tool that edits posted documents
 * is not maintenance, it is an audit finding.
 */
export default function InvoiceMaintenancePage() {
  const [run, setRun] = useState<MaintenanceRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  async function scan(mode: 'preview' | 'apply') {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await apiPost<MaintenanceRun>('/settings/invoice-maintenance', { mode });
      setRun(result);
      const repaired = result.applied?.repairedDraftTotals?.length ?? 0;
      setNotice(
        mode === 'apply'
          ? { kind: 'ok', text: repaired ? `تم تصحيح إجماليات ${repaired} فاتورة مسودة.` : 'لا توجد مسودات تحتاج تصحيحاً.' }
          : { kind: 'info', text: 'فحص فقط — لم يُعدّل أي مستند.' },
      );
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const counts = run?.findings?.counts;

  return (
    <Screen
      title="صيانة الفواتير"
      subtitle="فحص الفواتير عن التعارضات: إجماليات لا تطابق سطورها، فواتير مرحّلة بلا قيد، فجوات ترقيم، ومسودات معلّقة."
      crumbs={['الإعدادات', 'إعدادات إدارية']}
      actions={
        <>
          <button type="button" className="btn" disabled={busy} onClick={() => scan('preview')}>
            فحص
          </button>
          <button type="button" className="btn primary" disabled={busy || !counts?.repairableTotals} onClick={() => scan('apply')}>
            تصحيح المسودات
          </button>
        </>
      }
    >
      <div className="card">
        <p className="alert info">
          التصحيح التلقائي يقتصر على فواتير <strong>المسودة</strong>: تُعاد حساب إجمالياتها من سطورها. الفواتير
          المرحّلة تُعرض للمراجعة ولا تُعدّل، لأن تعديل مستند مرحّل يُصحَّح بإشعار دائن لا بتحرير صامت.
        </p>
        <Notice notice={notice} />
        {counts && (
          <div className="kpi" style={{ marginTop: 12 }}>
            <div>
              <span className="muted small">إجماليات غير مطابقة</span>
              <strong>{counts.totalsMismatch}</strong>
            </div>
            <div>
              <span className="muted small">قابل للتصحيح (مسودات)</span>
              <strong>{counts.repairableTotals}</strong>
            </div>
            <div>
              <span className="muted small">مرحّلة بلا قيد</span>
              <strong>{counts.postedWithoutJournal}</strong>
            </div>
            <div>
              <span className="muted small">أرقام مفقودة</span>
              <strong>{counts.numberingGaps}</strong>
            </div>
            <div>
              <span className="muted small">مسودات معلّقة</span>
              <strong>{counts.staleDrafts}</strong>
            </div>
          </div>
        )}
      </div>

      {run && (
        <>
          <section className="card">
            <h3>إجماليات لا تطابق السطور</h3>
            {run.findings.totalsMismatch.length === 0 ? (
              <p className="muted">لا توجد فروقات.</p>
            ) : (
              <DataTable
                columns={[
                  { key: 'number', header: 'الفاتورة', align: 'ltr', cell: (row: Mismatch) => row.number ?? row.id.slice(0, 8) },
                  { key: 'status', header: 'الحالة', cell: (row: Mismatch) => (row.status === 'posted' ? 'مرحّلة' : 'مسودة') },
                  { key: 'stored', header: 'المسجّل', align: 'num', cell: (row: Mismatch) => money(row.stored_total) },
                  { key: 'lines', header: 'من السطور', align: 'num', cell: (row: Mismatch) => money(row.line_total) },
                  { key: 'fix', header: 'الإجراء', cell: (row: Mismatch) => (row.repairable ? 'يُصحَّح تلقائياً' : 'مراجعة يدوية — إشعار دائن') },
                ]}
                rows={run.findings.totalsMismatch}
                rowKey={(row) => row.id}
              />
            )}
          </section>

          <div className="grid cols-2">
            <section className="card">
              <h3>مرحّلة بلا قيد محاسبي</h3>
              {run.findings.postedWithoutJournal.length === 0 ? (
                <p className="muted">لا توجد.</p>
              ) : (
                <DataTable
                  columns={[
                    { key: 'number', header: 'الفاتورة', align: 'ltr', cell: (row: Unposted) => row.number ?? row.id.slice(0, 8) },
                    { key: 'total', header: 'الإجمالي', align: 'num', cell: (row: Unposted) => money(row.total) },
                  ]}
                  rows={run.findings.postedWithoutJournal}
                  rowKey={(row) => row.id}
                />
              )}
            </section>
            <section className="card">
              <h3>فجوات الترقيم</h3>
              {run.findings.numberingGaps.length === 0 ? (
                <p className="muted">التسلسل متصل.</p>
              ) : (
                <DataTable
                  columns={[
                    { key: 'prefix', header: 'السلسلة', align: 'ltr', cell: (row: Gap) => row.prefix },
                    { key: 'range', header: 'المدى', align: 'ltr', cell: (row: Gap) => `${row.first_seq} → ${row.last_seq}` },
                    { key: 'issued', header: 'الصادر', align: 'num', cell: (row: Gap) => String(row.issued) },
                    { key: 'missing', header: 'المفقود', align: 'num', cell: (row: Gap) => String(row.missing) },
                  ]}
                  rows={run.findings.numberingGaps}
                  rowKey={(row) => row.prefix}
                />
              )}
            </section>
          </div>

          <section className="card">
            <h3>مسودات معلّقة</h3>
            {run.findings.staleDrafts.length === 0 ? (
              <p className="muted">لا توجد مسودات قديمة.</p>
            ) : (
              <DataTable
                columns={[
                  { key: 'number', header: 'الفاتورة', align: 'ltr', cell: (row: StaleDraft) => row.number ?? row.id.slice(0, 8) },
                  { key: 'created', header: 'أُنشئت', cell: (row: StaleDraft) => shortDate(row.created_at) },
                  { key: 'total', header: 'الإجمالي', align: 'num', cell: (row: StaleDraft) => money(row.total) },
                ]}
                rows={run.findings.staleDrafts}
                rowKey={(row) => row.id}
              />
            )}
          </section>

          <p className="muted small">آخر فحص: {dateTime(run.createdAt)}</p>
        </>
      )}
    </Screen>
  );
}
