'use client';

import { useState } from 'react';

import { Empty, ErrorBox, Loading, Screen } from '../../components/screen';
import { ApiError, apiData, apiPost } from '../../lib/api';
import { useQuery } from '../../lib/use-query';

/**
 * المتابعة والتحصيل — شاشة يطلبها P-C4 («dunning screen: attempts · schedule · messages»).
 *
 * ثلاث طبقات في صفحة واحدة، وكلٌّ منها تقرأ حقيقةً لا وعداً:
 *
 * 1. **الجدول** (`schedule`) — كل فاتورة متأخّرة، ودورها في السلّم، وتاريخ محاولتها القادمة.
 *    الأيام تأتي من إعداد المنصة (`billing.dunning_days`: 0 · 3 · 7)، والسقف من العقود
 *    (`PLATFORM_DUNNING_MAX_ATTEMPTS` = 3) — فما يعرضه الزرّ هو ما سيفعله.
 * 2. **المحاولات** (`attempts`) — ما جرى فعلاً: الرقم والقناة والحالة والوقت.
 * 3. **الرسائل** (`messages`) — نصّ كل محاولة كما سيُرسل.
 *
 * وحدودٌ مقصودة تُعلَن في الشاشة لا تُسكَت: لا خدمة بريد بعد (P-C6)، فالمحاولة تُسجَّل
 * `مجدولة` وتظهر في الجدول بتاريخها؛ والقناة اليدوية وحدها تُسجَّل `أُرسلت` لأن مشغّلاً
 * أجرى الاتّصال بنفسه. أمّا استحقاق الفواتير فيقرأه زرّ التشغيل من `due_date` لا من تخمين.
 */

type Channel = 'email' | 'sms' | 'manual';
type AttemptStatus = 'scheduled' | 'sent' | 'failed' | 'skipped';

type Attempt = {
  id: string;
  subscriptionId: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  tenantId: string;
  tenantCode: string;
  tenantName: string;
  attemptNo: number;
  channel: Channel;
  status: AttemptStatus;
  scheduledAt: string;
  sentAt: string | null;
  message: string;
  outcome: string | null;
};

type ScheduleRow = {
  invoiceId: string;
  invoiceNumber: string | null;
  subscriptionId: string;
  tenantId: string;
  tenantCode: string;
  tenantName: string;
  dueDate: string | null;
  daysOverdue: number;
  remaining: string;
  currency: string;
  attemptsMade: number;
  nextAttemptNo: number;
  nextAttemptAt: string | null;
  exhausted: boolean;
};

type Board = {
  attempts: Attempt[];
  schedule: ScheduleRow[];
  ladderDays: number[];
  maxAttempts: number;
  currency: string;
};

type RunResult = {
  subscriptionId: string;
  subscriptionStatus: string;
  created: Attempt[];
  skipped: Array<{ invoiceId: string; reason: string }>;
};

const CHANNEL_LABEL: Record<Channel, string> = { email: 'بريد', sms: 'رسالة نصية', manual: 'اتصال يدوي' };
const STATUS_LABEL: Record<AttemptStatus, string> = {
  scheduled: 'مجدولة',
  sent: 'أُرسلت',
  failed: 'فشلت',
  skipped: 'متجاوَزة',
};

function dateText(value: string | null): string {
  return value ? new Date(value).toLocaleDateString('ar-SA') : '—';
}

