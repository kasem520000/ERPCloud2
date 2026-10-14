'use client';

import { Directory } from '../../../../components/directory';
import { apiData, apiPost } from '../../../../lib/api';
import { arabicName, listBranches, listWarehouses, type Branch, type Warehouse } from '../../../../lib/lookups';
import { useQuery } from '../../../../lib/use-query';

type Connection = { id: string; storeId: string };
type Mapping = {
  id: string;
  connectionId: string | null;
  storeId: string | null;
  branchId: string | null;
  branchName: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  remoteBranchId: string | null;
};

/** Maps a Salla store branch onto the branch + warehouse that fulfils its orders. */
export default function SallaWarehousesPage() {
  const mappings = useQuery<Mapping[]>(() => apiData<Mapping[]>('/integrations/salla/branch-mappings'), []);
  const connections = useQuery<Connection[]>(() => apiData<Connection[]>('/integrations/salla/connections'), []);
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);

  const connectionRows = connections.data ?? [];

  return (
    <Directory<Mapping>
      title="ربط المستودعات بمتجر سلة"
      subtitle="حدّد أي فرع ومستودع يخدم كل فرع في المتجر الإلكتروني، حتى تخصم الطلبات من المخزون الصحيح."
      crumbs={['المستودعات', 'متجر سلة']}
      query={mappings}
      createLabel="ربط جديد"
      formTitle="ربط فرع المتجر بمستودع"
      empty="لا يوجد ربط"
      emptyDetail="بدون ربط، لن يعرف النظام من أي مستودع يخصم طلبات المتجر."
      blocked={connectionRows.length === 0 ? 'اربط متجر سلة أولاً من شاشة إعدادات ربط سلة.' : undefined}
      fields={[
        { name: 'connectionId', label: 'المتجر', type: 'select', required: true, options: connectionRows.map((row) => ({ id: row.id, label: row.storeId })) },
        { name: 'remoteBranchId', label: 'معرّف الفرع في سلة', ltr: true },
        { name: 'branchId', label: 'الفرع', type: 'select', options: (branches.data ?? []).map((row) => ({ id: row.id, label: arabicName(row) })) },
        { name: 'warehouseId', label: 'المستودع', type: 'select', options: (warehouses.data ?? []).map((row) => ({ id: row.id, label: arabicName(row) })) },
      ]}
      onCreate={(values) =>
        apiPost('/integrations/salla/branch-mappings', {
          connectionId: String(values.connectionId),
          remoteBranchId: values.remoteBranchId ? String(values.remoteBranchId) : undefined,
          branchId: values.branchId ? String(values.branchId) : undefined,
          warehouseId: values.warehouseId ? String(values.warehouseId) : undefined,
        })
      }
      successText={() => 'تم حفظ الربط.'}
      columns={[
        { key: 'store', header: 'المتجر', align: 'ltr', cell: (row) => row.storeId ?? '—' },
        { key: 'remote', header: 'فرع سلة', align: 'ltr', cell: (row) => row.remoteBranchId ?? '—' },
        { key: 'branch', header: 'الفرع', cell: (row) => row.branchName ?? '—' },
        { key: 'warehouse', header: 'المستودع', cell: (row) => row.warehouseName ?? '—' },
      ]}
      rowKey={(row) => row.id}
    />
  );
}
