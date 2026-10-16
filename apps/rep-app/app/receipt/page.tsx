'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Decimal } from 'decimal.js';
import { useSession } from '@erp/web-core/session';

import { Empty, Forbidden, Loading, Screen } from '../../components/screen';
import { useOfflineRead } from '../../components/offline-data';
import { useLang } from '../../lib/i18n';
import { listOpenCreditDocuments, listPaymentMethods, listQueueRecords } from '../../lib/offline/rep-db';
import { enqueueCollection, formatMoney, outstandingOfOfflineInvoice } from '../../lib/offline/ops';
import type { RepQueueRecord } from '../../lib/offline/types';

/**
 * M5 — cash collection. Two target kinds, exactly as the M4 replay contract frames
 * them: a SERVER open credit document (`documentId`) or an invoice THIS device created
 * (`sourceOfflineId` — the device collects its own offline credit sale; the server ties
 * the collection to the replayed invoice even before both exist there).
 */
export default function ReceiptPage() {
  const { can } = useSession();
  const { t } = useLang();
  const [flash, setFlash] = useState<string | undefined>(undefined);

  const documents = useOfflineRead(listOpenCreditDocuments);
  const queue = useOfflineRead(listQueueRecords);
  const methods = useOfflineRead(listPaymentMethods);

  const [target, setTarget] = useState('');
  const [collectedAmount, setCollectedAmount] = useState('');
  const [notes, setNotes] = useState('');

  const records: RepQueueRecord[] = queue.data ?? [];
  const serverDocs = documents.data ?? [];
  const offlineInvoices = records.filter((record) => record.operation === 'invoice');

  /**
   * The cash location rides with the collection (the M4 contract): without it the
   * treasury engine cannot post the receipt voucher — the movement would record with a
   * null voucher. The snapshot's default cash payment method carries the location.
   */
  const cashLocationId = (methods.data ?? []).find((method) => method.isDefault && method.kind === 'cash')?.cashLocationId ?? undefined;

  const targetOutstanding = (() => {
    if (!target) return null;
    if (target.startsWith('doc:')) {
      const document = serverDocs.find((row) => row.id === target.slice(4));
      return document ? new Decimal(document.outstanding) : null;
    }
    if (target.startsWith('off:')) {
      return outstandingOfOfflineInvoice(target.slice(4), records);
    }
    return null;
  })();

  const amountOk = new Decimal(collectedAmount || '0').greaterThan(0) && (targetOutstanding === null || new Decimal(collectedAmount || '0').lessThanOrEqualTo(targetOutstanding));
  const canSubmit = Boolean(target) && amountOk;

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    const offlineId = target.startsWith('off:') ? target.slice(4) : undefined;
    const documentId = target.startsWith('doc:') ? target.slice(4) : undefined;
    await enqueueCollection({
      ...(documentId ? { documentId } : { sourceOfflineId: offlineId }),
      collectedAmount: new Decimal(collectedAmount || '0').toFixed(2),
      ...(cashLocationId ? { cashLocationId } : {}),
      ...(notes ? { notes } : {}),
    });
    setFlash(t('receipt.queued'));
    setCollectedAmount('');
    setNotes('');
    queue.reload();
  }

  if (!can('van_sales.collection.create')) return <Forbidden />;

  return (
    <Screen title={t('receipt.title')} subtitle={t('home.offlineHint')}>
      {flash ? (
        <div className="card tight" role="status">
          {flash}{' '}
          <Link href="/queue" className="btn sm">
            {t('nav.queue')} →
          </Link>
        </div>
      ) : null}

      {documents.loading ? (
        <Loading rows={3} />
      ) : serverDocs.length === 0 && offlineInvoices.length === 0 ? (
        <Empty hint={t('invoice.needSnapshot')} />
      ) : (
        <div className="card">
          <label className="field">
            <span>{t('receipt.pick')}</span>
            <select className="input" value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="">—</option>
              {serverDocs.map((document) => (
                <option key={document.id} value={`doc:${document.id}`}>
                  [{t('receipt.serverDoc')}] {document.number} · {document.customerName} · {t('receipt.outstanding')} {document.outstanding}
                </option>
              ))}
              {offlineInvoices.map((record) => (
                <option key={record.offlineId} value={`off:${record.offlineId}`}>
                  [{t('receipt.offlineDoc')}] {record.documentNumber ?? record.offlineId} · {t('receipt.outstanding')}{' '}
                  {formatMoney(outstandingOfOfflineInvoice(record.offlineId, records))} ({t('receipt.estimate')})
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>{t('receipt.amount')}</span>
            <input
              className="input"
              type="number"
              dir="ltr"
              inputMode="decimal"
              min="0"
              step="any"
              value={collectedAmount}
              onChange={(event) => setCollectedAmount(event.target.value)}
              aria-invalid={Boolean(collectedAmount) && !amountOk}
            />
          </label>

          <label className="field">
            <span>{t('receipt.notes')}</span>
            <input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>

          <button type="button" className="btn primary block" disabled={!canSubmit} onClick={() => void submit()}>
            {t('receipt.submit')}
          </button>
        </div>
      )}
    </Screen>
  );
}
