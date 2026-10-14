'use client';

import Link from 'next/link';

import { DataTable, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { dateTime } from '../../../lib/lookups';
import { SYNC_ENTITY_LABELS, fetchSyncOverview, type SyncOverview } from '../../../lib/sync';
import { useQuery } from '../../../lib/use-query';

/**
 * Sync home.
 *
 * The desktop/Android clients pull master data and push documents through the compat
 * gateway; this screen answers the two questions an operator actually has — is anything
 * arriving, and is every device still alive.
 */
export default function SyncOverviewPage() {
  const overview = useQuery<SyncOverview>(() => fetchSyncOverview(), []);

  return (
    <Screen
      title="مزامنة البيانات"
      subtitle="حالة المزامنة مع الأجهزة المرتبطة: ما وصل من مستندات، وما هو متاح للسحب."
      crumbs={['الإعدادات', 'المزامنة']}
      actions={
        <>
          <Link className="btn" href="/settings/sync/manage">
            إدارة المزامنة
          </Link>
          <Link className="btn" href="/settings/devices">
            الأجهزة المرتبطة
          </Link>
        </>
      }
    >
      <QueryView query={overview} isEmpty={() => false}>
        {(data) => (
          <>
            <div className="grid cols-2">
              <section className="card">
                <h3>المستندات الواردة من الأجهزة</h3>
                <DataTable
                  columns={[
                    { key: 'entity', header: 'النوع', cell: (row: SyncOverview['inbound'][number]) => SYNC_ENTITY_LABELS[row.entity] ?? row.entity },
                    { key: 'received', header: 'العدد', align: 'num', cell: (row: SyncOverview['inbound'][number]) => String(row.received) },
                    { key: 'last', header: 'آخر وصول', cell: (row: SyncOverview['inbound'][number]) => dateTime(row.last_at) },
                    {
                      key: 'open',
                      header: '',
                      cell: (row: SyncOverview['inbound'][number]) => (
                        <Link className="btn sm" href={`/settings/sync/${row.entity}`}>
                          عرض
                        </Link>
                      ),
                    },
                  ]}
                  rows={data.inbound}
                  rowKey={(row) => row.entity}
                />
              </section>
              <section className="card">
                <h3>البيانات المتاحة للسحب</h3>
                <DataTable
                  columns={[
                    { key: 'entity', header: 'النوع', cell: (row: SyncOverview['master'][number]) => SYNC_ENTITY_LABELS[row.entity] ?? row.entity },
                    { key: 'available', header: 'العدد', align: 'num', cell: (row: SyncOverview['master'][number]) => String(row.available) },
                    { key: 'last', header: 'آخر تحديث', cell: (row: SyncOverview['master'][number]) => dateTime(row.last_at) },
                  ]}
                  rows={data.master}
                  rowKey={(row) => row.entity}
                />
              </section>
            </div>
            <section className="card">
              <h3>الأجهزة</h3>
              {data.devices.length === 0 ? (
                <p className="muted">
                  لا يوجد جهاز مرتبط. أنشئ جهازاً من شاشة <Link href="/settings/devices">الأجهزة المرتبطة</Link> واحفظ مفتاح الـ API الظاهر مرة واحدة فقط.
                </p>
              ) : (
                <DataTable
                  columns={[
                    { key: 'name', header: 'الجهاز', cell: (row: SyncOverview['devices'][number]) => row.name },
                    { key: 'branch', header: 'الفرع', cell: (row: SyncOverview['devices'][number]) => row.branchName ?? '—' },
                    { key: 'status', header: 'الحالة', cell: (row: SyncOverview['devices'][number]) => (row.status === 'active' ? 'نشط' : 'موقوف') },
                    { key: 'seen', header: 'آخر اتصال', cell: (row: SyncOverview['devices'][number]) => dateTime(row.lastSeenAt) },
                    { key: 'cursors', header: 'مؤشرات السحب', cell: (row: SyncOverview['devices'][number]) => Object.keys(row.cursors ?? {}).map((entity) => SYNC_ENTITY_LABELS[entity] ?? entity).join('، ') || '—' },
                  ]}
                  rows={data.devices}
                  rowKey={(row) => row.id}
                />
              )}
            </section>
          </>
        )}
      </QueryView>
    </Screen>
  );
}
