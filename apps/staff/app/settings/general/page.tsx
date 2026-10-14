'use client';

import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';

import { Screen } from '../../../components/screen';
import { Button } from '../../../components/ui/button';
import { Labeled } from '../../../components/ui/input';
import { Table } from '../../../components/ui/table';
import { Toggle } from '../../../components/ui/toggle';
import { ApiError, apiData, apiPut } from '../../../lib/api';
import { useQuery } from '../../../lib/use-query';

type Settings = Record<string, unknown>;

/**
 * ⚙️ إعدادات الكاشير — نافذة `frmCasherSetting.xaml` (٣٠٧ أسطر) بترويساتها الحرفية:
 * «الباركود أوتوماتيك» (س239) · «تاتش سكرين» (س252) · «عرض المجموعات والأصناف» (س265) ·
 * «قيمة التوصيل» (س271) · «التأمين» (س279) · «الوحدة» (س287) — وزرّ «حفظ» (س300) هو
 * `PUT /settings/pos.*` نفسها. والشاشة تقرأ ما هو مكتوبٌ بالفعل وتعرضه بجانب حقوله، فلا
 * تظهر خانةٌ فارغة وكأنّ الإعداد غير قائم.
 */
const CASHER_FIELDS: Array<{ key: string; label: string; kind: 'boolean' | 'number' | 'text'; hint?: string }> = [
  // النصوص حرفيةٌ من `frmCasherSetting.xaml` — بالأيقونة واللفظ الذي يراه المشرف هناك.
  {
    key: 'sales.saveAsDraft',
    label: '📝 حفظ فاتورة المبيعات كمسودة قبل الترحيل',
    kind: 'boolean',
    hint: 'عند إيقاف هذا الخيار (الوضع الافتراضي السحابي)، يتم حفظ وترحيل فاتورة المبيعات فوراً وإصدار رقمها الضريبي وباركود QR مباشرة.',
  },
  { key: 'pos.barcodeAuto', label: '📷 الباركود أوتوماتيك', kind: 'boolean', hint: 'يُسجَّل الباركود تلقائياً عند فتح شاشة البيع.' },
  { key: 'pos.touchScreen', label: '👆 الشاشة تدعم التاتش سكرين', kind: 'boolean', hint: 'تكبير أزرار شاشة اللمس وتبسيط التنقل.' },
  { key: 'pos.showGroups', label: '📦 عرض المجموعات والأصناف', kind: 'boolean', hint: 'عرض المجموعات كأزرار سريعة أعلى لوحة الأصناف.' },
  { key: 'pos.defaultDeliveryFee', label: '🚗 قيمة التوصيل الافتراضية', kind: 'number' },
  { key: 'pos.defaultInsurance', label: '🛡️ قيمة التأمين الافتراضية', kind: 'number' },
  { key: 'pos.defaultUnitId', label: '📏 الوحدة الافتراضية', kind: 'text' },
];

