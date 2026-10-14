'use client';

import { use } from 'react';

import { DataTable, QueryView } from '../../../../components/data-view';
import { Screen } from '../../../../components/screen';
import { dateTime, money, quantity, shortDate, statusLabel } from '../../../../lib/lookups';
import { SYNC_DOCUMENT_ENTITIES, SYNC_ENTITY_LABELS, fetchSyncDocuments, type SyncDocument } from '../../../../lib/sync';
import { useQuery } from '../../../../lib/use-query';

/**
 * Documents received from the connected clients, per entity.
 *
 * Every pushed document keeps its legacy identifier, which is what makes the sync
 * idempotent — and what an operator needs when reconciling against the desktop app.
 */
export default function SyncDocumentsPage({ params }: { params: Promise<{ entity: string }> }) {
  const entity = use(params).entity;
  const known = SYNC_DOCUMENT_ENTITIES.includes(entity);
  const documents = useQuery<SyncDocument[]>(async () => (known ? fetchSyncDocuments(entity) : []), [entity, known]);

  return (
    <Screen
      title={`مزامنة ${SYNC_ENTITY_LABELS[entity] ?? entity}`}
      subtitle="المستندات التي وصلت من الأجهزة المرتبطة، بمعرّفها القديم ومقابلها في السحابة."
      crumbs={['الإعدادات', 'المزامنة']}
    >
      {known ? null : <p className="alert warn">نوع غير معروف. الأنواع المتاحة: الفواتير، السندات، القيود، المخزون.</p>}
      <QueryView query={documents} empty="لم يصل أي مستند بعد" emptyDetail="سيظهر هنا كل مستند يدفعه جهاز مرتبط عبر بوابة التوافق.">
        {(rows) => (
          <div className="card">
            <DataTable
              columns={columnsFor(entity)}
              rows={rows}
              rowKey={(row) => row.id}
            />
          </div>
        )}
      </QueryView>
    </Screen>
  );
}

function columnsFor(entity: string) {
  if (entity === 'stock') {
    return [
      { key: 'occurred', header: 'الوقت', cell: (row: SyncDocument) => dateTime(row.occurredAt) },
      { key: 'item', header: 'الصنف', cell: (row: SyncDocument) => row.itemName ?? '—' },
      { key: 'warehouse', header: 'المستودع', cell: (row: SyncDocument) => row.warehouseName ?? '—' },
      { key: 'direction', header: 'الاتجاه', cell: (row: SyncDocument) => (row.direction === 'in' ? 'وارد' : 'صادر') },
      { key: 'qty', header: 'الكمية', align: 'num' as const, cell: (row: SyncDocument) => quantity(row.qty) },
      { key: 'cost', header: 'القيمة', align: 'num' as const, cell: (row: SyncDocument) => money(row.totalCost) },
      { key: 'legacy', header: 'المعرّف القديم', align: 'ltr' as const, cell: (row: SyncDocument) => row.legacyId ?? '—' },
    ];
  }
  if (entity === 'vouchers') {
    return [
      { key: 'number', header: 'رقم السند', align: 'ltr' as const, cell: (row: SyncDocument) => row.number ?? '—' },
      { key: 'date', header: 'التاريخ', cell: (row: SyncDocument) => shortDate(row.date) },
      { key: 'kind', header: 'النوع', cell: (row: SyncDocument) => (row.kind === 'receipt' ? 'قبض' : 'صرف') },
      { key: 'amount', header: 'المبلغ', align: 'num' as const, cell: (row: SyncDocument) => money(row.amount) },
      { key: 'status', header: 'الحالة', cell: (row: SyncDocument) => statusLabel(row.status) },
      { key: 'legacy', header: 'المعرّف القديم', align: 'ltr' as const, cell: (row: SyncDocument) => row.legacyId ?? '—' },
    ];
  }
  if (entity === 'journals') {
    return [
      { key: 'number', header: 'رقم القيد', align: 'ltr' as const, cell: (row: SyncDocument) => row.number ?? '—' },
      { key: 'date', header: 'التاريخ', cell: (row: SyncDocument) => shortDate(row.date) },
      { key: 'kind', header: 'النوع', cell: (row: SyncDocument) => row.kind ?? '—' },
      { key: 'status', header: 'الحالة', cell: (row: SyncDocument) => statusLabel(row.status) },
      { key: 'legacy', header: 'المعرّف القديم', align: 'ltr' as const, cell: (row: SyncDocument) => row.legacyId ?? '—' },
    ];
  }
  return [
    { key: 'number', header: 'رقم الفاتورة', align: 'ltr' as const, cell: (row: SyncDocument) => row.number ?? '—' },
    { key: 'kind', header: 'النوع', cell: (row: SyncDocument) => (row.kind === 'sale_return' ? 'مردود مبيعات' : 'فاتورة مبيعات') },
    { key: 'total', header: 'الإجمالي', align: 'num' as const, cell: (row: SyncDocument) => money(row.total) },
    { key: 'status', header: 'الحالة', cell: (row: SyncDocument) => statusLabel(row.status) },
    { key: 'payment', header: 'السداد', cell: (row: SyncDocument) => statusLabel(row.paymentStatus) },
    { key: 'updated', header: 'آخر تحديث', cell: (row: SyncDocument) => dateTime(row.updatedAt) },
    { key: 'legacy', header: 'المعرّف القديم', align: 'ltr' as const, cell: (row: SyncDocument) => row.legacyId ?? '—' },
  ];
}
