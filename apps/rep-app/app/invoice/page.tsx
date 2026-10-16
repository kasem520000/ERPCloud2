'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Decimal } from 'decimal.js';
import { useSession } from '@erp/web-core/session';

import { Forbidden, Loading, Screen } from '../../components/screen';
import { useOfflineRead } from '../../components/offline-data';
import { useLang } from '../../lib/i18n';
import {
  findCustomerPrices,
  listCustomers,
  listOpenCreditDocuments,
  listOpenLoadOrders,
  listPaymentMethods,
  listQueueRecords,
  readMetaBundle,
} from '../../lib/offline/rep-db';
import { enqueueInvoice, estimateInvoiceTotal, formatMoney, formatQty, projectedRemaining } from '../../lib/offline/ops';
import type { RepCustomerPrice, RepOpenCreditDocument, RepQueueRecord } from '../../lib/offline/types';

/**
 * M5 — the van sale: pick the load order, the customer (or walk-in cash), the quantity
 * and (within the customer's caps) the bonus; the price is LOCKED when the customer's
 * price row says `lockPrice` (and prefilled from it either way). Everything is enqueued
 * locally with the EXACT M4 replay payload — the server re-validates every rule (caps,
 * remaining, credit) on sync; this screen pre-checks what it can offline and labels the
 * rest honestly.
 */
