'use client';

import { useMemo, useState } from 'react';
import { useSession } from '@erp/web-core/session';

import { Empty, Forbidden, Loading, Screen } from '../../components/screen';
import { useOfflineRead } from '../../components/offline-data';
import { useLang } from '../../lib/i18n';
import { findCustomerPrices, listCustomers, listItems } from '../../lib/offline/rep-db';
import type { RepCustomerPrice } from '../../lib/offline/types';

/**
 * M5 — the customer list with THEIR prices (the snapshot's customerPrices rows, per
 * party per item): the rep sees the locked price, the bonus caps and the credit limit
 * exactly as the van-sales engine will enforce them — read offline, always available.
 */
export default function CustomersPage() {
  const { can } = useSession();
  const { t, lang } = useLang();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const customers = useOfflineRead(listCustomers);
  const items = useOfflineRead(listItems);
  const prices = useOfflineRead(() => (selectedId ? findCustomerPrices(selectedId) : Promise.resolve([])), selectedId);

  const itemNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items.data ?? []) map.set(item.id, lang === 'ar' ? item.nameAr : item.nameEn ?? item.nameAr);
    return map;
  }, [items.data, lang]);

  if (!can('van_sales.view')) return <Forbidden />;

  const rows = (customers.data ?? []).filter((customer) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return customer.name.toLowerCase().includes(needle) || customer.code.toLowerCase().includes(needle);
  });

  const priceRows: RepCustomerPrice[] = prices.data ?? [];

  return (
    <Screen title={t('customers.title')} subtitle={t('home.offlineHint')}>
      <input
        className="input"
        type="search"
        placeholder={t('customers.search')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label={t('customers.search')}
      />

      {customers.loading ? (
        <Loading rows={3} />
      ) : rows.length === 0 ? (
        <Empty hint={t('invoice.needSnapshot')} />
      ) : (
        <div className="grid">
          {rows.map((customer) => (
            <button
              key={customer.id}
              type="button"
              className={`card tight${selectedId === customer.id ? ' selected' : ''}`}
              style={{ textAlign: 'start', cursor: 'pointer', border: selectedId === customer.id ? '1px solid var(--brand)' : undefined }}
              onClick={() => setSelectedId(selectedId === customer.id ? null : customer.id)}
            >
              <strong>{customer.name}</strong>
              <span className="muted small" style={{ display: 'block' }}>
                {customer.code}
                {customer.phone ? ` · ${customer.phone}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}

      {selectedId ? (
        prices.loading ? (
          <Loading rows={2} />
        ) : priceRows.length === 0 ? (
          <Empty hint={t('customers.prices')} />
        ) : (
          <div className="card">
            <strong>{t('customers.prices')}</strong>
            <div className="table-wrap" style={{ marginTop: '10px' }}>
              <table>
                <thead>
                  <tr>
                    <th>{t('invoice.item')}</th>
                    <th className="num">{t('invoice.price')}</th>
                    <th className="num">{t('customers.bonusCap')}</th>
                    <th className="num">{t('customers.creditLimit')}</th>
                    <th>{t('invoice.lockedPrice')}</th>
                  </tr>
                </thead>
                <tbody>
                  {priceRows.map((row) => (
                    <tr key={`${row.partyId}-${row.itemId ?? 'any'}`}>
                      <td>{row.itemId ? itemNames.get(row.itemId) ?? row.itemId : t('customers.anyItem')}</td>
                      <td className="num">{row.unitPrice}</td>
                      <td className="num">{row.maxBonusKgPerInvoice}</td>
                      <td className="num">{row.creditLimit}</td>
                      <td>{row.lockPrice ? <span className="badge approved">{t('customers.lockPrice')}</span> : <span className="muted small">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : null}
    </Screen>
  );
}
