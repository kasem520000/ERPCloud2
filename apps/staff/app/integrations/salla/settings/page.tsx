'use client';

import { Directory } from '../../../../components/directory';
import { apiData, apiPost } from '../../../../lib/api';
import { dateTime } from '../../../../lib/lookups';
import { useQuery } from '../../../../lib/use-query';

type Connection = {
  id: string;
  storeId: string;
  status: string;
  scopes: string[];
  expiresAt: string | null;
  createdAt: string;
  accessTokenMasked: string;
  webhookSecretMasked: string;
};

/**
 * Salla connection settings.
 *
 * Tokens are written once and never read back — the API returns masked values only, so
 * this screen can show the connection health without ever holding a live credential.
 */
export default function SallaSettingsPage() {
  const connections = useQuery<Connection[]>(() => apiData<Connection[]>('/integrations/salla/connections'), []);

  return (
    <Directory<Connection>
      title="إعدادات ربط سلة"
      subtitle="اربط متجر سلة عبر رمز الوصول وسر التوقيع. تُخزَّن الأسرار مشفّرة ولا تُعرض مرة أخرى."
      crumbs={['الإعدادات', 'التكاملات']}
      query={connections}
      createLabel="ربط متجر"
      formTitle="بيانات الاتصال بمتجر سلة"
      empty="لا يوجد متجر مرتبط"
      emptyDetail="أنشئ تطبيقاً في لوحة سلة، ثم أدخل معرّف المتجر ورمز الوصول وسر الويب هوك هنا."
      fields={[
        { name: 'storeId', label: 'معرّف المتجر', required: true, ltr: true },
        { name: 'accessToken', label: 'رمز الوصول (Access token)', required: true, ltr: true, wide: true },
        { name: 'refreshToken', label: 'رمز التجديد (اختياري)', ltr: true, wide: true },
        { name: 'webhookSecret', label: 'سر الويب هوك', required: true, ltr: true, wide: true, hint: 'يُستخدم للتحقق من توقيع كل طلب وارد من سلة.' },
        { name: 'expiresAt', label: 'انتهاء الرمز', type: 'date' },
      ]}
      onCreate={(values) =>
        apiPost('/integrations/salla/connections', {
          storeId: String(values.storeId),
          accessToken: String(values.accessToken),
          refreshToken: values.refreshToken ? String(values.refreshToken) : undefined,
          webhookSecret: String(values.webhookSecret),
          expiresAt: values.expiresAt ? new Date(`${String(values.expiresAt)}T00:00:00Z`).toISOString() : undefined,
        })
      }
      successText={(values) => `تم ربط المتجر ${String(values.storeId)}.`}
      columns={[
        { key: 'storeId', header: 'المتجر', align: 'ltr', cell: (row) => row.storeId },
        { key: 'status', header: 'الحالة', cell: (row) => (row.status === 'active' ? 'نشط' : row.status) },
        { key: 'token', header: 'رمز الوصول', cell: (row) => row.accessTokenMasked },
        { key: 'secret', header: 'سر الويب هوك', cell: (row) => row.webhookSecretMasked },
        { key: 'scopes', header: 'الصلاحيات', cell: (row) => (row.scopes?.length ? row.scopes.join('، ') : '—') },
        { key: 'expires', header: 'انتهاء الرمز', cell: (row) => dateTime(row.expiresAt) },
        { key: 'created', header: 'تاريخ الربط', cell: (row) => dateTime(row.createdAt) },
      ]}
      rowKey={(row) => row.id}
    >
      <div className="card">
        <h3>عنوان الويب هوك</h3>
        <p className="muted small">
          سجّل هذا العنوان في لوحة سلة لاستقبال الطلبات: <code dir="ltr">POST /api/v1/integrations/salla/webhooks/&lt;storeId&gt;/orders</code> مع ترويسة
          <code dir="ltr"> x-salla-signature</code>. كل طلب وارد يُنشئ فاتورة مبيعات مباشرة.
        </p>
      </div>
    </Directory>
  );
}
