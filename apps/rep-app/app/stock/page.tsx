'use client';

import { useState } from 'react';
import { Decimal } from 'decimal.js';
import { useSession } from '@erp/web-core/session';

import { Empty, Forbidden, Loading, Screen } from '../../components/screen';
import { useOfflineRead } from '../../components/offline-data';
import { useLang } from '../../lib/i18n';
import { listItems, listOpenCreditDocuments, listOpenLoadOrders, listQueueRecords, listStock, readMetaBundle } from '../../lib/offline/rep-db';
import { enqueueReceipt, formatQty, projectedRemaining, projectedStock, remainingOfLoadOrder } from '../../lib/offline/ops';
import type { RepOpenCreditDocument, RepOpenLoadOrder, RepQueueRecord, RepStockRow } from '../../lib/offline/types';

/**
 * M5 — van stock: the snapshot balance PLUS this phone's pending ops (an unsynced sale
 * must already reduce what the rep believes he has — that is the honest offline number),
 * and the open load orders with their projected remaining + the offline receipt
 * confirmation (an unreceived order cannot be sold from, so confirming receipt is the
 * first action of the route).
 */
export default function StockPage() {
  const { can } = useSession();
  const { t, lang } = useLang();
  const [flash, setFlash] = useState<string | undefined>(undefined);

  const stock = useOfflineRead(listStock);
  const items = useOfflineRead(listItems);
  const orders = useOfflineRead(listOpenLoadOrders);
  const documents = useOfflineRead(listOpenCreditDocuments);
  const queue = useOfflineRead(listQueueRecords);
  const meta = useOfflineRead(readMetaBundle);

  if (!can('van_sales.view')) return <Forbidden />;

  const records: RepQueueRecord[] = queue.data ?? [];
  const docRows: RepOpenCreditDocument[] = documents.data ?? [];
  const stockRows: RepStockRow[] = stock.data ?? [];
  const itemNames = new Map((items.data ?? []).map((item) => [item.id, lang === 'ar' ? item.nameAr : item.nameEn ?? item.nameAr]));
  const orderRows: RepOpenLoadOrder[] = orders.data ?? [];

  async function confirmReceipt(order: RepOpenLoadOrder): Promise<void> {
    await enqueueReceipt({ loadOrderId: order.id, receivedQty: order.loadedQty });
    setFlash(t('stock.receiptQueued'));
    queue.reload();
  }

  return (
    <Screen
      title={t('stock.title')}
      subtitle={`${t('sync.snapshotAt')}: ${meta.data?.snapshotAt ? new Date(meta.data.snapshotAt).toLocaleString() : '—'}`}
    >
      {flash ? <div className="card tight" role="status">{flash}</div> : null}

      <div className="card">
        <strong>{t('stock.projected')}</strong>
        {stock.loading ? (
          <Loading rows={2} />
        ) : stockRows.length === 0 ? (
          <p className="muted small" style={{ margin: '8px 0 0' }}>
            {t('invoice.needSnapshot')}
          </p>
        ) : (
          <div className="table-wrap" style={{ marginTop: '10px' }}>
            <table>
              <thead>
                <tr>
                  <th>{t('invoice.item')}</th>
                  <th className="num">{t('stock.snapshot')}</th>
                  <th className="num">{t('stock.projected')}</th>
                </tr>
              </thead>
              <tbody>
                {stockRows.map((row) => (
                  <tr key={row.itemId}>
                    <td>{itemNames.get(row.itemId) ?? row.itemId}</td>
                    <td className="num">{formatQty(row.quantity)}</td>
                    <td className="num">{formatQty(projectedStock(row, records, docRows))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <strong>{t('stock.orders')}</strong>
        {orders.loading ? (
          <Loading rows={2} />
        ) : orderRows.length === 0 ? (
          <Empty hint={t('queue.empty')} />
        ) : (
          <div className="grid" style={{ marginTop: '10px' }}>
            {orderRows.map((order) => {
              const notReceived = new Decimal(order.receivedQty || '0').isZero();
              const itemLabel = order.itemId ? itemNames.get(order.itemId) ?? order.itemId : '—';
              return (
                <div key={order.id} className="card tight" style={{ boxShadow: 'none' }}>
                  <strong>
                    {order.number} · {itemLabel}
                  </strong>
                  <span className="muted small" style={{ display: 'block' }}>
                    {order.productionBatchNo} · {new Date(order.loadDate).toLocaleDateString()}
                  </span>
                  <div className="row" style={{ marginTop: '8px', alignItems: 'center' }}>
                    <span className={`badge ${notReceived ? 'pending' : 'approved'}`}>
                      {notReceived ? t('stock.notReceived') : t('stock.remaining')}
                    </span>
                    <span className="small">
                      {notReceived
                        ? `${formatQty(order.loadedQty)} → ${formatQty(remainingOfLoadOrder(order))}`
                        : formatQty(projectedRemaining(order, records, docRows))}
                    </span>
                    {notReceived && can('van_sales.invoice.create') ? (
                      <button type="button" className="btn sm primary" onClick={() => void confirmReceipt(order)}>
                        {t('stock.confirmReceipt')}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Screen>
  );
}
