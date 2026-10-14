'use client';

import { useState } from 'react';

import { DataTable, Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { apiData, apiPost } from '../../../lib/api';
import { dateTime } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

type Counted = { labelAr: string; rows: number };
type RotationRun = {
  id: string;
  mode: string;
  cutoffDate: string | null;
  findings: {
    cutoffDate?: string;
    rotatable?: Record<string, Counted>;
    preserved?: Record<string, Counted>;
    retainedByDesign?: Record<string, { labelAr: string; reasonAr: string }>;
  };
  applied: Record<string, number>;
  createdAt: string;
};

const yearAgo = () => new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);

/**
 * تدوير البيانات.
 *
 * In the desktop product this menu item quietly deleted old documents. Here it deletes
 * **operational logs only** — notifications, queued jobs, idempotency keys — and shows the
 * documents it is leaving alone next to them, so the difference is visible rather than
 * assumed. The audit log is not rotatable at all: the database revokes DELETE on it from
 * the application, which is what makes an audit trail worth having.
 */
export default function DataRotationPage() {
  const runs = useQuery<RotationRun[]>(() => apiData<RotationRun[]>('/settings/maintenance-runs?kind=data_rotation'), []);
  const [cutoff, setCutoff] = useState(yearAgo());
  const [preview, setPreview] = useState<RotationRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  async function run(mode: 'preview' | 'apply') {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await apiPost<RotationRun>('/settings/data-rotation', { cutoffDate: cutoff, mode, confirm: mode === 'apply' });
      setPreview(result);
      if (mode === 'apply') {
        const deleted = Object.values(result.applied ?? {}).reduce((sum, value) => sum + Number(value), 0);
        setNotice({ kind: 'ok', text: `تم حذف ${deleted} سجلاً تشغيلياً أقدم من ${cutoff}. لم تُحذف أي مستندات.` });
        runs.reload();
      } else {
        setNotice({ kind: 'info', text: 'معاينة فقط — لم يُحذف أي شيء.' });
      }
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const rotatable = Object.entries(preview?.findings?.rotatable ?? {}).map(([table, value]) => ({ table, ...value }));
  const preserved = Object.entries(preview?.findings?.preserved ?? {}).map(([table, value]) => ({ table, ...value }));
  const rotatableTotal = rotatable.reduce((sum, row) => sum + row.rows, 0);

  return (
    <Screen
      title="تدوير البيانات"
      subtitle="تنظيف السجلات التشغيلية القديمة. المستندات المالية لا تُحذف من هنا إطلاقاً."
      crumbs={['الإعدادات', 'إعدادات إدارية']}
    >
      <div className="card">
        <p className="alert warn">
          التدوير يحذف السجلات التشغيلية فقط (الإشعارات، مهام الإرسال، مفاتيح منع التكرار). الفواتير والقيود
          والسندات وحركات المخزون تبقى كما هي — إذا كان المطلوب بداية دفترية جديدة فاستخدم «إنشاء ملف».
          التاريخ المطلوب يجب أن يسبق اليوم بـ 90 يوماً على الأقل.
        </p>
        <div className="toolbar">
          <label className="field">
            <span>حذف ما قبل تاريخ</span>
            <input className="input" type="date" value={cutoff} onChange={(event) => setCutoff(event.target.value)} />
          </label>
          <button type="button" className="btn" disabled={busy} onClick={() => run('preview')}>
            معاينة
          </button>
          <button type="button" className="btn danger" disabled={busy || !preview || rotatableTotal === 0} onClick={() => run('apply')}>
            تنفيذ التدوير
          </button>
        </div>
        <Notice notice={notice} />
      </div>

      {preview && (
        <div className="grid cols-2">
          <section className="card">
            <h3>سيُحذف</h3>
            <DataTable
              columns={[
                { key: 'label', header: 'النوع', cell: (row: (typeof rotatable)[number]) => row.labelAr },
                { key: 'rows', header: 'عدد السجلات', align: 'num', cell: (row: (typeof rotatable)[number]) => String(row.rows) },
              ]}
              rows={rotatable}
              rowKey={(row) => row.table}
            />
            {Object.values(preview.findings?.retainedByDesign ?? {}).map((entry) => (
              <p className="muted small" key={entry.labelAr}>
                {entry.labelAr}: {entry.reasonAr}
              </p>
            ))}
          </section>
          <section className="card">
            <h3>سيبقى كما هو</h3>
            <DataTable
              columns={[
                { key: 'label', header: 'النوع', cell: (row: (typeof preserved)[number]) => row.labelAr },
                { key: 'rows', header: 'قبل التاريخ', align: 'num', cell: (row: (typeof preserved)[number]) => String(row.rows) },
              ]}
              rows={preserved}
              rowKey={(row) => row.table}
            />
          </section>
        </div>
      )}

      <section className="card">
        <h3>سجل عمليات التدوير</h3>
        {(runs.data ?? []).length === 0 ? (
          <p className="muted">لا توجد عمليات سابقة.</p>
        ) : (
          <DataTable
            columns={[
              { key: 'createdAt', header: 'التاريخ', cell: (row: RotationRun) => dateTime(row.createdAt) },
              { key: 'mode', header: 'النوع', cell: (row: RotationRun) => (row.mode === 'apply' ? 'تنفيذ' : 'معاينة') },
              { key: 'cutoff', header: 'حتى تاريخ', cell: (row: RotationRun) => row.cutoffDate ?? '—' },
              {
                key: 'deleted',
                header: 'المحذوف',
                align: 'num',
                cell: (row: RotationRun) => String(Object.values(row.applied ?? {}).reduce((sum, value) => sum + Number(value), 0)),
              },
            ]}
            rows={runs.data ?? []}
            rowKey={(row) => row.id}
          />
        )}
      </section>
    </Screen>
  );
}
