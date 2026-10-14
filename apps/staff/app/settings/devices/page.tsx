'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { FormFields, type FormValues } from '../../../components/directory';
import { Screen } from '../../../components/screen';
import { ApiError, apiData, apiPatch, apiPost } from '../../../lib/api';
import { arabicName, dateTime, listBranches, type Branch } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

type Device = { id: string; name: string; branchId: string; status: string; lastSeenAt: string | null; createdAt: string };

/**
 * Device registry for the Android/desktop clients.
 *
 * The API key is generated server-side and shown exactly once — it is stored hashed, so
 * a lost key means issuing a new device rather than looking the old one up.
 */
export default function SyncDevicesPage() {
  const devices = useQuery<Device[]>(() => apiData<Device[]>('/compat/devices'), []);
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const [values, setValues] = useState<FormValues>({ name: '', branchId: '' });
  const [busy, setBusy] = useState(false);
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  const branchRows = branches.data ?? [];

  async function createDevice(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    setIssuedKey(null);
    try {
      const created = await apiPost<{ apiKey?: string; data?: { apiKey: string } }>('/compat/devices', { name: String(values.name), branchId: String(values.branchId) });
      setIssuedKey(created.apiKey ?? created.data?.apiKey ?? null);
      setValues({ name: '', branchId: String(values.branchId) });
      setNotice({ kind: 'ok', text: 'تم إنشاء الجهاز. انسخ المفتاح الآن — لن يُعرض مرة أخرى.' });
      devices.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(device: Device) {
    setBusy(true);
    try {
      await apiPatch(`/compat/devices/${device.id}/revoke`, {});
      setNotice({ kind: 'ok', text: `تم إيقاف الجهاز ${device.name}.` });
      devices.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="أجهزة أندرويد المرتبطة"
      subtitle="كل جهاز يُصدر له مفتاح API خاص بفرع واحد، ويمكن إيقافه فوراً عند فقدانه."
      crumbs={['الإعدادات', 'المزامنة']}
    >
      <form className="card" onSubmit={createDevice}>
        <h3>جهاز جديد</h3>
        <FormFields
          fields={[
            { name: 'name', label: 'اسم الجهاز', required: true, placeholder: 'كاشير الفرع الرئيسي' },
            { name: 'branchId', label: 'الفرع', type: 'select', required: true, options: branchRows.map((row) => ({ id: row.id, label: arabicName(row) })) },
          ]}
          values={values}
          onChange={setValues}
        />
        <button className="btn primary" type="submit" disabled={busy || !values.name || !values.branchId}>
          {busy ? 'جارٍ الإنشاء…' : 'إنشاء وإصدار مفتاح'}
        </button>
        <Notice notice={notice} />
        {issuedKey ? (
          <p className="alert ok" dir="ltr">
            <code>{issuedKey}</code>
          </p>
        ) : null}
      </form>

      <QueryView query={devices} empty="لا توجد أجهزة" emptyDetail="أنشئ جهازاً لتتمكن تطبيقات الكاشير من المزامنة.">
        {(rows) => (
          <div className="card">
            <DataTable
              columns={[
                { key: 'name', header: 'الجهاز', cell: (row: Device) => row.name },
                { key: 'branch', header: 'الفرع', cell: (row: Device) => arabicName(branchRows.find((branch) => branch.id === row.branchId) ?? { code: '—' }) },
                { key: 'status', header: 'الحالة', cell: (row: Device) => (row.status === 'active' ? 'نشط' : 'موقوف') },
                { key: 'seen', header: 'آخر اتصال', cell: (row: Device) => dateTime(row.lastSeenAt) },
                { key: 'created', header: 'تاريخ الإنشاء', cell: (row: Device) => dateTime(row.createdAt) },
                {
                  key: 'actions',
                  header: '',
                  cell: (row: Device) =>
                    row.status === 'active' ? (
                      <button type="button" className="btn sm danger" disabled={busy} onClick={() => revoke(row)}>
                        إيقاف
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    ),
                },
              ]}
              rows={rows}
              rowKey={(row) => row.id}
            />
          </div>
        )}
      </QueryView>
    </Screen>
  );
}
