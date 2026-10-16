'use client';

import { useMemo, useState } from 'react';
import { Decimal } from 'decimal.js';
import { useSession } from '@erp/web-core/session';

import { ErrorBox, Forbidden, Loading, Screen } from '../../components/screen';
import { useOfflineRead } from '../../components/offline-data';
import { useLang } from '../../lib/i18n';
import { listOpenLoadOrders } from '../../lib/offline/rep-db';
import { formatMoney, formatQty, remainingOfLoadOrder } from '../../lib/offline/ops';
import { fetchRepCustody, submitRepClosing } from '../../lib/rep-api';
import { useQuery } from '../../lib/use-query';

/**
 * M5 — closing the route (D-008 done honestly):
 *
 *   • ONLINE ONLY: closing posts once to the server (`POST /rep-workspace/closing`),
 *     never through the offline queue — settlement touches custody, cash and possibly
 *     the accountant's approvals; replaying it blind is exactly the silent settlement
 *     the engine refuses.
 *   • COUNTED vs EXPECTED, side by side: the server's expected remaining next to the
 *     rep's physical count; the difference is the shortage, shown before submit.
 *   • EXPLICIT, never silent: when the count is short, the submit button stays disabled
 *     until the rep acknowledges that the difference goes to the accountant for the
 *     shortage decision (`pending_policy_approval` upstream — D-008). The app surfaces
 *     the numbers; the accountant decides the policy. Surplus is equally explicit: it
 *     is approved by acknowledgment upstream, never pocketed silently.
 */
