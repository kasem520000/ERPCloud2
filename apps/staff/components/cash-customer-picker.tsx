'use client';

import { useEffect, useMemo, useState } from 'react';

import { apiList } from '../lib/api';
import { useQuery } from '../lib/use-query';

/**
 * 👤 عميل نقدي — `Form_WPF/frmCashCustomer.xaml`.
 *
 * The desktop window is `👤 عميل نقدي` / «إضافة أو اختيار عميل نقدي للفاتورة» with
 * `🏷️ الاسم:`, `📱 رقم الجوال:`, `✅ إدراج` / `🚪 خروج`, a search row — `🔍` بالجوال or
 * بالاسم, labelled `📱 الجوال` and `🏷️ الاسم:` — and a grid of `👤 الاسم` ·
 * `📱 الجوال` · `اختيار` whose rows end in `✔ اختار`.
 *
 * The decisive detail lives in the code-behind (`SearchCustomers`): the search does
 * **not** read a customer table, it reads the invoices —
 *
 *   SELECT CashCustomerName, CashCustomerMobile FROM inv
 *    WHERE (CashCustomerMobile = @Mobile) AND CashCustomerName <> ''
 *      — or —  WHERE CashCustomerName LIKE '%' + @Name + '%' AND CashCustomerName <> ''
 *
 * A walk-in is a name and a mobile **written on the sale**, so the till can produce one
 * without opening a ledger account, and "find the customer" means "find a name this shop
 * has already served". `BtnInsert_Click` refuses an empty name or mobile with
 * `يجب إدخال الاسم` / `يجب إدخال رقم الجوال` — two messages kept here verbatim.
 */

export type CashCustomer = {
  name: string;
  mobile: string | null;
  invoices: number;
  lastAt: string;
};

type Props = {
  /** The pair the caller is editing — the till's own fields. */
  value: { name: string; mobile: string };
  onPick: (customer: { name: string; mobile: string }) => void;
  onClose: () => void;
  /** Set when the panel is rendered inside a page instead of a dialog. */
  embedded?: boolean;
};

export function CashCustomerPicker({ value, onPick, onClose, embedded }: Props) {
  const [name, setName] = useState(value.name);
  const [mobile, setMobile] = useState(value.mobile);
  const [searchName, setSearchName] = useState('');
  const [searchMobile, setSearchMobile] = useState('');
  const [notice, setNotice] = useState('');

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (searchName.trim()) params.set('name', searchName.trim());
    if (searchMobile.trim()) params.set('mobile', searchMobile.trim());
    return params.toString();
  }, [searchName, searchMobile]);

  const results = useQuery<CashCustomer[]>(() => apiList<CashCustomer>(`/sales/cash-customers?${query}`), [query]);
  const rows = results.data ?? [];

  useEffect(() => {
    setName(value.name);
    setMobile(value.mobile);
  }, [value.name, value.mobile]);

  function insert() {
    // `frmCashCustomer.xaml.cs` BtnInsert_Click — in the desktop's own words.
    if (!name.trim()) {
      setNotice('يجب إدخال الاسم');
      return;
    }
    if (!mobile.trim()) {
      setNotice('يجب إدخال رقم الجوال');
      return;
    }
    setNotice('');
    onPick({ name: name.trim(), mobile: mobile.trim() });
  }

  const panel = (
    <>
      <div className="form-grid">
        <label className="field">
          <span>🏷️ الاسم:</span>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">
          <span>📱 رقم الجوال:</span>
          <input
            className="input"
            dir="ltr"
            inputMode="tel"
            value={mobile}
            onChange={(event) => setMobile(event.target.value)}
          />
        </label>
      </div>

      <div className="row" style={{ marginTop: 10, justifyContent: 'center' }}>
        <button type="button" className="btn primary" onClick={insert}>
          ✅ إدراج
        </button>
        <button type="button" className="btn danger" onClick={onClose}>
          🚪 خروج
        </button>
      </div>

      {notice ? (
        <p className="alert warn" style={{ marginTop: 8 }}>
          {notice}
        </p>
      ) : null}

      <div className="grid cols" style={{ marginTop: 14 }}>
        <label className="field">
          <span>📱 الجوال</span>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input
              className="input"
              dir="ltr"
              inputMode="tel"
              placeholder="05…"
              value={searchMobile}
              onChange={(event) => setSearchMobile(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') results.reload();
              }}
            />
            <button type="button" className="btn" title="بحث بالجوال" onClick={() => results.reload()}>
              🔍
            </button>
          </div>
        </label>
        <label className="field">
          <span>🏷️ الاسم:</span>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input
              className="input"
              value={searchName}
              onChange={(event) => setSearchName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') results.reload();
              }}
            />
            <button type="button" className="btn" title="بحث بالاسم" onClick={() => results.reload()}>
              🔍
            </button>
          </div>
        </label>
      </div>

      <div className="table-wrap" style={{ marginTop: 10, maxHeight: 300 }}>
        <table className="compact">
          <thead>
            <tr>
              <th>👤 الاسم</th>
              <th>📱 الجوال</th>
              <th>فاتورة</th>
              <th>اختيار</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted" style={{ textAlign: 'center' }}>
                  لا يوجد عملاء بهذا البحث
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={`${row.name}-${row.mobile ?? ''}`}>
                  <td>{row.name}</td>
                  <td dir="ltr">{row.mobile ?? '—'}</td>
                  <td>{row.invoices}</td>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setName(row.name);
                        setMobile(row.mobile ?? '');
                        setNotice('');
                      }}
                    >
                      ✔ اختار
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );

  if (embedded) return panel;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="👤 عميل نقدي">
      <div className="modal-card" style={{ maxWidth: 860 }}>
        <div className="modal-head">
          <span className="modal-title">👤 عميل نقدي</span>
        </div>
        <p className="muted small" style={{ textAlign: 'center', margin: '8px 12px 0' }}>
          إضافة أو اختيار عميل نقدي للفاتورة
        </p>
        <div style={{ padding: 12 }}>{panel}</div>
      </div>
    </div>
  );
}
