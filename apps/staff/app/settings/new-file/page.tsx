'use client';

import { useState } from 'react';

import { DataTable, Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { apiData, apiPost } from '../../../lib/api';
import { dateTime } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

type CompanyFile = {
  id: string;
  code: string;
  name: string;
  status: string;
  copied: Record<string, number>;
  createdAt: string;
  subscriptionStatus?: string;
};

const COPY_SETS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'accounts', label: 'دليل الحسابات ومراكز التكلفة', hint: 'نفس الشجرة المحاسبية بدون أي أرصدة' },
  { id: 'catalog', label: 'دليل المواد والوحدات والمجموعات', hint: 'الأصناف وتصنيفاتها بدون كميات' },
  { id: 'parties', label: 'العملاء والموردون', hint: 'البطاقات فقط بدون أرصدة أو فواتير' },
  { id: 'structure', label: 'الفروع والمستودعات', hint: 'هيكل المنشأة كما هو' },
];

/**
 * إنشاء ملف.
 *
 * A new company file is a new tenant: a completely separate set of books that the same
 * person owns and reaches from the file picker at login. What can be carried over is
 * master data only — the chart of accounts, the catalog, the parties, the structure.
 * Balances, documents and users never cross, because a file that opens with last year's
 * ledger is not a new file.
 *
 * The new file is created **without a licence** and files an activation request, exactly
 * like a signup. Being able to create books is not the same as being able to grant
 * yourself a subscription.
 */
export default function NewCompanyFilePage() {
  const files = useQuery<CompanyFile[]>(() => apiData<CompanyFile[]>('/settings/company-files'), []);
  const [form, setForm] = useState({ code: '', name: '' });
  const [copy, setCopy] = useState<string[]>(['accounts', 'catalog']);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  function toggle(id: string) {
    setCopy((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  }

  async function create() {
    setBusy(true);
    setNotice(undefined);
    try {
      const created = await apiPost<CompanyFile>('/settings/company-files', {
        code: form.code.trim().toLowerCase(),
        name: form.name.trim(),
        copy,
      });
      setForm({ code: '', name: '' });
      setNotice({
        kind: 'ok',
        text: `تم إنشاء الملف «${created.name}» برمز ${created.code}. سجّل الخروج ثم ادخل باختيار هذا الرمز. الاشتراك بانتظار التفعيل.`,
      });
      files.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="إنشاء ملف"
      subtitle="ملف منشأة جديد بدفاتر مستقلة تماماً، لنفس المالك، يمكن نسخ البيانات الأساسية إليه."
      crumbs={['الإعدادات', 'إعدادات إدارية']}
    >
      <div className="card">
        <p className="alert info">
          الملف الجديد منفصل بالكامل: لا أرصدة ولا فواتير ولا قيود تنتقل إليه، والمنقول اختيارياً هو البيانات
          التعريفية فقط. يبدأ الملف بدون ترخيص ويُسجَّل طلب تفعيل تلقائياً لدى مزوّد الخدمة.
        </p>
        <div className="form-grid">
          <label className="field">
            <span>رمز الملف</span>
            <input
              className="input"
              dir="ltr"
              value={form.code}
              onChange={(event) => setForm({ ...form, code: event.target.value })}
              placeholder="branch-2027"
            />
          </label>
          <label className="field wide">
            <span>اسم المنشأة في الملف الجديد</span>
            <input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="مؤسسة النور — فرع جدة" />
          </label>
        </div>
        <p className="muted small" style={{ marginTop: 10 }}>
          ما يُنسخ من الملف الحالي:
        </p>
        <div className="chips">
          {COPY_SETS.map((set) => (
            <button key={set.id} type="button" className={`chip ${copy.includes(set.id) ? 'on' : ''}`} onClick={() => toggle(set.id)} title={set.hint}>
              {set.label}
            </button>
          ))}
        </div>
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button type="button" className="btn primary" disabled={busy || form.code.trim().length < 2 || form.name.trim().length < 2} onClick={create}>
            {busy ? 'جارٍ الإنشاء…' : 'إنشاء الملف'}
          </button>
        </div>
        <Notice notice={notice} />
      </div>

      <section className="card">
        <h3>الملفات المُنشأة من هنا</h3>
        {(files.data ?? []).length === 0 ? (
          <p className="muted">لم يُنشأ أي ملف بعد.</p>
        ) : (
          <DataTable
            columns={[
              { key: 'code', header: 'الرمز', align: 'ltr', cell: (row: CompanyFile) => row.code },
              { key: 'name', header: 'الاسم', cell: (row: CompanyFile) => row.name },
              {
                key: 'copied',
                header: 'المنقول',
                cell: (row: CompanyFile) =>
                  Object.entries(row.copied ?? {})
                    .map(([table, count]) => `${table}: ${count}`)
                    .join('، ') || '—',
              },
              { key: 'createdAt', header: 'التاريخ', cell: (row: CompanyFile) => dateTime(row.createdAt) },
            ]}
            rows={files.data ?? []}
            rowKey={(row) => row.id}
          />
        )}
      </section>
    </Screen>
  );
}
