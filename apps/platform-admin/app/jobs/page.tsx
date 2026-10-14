'use client';

import { useState } from 'react';
import {
  Activity,
  Ban,
  RefreshCw,
  RotateCcw,
  Server,
  Wifi,
} from 'lucide-react';

import { Empty, ErrorBox, Forbidden, Screen } from '../../components/screen';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/input';
import { SkeletonRows } from '../../components/ui/skeleton';
import { Table } from '../../components/ui/table';
import { apiData } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useQuery } from '../../lib/use-query';

/**
 * المهام والطوابير — the outbox across every customer, **with the two actions** (P-C9).
 *
 * P-C1 opened this page read-only and said so in its subtitle («إعادة المحاولة في جزء
 * العمليات»). This is that part: «إعادة» تُعيد صفّاً معلَّقاً أو ميتاً إلى الطابور بمحاولاتٍ
 * مصفَّرة، و«إلغاء» توسم الصفّ `dead` بسببٍ مكتوب في قرأه لاحقاً، والاثنان مقيَّدان بـ
 * `console.jobs.manage` — فمدقّق المنصة يقرأ الطابور ولا يُشغّله.
 *
 * والأعمدة الثلاثة التي أُضيفت هنا هي ما يجعل الفعل قراراً لا قماراً: **الاستحقاق**
 * (`runAt` — مهمّةٌ مجدولة بلا وقتها لا تُثبت جدولتها)، و**مفاتيح الحمولة** (بلا قيمٍ:
 * قرار «أُعيد المحاولة» لا يحتاج بيانات عميل)، و**نوع الخطأ** كما هو بلا تلخيص.
 */

type JobRow = {
  id: string;
  tenantId: string;
  tenantCode: string | null;
  queue: string;
  type: string;
  status: 'pending' | 'published' | 'dead';
  attempts: number;
  lastError: string | null;
  runAt: string;
  processedAt: string | null;
  createdAt: string;
  payloadKeys: string[];
};

type JobPage = { data: JobRow[]; meta: { total: number; limit: number; offset: number } };

type Heartbeat = { running: boolean; enabled: boolean; oldestPendingAgeSeconds: number | null };

const STATUS_LABEL: Record<string, string> = {
  pending: 'بانتظار النشر',
  published: 'نُشرت',
  dead: 'ميتة',
};

