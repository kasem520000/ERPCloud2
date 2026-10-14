'use client';

import { useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../components/screen';
import { apiData } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useQuery } from '../../lib/use-query';

/**
 * طلبات البيانات — التصدير والمحو (P-C10).
 *
 * الشاشة تفصل بين **القرار** و**التنفيذ** عن قصد: طلبٌ يُفتح `pending`، ويُقبل أو يُرفض
 * بسببٍ مكتوب، ثم يُنفَّذ. والمحو تحديداً لا يُنفَّذ بضغطة: يكتب المشغّل **بريد صاحب
 * البيانات نفسه** ليؤكّد — لأن الفعل لا رجعة فيه، والتأكيد يجب أن يكلّف شيئاً.
 *
 * وما بعد التنفيذ يُعرض كما هو لا كما يُتمنّى:
 *   * المحو: الحقول التي أُخفيت بالأسماء، والعضويات المسحوبة، والجلسات المُبطلة،
 *     و**عددُ صفوف التدقيق الباقية** — لأن الإيصال يبقى بعد أن تختفي الهوية.
 *   * التصدير: حجم الملف وبصمته ورابطٌ موقّع قصير العمر يفتحه المشغّل بنفسه.
 */

type DataRequestRow = {
  id: string;
  kind: 'export' | 'erase';
  status: 'pending' | 'approved' | 'rejected' | 'completed' | 'cancelled';
  tenantId: string;
  tenantCode: string | null;
  subjectEmail: string;
  subjectUserId: string | null;
  note: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  executedAt: string | null;
  result: {
    artifactId: string | null;
    bytes: number | null;
    checksum: string | null;
    store: string | null;
    tables: number | null;
    rows: number | null;
    anonymisedFields: string[] | null;
    anonymisedUsers: number | null;
    suspendedMemberships: number | null;
    revokedSessions: number | null;
    retainedAuditRows: number | null;
    subjectRef: string | null;
  } | null;
  createdAt: string;
};

type RequestPage = { data: DataRequestRow[]; meta: { total: number } };

type ExportResult = {
  requestId: string;
  subjectRef: string;
  bytes: number;
  checksum: string;
  totalRows: number;
  downloadUrl: string;
  expiresAt: string;
};

type EraseResult = {
  requestId: string;
  subjectRef: string;
  anonymisedFields: string[];
  anonymisedUsers: number;
  suspendedMemberships: number;
  revokedSessions: number;
  retainedAuditRows: number;
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'بانتظار قرار',
  approved: 'مقبول',
  rejected: 'مرفوض',
  completed: 'مُنفَّذ',
  cancelled: 'ملغى',
};

const STATUS_CLASS: Record<string, string> = {
  pending: 'pending',
  approved: 'active',
  rejected: 'failed',
  completed: 'active',
  cancelled: 'failed',
};

const KIND_LABEL: Record<string, string> = { export: 'تصدير', erase: 'محو' };

