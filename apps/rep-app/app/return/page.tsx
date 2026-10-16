'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Decimal } from 'decimal.js';
import { useSession } from '@erp/web-core/session';

import { Empty, Forbidden, Loading, Screen } from '../../components/screen';
import { useOfflineRead } from '../../components/offline-data';
import { useLang } from '../../lib/i18n';
import { listOpenCreditDocuments, listQueueRecords } from '../../lib/offline/rep-db';
import { enqueueReturn, formatQty } from '../../lib/offline/ops';
import type { RepQueueRecord } from '../../lib/offline/types';

/**
 * M5 — the return: goods coming back from a customer against a server document or an
 * offline invoice of this device (`documentId` / `sourceOfflineId`, the M4 pair). The
 * return total is pre-tax upstream (M4 fact); the qty cap shown here is the document's
 * sold qty (the server enforces the exact rule on replay).
 */
export default function ReturnPage() {
  const { can } = useSession();
  const { t } = useLang();
  const [flash, setFlash] = useState<string | undefined>(undefined);

  const documents = useOfflineRead(listOpenCreditDocuments);
  const queue = useOfflineRead(listQueueRecords);

  const [target, setTarget] = useState('');
  const [returnedQty, setReturnedQty] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');

  const records: RepQueueRecord[] = queue.data ?? [];
  const serverDocs = documents.data ?? [];
  const offlineInvoices = records.filter((record) => record.operation === 'invoice');

  const targetRow = (() => {
    if (!target) return null;
    if (target.startsWith('doc:')) return serverDocs.find((row) => row.id === target.slice(4)) ?? null;
    if (target.startsWith('off:')) {
      const record = records.find((row) => row.offlineId === target.slice(4));
      if (!record) return null;
      return {
        soldQty: (record.payload as { soldQty?: string }).soldQty ?? '0',
        customerName: record.documentNumber ?? record.offlineId,
      };
    }
    return null;
  })();

  const qtyOk = new Decimal(returnedQty || '0').greaterThan(0) && (!targetRow || new Decimal(returnedQty || '0').lessThanOrEqualTo(new Decimal(targetRow.soldQty || '0')));
  const canSubmit = Boolean(target) && qtyOk;

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    const offlineId = target.startsWith('off:') ? target.slice(4) : undefined;
    const documentId = target.startsWith('doc:') ? target.slice(4) : undefined;
    await enqueueReturn({
      ...(documentId ? { documentId } : { sourceOfflineId: offlineId }),
      returnedQty: new Decimal(returnedQty || '0').toFixed(4),
      ...(reason ? { reason } : {}),
      ...(notes ? { notes } : {}),
    });
    setFlash(t('return.queued'));
    setReturnedQty('');
    setReason('');
    setNotes('');
    queue.reload();
  }

  if (!can('van_sales.invoice.create')) return <Forbidden />;

  return (
    <Screen title={t('return.title')} subtitle={t('home.offlineHint')}>
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
            <span>{t('return.pick')}</span>
            <select className="input" value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="">—</option>
              {serverDocs.map((document) => (
                <option key={document.id} value={`doc:${document.id}`}>
                  [{t('receipt.serverDoc')}] {document.number} · {document.customerName} · {t('return.sold')} {document.soldQty}
                </option>
              ))}
              {offlineInvoices.map((record) => (
                <option key={record.offlineId} value={`off:${record.offlineId}`}>
                  [{t('receipt.offlineDoc')}] {record.documentNumber ?? record.offlineId} · {t('return.sold')}{' '}
                  {formatQty((record.payload as { soldQty?: string }).soldQty ?? '0')}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>{t('return.qty')}</span>
            <input
              className="input"
              type="number"
              dir="ltr"
              inputMode="decimal"
              min="0"
              step="any"
              value={returnedQty}
              onChange={(event) => setReturnedQty(event.target.value)}
              aria-invalid={Boolean(returnedQty) && !qtyOk}
            />
          </label>

          <label className="field">
            <span>{t('return.reason')}</span>
            <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>

          <label className="field">
            <span>{t('return.notes')}</span>
            <input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>

          <button type="button" className="btn primary block" disabled={!canSubmit} onClick={() => void submit()}>
            {t('return.submit')}
          </button>
        </div>
      )}
    </Screen>
  );
}
