'use client';

import Link from 'next/link';
import { Decimal } from 'decimal.js';
import { useSession } from '@erp/web-core/session';

import { Screen } from '../components/screen';
import { useOfflineRead } from '../components/offline-data';
import { useLang } from '../lib/i18n';
import { listOpenCreditDocuments, listOpenLoadOrders, listStock, readMetaBundle } from '../lib/offline/rep-db';
import { formatMoney, formatQty, projectedStock } from '../lib/offline/ops';
import { readQueueBoard } from '../lib/offline/rep-sync';
import type { RepOpenCreditDocument, RepQueueRecord, RepStockRow } from '../lib/offline/types';

/**
 * M5 — the rep's home: everything the phone knows about today, honestly labelled as
 * device state. The numbers come from the offline stores (they exist offline); the
 * quick actions jump straight into the day's work.
 */
export default function RepHomePage() {
  const { can } = useSession();
  const { t } = useLang();
  const board = useOfflineRead(readQueueBoard);
  const stock = useOfflineRead(listStock);
  const orders = useOfflineRead(listOpenLoadOrders);
  const documents = useOfflineRead(listOpenCreditDocuments);
  const meta = useOfflineRead(readMetaBundle);

  const records: RepQueueRecord[] = board.data?.records ?? [];
  const hasSnapshot = Boolean(meta.data?.watermark);
  const stockRows: RepStockRow[] = stock.data ?? [];
  const docRows: RepOpenCreditDocument[] = documents.data ?? [];

  const vanKg = stockRows.reduce(
    (sum, row) => sum.plus(projectedStock(row, records, docRows)),
    new Decimal(0),
  );
  const expectedCash = (orders.data ?? []).reduce(
    (sum, order) => sum.plus(new Decimal(order.expectedCash || '0')).minus(new Decimal(order.collectedCash || '0')),
    new Decimal(0),
  );

  return (
    <Screen title={t('home.title')} subtitle={t('app.tagline')}>
      {!hasSnapshot ? (
        <div className="card">
          <strong>{t('home.noSnapshot')}</strong>
          <p className="muted small" style={{ margin: '6px 0 10px' }}>
            {t('sync.snapshotAt')}: {meta.data?.snapshotAt ? new Date(meta.data.snapshotAt).toLocaleString() : '—'}
          </p>
          {can('van_sales.view') ? (
            <Link href="/sync" className="btn primary">
              {t('nav.sync')}
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className="stats">
        <div className="stat">
          <strong>{board.data?.pending ?? 0}</strong>
          <span>{t('home.pendingDocs')}</span>
        </div>
        <div className="stat">
          <strong>{board.data?.conflict ?? 0}</strong>
          <span>{t('home.conflicts')}</span>
        </div>
        <div className="stat">
          <strong>{formatQty(vanKg)}</strong>
          <span>{t('home.vanKg')}</span>
        </div>
        <div className="stat">
          <strong>{formatMoney(expectedCash)}</strong>
          <span>{t('receipt.outstanding')}</span>
        </div>
      </div>

      <div className="card">
        <strong>{t('home.quick')}</strong>
        <div className="row" style={{ marginTop: '10px' }}>
          {can('van_sales.invoice.create') ? (
            <Link href="/invoice" className="btn primary">
              {t('nav.invoice')}
            </Link>
          ) : null}
          {can('van_sales.collection.create') ? (
            <Link href="/receipt" className="btn">
              {t('nav.receipt')}
            </Link>
          ) : null}
          {can('van_sales.invoice.create') ? (
            <Link href="/return" className="btn">
              {t('nav.return')}
            </Link>
          ) : null}
          {can('van_sales.closing.submit') ? (
            <Link href="/closing" className="btn">
              {t('nav.closing')}
            </Link>
          ) : null}
          <Link href="/sync" className="btn ghost">
            {t('nav.sync')}
          </Link>
        </div>
      </div>

      <div className="card">
        <strong>{t('home.offlineHint')}</strong>
        {records.length === 0 ? (
          <p className="muted small" style={{ margin: '6px 0 0' }}>
            {t('queue.empty')}
          </p>
        ) : (
          <ul className="small" style={{ margin: '10px 0 0', paddingInlineStart: '18px' }}>
            {records.slice(0, 5).map((record) => (
              <li key={record.offlineId}>
                {t(`op.${record.operation}`)} — {new Date(record.createdAt).toLocaleTimeString()}{' '}
                <span className={`badge ${record.status}`}>{t(`queue.${record.status}`)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Screen>
  );
}
