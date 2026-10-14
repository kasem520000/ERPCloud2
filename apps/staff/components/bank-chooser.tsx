'use client';

import { useEffect, useState } from 'react';

import { cashLocationLabel, type CashLocation } from '../lib/lookups';

/**
 * 🏦 اختر طريقة الدفع (تحويل بنكي) — `Form_WPF/frmPayBank.xaml`.
 *
 * The desktop window is a **chooser, not a form**: a header `🏦 اختر طريقة الدفع
 * (تحويل بنكي)`, a `🏦 البنوك المتاحة` panel of tiles built in `LoadBanks()` from
 * `SELECT id, name FROM Banks WHERE IS_Deleted=0 AND id != 1 AND id != 2`, and two
 * buttons — `✔ موافق` / `✖ خروج`. Two sentences carry the whole design:
 *
 *   `SelectedBankId == 0` → "يرجى اختيار بنك أولًا"  (a transfer must name its bank)
 *   no rows                → "لا توجد بنوك متاحة"    (and the window says so plainly)
 *
 * Why it exists at all: `frmPOSBill.xaml.cs` `BtnBank_Click` sets
 * `Invoic.Bank = bankFrm.SelectedBankId` and `_payment.PayType = 2`, and
 * `Class/EntryOper.cs` L493/L537/L620 then keeps that transfer **out of the generic
 * شبكة bucket and on its own line, debited to that bank's own account**. A transfer
 * routed to "whatever the default is" would reconcile to the wrong account, so the
 * choice belongs at the moment of payment — not in a settings screen.
 *
 * The excluded ids 1 and 2 are the desktop's الصندوق/المحفظة placeholders; in the cloud
 * a bank is a `cash_locations` row of kind `bank`, so the caller passes banks and this
 * window renders them. It never decides which rows those are.
 */

export type BankChoice = { id: string; label: string };

export function BankChooser({
  banks,
  selectedId,
  loading,
  onPick,
  onCancel,
}: {
  banks: CashLocation[];
  selectedId: string;
  loading?: boolean;
  onPick: (bank: BankChoice) => void;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState(selectedId);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setChosen(selectedId);
    setNotice('');
  }, [selectedId]);

  function confirm() {
    const bank = banks.find((row) => row.id === chosen);
    if (!bank) {
      // The desktop's own words — a transfer without a bank is refused, not guessed.
      setNotice('يرجى اختيار بنك أولًا');
      return;
    }
    onPick({ id: bank.id, label: cashLocationLabel(bank) });
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="🏦 اختر طريقة الدفع (تحويل بنكي)">
      <div className="modal-card" style={{ maxWidth: 640 }}>
        <div className="modal-head">
          <span className="modal-title">🏦 اختر طريقة الدفع (تحويل بنكي)</span>
        </div>

        <div className="card" style={{ margin: 12 }}>
          <div className="card-head">🏦 البنوك المتاحة</div>
          <div className="bank-tiles">
            {loading ? <p className="muted small">…</p> : null}
            {!loading && banks.length === 0 ? (
              // `frmPayBank.xaml.cs` writes this into the panel when the query is empty.
              <p className="muted" style={{ textAlign: 'center', margin: '20px 0' }}>
                لا توجد بنوك متاحة
              </p>
            ) : null}
            {banks.map((bank) => (
              <button
                key={bank.id}
                type="button"
                className={`bank-tile ${chosen === bank.id ? 'on' : ''}`}
                onClick={() => {
                  setChosen(bank.id);
                  setNotice('');
                }}
              >
                <span className="bank-tile-icon">🏦</span>
                <span className="bank-tile-name">{cashLocationLabel(bank)}</span>
              </button>
            ))}
          </div>
        </div>

        {notice ? <p className="notice danger" style={{ margin: '0 12px' }}>{notice}</p> : null}

        <div className="modal-foot">
          <button type="button" className="btn danger" onClick={onCancel}>
            ✖ خروج
          </button>
          <button type="button" className="btn primary" onClick={confirm}>
            ✔ موافق
          </button>
        </div>
      </div>
    </div>
  );
}
