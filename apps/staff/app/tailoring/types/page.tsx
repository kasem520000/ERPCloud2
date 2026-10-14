'use client';

import { Directory } from '../../../components/directory';
import { apiDelete, apiList, apiPatch, apiPost } from '../../../lib/api';
import { money } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * 🧵 أنواع التفصيل — `Form_WPF/frmOrderDetails.xaml.cs`.
 *
 * الديسكتوب لا يملك نافذةً لهذا: النوع يُقرأ في بطاقة الطلب
 * (`SELECT TypeID, TypeName, DefaultPrice FROM TailoringTypes WHERE IsActive=1 ORDER BY
 * TypeName`, L60) ليُملأ «نوع التفصيل:» (`frmOrderDetails.xaml:177`)، ويُكتب من النافذة
 * نفسها (L359). والسحابة تعطيه بطاقته المستقلّة لأن الطلب السحابي لا يُنشئ الأنواع —
 * فيبقى مصدر «نوع التفصيل» وسعرِه الافتراضي هنا (والسعر اقتراحٌ يُعدّل في الطلب).
 */
type TailoringType = {
  id: string;
  code: string | null;
  nameAr: string;
  defaultPrice: string;
  active: boolean;
};

export default function TailoringTypesPage() {
  const { can } = useSession();
  const types = useQuery<TailoringType[]>(() => apiList<TailoringType>('/tailoring/types?activeOnly=0'), []);

  const rows = types.data ?? [];

  return (
    <Directory<TailoringType>
      title="أنواع التفصيل"
      subtitle="أنواع التفصيل المتاحة في طلبات التفصيل، ولكلّ نوعٍ سعرُه الافتراضي. والطلب يقترح السعر ولا يفرضه."
      crumbs={['التفصيل', 'التعاريف']}
      query={types}
      canCreate={can('tailoring.manage')}
      createLabel="➕ إضافة نوع"
      formTitle="نوع تفصيل"
      fields={[
        { name: 'nameAr', label: 'اسم النوع', required: true },
        { name: 'code', label: 'الرمز', ltr: true },
        { name: 'defaultPrice', label: 'السعر الافتراضي', type: 'number', hint: 'يُقترح في الطلب ويمكن تعديله' },
        { name: 'active', label: 'مُتاح', type: 'checkbox' },
      ]}
      initial={{ active: true }}
      onCreate={(values) =>
        apiPost('/tailoring/types', {
          nameAr: String(values.nameAr).trim(),
          code: String(values.code).trim() || undefined,
          defaultPrice: String(values.defaultPrice).trim() || undefined,
        })
      }
      edit={{
        toForm: (row) => ({
          nameAr: row.nameAr,
          code: row.code ?? '',
          defaultPrice: row.defaultPrice,
          active: row.active,
        }),
        onUpdate: (row, values) =>
          apiPatch(`/tailoring/types/${row.id}`, {
            nameAr: String(values.nameAr).trim(),
            code: String(values.code).trim(),
            defaultPrice: String(values.defaultPrice).trim() || undefined,
            active: Boolean(values.active),
          }),
      }}
      onDelete={(row) => apiDelete(`/tailoring/types/${row.id}`)}
      deleteLabel="إخفاء"
      rowLabel={(row) => row.nameAr}
      confirmDelete={(row) => `هل تريد إخفاء النوع «${row.nameAr}»؟ الطلبات القائمة تحتفظ باسمه.`}
      successText={(values) => `تم حفظ النوع ${String(values.nameAr)}.`}
      empty="لا توجد أنواع تفصيل"
      emptyDetail="أضف النوع الأول ليظهر في قائمة «نوع التفصيل» داخل طلب التفصيل."
      rowKey={(row) => row.id}
      columns={[
        { key: 'code', header: 'الرمز', align: 'ltr', cell: (row) => row.code ?? '—' },
        { key: 'name', header: 'النوع', cell: (row) => row.nameAr },
        { key: 'price', header: 'السعر الافتراضي', align: 'num', cell: (row) => money(row.defaultPrice) },
        {
          key: 'state',
          header: 'الحالة',
          cell: (row) => <span className={`badge ${row.active ? 'ok' : ''}`}>{row.active ? 'مُتاح' : 'مُخفى'}</span>,
        },
      ]}
      tiles={[
        { label: 'الأنواع', value: rows.length },
        { label: 'المُتاحة', value: rows.filter((row) => row.active).length, tone: 'ok' },
        { label: 'المُخفاة', value: rows.filter((row) => !row.active).length, tone: 'warn' },
      ]}
    />
  );
}