export default function DataRequestsPage() {
  const { canConsole } = useSession();
  const canManage = canConsole('console.backups.manage');

  const [kind, setKind] = useState<'export' | 'erase'>('export');
  const [tenant, setTenant] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);

  const requests = useQuery<RequestPage>(() => apiData<RequestPage>('/platform/data-requests?limit=100'), []);
  const rows = requests.data?.data ?? [];
  const reasonReady = reason.trim().length >= 5;
  const formReady = tenant.trim().length > 0 && email.trim().includes('@');

  async function open() {
    setBusy('create');
    setNotice(undefined);
    try {
      const created = await apiData<DataRequestRow>('/platform/data-requests', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          tenantId: tenant.trim(),
          subjectEmail: email.trim(),
          ...(note.trim().length >= 3 ? { note: note.trim() } : {}),
        }),
      });
      setNotice({
        kind: 'ok',
        text: `فُتح طلب ${KIND_LABEL[created.kind]} على ${created.subjectEmail} — ينتظر قراراً.`,
      });
      requests.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function decide(row: DataRequestRow, decision: 'approve' | 'reject') {
    setBusy(row.id);
    setNotice(undefined);
    try {
      await apiData<DataRequestRow>(`/platform/data-requests/${row.id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason: reason.trim() }),
      });
      setNotice({
        kind: 'ok',
        text: `قرار: ${decision === 'approve' ? 'قبول' : 'رفض'} — والسبب مسجَّل في التدقيق.`,
      });
      requests.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function execute(row: DataRequestRow) {
    if (row.kind === 'erase' && confirmEmail.trim().toLowerCase() !== row.subjectEmail.toLowerCase()) {
      setNotice({ kind: 'danger', text: 'المحو يحتاج كتابة بريد صاحب البيانات نفسه في حقل التأكيد.' });
      return;
    }
    if (
      row.kind === 'erase' &&
      !window.confirm(`محو هوية ${row.subjectEmail} نهائياً؟ لا رجعة في هذا الفعل.`)
    )
      return;

    setBusy(row.id);
    setNotice(undefined);
    try {
      const outcome = await apiData<{ export?: ExportResult; erased?: EraseResult }>(
        `/platform/data-requests/${row.id}/execute`,
        {
          method: 'POST',
          body: JSON.stringify(
            row.kind === 'erase'
              ? { confirm: confirmEmail.trim(), ...(reasonReady ? { reason: reason.trim() } : {}) }
              : {},
          ),
        },
      );
      if (outcome.export) {
        window.open(outcome.export.downloadUrl, '_blank', 'noopener');
        setNotice({
          kind: 'ok',
          text: `صُدِّر ${outcome.export.totalRows} صفاً في ملفٍ حجمه ${formatBytes(outcome.export.bytes)} — الرابط صالح حتى ${new Date(outcome.export.expiresAt).toLocaleString('ar-SA')}.`,
        });
      } else if (outcome.erased) {
        setNotice({
          kind: 'ok',
          text: `مُحيت الهوية: ${outcome.erased.anonymisedUsers} مستخدماً، وسُحبت ${outcome.erased.suspendedMemberships} عضوية، وأُبطلت ${outcome.erased.revokedSessions} جلسة — وبقي ${outcome.erased.retainedAuditRows} صفّ تدقيقٍ كإيصال.`,
        });
      }
      requests.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen
      title="طلبات البيانات"
      subtitle="طلبُ تصديرٍ لبيانات شخصٍ بعينه، وطلبُ محوٍ يُخفي الهوية فعلاً — بقرارٍ مكتوب، وتنفيذٍ مُقاس، وإيصالٍ يبقى."
      crumbs={['المنصة', 'التشغيل']}
      actions={
        <button className="btn" type="button" onClick={requests.reload}>
          تحديث
        </button>
      }
    >
      {!canManage ? (
        <Forbidden />
      ) : (
        <>
          <div className="card tight no-print">
            <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label className="field" style={{ minWidth: 160 }}>
                <span>نوع الطلب</span>
                <select
                  className="input"
                  value={kind}
                  onChange={(event) => setKind(event.target.value as 'export' | 'erase')}
                >
                  <option value="export">تصدير بيانات</option>
                  <option value="erase">محو بيانات (إخفاء هوية)</option>
                </select>
              </label>
              <label className="field" style={{ minWidth: 320, flex: 1 }}>
                <span>معرّف المستأجر (uuid)</span>
                <input
                  className="input"
                  dir="ltr"
                  value={tenant}
                  onChange={(event) => setTenant(event.target.value)}
                />
              </label>
              <label className="field" style={{ minWidth: 260, flex: 1 }}>
                <span>بريد صاحب البيانات</span>
                <input
                  className="input"
                  dir="ltr"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="field" style={{ minWidth: 220, flex: 1 }}>
                <span>ملاحظة (اختياري)</span>
                <input className="input" value={note} onChange={(event) => setNote(event.target.value)} />
              </label>
              <button
                className="btn primary"
                type="button"
                disabled={!formReady || busy === 'create'}
                onClick={() => void open()}
              >
                افتح الطلب
              </button>
            </div>
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              المحو يُخفي حقول الهوية في `users` ويسحب العضوية ويُبطل الجلسات — ولا يحذف المستندات ولا صفوف
              التدقيق: الأولى دفاتر العميل تحتاج مرجع منشئها، والثانية هي الإيصال. والفرق يُعرض في عمود
              النتيجة.
            </p>
          </div>

          <div className="card tight no-print">
            <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label className="field" style={{ minWidth: 380, flex: 1 }}>
                <span>سبب القرار / سبب التنفيذ (5 محارف على الأقل)</span>
                <input
                  className="input"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="مثال: طلبٌ موثّق من صاحب البيانات بتاريخ …"
                />
              </label>
              <label className="field" style={{ minWidth: 300, flex: 1 }}>
                <span>تأكيد المحو — اكتب البريد كما هو</span>
                <input
                  className="input"
                  dir="ltr"
                  value={confirmEmail}
                  onChange={(event) => setConfirmEmail(event.target.value)}
                  placeholder="subject@example.test"
                />
              </label>
            </div>
          </div>

          {notice && <div className={`alert ${notice.kind === 'ok' ? '' : 'danger'}`}>{notice.text}</div>}

          {requests.status === 'loading' && <Loading />}
          {requests.status === 'forbidden' && <Forbidden />}
          {requests.status === 'error' && <ErrorBox message={requests.error} onRetry={requests.reload} />}
          {requests.status === 'success' &&
            (rows.length === 0 ? (
              <Empty
                title="لا طلبات"
                detail="افتح طلباً أعلاه — القرار ثم التنفيذ، ولكلٍّ منهما سببه المسجَّل."
              />
            ) : (
              <>
                <p className="muted small">
                  {rows.length} من {requests.data?.meta.total ?? rows.length} طلباً
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>فُتح</th>
                        <th>النوع</th>
                        <th>العميل</th>
                        <th>صاحب البيانات</th>
                        <th>الحالة</th>
                        <th>النتيجة</th>
                        <th className="no-print">إجراء</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id}>
                          <td dir="ltr">{new Date(row.createdAt).toLocaleString('ar-SA')}</td>
                          <td>
                            <span className={`badge ${row.kind === 'erase' ? 'failed' : 'pending'}`}>
                              {KIND_LABEL[row.kind] ?? row.kind}
                            </span>
                          </td>
                          <td dir="ltr">{row.tenantCode ?? row.tenantId.slice(0, 8)}</td>
                          <td dir="ltr">
                            {row.subjectEmail}
                            {row.result?.subjectRef && (
                              <div className="muted small" dir="ltr">
                                {row.result.subjectRef}
                              </div>
                            )}
                          </td>
                          <td>
                            <span className={`badge ${STATUS_CLASS[row.status] ?? 'pending'}`}>
                              {STATUS_LABEL[row.status] ?? row.status}
                            </span>
                            {row.decisionNote && <div className="muted small">{row.decisionNote}</div>}
                          </td>
                          <td className="small">
                            {row.result?.anonymisedUsers ? (
                              <>
                                أُخفي {row.result.anonymisedUsers} مستخدماً (
                                {row.result.anonymisedFields?.length ?? 0} حقلاً)
                                <div className="muted small">
                                  سُحبت {row.result.suspendedMemberships ?? 0} عضوية · أُبطلت{' '}
                                  {row.result.revokedSessions ?? 0} جلسة · بقي{' '}
                                  {row.result.retainedAuditRows ?? 0} صفّ تدقيق
                                </div>
                              </>
                            ) : row.result?.rows ? (
                              <>
                                {row.result.rows} صفاً في {row.result.tables ?? 0} جدولاً
                                <div className="muted small" dir="ltr">
                                  {row.result.bytes ? formatBytes(row.result.bytes) : ''} ·{' '}
                                  {row.result.checksum?.slice(0, 12)}…
                                </div>
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="no-print">
                            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                              {row.status === 'pending' && (
                                <>
                                  <button
                                    className="btn small"
                                    type="button"
                                    disabled={!reasonReady || busy === row.id}
                                    title={reasonReady ? 'قبول' : 'اكتب سبب القرار أولاً'}
                                    onClick={() => void decide(row, 'approve')}
                                  >
                                    اقبل
                                  </button>
                                  <button
                                    className="btn small danger"
                                    type="button"
                                    disabled={!reasonReady || busy === row.id}
                                    onClick={() => void decide(row, 'reject')}
                                  >
                                    ارفض
                                  </button>
                                </>
                              )}
                              {row.status === 'approved' && (
                                <button
                                  className="btn small primary"
                                  type="button"
                                  disabled={busy === row.id}
                                  onClick={() => void execute(row)}
                                >
                                  {row.kind === 'erase' ? 'نفّذ المحو' : 'نفّذ التصدير'}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ))}
        </>
      )}
    </Screen>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ك.ب`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} م.ب`;
}

function apiMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'تعذّر تنفيذ الفعل.';
}
