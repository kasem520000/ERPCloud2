'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { DataTable, Notice } from '../../../../../components/data-view';
import { Screen } from '../../../../../components/screen';
import { ApiError, apiData, apiList, apiPost } from '../../../../../lib/api';
import { money } from '../../../../../lib/lookups';
import { useSession } from '../../../../../lib/session';
import { useQuery } from '../../../../../lib/use-query';

type WpsRow = {
  employeeId: string;
  name: string;
  nationalId: string;
  iban: string;
  basic: string;
  housing: string;
  other: string;
  deductions: string;
  net: string;
  errors: string[];
};
type Preview = { yearMonth: string; bankCode: string; establishmentId: string; employeeCount: number; ready: boolean; totalNet: string; rows: WpsRow[]; csv: string };
type FileRow = { id: string; fileName: string; status: string; employeeCount: number; totalNet: string; bankResponse: string | null; createdAt: string };
type Settings = { establishmentId: string; bankCode: string; gosiEstablishmentNo: string };

const statusLabel: Record<string, string> = { generated: 'مُصدَّر', uploaded: 'مرفوع', accepted: 'مقبول', rejected: 'مرفوض' };

function download(name: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function PayrollWpsPage() {
  const params = useParams<{ id: string }>();
  const runId = String(params.id);
  const { can } = useSession();
  const settings = useQuery<Settings>(() => apiData<Settings>('/hrm/payroll/compliance-settings'), []);
  const files = useQuery<FileRow[]>(() => apiList<FileRow>(`/hrm/payroll/runs/${runId}/wps`), [runId]);
  const [bankCode, setBankCode] = useState('');
  const [establishmentId, setEstablishmentId] = useState('');
  const [preview, setPreview] = useState<Preview>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string }>();

  const bank = bankCode || settings.data?.bankCode || '';
  const establishment = establishmentId || settings.data?.establishmentId || '';

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="حماية الأجور والتأمينات"
      subtitle="تصدير ملف مدد/البنك وملف التأمينات، ثم تحديث الحالة بعد الرفع اليدوي."
      crumbs={['الموظفين والرواتب', 'المسيّر']}
      actions={<Link className="btn" href={`/hrm/payroll/${runId}`}>رجوع للمسيّر</Link>}
    >
      <Notice notice={notice} />
      <div className="card">
        <div className="form-grid">
          <label className="field">
            <span>رمز البنك</span>
            <input className="input" dir="ltr" value={bank} onChange={(event) => setBankCode(event.target.value.toUpperCase())} />
          </label>
          <label className="field">
            <span>رقم منشأة مدد</span>
            <input className="input" dir="ltr" value={establishment} onChange={(event) => setEstablishmentId(event.target.value)} />
          </label>
        </div>
        {can('payroll.wps.export') && (
          <div className="row">
            <button className="btn" type="button" disabled={busy} onClick={() => void run(async () => {
              await apiPost('/hrm/payroll/compliance-settings', { bankCode: bank, establishmentId: establishment, gosiEstablishmentNo: settings.data?.gosiEstablishmentNo });
              setPreview(await apiData<Preview>(`/hrm/payroll/runs/${runId}/wps-preview?bank_code=${encodeURIComponent(bank)}&establishment_id=${encodeURIComponent(establishment)}`));
            })}>
              معاينة الملف
            </button>
            <button className="btn primary" type="button" disabled={busy} onClick={() => void run(async () => {
              const exported = await apiPost<FileRow & { csv: string }>(`/hrm/payroll/runs/${runId}/wps-export`, { bankCode: bank, establishmentId: establishment });
              download(exported.fileName, exported.csv);
              setNotice({ kind: 'ok', text: `تم إنشاء الملف ${exported.fileName}` });
              files.reload();
            })}>
              تصدير حماية الأجور
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => void run(async () => {
              const exported = await apiPost<{ fileName: string; csv: string }>(`/hrm/payroll/runs/${runId}/gosi-export`, {});
              download(exported.fileName, exported.csv);
              setNotice({ kind: 'ok', text: `تم إنشاء ${exported.fileName}` });
            })}>
              تصدير التأمينات
            </button>
          </div>
        )}
      </div>

      {preview && (
        <div className="card">
          <h2>معاينة {preview.yearMonth} — {preview.employeeCount} موظف — {money(preview.totalNet)}</h2>
          {!preview.ready && <p className="alert warn">الملف غير جاهز للتصدير حتى تكتمل الهوية والآيبان.</p>}
          <DataTable
            rows={preview.rows}
            rowKey={(row) => row.employeeId}
            columns={[
              { key: 'name', header: 'الموظف', cell: (row) => row.name },
              { key: 'id', header: 'الهوية', align: 'ltr', cell: (row) => row.nationalId || '—' },
              { key: 'iban', header: 'الآيبان', align: 'ltr', cell: (row) => row.iban || '—' },
              { key: 'net', header: 'الصافي', align: 'num', cell: (row) => money(row.net) },
              { key: 'errors', header: 'ملاحظات', cell: (row) => row.errors.join(' · ') || '—' },
            ]}
          />
        </div>
      )}

      <div className="card">
        <h2>الملفات المصدّرة</h2>
        <DataTable
          rows={files.data ?? []}
          rowKey={(row) => row.id}
          columns={[
            { key: 'name', header: 'الملف', cell: (row) => row.fileName },
            { key: 'status', header: 'الحالة', cell: (row) => statusLabel[row.status] ?? row.status },
            { key: 'count', header: 'الموظفون', align: 'num', cell: (row) => row.employeeCount },
            { key: 'net', header: 'الصافي', align: 'num', cell: (row) => money(row.totalNet) },
            {
              key: 'actions',
              header: '',
              cell: (row) => (
                <button className="btn" type="button" onClick={() => void run(async () => {
                  const full = await apiData<{ fileName: string; csv: string }>(`/hrm/payroll/wps/${row.id}`);
                  download(full.fileName, full.csv);
                })}>
                  تنزيل
                </button>
              ),
            },
          ]}
        />
        {(files.data ?? [])[0] && can('payroll.wps.export') && (
          <div className="row">
            {(['uploaded', 'accepted', 'rejected'] as const).map((status) => (
              <button key={status} className="btn" type="button" disabled={busy} onClick={() => void run(async () => {
                await apiPost(`/hrm/payroll/wps/${files.data?.[0]?.id}/status`, { status, bankResponse: status === 'rejected' ? 'مرفوض من البنك' : 'تم الرفع يدوياً' });
                setNotice({ kind: 'ok', text: 'تم تحديث حالة آخر ملف' });
                files.reload();
              })}>
                {statusLabel[status]}
              </button>
            ))}
          </div>
        )}
      </div>
    </Screen>
  );
}
