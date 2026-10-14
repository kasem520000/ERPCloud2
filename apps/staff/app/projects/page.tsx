'use client';

import Link from 'next/link';

import { Directory } from '../../components/directory';
import { apiList, apiPost } from '../../lib/api';
import {
  branchOptions,
  listBranches,
  listCostCenters,
  listParties,
  money,
  partyLabel,
  percent,
  shortDate,
  statusLabel,
  today,
  type Branch,
  type CostCenter,
  type Party,
} from '../../lib/lookups';
import { useSession } from '../../lib/session';
import { useQuery } from '../../lib/use-query';

type Project = {
  id: string;
  code: string;
  name: string;
  partyId: string;
  contractorPartyId: string | null;
  status: string;
  startsOn: string | null;
  endsOn: string | null;
  contractValue: string;
  retentionPct: string;
};

export default function ProjectsPage() {
  const { can } = useSession();
  const projects = useQuery<Project[]>(() => apiList<Project>('/projects'), []);
  const parties = useQuery<Party[]>(() => listParties(), []);
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const costCenters = useQuery<CostCenter[]>(() => listCostCenters(), []);

  const partyRows = parties.data ?? [];
  const nameOfParty = (id: string | null) => {
    const party = partyRows.find((row) => row.id === id);
    return party ? partyLabel(party) : '—';
  };

  return (
    <Directory<Project>
      title="المشاريع"
      subtitle="عقود العملاء والمقاولين مع قيمة العقد ونسبة المحتجز، ومنها تُصدر مستخلصات التنفيذ."
      crumbs={['إدارة المشاريع']}
      query={projects}
      canCreate={can('projects.manage')}
      createLabel="مشروع جديد"
      blocked={partyRows.length === 0 ? 'أضف عميلاً واحداً على الأقل من «بطاقة عميل».' : undefined}
      fields={[
        { name: 'code', label: 'رمز المشروع', required: true, ltr: true },
        { name: 'name', label: 'اسم المشروع', required: true },
        { name: 'partyId', label: 'العميل', type: 'select', required: true, options: partyRows.map((row) => ({ id: row.id, label: partyLabel(row) })) },
        { name: 'contractorPartyId', label: 'المقاول', type: 'select', options: partyRows.map((row) => ({ id: row.id, label: partyLabel(row) })) },
        { name: 'branchId', label: 'الفرع', type: 'select', options: branchOptions(branches.data ?? []) },
        { name: 'startsOn', label: 'تاريخ البدء', type: 'date' },
        { name: 'endsOn', label: 'تاريخ الانتهاء', type: 'date' },
        { name: 'contractValue', label: 'قيمة العقد', type: 'number' },
        { name: 'retentionPct', label: 'نسبة المحتجز %', type: 'number', hint: 'مثال: 5 تعني 5%' },
        {
          name: 'costCenterId',
          label: 'مركز التكلفة',
          type: 'select',
          options: (costCenters.data ?? []).map((row) => ({ id: row.id, label: `${row.code} — ${row.nameAr ?? row.name_ar ?? ''}` })),
        },
      ]}
      initial={{ startsOn: today() }}
      onCreate={(values) =>
        apiPost('/projects', {
          code: String(values.code).trim(),
          name: String(values.name).trim(),
          partyId: String(values.partyId),
          contractorPartyId: String(values.contractorPartyId) || undefined,
          branchId: String(values.branchId) || undefined,
          startsOn: String(values.startsOn) || undefined,
          endsOn: String(values.endsOn) || undefined,
          contractValue: String(values.contractValue).trim() || undefined,
          retentionPct: String(values.retentionPct).trim() || undefined,
          costCenterId: String(values.costCenterId) || undefined,
        })
      }
      successText={(values) => `تم إنشاء المشروع ${String(values.name)}.`}
      rowKey={(row) => row.id}
      empty="لا توجد مشاريع"
      columns={[
        { key: 'code', header: 'الرمز', align: 'ltr', cell: (row) => <Link href={`/projects/${row.id}`}>{row.code}</Link> },
        { key: 'name', header: 'المشروع', cell: (row) => row.name },
        { key: 'client', header: 'العميل', cell: (row) => nameOfParty(row.partyId) },
        { key: 'contractor', header: 'المقاول', cell: (row) => nameOfParty(row.contractorPartyId) },
        { key: 'from', header: 'البدء', align: 'ltr', cell: (row) => shortDate(row.startsOn) },
        { key: 'to', header: 'الانتهاء', align: 'ltr', cell: (row) => shortDate(row.endsOn) },
        { key: 'value', header: 'قيمة العقد', align: 'num', cell: (row) => money(row.contractValue) },
        { key: 'retention', header: 'المحتجز', align: 'num', cell: (row) => percent(Number(row.retentionPct) / 100) },
        { key: 'status', header: 'الحالة', cell: (row) => <span className="badge">{statusLabel(row.status)}</span> },
      ]}
    />
  );
}