export default function DunningPage() {
  const board = useQuery<Board>(() => apiData<Board>('/platform/dunning'), []);
  const [channel, setChannel] = useState<Channel>('email');
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();
  const [busyFor, setBusyFor] = useState<string>();

  async function run(row: ScheduleRow) {
    setBusyFor(row.subscriptionId);
    setMessage(undefined);
    try {
      const result = await apiPost<RunResult>(`/platform/dunning/${row.subscriptionId}/run`, {
        channel,
        invoiceId: row.invoiceId,
        reason: `متابعة الفاتورة ${row.invoiceNumber ?? ''}`.trim(),
      });
      setMessage({
        kind: 'ok',
        text:
          result.created.length === 0
            ? 'لم تُنشأ محاولة: لا فاتورة متأخّرة في هذه اللحظة.'
            : `أُجريت ${result.created.length} محاولة (${STATUS_LABEL[result.created[0]!.status]})، وحالة الترخيص الآن «${result.subscriptionStatus}».`,
      });
      board.reload();
    } catch (error) {
      setMessage({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusyFor(undefined);
    }
  }

  const data = board.data;
  const schedule = data?.schedule ?? [];
  const attempts = data?.attempts ?? [];

  return (
    <Screen
      title="المتابعة والتحصيل"
      subtitle="من تأخّر عن السداد، وما أُرسل له، وما سيُرسل غداً — الفواتير المتأخّرة لا تُترك للذاكرة."
      crumbs={['المنصة', 'العملاء والتراخيص']}
      actions={
        <>
          <select className="input" style={{ maxWidth: 150 }} value={channel} onChange={(event) => setChannel(event.target.value as Channel)}>
            {(Object.keys(CHANNEL_LABEL) as Channel[]).map((key) => (
              <option key={key} value={key}>
                {CHANNEL_LABEL[key]}
              </option>
            ))}
          </select>
          <button className="btn" type="button" onClick={board.reload}>
            تحديث
          </button>
        </>
      }
    >
      {message && <p className={`alert ${message.kind}`}>{message.text}</p>}
      {board.status === 'loading' && <Loading />}
      {board.status === 'error' && <ErrorBox message={board.error} onRetry={board.reload} />}

      {board.status === 'success' && data && (
        <>
          <div className="card">
            <dl className="kv">
              <dt>السلّم</dt>
              <dd dir="ltr">{data.ladderDays.join(' · ')} يوم بعد الاستحقاق</dd>
              <dt>سقف المحاولات</dt>
              <dd>{data.maxAttempts}</dd>
              <dt>فواتير متأخّرة</dt>
              <dd>{schedule.length}</dd>
              <dt>محاولات مسجَّلة</dt>
              <dd>{attempts.length}</dd>
            </dl>
            <p className="muted small" style={{ marginBottom: 0 }}>
              المحاولة تُسجَّل «مجدولة» عند إنشائها — لا خدمة بريد بعد (P-C6)، ولا ندّعي إرسالاً لم يقع.
              واختيار «اتصال يدوي» يسجّلها «أُرسلت» لأن من أجراها مشغّل.
            </p>
          </div>

          <section className="card">
            <h2>الجدول — ما سيُنفَّذ</h2>
            {schedule.length === 0 ? (
              <Empty title="لا فاتورة متأخّرة" detail="كل فاتورة صادرة إمّا مدفوعة أو لم يحن استحقاقها." />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>الفاتورة</th>
                      <th>العميل</th>
                      <th>الاستحقاق</th>
                      <th className="num">التأخير</th>
                      <th className="num">المتبقّي</th>
                      <th className="num">المحاولات</th>
                      <th>القادمة</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.map((row) => (
                      <tr key={row.invoiceId}>
                        <td dir="ltr">{row.invoiceNumber ?? '—'}</td>
                        <td>
                          <strong>{row.tenantName}</strong>
                          <div className="muted small" dir="ltr">
                            {row.tenantCode}
                          </div>
                        </td>
                        <td dir="ltr">{dateText(row.dueDate)}</td>
                        <td className="num">{row.daysOverdue} يوماً</td>
                        <td className="num">
                          {Number(row.remaining).toLocaleString('ar-SA', { minimumFractionDigits: 2 })} {row.currency}
                        </td>
                        <td className="num">
                          {row.attemptsMade} / {data.maxAttempts}
                        </td>
                        <td>
                          {row.exhausted ? (
                            <span className="badge failed">استُنفدت المحاولات</span>
                          ) : (
                            <>
                              <span className="badge pending">المحاولة {row.nextAttemptNo}</span>
                              <div className="muted small" dir="ltr">
                                {dateText(row.nextAttemptAt)}
                              </div>
                            </>
                          )}
                        </td>
                        <td>
                          <button
                            className="btn sm"
                            type="button"
                            disabled={busyFor === row.subscriptionId}
                            onClick={() => void run(row)}
                          >
                            {busyFor === row.subscriptionId ? 'جارٍ…' : 'متابعة'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card">
            <h2>المحاولات والرسائل</h2>
            {attempts.length === 0 ? (
              <Empty title="لا محاولات بعد" detail="شغّل المتابعة من الجدول أعلاه." />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>الفاتورة</th>
                      <th>العميل</th>
                      <th>القناة</th>
                      <th>الحالة</th>
                      <th>التاريخ</th>
                      <th>الرسالة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attempts.map((attempt) => (
                      <tr key={attempt.id}>
                        <td className="num">{attempt.attemptNo}</td>
                        <td dir="ltr">{attempt.invoiceNumber ?? '—'}</td>
                        <td>{attempt.tenantName}</td>
                        <td>{CHANNEL_LABEL[attempt.channel]}</td>
                        <td>
                          <span className={`badge ${attempt.status}`}>{STATUS_LABEL[attempt.status]}</span>
                          {attempt.outcome && <div className="muted small">{attempt.outcome}</div>}
                        </td>
                        <td dir="ltr">{dateText(attempt.sentAt ?? attempt.scheduledAt)}</td>
                        <td className="small">{attempt.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </Screen>
  );
}