export default function JobsPage() {
  const { canConsole } = useSession();
  const canManage = canConsole('console.jobs.manage');
  const [status, setStatus] = useState('');
  const [onlyTenant, setOnlyTenant] = useState('');
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string }>();

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (onlyTenant) params.set('tenantId', onlyTenant);
  params.set('limit', '100');
  const query = params.toString();

  const jobs = useQuery<JobPage>(() => {
    return apiData<JobPage>(`/platform/jobs?${query}`);
  }, [status, onlyTenant, query]);

  const heartbeat = useQuery<Heartbeat>(() => apiData<Heartbeat>('/platform/jobs/heartbeat'), []);

  const rows = jobs.data?.data ?? [];
  const reasonReady = reason.trim().length >= 5;

  async function act(row: JobRow, action: 'retry' | 'cancel') {
    const verb = action === 'retry' ? 'إعادة' : 'إلغاء';
    if (!window.confirm(`${verb} المهمّة «${row.type}» للعميل ${row.tenantCode ?? row.tenantId.slice(0, 8)}؟`)) {
      return;
    }
    setBusyId(row.id);
    setNotice(undefined);
    try {
      const updated = await apiData<JobRow>(`/platform/jobs/${row.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      setNotice({
        kind: 'ok',
        text:
          action === 'retry'
            ? `أُعيدت «${updated.type}» إلى الطابور بمحاولاتٍ مصفَّرة (${updated.status}).`
            : `أُلغيت «${updated.type}» فصارت ${STATUS_LABEL[updated.status] ?? updated.status} بسببٍ مسجَّل.`,
      });
      jobs.reload();
      heartbeat.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusyId(null);
    }
  }

  const running = heartbeat.data?.running ?? false;
  const enabled = heartbeat.data?.enabled ?? false;
  const oldest = heartbeat.data?.oldestPendingAgeSeconds ?? null;

  return (
    <Screen
      title="المهام والطوابير"
      subtitle="صندوق الأحداث الصادرة (outbox) عبر كل العملاء: ما بانتظار النشر، وما فشل، ومتى — مع إعادة المحاولة والإلغاء بسببٍ مكتوب."
      crumbs={['المنصة', 'التشغيل']}
      actions={
        <>
          <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={jobs.reload}>تحديث</Button>
          <Button variant="secondary" icon={<Activity size={14} />} onClick={heartbeat.reload}>نبض العامل</Button>
        </>
      }
    >
      {/* runner heartbeat */}
      {heartbeat.status === 'success' ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[10px] border border-line bg-surface px-4 py-3 shadow-1 no-print">
          <span className="flex items-center gap-2 text-[13px] font-bold">
            <span className="relative flex size-2.5">
              {running && <span className="absolute inline-flex size-full animate-ping rounded-full bg-ok opacity-60" />}
              <span className={`relative inline-flex size-2.5 rounded-full ${running ? 'bg-ok' : 'bg-line-raised'}`} />
            </span>
            <span className={running ? 'text-ok-ink' : 'text-muted'}>
              {running ? 'عاملٌ يعمل' : 'لا عامل يعمل (WORKER=0)'}
            </span>
          </span>
          <Badge tone={enabled ? 'green' : 'amber'} dot>
            <Wifi size={11} /> {enabled ? 'الطابور موصول (Redis)' : 'الطابور في القاعدة فقط'}
          </Badge>
          <span className="font-mono text-[12px] text-muted" dir="ltr">
            {oldest === null ? 'لا صفوف معلَّقة الآن.' : `أقدم صفٍّ معلَّق قبل ${formatAge(oldest)}.`}
          </span>
          <span className="ms-auto text-[11.5px] text-muted max-w-[380px] leading-relaxed">
            «لا عامل يعمل» ليس عطلاً بذاته: الصفوف تبقى معلَّقة في القاعدة بلا خسارة — لكنها لا تُنفَّذ.
            الاثنان معاً (لا عامل + تراكم) هما الحادثة.
          </span>
        </div>
      ) : null}

      {/* filter bar */}
      <div className="mt-3 rounded-[10px] border border-line bg-surface p-3 shadow-1 no-print">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <div style={{ minWidth: 160 }}>
            <Select label="الحالة" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">الكل</option>
              <option value="pending">بانتظار النشر</option>
              <option value="published">نُشرت</option>
              <option value="dead">ميتة</option>
            </Select>
          </div>
          <Input label="معرّف العميل (اختياري)" dir="ltr" placeholder="uuid" value={onlyTenant} onChange={(e) => setOnlyTenant(e.target.value)} />
          <Input
            label={canManage ? 'سبب الفعل (يُسجَّل في التدقيق — 5 محارف على الأقل)' : 'ملاحظاتك'}
            placeholder="مثال: مزوّد البريد عاد للعمل بعد انقطاع"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={canManage && reason.length > 0 && !reasonReady ? '5 محارف على الأقل' : undefined}
          />
        </div>
        <p className="m-0 mt-2 text-[11.5px] text-muted">
          {canManage
            ? 'الإجراءان يظهران على الصفوف المعلَّقة والميتة فقط. المهمّة التي نُفِّذت لا تُعاد: تنفيذُ ما نُفِّذ مرّتين قرارُ ناشره لا قرار لوحة المنصة.'
            : 'صلاحيتك تسمح بالقراءة فقط (console.jobs.view): لا إعادة ولا إلغاء من هنا، ولا يظهران.'}
        </p>
      </div>

      {notice ? (
        <div
          className={`mt-3 flex items-center gap-2 rounded-[10px] border px-4 py-2.5 text-[13px] font-semibold ${
            notice.kind === 'ok' ? 'border-ok-line bg-ok-soft text-ok-ink' : 'border-danger-line bg-danger-soft text-danger-ink'
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      {jobs.status === 'loading' ? (
        <div className="mt-3 rounded-[10px] border border-line bg-surface p-4 shadow-1">
          <SkeletonRows rows={6} />
        </div>
      ) : jobs.status === 'forbidden' ? (
        <Forbidden />
      ) : jobs.status === 'error' ? (
        <ErrorBox message={jobs.error} onRetry={jobs.reload} />
      ) : rows.length === 0 ? (
        <div className="mt-3 rounded-[10px] border border-line bg-surface p-8 shadow-1">
          <Empty title="لا توجد مهام بهذا المرشّح" detail="هذا هو الوضع الطبيعي عندما يعمل العامل ولا توجد مهام فاشلة." />
        </div>
      ) : (
        <>
          <p className="mt-3 mb-2 text-[12px] font-semibold text-muted">
            {rows.length} من {jobs.data?.meta.total ?? rows.length} مهمّة
          </p>
          <div className="overflow-hidden rounded-[10px] border border-line bg-surface shadow-1">
            <Table
              rows={rows}
              rowKey={(row) => row.id}
              dense
              columns={[
                {
                  key: 'runAt',
                  header: 'الاستحقاق',
                  ltr: true,
                  cell: (row) => <span className="font-mono text-[11.5px] text-muted">{new Date(row.runAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC</span>,
                },
                {
                  key: 'tenant',
                  header: 'العميل',
                  cell: (row) => <span className="font-mono text-[12px] font-semibold text-ink-2" dir="ltr">{row.tenantCode ?? row.tenantId.slice(0, 8)}</span>,
                },
                { key: 'queue', header: 'الطابور', cell: (row) => <span className="font-mono text-[11.5px] text-muted" dir="ltr">{row.queue}</span> },
                { key: 'type', header: 'النوع', cell: (row) => <span className="font-mono text-[11.5px] text-ink-2" dir="ltr">{row.type}</span> },
                {
                  key: 'status',
                  header: 'الحالة',
                  cell: (row) =>
                    row.status === 'pending' ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-warn-soft px-2.5 py-[3px] text-[11.5px] font-bold text-warn-ink ring-1 ring-warn-line">
                        <span className="relative flex size-1.5">
                          <span className="absolute inline-flex size-full animate-ping rounded-full bg-warn opacity-70" />
                          <span className="relative inline-flex size-1.5 rounded-full bg-warn" />
                        </span>
                        <Server size={11} /> {STATUS_LABEL[row.status]}
                      </span>
                    ) : row.status === 'dead' ? (
                      <Badge tone="red" dot>{STATUS_LABEL[row.status]}</Badge>
                    ) : (
                      <Badge tone="green" dot>{STATUS_LABEL[row.status]}</Badge>
                    ),
                },
                {
                  key: 'attempts',
                  header: 'المحاولات',
                  numeric: true,
                  ltr: true,
                  cell: (row) => <span className={`font-mono text-[12px] font-bold ${row.attempts > 3 ? 'text-danger' : 'text-ink-2'}`}>{row.attempts}</span>,
                },
                {
                  key: 'payload',
                  header: 'مفاتيح الحمولة',
                  cell: (row) =>
                    row.payloadKeys.length === 0 ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1" dir="ltr">
                        {row.payloadKeys.map((key) => (
                          <span key={key} className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-muted">
                            {key}
                          </span>
                        ))}
                      </span>
                    ),
                },
                {
                  key: 'error',
                  header: 'آخر خطأ',
                  cell: (row) =>
                    row.lastError ? (
                      <span className="block max-w-[260px] truncate font-mono text-[11px] text-danger" dir="ltr" title={row.lastError}>
                        {row.lastError}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    ),
                },
                ...(canManage
                  ? [
                      {
                        key: 'actions',
                        header: 'إجراء',
                        numeric: true as const,
                        cell: (row: JobRow) => (
                          <span className="flex items-center justify-end gap-1.5">
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<RotateCcw size={12} />}
                              loading={busyId === row.id}
                              disabled={!reasonReady || row.status === 'published'}
                              title={reasonReady ? 'إعادة إلى الطابور' : 'اكتب السبب أولاً'}
                              onClick={() => void act(row, 'retry')}
                            >
                              إعادة
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              icon={<Ban size={12} />}
                              disabled={!reasonReady || row.status === 'published'}
                              title={reasonReady ? 'إلغاء المهمّة' : 'اكتب السبب أولاً'}
                              onClick={() => void act(row, 'cancel')}
                            >
                              إلغاء
                            </Button>
                          </span>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        </>
      )}
    </Screen>
  );
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds} ث`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} د`;
  return `${Math.floor(seconds / 3600)} س`;
}

function apiMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
