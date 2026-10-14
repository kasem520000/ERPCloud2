'use client';

import Link from 'next/link';
import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { apiData, apiPost } from '../../../lib/api';
import { dateTime } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

type BackupRun = { id: string; note: string | null; totalRows: number; createdAt: string; checksum: string };
type RestoreRun = {
  id: string;
  mode: string;
  status: string;
  insertedRows: number;
  skippedRows: number;
  summary: { tables?: Record<string, { rows: number; inserted: number; skipped: number; error?: string }>; unresolved?: string[]; existingRows?: Record<string, number> };
  createdAt: string;
};

/**
 * إستعادة البيانات.
 *
 * The restore here is **additive**: it inserts rows that are missing and skips rows whose
 * key already exists. Nothing is deleted, nothing is overwritten. That is a smaller
 * promise than the desktop "restore over the file", and a deliberate one — an operator
 * cannot destroy this year's ledger by restoring last year's backup into it.
 *
 * The dry run is the default and reports what would land; applying requires typing the
 * file code, which is the one detail somebody restoring into the wrong file gets wrong.
 */
export default function RestorePage() {
  const backups = useQuery<BackupRun[]>(() => apiData<BackupRun[]>('/settings/backups'), []);
  const runs = useQuery<RestoreRun[]>(() => apiData<RestoreRun[]>('/settings/restores'), []);
  const [backupId, setBackupId] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RestoreRun | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  async function run(mode: 'dry_run' | 'apply') {
    setBusy(true);
    setNotice(undefined);
    setResult(null);
    try {
      const restored = await apiPost<RestoreRun>('/settings/restores', {
        backupId,
        mode,
        confirmTenantCode: mode === 'apply' ? confirmCode.trim() : undefined,
      });
      setResult(restored);
      setNotice(
        mode === 'dry_run'
          ? { kind: 'info', text: 'فحص تجريبي فقط — لم تُكتب أي بيانات.' }
          : { kind: 'ok', text: `تمت الإضافة: ${restored.insertedRows} سجلاً، وتُخطي ${restored.skippedRows} سجلاً موجوداً مسبقاً.` },
      );
      runs.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const tables = Object.entries(result?.summary?.tables ?? {}).map(([table, value]) => ({ table, ...value }));

  return (
    <Screen
      title="إستعادة البيانات"
      subtitle="إعادة السجلات الناقصة من نسخة محفوظة. الإستعادة إضافية فقط: لا تحذف ولا تستبدل أي سجل قائم."
      crumbs={['الإعدادات', 'إعدادات إدارية']}
      actions={
        <Link className="btn" href="/settings/backup">
          النسخ الإحتياطي
        </Link>
      }
    >
      <div className="card">
        <p className="alert warn">
          الإستعادة تضيف السجلات المفقودة فقط. إذا كان الهدف بدء سجلات جديدة تماماً فالمطلوب «إنشاء ملف»
          جديد وليس الإستعادة فوق ملف يعمل.
        </p>
        <div className="toolbar">
          <label className="field wide">
            <span>النسخة</span>
            <select className="input" value={backupId} onChange={(event) => setBackupId(event.target.value)}>
              <option value="">—</option>
              {(backups.data ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {dateTime(row.createdAt)} — {row.totalRows} سجل {row.note ? `(${row.note})` : ''}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn" disabled={!backupId || busy} onClick={() => run('dry_run')}>
            فحص تجريبي
          </button>
        </div>
        <div className="toolbar">
          <label className="field">
            <span>اكتب رمز الملف للتأكيد</span>
            <input className="input" dir="ltr" value={confirmCode} onChange={(event) => setConfirmCode(event.target.value)} placeholder="demo" />
          </label>
          <button type="button" className="btn danger" disabled={!backupId || !confirmCode.trim() || busy} onClick={() => run('apply')}>
            تنفيذ الإستعادة
          </button>
        </div>
        <Notice notice={notice} />
      </div>

      {tables.length > 0 && (
        <section className="card">
          <h3>تفاصيل {result?.mode === 'apply' ? 'التنفيذ' : 'الفحص'}</h3>
          <DataTable
            columns={[
              { key: 'table', header: 'الجدول', align: 'ltr', cell: (row: (typeof tables)[number]) => row.table },
              { key: 'rows', header: 'في النسخة', align: 'num', cell: (row: (typeof tables)[number]) => String(row.rows) },
              { key: 'inserted', header: 'أُضيف', align: 'num', cell: (row: (typeof tables)[number]) => String(row.inserted) },
              { key: 'skipped', header: 'موجود مسبقاً', align: 'num', cell: (row: (typeof tables)[number]) => String(row.skipped) },
              { key: 'error', header: 'ملاحظة', cell: (row: (typeof tables)[number]) => row.error ?? '—' },
            ]}
            rows={tables}
            rowKey={(row) => row.table}
          />
        </section>
      )}

      <QueryView query={runs} empty="لا توجد عمليات إستعادة سابقة" emptyDetail="ابدأ بفحص تجريبي لنسخة محفوظة.">
        {(rows) => (
          <section className="card">
            <h3>سجل عمليات الإستعادة</h3>
            <DataTable
              columns={[
                { key: 'createdAt', header: 'التاريخ', cell: (row: RestoreRun) => dateTime(row.createdAt) },
                { key: 'mode', header: 'النوع', cell: (row: RestoreRun) => (row.mode === 'apply' ? 'تنفيذ' : 'فحص تجريبي') },
                { key: 'inserted', header: 'أُضيف', align: 'num', cell: (row: RestoreRun) => String(row.insertedRows) },
                { key: 'skipped', header: 'تُخطي', align: 'num', cell: (row: RestoreRun) => String(row.skippedRows) },
              ]}
              rows={rows}
              rowKey={(row) => row.id}
            />
          </section>
        )}
      </QueryView>
    </Screen>
  );
}
