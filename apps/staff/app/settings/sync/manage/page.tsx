'use client';

import Link from 'next/link';

import { DataTable, QueryView } from '../../../../components/data-view';
import { Screen } from '../../../../components/screen';
import { dateTime } from '../../../../lib/lookups';
import { SYNC_DOCUMENT_ENTITIES, SYNC_ENTITY_LABELS, fetchSyncOverview, type SyncOverview } from '../../../../lib/sync';
import { useQuery } from '../../../../lib/use-query';

/**
 * Sync control room: per-device pull cursors next to per-entity inbound counters.
 *
 * A cursor that stops moving is the earliest signal that a branch went offline, so the
 * two tables belong on the same screen.
 */
export default function SyncManagePage() {
  const overview = useQuery<SyncOverview>(() => fetchSyncOverview(), []);

  return (
    <Screen
      title="إدارة المزامنة"
      subtitle="مؤشرات السحب لكل جهاز ولكل نوع بيانات، مع عدّاد المستندات الواردة."
      crumbs={['الإعدادات', 'المزامنة']}
      actions={
        <button type="button" className="btn" onClick={() => overview.reload()}>
          تحديث
        </button>
      }
    >
      <QueryView query={overview} isEmpty={() => false}>
        {(data) => (
          <>
            <section className="card">
              <h3>حالة الاستقبال</h3>
              <div className="row">
                {data.inbound.map((row) => (
                  <Link key={row.entity} className="chip" href={`/settings/sync/${row.entity}`}>
                    {SYNC_ENTITY_LABELS[row.entity] ?? row.entity}: {row.received}
                  </Link>
                ))}
              </div>
            </section>

            <section className="card">
              <h3>مؤشرات السحب لكل جهاز</h3>
              {data.devices.length === 0 ? (
                <p className="muted">
                  لا يوجد جهاز مرتبط بعد — أنشئ واحداً من <Link href="/settings/devices">الأجهزة المرتبطة</Link>.
                </p>
              ) : (
                <DataTable
                  columns={[
                    { key: 'name', header: 'الجهاز', cell: (row: SyncOverview['devices'][number]) => row.name },
                    { key: 'branch', header: 'الفرع', cell: (row: SyncOverview['devices'][number]) => row.branchName ?? '—' },
                    { key: 'seen', header: 'آخر اتصال', cell: (row: SyncOverview['devices'][number]) => dateTime(row.lastSeenAt) },
                    ...['items', 'parties', 'accounts', 'tax-groups'].map((entity) => ({
                      key: entity,
                      header: SYNC_ENTITY_LABELS[entity] ?? entity,
                      cell: (row: SyncOverview['devices'][number]) => dateTime(row.cursors?.[entity]?.updatedAt ?? null),
                    })),
                  ]}
                  rows={data.devices}
                  rowKey={(row) => row.id}
                />
              )}
            </section>

            <section className="card">
              <h3>سجلات المستندات</h3>
              <div className="row">
                {SYNC_DOCUMENT_ENTITIES.map((entity) => (
                  <Link key={entity} className="btn sm" href={`/settings/sync/${entity}`}>
                    مزامنة {SYNC_ENTITY_LABELS[entity] ?? entity}
                  </Link>
                ))}
              </div>
            </section>
          </>
        )}
      </QueryView>
    </Screen>
  );
}
