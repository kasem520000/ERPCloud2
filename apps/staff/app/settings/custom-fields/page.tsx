'use client';

import { useEffect, useState } from 'react';

import { ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { createCustomField, deleteCustomField, listCustomFields, type CustomField, type CustomFieldEntity, type CustomFieldType } from '../../../lib/custom-fields';
import { useSession } from '../../../lib/session';

const entities: Array<{ value: CustomFieldEntity; label: string }> = [
  { value: 'party', label: 'العملاء والموردون' },
  { value: 'item', label: 'الأصناف' },
  { value: 'invoice', label: 'الفواتير' },
  { value: 'employee', label: 'الموظفون' },
];

const types: Array<{ value: CustomFieldType; label: string }> = [
  { value: 'text', label: 'نص' },
  { value: 'number', label: 'رقم' },
  { value: 'date', label: 'تاريخ' },
  { value: 'select', label: 'قائمة اختيار' },
  { value: 'boolean', label: 'نعم / لا' },
];

export default function CustomFieldsSettingsPage() {
  const { can } = useSession();
  const [entity, setEntity] = useState<CustomFieldEntity>('item');
  const [fields, setFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [type, setType] = useState<CustomFieldType>('text');
  const [options, setOptions] = useState('');
  const [required, setRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  const reload = async (): Promise<void> => {
    setLoading(true);
    try {
      setFields(await listCustomFields(entity));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, [entity]);

  if (!can('custom_fields.view')) {
    return <Screen title="الحقول الإضافية" crumbs={['الإعدادات', 'الحقول الإضافية']}><Forbidden /></Screen>;
  }

  const reset = (): void => { setLabel(''); setKey(''); setType('text'); setOptions(''); setRequired(false); };
  const save = async (): Promise<void> => {
    setBusy(true); setNotice(undefined);
    try {
      await createCustomField({ entity, key: key.trim(), label: label.trim(), type, options: type === 'select' ? options.split('\n').map((value) => value.trim()).filter(Boolean) : undefined, required });
      reset(); await reload(); setNotice('تم إنشاء الحقل الإضافي.');
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const remove = async (field: CustomField): Promise<void> => {
    if (!window.confirm(`إيقاف الحقل «${field.label}»؟`)) return;
    setBusy(true);
    try { await deleteCustomField(field.id); await reload(); setNotice('تم إيقاف الحقل مع إبقاء قيمه التاريخية.'); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  return (
    <Screen title="الحقول الإضافية" subtitle="أضف حقولاً typed للعميل أو الصنف أو الفاتورة أو الموظف، وتظهر تلقائياً في البطاقات والتقارير." crumbs={['الإعدادات', 'الحقول الإضافية']}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-xl border border-line bg-surface p-5 shadow-1">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h2 className="m-0 text-[16px] font-bold text-ink">الحقول المعرفة</h2>
            <select className="h-10 rounded-lg border border-line px-3 text-sm" value={entity} onChange={(event) => setEntity(event.target.value as CustomFieldEntity)}>
              {entities.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          {loading ? <Loading rows={4} /> : error ? <ErrorBox message={error} onRetry={() => void reload()} /> : fields.length === 0 ? <p className="text-sm text-muted">لا توجد حقول لهذا الكيان بعد.</p> : (
            <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-right text-muted"><th className="p-2">الاسم</th><th className="p-2">المفتاح</th><th className="p-2">النوع</th><th className="p-2">مطلوب</th><th className="p-2">الحالة</th><th /></tr></thead><tbody>
              {fields.map((field) => <tr key={field.id} className="border-b last:border-0"><td className="p-2 font-semibold">{field.label}</td><td className="p-2 font-mono text-xs" dir="ltr">{field.key}</td><td className="p-2">{types.find((option) => option.value === field.type)?.label ?? field.type}</td><td className="p-2">{field.required ? 'نعم' : 'لا'}</td><td className="p-2">{field.active ? 'نشط' : 'متوقف'}</td><td className="p-2 text-left">{can('custom_fields.manage') && field.active ? <button className="text-danger hover:underline" type="button" disabled={busy} onClick={() => void remove(field)}>إيقاف</button> : null}</td></tr>)}
            </tbody></table></div>
          )}
        </section>
        {can('custom_fields.manage') ? <section className="rounded-xl border border-line bg-surface p-5 shadow-1"><h2 className="m-0 mb-4 text-[16px] font-bold">حقل جديد</h2><div className="grid gap-3">
          <label className="grid gap-1 text-sm"><span>الاسم الظاهر</span><input className="h-10 rounded-lg border px-3" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="تاريخ الضمان" /></label>
          <label className="grid gap-1 text-sm"><span>المفتاح البرمجي</span><input className="h-10 rounded-lg border px-3 font-mono" dir="ltr" value={key} onChange={(event) => setKey(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} placeholder="warranty_date" /></label>
          <label className="grid gap-1 text-sm"><span>النوع</span><select className="h-10 rounded-lg border px-3" value={type} onChange={(event) => setType(event.target.value as CustomFieldType)}>{types.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          {type === 'select' ? <label className="grid gap-1 text-sm"><span>الخيارات، كل خيار في سطر</span><textarea className="min-h-24 rounded-lg border p-3" value={options} onChange={(event) => setOptions(event.target.value)} /></label> : null}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} /> حقل مطلوب عند الحفظ</label>
          <button className="h-10 rounded-lg bg-brand-600 px-4 font-bold text-on-accent disabled:opacity-50" type="button" disabled={busy || !label.trim() || !key.trim()} onClick={() => void save()}>حفظ الحقل</button>
          {notice ? <p className="m-0 text-sm text-ink-2">{notice}</p> : null}
        </div></section> : null}
      </div>
    </Screen>
  );
}
