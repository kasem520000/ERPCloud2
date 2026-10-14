'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../../components/data-view';
import { Screen } from '../../../../components/screen';
import { ApiError, apiFetch, apiPost } from '../../../../lib/api';
import { dateTime } from '../../../../lib/lookups';
import { useQuery } from '../../../../lib/use-query';

type Submission = {
  id: string;
  invoiceId: string;
  authority: string;
  environment: string;
  status: string;
  uuid: string | null;
  hash: string | null;
  attempts: string;
  error: string | null;
  submittedAt: string | null;
  createdAt: string;
  qrPayload: string | null;
  requestPayload: { xml?: string; counter?: number; profile?: string } | null;
  response: { reason?: string; submitted?: boolean; signed?: boolean; httpStatus?: number } | null;
};

const STATUS_LABELS: Record<string, string> = {
  prepared: 'مُجهَّزة (لم تُرسل)',
  signed: 'موقّعة (بانتظار الربط)',
  reported: 'مُبلَّغ',
  cleared: 'مُصادق',
  rejected: 'مرفوض',
  failed: 'فشل',
  pending: 'قيد الإرسال',
  not_implemented: 'غير مدعوم',
};

const REASON_LABELS: Record<string, string> = {
  NO_CREDENTIALS: 'لم تُرفع بيانات الاعتماد (شهادة ZATCA) بعد — الفاتورة مُجهَّزة ورمز QR للمرحلة الأولى صالح.',
  NO_GATEWAY_CONFIGURED: 'الفاتورة موقّعة، لكن عنوان بوابة الهيئة (ZATCA_API_BASE_URL) غير مضبوط في البيئة.',
};

/** The UBL document is stored with the submission; downloading it is how an auditor checks it. */
function downloadXml(row: Submission) {
  const xml = row.requestPayload?.xml;
  if (!xml) return;
  const url = URL.createObjectURL(new Blob([xml], { type: 'application/xml;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `zatca-${row.uuid ?? row.id}.xml`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Every invoice sent to the authority, with the hash chain and a retry for failures. */
export default function ZatcaSyncPage() {
  const [status, setStatus] = useState('');
  const submissions = useQuery<Submission[]>(() => apiFetch<Submission[]>(`/einvoice/submissions${status ? `?status=${status}` : ''}`), [status]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  async function retry(row: Submission) {
    setBusy(true);
    setNotice(undefined);
    try {
      await apiPost(`/einvoice/submissions/${row.id}/retry`, {});
      setNotice({ kind: 'ok', text: 'أُعيد إرسال الفاتورة.' });
      submissions.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="مزامنة الفواتير مع هيئة الزكاة والضريبة"
      subtitle="حالة كل فاتورة أُرسلت للهيئة، وسلسلة التجزئة (hash chain) التي تربطها بسابقتها."
      crumbs={['الإعدادات', 'المزامنة']}
    >
      <div className="card toolbar">
        <label className="field">
          <span>الحالة</span>
          <select className="input" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">الكل</option>
            <option value="prepared">مُجهَّزة</option>
            <option value="signed">موقّعة</option>
            <option value="reported">مُبلَّغ</option>
            <option value="cleared">مُصادق</option>
            <option value="rejected">مرفوض</option>
            <option value="failed">فشل</option>
          </select>
        </label>
        <span className="muted small">الإرسال يتم من شاشة الفاتورة بعد ترحيلها؛ هذه الشاشة للمتابعة وإعادة المحاولة.</span>
      </div>
      <Notice notice={notice} />
      <Notice
        notice={{
          kind: 'info',
          text: 'مُجهَّزة = تم بناء مستند UBL 2.1 وربطه بسلسلة التجزئة وتوليد رمز QR للمرحلة الأولى، ولم يُرسل لأن بيانات الاعتماد غير مرفوعة. موقّعة = وُقِّع المستند بمفتاح المنشأة وينتظر ضبط عنوان بوابة الهيئة. لا تُعرض حالة «مُبلَّغ» إلا بعد رد فعلي من الهيئة.',
        }}
      />

      <QueryView query={submissions} empty="لا توجد فواتير مُرسَلة" emptyDetail="رحّل فاتورة ثم أرسلها للهيئة لتظهر هنا.">
        {(rows) => (
          <div className="card">
            <DataTable
              columns={[
                { key: 'created', header: 'التاريخ', cell: (row: Submission) => dateTime(row.submittedAt ?? row.createdAt) },
                { key: 'environment', header: 'البيئة', cell: (row: Submission) => (row.environment === 'production' ? 'إنتاج' : 'تجريبية') },
                { key: 'status', header: 'الحالة', cell: (row: Submission) => STATUS_LABELS[row.status] ?? row.status },
                { key: 'uuid', header: 'UUID', align: 'ltr', cell: (row: Submission) => (row.uuid ? row.uuid.slice(0, 13) + '…' : '—') },
                { key: 'hash', header: 'التجزئة', align: 'ltr', cell: (row: Submission) => (row.hash ? row.hash.slice(0, 12) + '…' : '—') },
                { key: 'attempts', header: 'المحاولات', align: 'num', cell: (row: Submission) => row.attempts },
                { key: 'counter', header: 'العدّاد', align: 'num', cell: (row: Submission) => String(row.requestPayload?.counter ?? '—') },
                { key: 'profile', header: 'النوع', cell: (row: Submission) => (row.requestPayload?.profile === 'standard' ? 'ضريبية' : 'مبسّطة') },
                { key: 'error', header: 'الملاحظة', cell: (row: Submission) => row.error ?? REASON_LABELS[row.response?.reason ?? ''] ?? '—' },
                {
                  key: 'actions',
                  header: '',
                  cell: (row: Submission) =>
                    row.status === 'not_implemented' ? (
                      <span className="muted">—</span>
                    ) : (
                      <div className="row">
                        <button type="button" className="btn sm" disabled={!row.requestPayload?.xml} onClick={() => downloadXml(row)}>
                          تنزيل XML
                        </button>
                        <button type="button" className="btn sm" disabled={busy} onClick={() => retry(row)}>
                          إعادة إرسال
                        </button>
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
