'use client';

import { FileSearch, RefreshCw, ScanLine, ShieldAlert } from 'lucide-react';
import { useState } from 'react';

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
 * الملفات — the cross-tenant file manager (P-C9).
 *
 * السؤال الذي تجيب عنه هذه الشاشة ليس «كم ملفاً عندنا» بل **«أيُّ ملفٍّ لم يُفحص؟»**.
 * وحكم الفحص لا يُخترع هنا: هو `meta.scan` الذي يكتبه مسار الرفع في مسار التدقيق
 * (`FilesService.finalize` عبر منفذ `VirusScanner`)، وهذه الشاشة تقرؤه وتعرضه كما هو.
 *
 * ولهذا يقول العمود **«لم يُفحص»** للملفّ الذي `scan = null`، ولا يقول «نظيف»: الماسح
 * المربوط في هذا المستودع لا يفعل شيئاً فيُعيد `skipped`، وترجمةُ `skipped` إلى «سليم»
 * هي بالضبط الكذبة التي تمنع ظهور الحاجة إلى ماسحٍ حقيقي.
 */

type FileRow = {
  id: string;
  tenantId: string;
  tenantCode: string | null;
  name: string;
  mime: string;
  sizeBytes: number;
  status: 'pending' | 'ready' | 'deleted';
  entity: string | null;
  entityId: string | null;
  uploadedByLabel: string | null;
  createdAt: string;
  deletedAt: string | null;
  scan: {
    verdict: 'clean' | 'infected' | 'skipped';
    scanner: string;
    detail: string | null;
    recordedAt: string;
  } | null;
};

type FilePage = { data: FileRow[]; meta: { total: number; limit: number; offset: number } };

type ScanResult = {
  fileId: string;
  verdict: string;
  scanner: string;
  detail: string | null;
  scannedAt: string;
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'بانتظار الرفع',
  ready: 'جاهز',
  deleted: 'محجور',
};

const STATUS_TONE: Record<string, 'amber' | 'green' | 'red' | 'neutral'> = {
  pending: 'amber',
  ready: 'green',
  deleted: 'red',
};

const SCAN_LABEL: Record<string, string> = {
  clean: 'نظيف',
  infected: 'مُصاب',
  skipped: 'لم يُفحص فعلياً',
};

const SCAN_TONE: Record<string, 'green' | 'red' | 'amber' | 'neutral'> = {
  clean: 'green',
  infected: 'red',
  skipped: 'amber',
};

