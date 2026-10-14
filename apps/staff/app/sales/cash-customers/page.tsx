'use client';

import { useState } from 'react';

import { CashCustomerPicker, type CashCustomer } from '../../../components/cash-customer-picker';
import { Screen } from '../../../components/screen';
import { apiList } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * 👤 عميل نقدي — `Form_WPF/frmCashCustomer.xaml`.
 *
 * The till's walk-in, on its own page: the desktop window is opened *from* a sale, and
 * this page is the same panel standing alone so the names a shop has already served can
 * be reviewed — and reused — without opening the till.
 *
 * The rule it exists to serve is in the code-behind: a cash customer is not a row in a
 * customer table, it is a name and a mobile written **on the invoice**
 * (`SELECT … FROM inv WHERE CashCustomerName <> ''`), which is why a till can produce one
 * without opening a ledger account, and why a name is only ever as permanent as the sale
 * it was written on.
 */
export default function CashCustomersPage() {
  const { can } = useSession();
  const [notice, setNotice] = useState('');
  const [picked, setPicked] = useState<CashCustomer | undefined>();

  const recent = useQuery<CashCustomer[]>(() => apiList<CashCustomer>('/sales/cash-customers'), []);
  const served = (recent.data ?? []).reduce((running, row) => running + Number(row.invoices), 0);

  if (!can('sales.view')) {
    return (
      <Screen title="👤 عميل نقدي" crumbs={['المبيعات']}>
        <div className="card state">
          <strong>لا تملك صلاحية عرض العملاء</strong>
          <span>تحتاج صلاحية sales.view.</span>
        </div>
      </Screen>
    );
  }

  return (
    <Screen
      title="👤 عميل نقدي"
      subtitle="إضافة أو اختيار عميل نقدي للفاتورة — الأسماء التي خدمها المتجر"
      crumbs={['المبيعات', 'العملاء']}
    >
      <div className="grid cols">
        <div className="card">
          <div className="card-head">📋 ملخّص</div>
          <dl className="kv">
            <dt>أسماء محفوظة</dt>
            <dd>{(recent.data ?? []).length}</dd>
            <dt>فواتير كُتبت بأسماء نقدية</dt>
            <dd>{served}</dd>
          </dl>
          <p className="muted small" style={{ marginTop: 8 }}>
            الاسم النقدي يُحفظ على الفاتورة نفسها لا في سجل الأطراف؛ لذلك لا يُفتح له حساب
            ذمم، ويكفي أن تعود باسمه لتجده هنا.
          </p>
          {notice ? (
            <p className="alert ok" style={{ marginTop: 8 }}>
              {notice}
            </p>
          ) : null}
          {picked ? (
            <p className="alert info" style={{ marginTop: 8 }}>
              المختار الآن: {picked.name} — {picked.mobile ?? '—'}
            </p>
          ) : null}
        </div>

        <div className="card">
          <div className="card-head">🏷️ إضافة أو اختيار</div>
          <CashCustomerPicker
            embedded
            value={{ name: picked?.name ?? '', mobile: picked?.mobile ?? '' }}
            onPick={(customer) => {
              setPicked({ name: customer.name, mobile: customer.mobile, invoices: 0, lastAt: '' });
              setNotice(`أُدرج الاسم «${customer.name}» ليُستخدم في الفاتورة القادمة`);
              recent.reload();
            }}
            onClose={() => {
              setPicked(undefined);
              setNotice('');
            }}
          />
        </div>
      </div>
    </Screen>
  );
}