export default function GeneralSettingsPage() {
  const settings = useQuery<Settings>(() => apiData<Settings>('/settings'), []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  useEffect(() => {
    if (settings.status !== 'success') return;
    const next: Record<string, string> = {};
    for (const field of CASHER_FIELDS) {
      const value = settings.data?.[field.key];
      if (field.key === 'sales.saveAsDraft') {
        next[field.key] = value === true || value === 'true' ? 'true' : 'false';
      } else {
        next[field.key] = value === undefined || value === null ? '' : String(value);
      }
    }
    setDraft(next);
  }, [settings.status, settings.data]);

  async function saveCasher() {
    setBusy(true);
    setNotice(undefined);
    try {
      for (const field of CASHER_FIELDS) {
        const raw = draft[field.key] ?? '';
        const value =
          field.kind === 'boolean' ? raw === 'true' : field.kind === 'number' ? Number(raw || 0) : raw;
        await apiPut(`/settings/${field.key}`, { value });
      }
      setNotice({ kind: 'ok', text: 'تم حفظ إعدادات الكاشير.' });
      settings.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const entries = Object.entries(settings.data ?? {}).map(([key, value]) => ({ key, value }));

  return (
    <Screen
      title="إعدادات عامة"
      subtitle="الإعدادات المطبقة على هذه المنشأة (إعدادات الكاشير، العملة، الضريبة، سياسة الترقيم…)."
      crumbs={['الإعدادات', 'إعدادات عامة']}
      actions={
        <Button variant="secondary" onClick={settings.reload}>
          تحديث
        </Button>
      }
    >
      {settings.status === 'loading' && <ScreenLoading />}
      {settings.status === 'forbidden' && <Forbidden />}
      {settings.status === 'error' && <ErrorBox message={settings.error} onRetry={settings.reload} />}
      {settings.status === 'success' && (
        <section className="rounded-xl border border-line bg-surface shadow-1 overflow-hidden">
          <header className="px-4 pt-4 pb-1 flex items-center justify-between gap-2">
            <div>
              <h3 className="m-0 text-[15px] font-bold text-ink">⚙️ إعدادات الكاشير</h3>
              <p className="m-0 mt-0.5 text-[12.5px] text-muted">تُطبَّق مباشرة على شاشة نقطة البيع.</p>
            </div>
          </header>
          <div className="grid gap-x-6 gap-y-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
            {CASHER_FIELDS.map((field) =>
              field.kind === 'boolean' ? (
                <div key={field.key} className="grid gap-1 rounded-lg border border-line bg-surface-2 p-3">
                  <Toggle
                    label={field.label}
                    hint={field.hint}
                    checked={draft[field.key] !== 'false'}
                    onChange={(checked) => setDraft((current) => ({ ...current, [field.key]: String(checked) }))}
                  />
                  <span className="text-[10.5px] font-semibold text-muted" dir="ltr">
                    {field.key}
                  </span>
                </div>
              ) : (
                <div key={field.key} className="grid gap-1.5">
                  <Labeled label={field.label}>
                    <input
                      dir={field.kind === 'number' ? 'ltr' : undefined}
                      inputMode={field.kind === 'number' ? 'decimal' : undefined}
                      value={draft[field.key] ?? ''}
                      onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                      className="w-full h-10 px-3 rounded-[10px] border border-line-strong bg-surface text-[13.5px] text-ink focus:outline-none focus:border-brand-600 focus:shadow-[var(--ring-brand)] transition-all duration-150"
                    />
                  </Labeled>
                  <span className="text-[10.5px] font-semibold text-muted" dir="ltr">
                    {field.key}
                  </span>
                </div>
              ),
            )}
          </div>
          <footer className="px-4 py-3 border-t border-line flex flex-wrap items-center justify-between gap-3">
            {notice ? (
              <span
                className={`text-[13px] font-semibold ${notice.kind === 'ok' ? 'text-ok-ink' : 'text-danger'}`}
              >
                {notice.text}
              </span>
            ) : (
              <span className="text-[12px] text-muted">الحفظ يحدّث كل المفاتيح أعلاه دفعة واحدة.</span>
            )}
            <Button variant="primary" icon={<Save size={15} />} loading={busy} onClick={() => void saveCasher()}>
              حفظ
            </Button>
          </footer>
        </section>
      )}

      {settings.status === 'success' && (
        <section className="rounded-xl border border-line bg-surface shadow-1 overflow-hidden">
          <header className="px-4 pt-4 pb-1">
            <h3 className="m-0 text-[15px] font-bold text-ink">سجل المفاتيح ({entries.length})</h3>
            <p className="m-0 mt-0.5 text-[12.5px] text-muted">كل مفاتيح الإعدادات المخزنة لهذه المنشأة.</p>
          </header>
          <div className="px-1 pb-2">
            <Table
              rows={entries}
              rowKey={(row) => row.key}
              dense
              columns={[
                {
                  key: 'key',
                  header: 'المفتاح',
                  ltr: true,
                  cell: (row) => (
                    <span className="font-semibold text-ink-2">{row.key}</span>
                  ),
                },
                {
                  key: 'value',
                  header: 'القيمة',
                  ltr: true,
                  cell: (row) => (
                    <span className="text-[12.5px] text-ink-2 break-all">
                      {typeof row.value === 'object' && row.value !== null ? JSON.stringify(row.value) : String(row.value)}
                    </span>
                  ),
                },
              ]}
            />
          </div>
        </section>
      )}
    </Screen>
  );
}

function ScreenLoading() {
  return (
    <div className="grid gap-4">
      {[0, 1].map((i) => (
        <div key={i} className="rounded-xl border border-line bg-surface p-4 shadow-1 grid gap-3" aria-busy="true">
          <div className="h-4 w-1/3 rounded-md bg-surface-3 animate-pulse" />
          {Array.from({ length: 3 }).map((_, j) => (
            <div key={j} className="h-9 rounded-md bg-surface-3 animate-pulse" style={{ width: `${95 - j * 15}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

function Forbidden() {
  return (
    <div className="rounded-xl border border-line bg-surface p-8 shadow-1 grid place-items-center text-center gap-2">
      <span className="grid place-items-center size-12 rounded-2xl bg-warn-soft text-warn">🔒</span>
      <p className="m-0 text-[15px] font-bold text-ink">لا تملك صلاحية الوصول</p>
      <p className="m-0 text-[13px] text-muted max-w-md">اطلب من مالك الحساب منحك الصلاحية المطلوبة من «صلاحيات المستخدمين».</p>
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-1 grid gap-3">
      <p className="m-0 flex items-center gap-2 rounded-xl border border-danger-line bg-danger-soft px-4 py-2.5 text-[13px] font-semibold text-danger-ink">
        تعذر تحميل البيانات: {message ?? 'خطأ غير معروف'}
      </p>
      <Button variant="primary" onClick={onRetry}>
        إعادة المحاولة
      </Button>
    </div>
  );
}