export default function FilesPage() {
  const { canConsole } = useSession();
  const [status, setStatus] = useState('');
  const [scan, setScan] = useState('');
  const [term, setTerm] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | null>(null);

  const files = useQuery<FilePage>(() => {
    const params = new URLSearchParams({ limit: '100' });
    if (status) params.set('filter[status]', status);
    if (scan) params.set('filter[scan]', scan);
    if (term.trim()) params.set('q', term.trim());
    return apiData<FilePage>(`/platform/files?${params.toString()}`);
  }, [status, scan, term]);

  const rows = files.data?.data ?? [];
  const canManage = canConsole('console.jobs.manage');
  const reasonReady = reason.trim().length >= 5;

  async function scanNow(row: FileRow) {
    setBusyId(row.id);
    setNotice(undefined);
    try {
      const result = await apiData<ScanResult>(`/platform/files/${row.id}/scan`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setNotice({
        kind: result.verdict === 'infected' ? 'danger' : 'ok',
        text: `الفحص الآن: ${SCAN_LABEL[result.verdict] ?? result.verdict} — الماسح «${result.scanner}».`,
      });
      files.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusyId(null);
    }
  }

  async function quarantine(row: FileRow) {
    if (!window.confirm(`حجر الملف «${row.name}»؟ يمنع تنزيله وتبقى ميتاداته دليلاً.`)) return;
    setBusyId(row.id);
    setNotice(undefined);
    try {
      await apiData<FileRow>(`/platform/files/${row.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      setNotice({ kind: 'ok', text: `حُجر «${row.name}» — الميتاداتا باقية والسبب مسجَّل.` });
      files.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Screen
      title="الملفات"
      subtitle="مدير ملفات عبر كل العملاء: الحالة، والارتباط بكيان، وحكم آخر فحص — وحكم الفحص مقروءٌ من مسار التدقيق لا محسوبٌ في الشاشة."
      crumbs={['المنصة', 'التشغيل']}
      actions={
        <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={files.reload}>
          تحديث
        </Button>
      }
    >
      {/* filter bar */}
      <div className="rounded-[10px] border border-line bg-surface p-3 shadow-1 no-print">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Input label="بحث في الاسم" placeholder="كشف" value={term} onChange={(e) => setTerm(e.target.value)} />
          <Select label="حالة الملف" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">الكل</option>
            <option value="pending">بانتظار الرفع</option>
            <option value="ready">جاهز</option>
            <option value="deleted">محجور</option>
          </Select>
          <Select label="حكم الفحص" value={scan} onChange={(e) => setScan(e.target.value)}>
            <option value="">الكل</option>
            <option value="clean">نظيف</option>
            <option value="infected">مُصاب</option>
            <option value="skipped">لم يُفحص فعلياً</option>
            <option value="none">لم يُفحص بعد</option>
          </Select>
          <Input
            label="سبب الحجر (5 محارف على الأقل — يُسجَّل في التدقيق)"
            placeholder="مثال: محتوى مشتبه به أبلغ عنه العميل"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            error={canManage && reason.length > 0 && !reasonReady ? '5 محارف على الأقل' : undefined}
          />
        </div>
        <p className="m-0 mt-2 text-[11.5px] text-muted">
          «لم يُفحص» و«لم يُفحص فعلياً» مختلفان: الأول ملفٌّ لم يمرّ على الماسح أصلاً (لا سطر تدقيق)، والثاني
          مرّ عليه فقال الماسح إنه لا يفحص (الماسح المُهيّأ هنا لا يفعل).
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

      {files.status === 'loading' ? (
        <div className="mt-3 rounded-[10px] border border-line bg-surface p-4 shadow-1">
          <SkeletonRows rows={6} />
        </div>
      ) : files.status === 'forbidden' ? (
        <Forbidden />
      ) : files.status === 'error' ? (
        <ErrorBox message={files.error} onRetry={files.reload} />
      ) : rows.length === 0 ? (
        <div className="mt-3 rounded-[10px] border border-line bg-surface p-8 shadow-1">
          <Empty title="لا ملفات بهذا المرشّح" detail="جرّب مرشّح «لم يُفحص بعد» — هو سؤال هذه الشاشة." />
        </div>
      ) : (
        <>
          <p className="mt-3 mb-2 text-[12px] font-semibold text-muted">
            {rows.length} من {files.data?.meta.total ?? rows.length} ملفاً
          </p>
          <div className="overflow-hidden rounded-[10px] border border-line bg-surface shadow-1">
            <Table
              rows={rows}
              rowKey={(row) => row.id}
              dense
              columns={[
                {
                  key: 'name',
                  header: 'الملف',
                  grow: true,
                  cell: (row) => (
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="grid size-8 flex-none place-items-center rounded-lg bg-surface-3 text-muted">
                        <FileSearch size={14} />
                      </span>
                      <span className="block min-w-0">
                        <span className="block truncate font-mono text-[12px] font-semibold text-ink" dir="ltr">{row.name}</span>
                        <span className="block truncate font-mono text-[10.5px] text-muted" dir="ltr">
                          {row.mime} · {row.uploadedByLabel ?? 'بلا رافع'}
                        </span>
                      </span>
                    </span>
                  ),
                },
                {
                  key: 'tenant',
                  header: 'العميل',
                  cell: (row) => <span className="font-mono text-[12px] text-ink-2" dir="ltr">{row.tenantCode ?? row.tenantId.slice(0, 8)}</span>,
                },
                {
                  key: 'size',
                  header: 'الحجم',
                  numeric: true,
                  ltr: true,
                  cell: (row) => <span className="font-mono text-[12px] text-ink-2">{formatBytes(row.sizeBytes)}</span>,
                },
                {
                  key: 'status',
                  header: 'الحالة',
                  cell: (row) => <Badge tone={STATUS_TONE[row.status] ?? 'neutral'} dot>{STATUS_LABEL[row.status] ?? row.status}</Badge>,
                },
                {
                  key: 'entity',
                  header: 'مربوط بـ',
                  cell: (row) =>
                    row.entity ? (
                      <span className="font-mono text-[11.5px] text-muted" dir="ltr">
                        {row.entity}/{row.entityId?.slice(0, 8) ?? ''}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    ),
                },
                {
                  key: 'scan',
                  header: 'حكم الفحص',
                  cell: (row) =>
                    row.scan ? (
                      <span className="block">
                        <Badge tone={SCAN_TONE[row.scan.verdict] ?? 'neutral'} dot>
                          <ScanLine size={11} /> {SCAN_LABEL[row.scan.verdict] ?? row.scan.verdict}
                        </Badge>
                        <span className="mt-0.5 block font-mono text-[10.5px] text-muted" dir="ltr">
                          {row.scan.scanner} · {new Date(row.scan.recordedAt).toLocaleString('en-GB', { timeZone: 'UTC' })}
                        </span>
                      </span>
                    ) : (
                      <Badge tone="neutral">لم يُفحص</Badge>
                    ),
                },
                {
                  key: 'created',
                  header: 'رُفع في',
                  ltr: true,
                  cell: (row) => <span className="font-mono text-[11.5px] text-muted">{new Date(row.createdAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC</span>,
                },
                ...(canManage
                  ? [
                      {
                        key: 'actions',
                        header: 'إجراء',
                        numeric: true as const,
                        cell: (row: FileRow) => (
                          <span className="flex items-center justify-end gap-1.5">
                            <Button
                              variant="secondary"
                              size="sm"
                              icon={<ScanLine size={12} />}
                              loading={busyId === row.id}
                              onClick={() => void scanNow(row)}
                            >
                              افحص الآن
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              icon={<ShieldAlert size={12} />}
                              disabled={row.status === 'deleted' || !reasonReady}
                              title={reasonReady ? 'حجر الملف' : 'اكتب السبب أولاً'}
                              onClick={() => void quarantine(row)}
                            >
                              حجر
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ك.ب`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} م.ب`;
}

function apiMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'تعذّر تنفيذ الفعل.';
}