export default function ClosingPage() {
  const { can } = useSession();
  const { t } = useLang();
  const custody = useQuery(fetchRepCustody, []);
  const localOrders = useOfflineRead(listOpenLoadOrders);

  const [loadOrderId, setLoadOrderId] = useState('');
  const [returnedQty, setReturnedQty] = useState('');
  const [actualRemainingQty, setActualRemainingQty] = useState('');
  const [damagedQty, setDamagedQty] = useState('');
  const [damageReason, setDamageReason] = useState('');
  const [collectedCash, setCollectedCash] = useState('');
  const [closingNotes, setClosingNotes] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<Record<string, unknown> | undefined>(undefined);

  const onlineOrders = custody.status === 'success' ? custody.data?.openLoadOrders ?? null : null;
  const orderOptions = onlineOrders ?? (localOrders.data ?? []).map((order) => ({
    id: order.id,
    number: order.number,
    loadDate: order.loadDate,
    status: order.status,
    itemId: order.itemId,
    itemName: order.itemId ?? '—',
    productionBatchNo: order.productionBatchNo,
    loadedQty: order.loadedQty,
    receivedQty: order.receivedQty,
    soldQty: order.soldQty,
    bonusQty: order.bonusQty,
    returnedQty: order.returnedQty,
    damagedQty: order.damagedQty,
    shortageQty: '0',
    expectedCash: order.expectedCash,
    collectedCash: order.collectedCash,
    outstandingCash: formatMoney(new Decimal(order.expectedCash || '0').minus(new Decimal(order.collectedCash || '0'))),
    expectedRemainingQty: formatQty(remainingOfLoadOrder(order)),
    actualRemainingQty: order.receivedQty,
    stockSettlementStatus: 'not_required',
  }));
  const selected = orderOptions.find((order) => order.id === loadOrderId);

  /** Expected remaining per the SERVER's formula; shortage is what the count cannot show. */
  const expectedRemaining = selected ? new Decimal(selected.expectedRemainingQty || '0') : null;
  const counted = actualRemainingQty === '' ? null : new Decimal(actualRemainingQty);
  const shortage = expectedRemaining && counted !== null ? Decimal.max(0, expectedRemaining.minus(counted)) : null;
  const surplus = expectedRemaining && counted !== null ? Decimal.max(0, counted.minus(expectedRemaining)) : null;
  const needsAcknowledgment = shortage !== null && shortage.greaterThan(0);

  const canSubmit = useMemo(
    () => Boolean(loadOrderId) && counted !== null && !busy && (!needsAcknowledgment || acknowledged),
    [loadOrderId, counted, busy, needsAcknowledgment, acknowledged],
  );

  async function submit(): Promise<void> {
    if (!canSubmit || !selected) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await submitRepClosing({
        loadOrderId,
        returnedQty: new Decimal(returnedQty || '0').toFixed(4),
        collectedCash: new Decimal(collectedCash || selected.expectedCash || '0').toFixed(2),
        actualRemainingQty: (counted as Decimal).toFixed(4),
        ...(damagedQty ? { damagedQty: new Decimal(damagedQty).toFixed(4) } : {}),
        ...(damageReason ? { damageReason } : {}),
        ...(closingNotes ? { closingNotes } : {}),
      });
      setDone(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!can('van_sales.closing.submit')) return <Forbidden />;

  if (custody.status === 'loading' || localOrders.loading) {
    return (
      <Screen title={t('closing.title')}>
        <Loading rows={4} />
      </Screen>
    );
  }

  if (custody.status === 'error') {
    return (
      <Screen title={t('closing.title')} subtitle={t('closing.onlineOnly')}>
        <ErrorBox message={custody.error} onRetry={custody.reload} />
        <div className="card">
          <strong>{t('closing.onlineOnly')}</strong>
          <p className="muted small" style={{ margin: '6px 0 0' }}>
            {t('home.offlineHint')}
          </p>
        </div>
      </Screen>
    );
  }

  return (
    <Screen title={t('closing.title')} subtitle={t('closing.onlineOnly')}>
      {done ? (
        <div className="card" role="status">
          <strong>{t('closing.submitted')}</strong>
          <p className="muted small" style={{ margin: '6px 0' }}>
            {t('closing.pendingApproval')}
          </p>
          <pre className="small" dir="ltr" style={{ overflow: 'auto', background: 'var(--surface-2)', padding: '10px', borderRadius: '8px' }}>
            {JSON.stringify(done, null, 2)}
          </pre>
        </div>
      ) : (
        <>
          <div className="card">
            <label className="field">
              <span>{t('invoice.order')}</span>
              <select className="input" value={loadOrderId} onChange={(event) => setLoadOrderId(event.target.value)}>
                <option value="">—</option>
                {orderOptions.map((order) => (
                  <option key={order.id} value={order.id}>
                    {order.number} · {t('closing.expected')} {order.expectedRemainingQty}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {selected ? (
            <div className="card">
              <div className="stats">
                <div className="stat">
                  <strong>{selected.expectedRemainingQty}</strong>
                  <span>{t('closing.expected')}</span>
                </div>
                <div className="stat">
                  <strong>{counted === null ? '—' : formatQty(counted)}</strong>
                  <span>{t('closing.count')}</span>
                </div>
                <div className="stat">
                  <strong style={{ color: shortage && shortage.greaterThan(0) ? 'var(--danger)' : undefined }}>
                    {shortage === null ? '—' : formatQty(shortage)}
                  </strong>
                  <span>{t('closing.difference')}</span>
                </div>
                <div className="stat">
                  <strong>{selected.outstandingCash}</strong>
                  <span>{t('receipt.outstanding')}</span>
                </div>
              </div>

              <label className="field" style={{ marginTop: '12px' }}>
                <span>{t('closing.count')} (المتبقي فعليًا في السيارة)</span>
                <input
                  className="input"
                  type="number"
                  dir="ltr"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={actualRemainingQty}
                  onChange={(event) => setActualRemainingQty(event.target.value)}
                />
              </label>

              <div className="grid cols-2">
                <label className="field">
                  <span>{t('stock.orders')} — مرتجع للمستودع</span>
                  <input
                    className="input"
                    type="number"
                    dir="ltr"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={returnedQty}
                    onChange={(event) => setReturnedQty(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>{t('closing.damagedQty')}</span>
                  <input
                    className="input"
                    type="number"
                    dir="ltr"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={damagedQty}
                    onChange={(event) => setDamagedQty(event.target.value)}
                  />
                </label>
              </div>

              <label className="field">
                <span>{t('closing.damageReason')}</span>
                <input className="input" value={damageReason} onChange={(event) => setDamageReason(event.target.value)} />
              </label>

              <label className="field">
                <span>{t('closing.collectedCash')}</span>
                <input
                  className="input"
                  type="number"
                  dir="ltr"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  placeholder={selected.expectedCash}
                  value={collectedCash}
                  onChange={(event) => setCollectedCash(event.target.value)}
                />
              </label>

              <label className="field">
                <span>{t('invoice.notes')}</span>
                <input className="input" value={closingNotes} onChange={(event) => setClosingNotes(event.target.value)} />
              </label>

              {needsAcknowledgment ? (
                <label className="card tight" style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', boxShadow: 'none', borderColor: 'var(--color-warning)' }}>
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                    style={{ marginTop: '3px' }}
                  />
                  <span className="small">{t('closing.shortage')}</span>
                </label>
              ) : null}

              {surplus && surplus.greaterThan(0) ? (
                <p className="small" role="status" style={{ color: 'var(--warn)' }}>
                  الفائض ({formatQty(surplus)}) يُعرض أيضًا على المحاسب — تسجيل الفائض يتم عند الاعتماد بإقرار صريح، لا من حساب المندوب.
                </p>
              ) : null}

              {error ? (
                <p className="small" role="alert" style={{ color: 'var(--danger)' }}>
                  {error}
                </p>
              ) : null}

              <button type="button" className="btn primary block" disabled={!canSubmit} onClick={() => void submit()}>
                {busy ? '…' : t('closing.submit')}
              </button>
            </div>
          ) : null}
        </>
      )}
    </Screen>
  );
}
