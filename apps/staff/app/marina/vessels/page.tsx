'use client';

import { useState } from 'react';

import { DataTable, Notice } from '../../../components/data-view';
import { ErrorBox, Loading, Screen } from '../../../components/screen';
import { ApiError, apiData, apiPost } from '../../../lib/api';
import { listParties, partyLabel, type Party } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Group = { id: string; code: string | null; name: string };
type Vessel = { id: string; code: string; name: string; groupId: string | null; capacity: number | null; status?: string };
type Marina = { groups: Group[]; vessels: Vessel[] };

const PERIOD_KINDS: Array<{ id: string; label: string }> = [
  { id: 'hour', label: 'ساعة' },
  { id: 'half_hour', label: 'نصف ساعة' },
  { id: 'offer', label: 'عرض خاص' },
];

export default function MarinaVesselsPage() {
  const { can } = useSession();
  const marina = useQuery<Marina>(() => apiData<Marina>('/marina'), []);
  const parties = useQuery<Party[]>(() => listParties(), []);

  const [group, setGroup] = useState({ name: '', code: '' });
  const [vessel, setVessel] = useState({ code: '', name: '', groupId: '', capacity: '' });
  const [pricing, setPricing] = useState({ groupId: '', periodKind: 'hour', priceText: '' });
  const [owner, setOwner] = useState({ vesselId: '', partyId: '', percentText: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  if (marina.status === 'loading') return <Loading />;
  if (marina.status !== 'success' || !marina.data) {
    return (
      <Screen title="بطاقة مركب" crumbs={['إدارة المراسي']}>
        <ErrorBox message={marina.error ?? 'تعذّر تحميل بيانات المراسي'} onRetry={marina.reload} />
      </Screen>
    );
  }

  const { groups, vessels } = marina.data;

  async function run(action: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: okText });
      marina.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title="بطاقة نموذج ومركب" subtitle="مجموعات المراكب وأسعارها، المراكب نفسها ونسب ملّاكها." crumbs={['إدارة المراسي', 'التعاريف']}>
      <Notice notice={notice} />

      <div className="grid cols-2">
        <div className="card">
          <h2>مجموعة (نموذج) جديدة</h2>
          <div className="form-grid">
            <label className="field">
              <span>الاسم *</span>
              <input className="input" value={group.name} onChange={(event) => setGroup({ ...group, name: event.target.value })} />
            </label>
            <label className="field">
              <span>الرمز</span>
              <input className="input" dir="ltr" value={group.code} onChange={(event) => setGroup({ ...group, code: event.target.value })} />
            </label>
          </div>
          <button
            className="btn"
            type="button"
            disabled={busy || !can('marina.manage') || !group.name.trim()}
            onClick={() =>
              run(async () => {
                await apiPost('/marina/groups', { name: group.name.trim(), code: group.code.trim() || undefined });
                setGroup({ name: '', code: '' });
              }, 'تمت إضافة المجموعة.')
            }
          >
            إضافة المجموعة
          </button>

          <h3>تسعير المجموعة</h3>
          <div className="form-grid">
            <label className="field">
              <span>المجموعة</span>
              <select className="input" value={pricing.groupId} onChange={(event) => setPricing({ ...pricing, groupId: event.target.value })}>
                <option value="">— اختر —</option>
                {groups.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>الفترة</span>
              <select className="input" value={pricing.periodKind} onChange={(event) => setPricing({ ...pricing, periodKind: event.target.value })}>
                {PERIOD_KINDS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>السعر</span>
              <input className="input" dir="ltr" inputMode="decimal" value={pricing.priceText} onChange={(event) => setPricing({ ...pricing, priceText: event.target.value })} />
            </label>
          </div>
          <button
            className="btn"
            type="button"
            disabled={busy || !can('marina.manage') || !pricing.groupId || !pricing.priceText.trim()}
            onClick={() =>
              run(async () => {
                await apiPost(`/marina/groups/${pricing.groupId}/pricing`, { periodKind: pricing.periodKind, price: pricing.priceText.trim() });
                setPricing({ ...pricing, priceText: '' });
              }, 'تم حفظ السعر.')
            }
          >
            حفظ السعر
          </button>
        </div>

        <div className="card">
          <h2>مركب جديد</h2>
          <div className="form-grid">
            <label className="field">
              <span>الرمز *</span>
              <input className="input" dir="ltr" value={vessel.code} onChange={(event) => setVessel({ ...vessel, code: event.target.value })} />
            </label>
            <label className="field">
              <span>الاسم *</span>
              <input className="input" value={vessel.name} onChange={(event) => setVessel({ ...vessel, name: event.target.value })} />
            </label>
            <label className="field">
              <span>المجموعة</span>
              <select className="input" value={vessel.groupId} onChange={(event) => setVessel({ ...vessel, groupId: event.target.value })}>
                <option value="">— بدون —</option>
                {groups.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>السعة</span>
              <input className="input" dir="ltr" inputMode="numeric" value={vessel.capacity} onChange={(event) => setVessel({ ...vessel, capacity: event.target.value })} />
            </label>
          </div>
          <button
            className="btn"
            type="button"
            disabled={busy || !can('marina.manage') || !vessel.code.trim() || !vessel.name.trim()}
            onClick={() =>
              run(async () => {
                await apiPost('/marina/vessels', {
                  code: vessel.code.trim(),
                  name: vessel.name.trim(),
                  groupId: vessel.groupId || undefined,
                  capacity: vessel.capacity ? Number(vessel.capacity) : undefined,
                });
                setVessel({ code: '', name: '', groupId: '', capacity: '' });
              }, 'تمت إضافة المركب.')
            }
          >
            إضافة المركب
          </button>

          <h3>مالك مركب</h3>
          <div className="form-grid">
            <label className="field">
              <span>المركب</span>
              <select className="input" value={owner.vesselId} onChange={(event) => setOwner({ ...owner, vesselId: event.target.value })}>
                <option value="">— اختر —</option>
                {vessels.map((row) => (
                  <option key={row.id} value={row.id}>
                    {`${row.code} — ${row.name}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>المالك</span>
              <select className="input" value={owner.partyId} onChange={(event) => setOwner({ ...owner, partyId: event.target.value })}>
                <option value="">— اختر —</option>
                {(parties.data ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {partyLabel(row)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>النسبة %</span>
              <input className="input" dir="ltr" inputMode="decimal" value={owner.percentText} onChange={(event) => setOwner({ ...owner, percentText: event.target.value })} />
            </label>
          </div>
          <button
            className="btn"
            type="button"
            disabled={busy || !can('marina.manage') || !owner.vesselId || !owner.partyId}
            onClick={() =>
              run(async () => {
                await apiPost(`/marina/vessels/${owner.vesselId}/owners`, { partyId: owner.partyId, percent: owner.percentText.trim() || '100' });
                setOwner({ vesselId: '', partyId: '', percentText: '' });
              }, 'تم ربط المالك بالمركب.')
            }
          >
            ربط المالك
          </button>
        </div>
      </div>

      <div className="card">
        <h2>المراكب</h2>
        <DataTable
          rows={vessels}
          rowKey={(row) => row.id}
          columns={[
            { key: 'code', header: 'الرمز', align: 'ltr', cell: (row) => row.code },
            { key: 'name', header: 'الاسم', cell: (row) => row.name },
            { key: 'group', header: 'المجموعة', cell: (row) => groups.find((entry) => entry.id === row.groupId)?.name ?? '—' },
            { key: 'capacity', header: 'السعة', align: 'num', cell: (row) => row.capacity ?? '—' },
          ]}
        />
      </div>

      <div className="card">
        <h2>المجموعات</h2>
        <DataTable
          rows={groups}
          rowKey={(row) => row.id}
          columns={[
            { key: 'code', header: 'الرمز', align: 'ltr', cell: (row) => row.code ?? '—' },
            { key: 'name', header: 'الاسم', cell: (row) => row.name },
            { key: 'count', header: 'عدد المراكب', align: 'num', cell: (row) => vessels.filter((entry) => entry.groupId === row.id).length },
          ]}
        />
      </div>
    </Screen>
  );
}
