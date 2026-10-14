'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo } from 'react';

import { Directory } from '../../../components/directory';
import { Loading } from '../../../components/screen';
import { apiDelete, apiList, apiPatch, apiPost } from '../../../lib/api';
import { arabicName, branchOptions, listBranches, type Branch } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type CashLocation = {
  id: string;
  branchId: string;
  kind: 'safe' | 'bank';
  name: string;
  accountId?: string | null;
  currencyCode?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
  changeInPos?: boolean;
  bank?: { bankName?: string; iban?: string; accountNo?: string } | null;
};

type Account = { id: string; code: string; nameAr?: string; name_ar?: string; isPostable?: boolean };

function Inner() {
  const { can } = useSession();
  const search = useSearchParams();
  const wanted = search?.get('type') ?? '';
  const kind: 'safe' | 'bank' | '' = wanted === 'bank' ? 'bank' : wanted === 'cash' || wanted === 'safe' ? 'safe' : '';

  const locations = useQuery<CashLocation[]>(() => apiList<CashLocation>('/cash-locations'), []);
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const accounts = useQuery<Account[]>(() => apiList<Account>('/accounts'), []);
  const manage = can('organization.cashlocation.manage');

  const rows = useMemo(() => {
    const list = locations.data ?? [];
    return kind ? list.filter((row) => row.kind === kind) : list;
  }, [locations.data, kind]);

  // `Directory` renders `query.data`; this screen shows a filtered slice of the same
  // request, so it hands the filtered rows over while keeping the original status.
  const view = { ...locations, data: rows };

  const title = kind === 'bank' ? 'بطاقة بنك' : kind === 'safe' ? 'بطاقة صندوق' : 'الصناديق والبنوك';
  const isBank = kind === 'bank';
  const branchRows = branches.data ?? [];
  const accountOptions = (accounts.data ?? [])
    .filter((row) => row.isPostable !== false)
    .map((row) => ({ id: row.id, label: `${row.code} — ${row.nameAr ?? row.name_ar ?? ''}`.trim() }));

  return (
    <Directory<CashLocation>
      title={title}
      subtitle="مواقع النقدية المرتبطة بحسابات دليل الحسابات — منها تُصرف وتُقبض السندات."
      crumbs={['المحاسبة', 'تعاريف']}
      query={view}
      canCreate={manage}
      createLabel={isBank ? 'حساب بنكي جديد' : 'صندوق جديد'}
      blocked={branchRows.length === 0 ? 'أنشئ فرعاً أولاً من «الإعدادات ← بطاقة فرع».' : undefined}
      fields={[
        { name: 'name', label: 'الاسم', required: true },
        { name: 'branchId', label: 'الفرع', type: 'select', required: true, options: branchOptions(branchRows) },
        {
          name: 'kind',
          label: 'النوع',
          type: 'select',
          required: true,
          options: [
            { id: 'safe', label: 'صندوق' },
            { id: 'bank', label: 'بنك' },
          ],
        },
        { name: 'accountId', label: 'الحساب في دليل الحسابات', type: 'select', wide: true, options: accountOptions },
        { name: 'currencyCode', label: 'العملة', ltr: true, placeholder: 'SAR' },
        { name: 'bankName', label: 'اسم البنك' },
        { name: 'iban', label: 'الآيبان', ltr: true, hint: 'يُتحقق من خانات المراجعة ISO 13616' },
        { name: 'isDefault', label: 'افتراضي', type: 'checkbox' },
        { name: 'changeInPos', label: 'يستخدم كصندوق فكة في نقطة البيع', type: 'checkbox' },
        { name: 'isActive', label: 'نشط', type: 'checkbox' },
      ]}
      initial={{ kind: kind || 'safe', isActive: true }}
      onCreate={(values) =>
        apiPost('/cash-locations', {
          branchId: String(values.branchId),
          kind: String(values.kind) === 'bank' ? 'bank' : 'safe',
          name: String(values.name).trim(),
          accountId: String(values.accountId) || undefined,
          currencyCode: String(values.currencyCode).trim().toUpperCase() || undefined,
          bank: String(values.bankName).trim() ? { bankName: String(values.bankName).trim(), iban: String(values.iban).trim() || undefined } : undefined,
          isDefault: Boolean(values.isDefault),
          changeInPos: Boolean(values.changeInPos),
          isActive: Boolean(values.isActive),
        })
      }
      edit={
        manage
          ? {
              toForm: (row) => ({
                name: row.name,
                branchId: row.branchId,
                kind: row.kind,
                accountId: row.accountId ?? '',
                currencyCode: row.currencyCode ?? '',
                bankName: row.bank?.bankName ?? '',
                iban: row.bank?.iban ?? '',
                isDefault: Boolean(row.isDefault),
                changeInPos: Boolean(row.changeInPos),
                isActive: row.isActive !== false,
              }),
              // `kind` is fixed after creation: a safe and a bank account post differently
              // and the API refuses the switch, so the form simply never sends it back.
              onUpdate: (row, values) =>
                apiPatch(`/cash-locations/${row.id}`, {
                  branchId: String(values.branchId),
                  name: String(values.name).trim(),
                  accountId: String(values.accountId) || null,
                  currencyCode: String(values.currencyCode).trim().toUpperCase() || null,
                  bank: String(values.bankName).trim() ? { bankName: String(values.bankName).trim(), iban: String(values.iban).trim() || undefined } : null,
                  isDefault: Boolean(values.isDefault),
                  changeInPos: Boolean(values.changeInPos),
                  isActive: Boolean(values.isActive),
                }),
            }
          : undefined
      }
      onDelete={manage ? (row) => apiDelete(`/cash-locations/${row.id}`) : undefined}
      rowLabel={(row) => (row.kind === 'bank' ? `الحساب البنكي ${row.name}` : `الصندوق ${row.name}`)}
      successText={(values) => `تمت إضافة ${String(values.name)}.`}
      rowKey={(row) => row.id}
      empty="لا توجد سجلات"
      emptyDetail="تُنشأ خزنة رئيسية تلقائياً عند تجهيز المنشأة."
      columns={[
        { key: 'name', header: 'الاسم', cell: (row) => row.name },
        { key: 'kind', header: 'النوع', cell: (row) => (row.kind === 'bank' ? 'بنك' : 'صندوق') },
        {
          key: 'branch',
          header: 'الفرع',
          cell: (row) => {
            const branch = branchRows.find((entry) => entry.id === row.branchId);
            return branch ? arabicName(branch) : '—';
          },
        },
        { key: 'bank', header: 'البنك / الآيبان', align: 'ltr', cell: (row) => row.bank?.iban ?? row.bank?.bankName ?? '—' },
        { key: 'currency', header: 'العملة', align: 'ltr', cell: (row) => row.currencyCode ?? '—' },
        {
          key: 'status',
          header: 'الحالة',
          cell: (row) => <span className={`badge ${row.isActive === false ? 'planned' : 'active'}`}>{row.isActive === false ? 'موقوف' : 'نشط'}</span>,
        },
      ]}
    />
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <Inner />
    </Suspense>
  );
}
