'use client';

import Link from 'next/link';
import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { apiData, apiPost } from '../../../lib/api';
import { dateTime } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

type BackupRun = {
  id: string;
  kind: string;
  status: string;
  note: string | null;
  tables: string[];
  rowCounts: Record<string, number>;
  totalRows: number;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
};

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} ك.ب`;

/**
 * النسخ الإحتياطي.
 *
 * A logical export of this company file's business data — not a database dump, and the
 * screen says so rather than letting an operator believe they are covered for a disk
 * failure. What it is genuinely good for: keeping a dated copy before a risky change, and
 * moving master data between files.
 */
export default function BackupPage() {
  const backups = useQuery<BackupRun[]>(() => apiData<BackupRun[]>('/settings/backups'), []);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  async function take() {
    setBusy(true);
    setNotice(undefined);
    try {
      const created = await apiPost<BackupRun>('/settings/backups', { note: note.trim() || undefined });
      setNote('');
      setNotice({ kind: 'ok', text: `تم أخذ نسخة تحتوي ${created.totalRows} سجلاً من ${created.tables.length} جدولاً.` });
      backups.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function download(id: string) {
    setNotice(undefined);
    try {
      const payload = await apiData<Record<string, unknown>>(`/settings/backups/${id}/download`);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `backup-${id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <Screen
      title="النسخ الإحتياطي"
      subtitle="نسخة منطقية من بيانات هذا الملف: كل جدول يخص المنشأة، بعدد سجلاته وبصمة تحقق."
      crumbs={['الإعدادات', 'إعدادات إدارية']}
      actions={
        <Link className="btn" href="/settings/restore">
          إستعادة البيانات
        </Link>
      }
    >
      <div className="card">
        <p className="alert info">
          هذه نسخة منطقية للبيانات وليست نسخة كاملة لقاعدة البيانات. تصلح للاحتفاظ بلقطة قبل عملية كبيرة أو
          لنقل البيانات، ولا تغني عن نسخة الخادم (pg_dump) في حالات تلف القرص. لا تتضمن النسخة المستخدمين ولا
          الصلاحيات ولا سجل التدقيق.
        </p>
        <div className="toolbar">
          <label className="field wide">
            <span>ملاحظة (اختياري)</span>
            <input className="input" value={note} onChange={(event) => setNote(event.target.value)} placeholder="قبل ترحيل بيانات المخزون" />
          </label>
          <button type="button" className="btn primary" onClick={take} disabled={busy}>
            {busy ? 'جارٍ أخذ النسخة…' : 'أخذ نسخة الآن'}
          </button>
        </div>
        <Notice notice={notice} />
      </div>

      <QueryView query={backups} empty="لا توجد نسخ محفوظة" emptyDetail="اضغط «أخذ نسخة الآن» لإنشاء أول نسخة.">
        {(rows) => (
          <section className="card">
            <h3>النسخ المحفوظة</h3>
            <DataTable
              columns={[
                { key: 'createdAt', header: 'التاريخ', cell: (row: BackupRun) => dateTime(row.createdAt) },
                { key: 'note', header: 'الملاحظة', cell: (row: BackupRun) => row.note ?? '—' },
                { key: 'tables', header: 'الجداول', align: 'num', cell: (row: BackupRun) => String(row.tables.length) },
                { key: 'rows', header: 'السجلات', align: 'num', cell: (row: BackupRun) => String(row.totalRows) },
                { key: 'size', header: 'الحجم', align: 'num', cell: (row: BackupRun) => kb(row.sizeBytes) },
                { key: 'checksum', header: 'البصمة', align: 'ltr', cell: (row: BackupRun) => row.checksum.slice(0, 12) },
                {
                  key: 'download',
                  header: '',
                  cell: (row: BackupRun) => (
                    <button type="button" className="btn sm" onClick={() => download(row.id)}>
                      تنزيل
                    </button>
                  ),
                },
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