export default function InvoicePage() {
  const { can } = useSession();
  const { t, lang } = useLang();
  const [flash, setFlash] = useState<string | undefined>(undefined);

  const [loadOrderId, setLoadOrderId] = useState('');
  const [partyId, setPartyId] = useState('');
  const [soldQty, setSoldQty] = useState('');
  const [bonusQty, setBonusQty] = useState('');
  const [bonusReason, setBonusReason] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'credit'>('cash');
  const [invoiceMode, setInvoiceMode] = useState<'zatca_tax' | 'internal_delivery'>('zatca_tax');
  const [notes, setNotes] = useState('');

  const orders = useOfflineRead(listOpenLoadOrders);
  const customers = useOfflineRead(listCustomers);
  const queue = useOfflineRead(listQueueRecords);
  const documents = useOfflineRead(listOpenCreditDocuments);
  const meta = useOfflineRead(readMetaBundle);
  const methods = useOfflineRead(listPaymentMethods);
  const prices = useOfflineRead(() => (partyId ? findCustomerPrices(partyId) : Promise.resolve([])), partyId);

  /** Cash sales carry the cash location (their receipt voucher posts there) — the
   * snapshot's default cash payment method carries it. */
  const cashLocationId = (methods.data ?? []).find((method) => method.isDefault && method.kind === 'cash')?.cashLocationId ?? undefined;

  const records: RepQueueRecord[] = queue.data ?? [];
  const docRows: RepOpenCreditDocument[] = documents.data ?? [];
  const hasSnapshot = Boolean(meta.data?.watermark);

  const orderRows = orders.data ?? [];
  const selectedOrder = orderRows.find((order) => order.id === loadOrderId);
  const customerRows = customers.data ?? [];

  /** The customer's price row for this order's item (a null-itemId row matches any). */
  const priceRow = useMemo<RepCustomerPrice | null>(() => {
    if (!partyId) return null;
    const rows = prices.data ?? [];
    const itemId = selectedOrder?.itemId ?? null;
    return (
      rows.find((row) => row.itemId === itemId) ??
      rows.find((row) => row.itemId === null) ??
      null
    );
  }, [partyId, prices.data, selectedOrder]);

  // Prefill/lock the price whenever the resolved price row changes.
  useEffect(() => {
    if (priceRow) setUnitPrice(priceRow.unitPrice);
  }, [priceRow]);

  const remaining = selectedOrder ? projectedRemaining(selectedOrder, records, docRows) : null;
  const totalEstimate = estimateInvoiceTotal({
    soldQty: soldQty || '0',
    unitPrice: unitPrice || '0',
    bonusQty: bonusQty || '0',
    invoiceMode,
    loadOrderId,
  });
  const qtyAsked = new Decimal(soldQty || '0').plus(new Decimal(bonusQty || '0'));
  const qtyOk = remaining !== null && qtyAsked.greaterThan(0) && qtyAsked.lessThanOrEqualTo(remaining);
  const priceOk = new Decimal(unitPrice || '0').greaterThanOrEqualTo(0);
  const canSubmit = Boolean(loadOrderId) && qtyOk && priceOk;

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    await enqueueInvoice({
      loadOrderId,
      ...(partyId ? { partyId } : { customerName: lang === 'ar' ? 'عميل نقدي' : 'Walk-in' }),
      ...(selectedOrder?.itemId ? { itemId: selectedOrder.itemId } : {}),
      invoiceMode,
      paymentMethod,
      ...(paymentMethod === 'cash' && cashLocationId ? { cashLocationId } : {}),
      soldQty: new Decimal(soldQty || '0').toFixed(4),
      ...(bonusQty ? { bonusQty: new Decimal(bonusQty || '0').toFixed(4) } : {}),
      ...(bonusQty && bonusReason ? { bonusReason } : {}),
      unitPrice: new Decimal(unitPrice || '0').toFixed(4),
      ...(notes ? { notes } : {}),
    });
    setFlash(t('invoice.queued'));
    setSoldQty('');
    setBonusQty('');
    setBonusReason('');
    setNotes('');
    queue.reload();
  }

  if (!can('van_sales.invoice.create')) return <Forbidden />;

  return (
    <Screen title={t('invoice.title')} subtitle={t('app.tagline')}>
      {flash ? (
        <div className="card tight" role="status">
          {flash}{' '}
          <Link href="/queue" className="btn sm">
            {t('nav.queue')} →
          </Link>
        </div>
      ) : null}

      {!hasSnapshot ? (
        <div className="card">
          <strong>{t('invoice.needSnapshot')}</strong>
          <Link href="/sync" className="btn" style={{ marginTop: '8px' }}>
            {t('nav.sync')}
          </Link>
        </div>
      ) : orders.loading ? (
        <Loading rows={4} />
      ) : (
        <div className="card">
          <label className="field">
            <span>{t('invoice.order')}</span>
            <select className="input" value={loadOrderId} onChange={(event) => setLoadOrderId(event.target.value)}>
              <option value="">—</option>
              {orderRows.map((order) => (
                <option key={order.id} value={order.id}>
                  {order.number} · {formatQty(projectedRemaining(order, records, docRows))} {t('stock.remaining')}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>{t('invoice.customer')}</span>
            <select className="input" value={partyId} onChange={(event) => setPartyId(event.target.value)}>
              <option value="">{t('invoice.cash')}</option>
              {customerRows.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </label>

          <div className="grid cols-2">
            <label className="field">
              <span>{t('invoice.qty')}</span>
              <input
                className="input"
                type="number"
                dir="ltr"
                inputMode="decimal"
                min="0"
                step="any"
                value={soldQty}
                onChange={(event) => setSoldQty(event.target.value)}
                aria-invalid={Boolean(soldQty) && !qtyOk}
              />
            </label>
            <label className="field">
              <span>{t('invoice.bonusQty')}</span>
              <input
                className="input"
                type="number"
                dir="ltr"
                inputMode="decimal"
                min="0"
                step="any"
                value={bonusQty}
                onChange={(event) => setBonusQty(event.target.value)}
                aria-invalid={Boolean(bonusQty) && priceRow ? new Decimal(bonusQty).greaterThan(new Decimal(priceRow.maxBonusKgPerInvoice)) : false}
              />
            </label>
          </div>

          {priceRow ? (
            <p className="small muted" style={{ margin: '0 0 10px' }}>
              {t('customers.bonusCap')}: <strong>{priceRow.maxBonusKgPerInvoice}</strong>
              {priceRow.lockPrice ? ` · ${t('invoice.lockedPrice')}` : ''}
            </p>
          ) : null}

          <label className="field">
            <span>{t('invoice.bonusReason')}</span>
            <input className="input" value={bonusReason} onChange={(event) => setBonusReason(event.target.value)} />
          </label>

          <label className="field">
            <span>{t('invoice.price')}</span>
            <input
              className="input"
              type="number"
              dir="ltr"
              inputMode="decimal"
              min="0"
              step="any"
              value={unitPrice}
              readOnly={Boolean(priceRow?.lockPrice)}
              onChange={(event) => setUnitPrice(event.target.value)}
              aria-invalid={Boolean(unitPrice) && !priceOk}
            />
          </label>

          <div className="grid cols-2">
            <label className="field">
              <span>{t('invoice.payment')}</span>
              <select className="input" value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as 'cash' | 'card' | 'credit')}>
                <option value="cash">cash</option>
                <option value="card">card</option>
                <option value="credit">credit</option>
              </select>
            </label>
            <label className="field">
              <span>{t('invoice.mode')}</span>
              <select className="input" value={invoiceMode} onChange={(event) => setInvoiceMode(event.target.value as 'zatca_tax' | 'internal_delivery')}>
                <option value="zatca_tax">{t('invoice.mode.zatca_tax')}</option>
                <option value="internal_delivery">{t('invoice.mode.internal_delivery')}</option>
              </select>
            </label>
          </div>

          <label className="field">
            <span>{t('invoice.notes')}</span>
            <input className="input" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>

          <div className="card tight" style={{ boxShadow: 'none' }}>
            {remaining !== null ? (
              <span className="small muted" style={{ display: 'block' }}>
                {t('invoice.remainingCap')}: <strong>{formatQty(remaining)}</strong>
              </span>
            ) : null}
            <span className="small muted">
              {t('invoice.estimate')}: <strong>{formatMoney(totalEstimate)}</strong>
            </span>
          </div>

          <button type="button" className="btn primary block" disabled={!canSubmit} onClick={() => void submit()}>
            {t('invoice.submit')}
          </button>
        </div>
      )}
    </Screen>
  );
}
