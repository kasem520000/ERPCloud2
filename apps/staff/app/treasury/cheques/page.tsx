'use client';

import Link from 'next/link';
import Decimal from 'decimal.js';
import { useMemo, useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { StatTile, StatTiles } from '../../../components/ui';
import { ApiError, apiList, apiPost } from '../../../lib/api';
import { cashLocationLabel, money, partyLabel, shortDate, statusLabel, type CashLocation, type Party } from '../../../lib/lookups';
import { listCashLocations, listParties } from '../../../lib/lookups';
import { useQuery } from '../../../lib/use-query';

/**
 * 🏦 كشف الشيكات — `frmSandQ` / `frmPaymentVoucher` كما يراها أمين الصندوق.
 *
 * الديسكتوب يعرض الشيكات في نفس شبكة السندات لكن بفلتر «شيك»:
 * `frmSandQD` / `frmSandSD` + `frmPaymentVoucher` (حالة الشيك: تحت التحصيل/محصّل/مرتجع).
 * هذه الشاشة هي نفس البيانات بفلتر ثابت `method=cheque` مع حالة الشيك وتوريد بنكي.
 *
 * القاعدة: الشيك وعد لا نقد — `chequesInHandAccountId` (أوراق القبض) حتى يُحصّل،
 * ثم ينتقل إلى الصندوق/البنك. المرتجع نهائي `CHEQUE_INVALID_STATE`.
 */

type Voucher = {
  id: string;
  number: string | null;
  kind: 'receipt' | 'payment';
  subtype: string;
  status: string;
  date: string;
  voucherTime?: string | null;
  partyId: string | null;
  cashLocationId: string;
  method: string;
  amount: string;
  chequeNo?: string | null;
  chequeDate?: string | null;
  chequeState?: string | null;
  bankName?: string | null;
  recipient?: string | null;
  description?: string | null;
};

const CHEQUE_STATES: Record<string, string> = {
  pending: 'تحت التحصيل',
  collected: 'محصّل',
  cleared: 'محصّل',
  bounced: 'مرتجع',
};

export default function ChequesPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (q.trim()) params.set('q', q.trim());
    const suffix = params.toString();
    return `/vouchers${suffix ? `?${suffix}` : ''}`;
  }, [from, to, q]);

  const vouchers = useQuery<Voucher[]>(() => apiList<Voucher>(query), [query]);
  const cashLocations = useQuery<CashLocation[]>(() => listCashLocations(), []);
  const parties = useQuery<Party[]>(() => listParties(), []);

  const cashRows = cashLocations.data ?? [];
  const allRows = (vouchers.data ?? []).filter((row) => row.method === 'cheque');
  const rows = allRows.filter((row) => (state ? row.chequeState === state : true));

  const totals = useMemo(() => {
    const pending = rows.filter((r) => r.chequeState === 'pending');
    const collected = rows.filter((r) => r.chequeState === 'collected' || r.chequeState === 'cleared');
    const bounced = rows.filter((r) => r.chequeState === 'bounced');
    const sum = (list: Voucher[]) => list.reduce((s, r) => s.plus(r.amount ?? '0'), new Decimal('0'));
    return {
      count: rows.length,
      pending: pending.length,
      collected: collected.length,
      bounced: bounced.length,
      pendingTotal: sum(pending),
      collectedTotal: sum(collected),
    };
  }, [rows]);

  const partyOf = (id: string | null) => (parties.data ?? []).find((p) => p.id === id);

  async function run(action: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: okText });
      vouchers.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="🏦 كشف الشيكات"
      subtitle="شيكات تحت التحصيل — `frmSandQ` / `frmPaymentVoucher`: رقم الشيك وتاريخ الاستحقاق والبنك وحالة التحصيل، مع تحصيل/إرجاع بقيد حقيقي."
      crumbs={['الخزينة', 'الشيكات']}
    >
      <StatTiles>
        <StatTile label="📋 الشيكات" value={totals.count} hint="في الفترة" />
        <StatTile label="🏦 تحت التحصيل" value={totals.pending} tone="warn" />
        <StatTile label="✅ محصّلة" value={totals.collected} tone="ok" />
        <StatTile label="↩️ مرتجعة" value={totals.bounced} />
        <StatTile label="💰 قيمة تحت التحصيل" value={money(totals.pendingTotal.toFixed(4))} />
        <StatTile label="💰 قيمة محصّلة" value={money(totals.collectedTotal.toFixed(4))} />
      </StatTiles>

      <div className="card toolbar">
        <label className="field">
          <span>📅 من تاريخ</span>
          <input className="input" type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span>📅 إلى تاريخ</span>
          <input className="input" type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="field">
          <span>📋 حالة الشيك</span>
          <select className="input" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">الكل</option>
            <option value="pending">تحت التحصيل</option>
            <option value="collected">محصّل</option>
            <option value="cleared">محصّل</option>
            <option value="bounced">مرتجع</option>
          </select>
        </label>
        <label className="field">
          <span>🔍 البحث</span>
          <input className="input" value={q} placeholder="رقم الشيك · البنك · البيان" onChange={(e) => setQ(e.target.value)} />
        </label>
        <button className="btn sm" type="button" onClick={() => { setFrom(''); setTo(''); setQ(''); setState(''); }}>
          📋 كل الفترة
        </button>
      </div>

      <Notice notice={notice} />

      <QueryView query={vouchers} isEmpty={() => rows.length === 0} empty="لا توجد شيكات" emptyDetail="الشيكات هي سندات قبض/صرف بطريقة دفع شيك.">
        {() => (
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            footer={[
              <>المجموع</>,
              '',
              '',
              '',
              '',
              '',
              '',
              money(rows.reduce((s, r) => s.plus(r.amount ?? '0'), new Decimal('0')).toFixed(4)),
              '',
              '',
            ]}
            columns={[
              { key: 'number', header: '🔢 الرقم', align: 'ltr', cell: (r) => r.number ?? 'مسودة' },
              { key: 'date', header: '📅 التاريخ', align: 'ltr', cell: (r) => shortDate(r.date) },
              { key: 'time', header: '⏰ الوقت', align: 'ltr', cell: (r) => r.voucherTime?.slice(0, 5) ?? '—' },
              {
                key: 'party',
                header: '👤 الطرف',
                cell: (r) => {
                  const p = partyOf(r.partyId);
                  return p ? partyLabel(p) : (r.recipient ?? '—');
                },
              },
              { key: 'chequeNo', header: '🔢 رقم الشيك', align: 'ltr', cell: (r) => r.chequeNo ?? '—' },
              { key: 'chequeDate', header: '📅 استحقاق', align: 'ltr', cell: (r) => (r.chequeDate ? shortDate(r.chequeDate) : '—') },
              { key: 'bank', header: '🏦 البنك', cell: (r) => r.bankName ?? '—' },
              { key: 'amount', header: '💰 المبلغ', align: 'num', cell: (r) => money(r.amount) },
              {
                key: 'cash',
                header: '🏦 الصندوق',
                cell: (r) => {
                  const loc = cashRows.find((x) => x.id === r.cashLocationId);
                  return loc ? cashLocationLabel(loc) : '—';
                },
              },
              {
                key: 'status',
                header: '📋 الحالة',
                cell: (r) => <span className="badge">{r.chequeState ? (CHEQUE_STATES[r.chequeState] ?? r.chequeState) : statusLabel(r.status)}</span>,
              },
              {
                key: 'actions',
                header: '',
                cell: (r) => (
                  <span className="row">
                    <Link className="btn sm" href={`/print/voucher/${r.id}`}>
                      🖨️ طباعة
                    </Link>
                    <Link className="btn sm" href={`/treasury/vouchers?id=${r.id}`}>
                      📄 عرض السند
                    </Link>
                    {r.status === 'posted' && r.chequeState === 'pending' && (
                      <>
                        <button className="btn sm" type="button" disabled={busy} onClick={() => run(() => apiPost(`/vouchers/${r.id}/cheque`, { action: 'clear' }), 'تم تحصيل الشيك — انتقل من أوراق القبض إلى الصندوق بقيد.')}>
                          💰 تحصيل
                        </button>
                        <button className="btn sm danger" type="button" disabled={busy} onClick={() => run(() => apiPost(`/vouchers/${r.id}/cheque`, { action: 'bounce' }), 'تم إرجاع الشيك — عاد الدين على الطرف بقيد عكسي.')}>
                          ↩️ إرجاع
                        </button>
                      </>
                    )}
                  </span>
                ),
              },
            ]}
          />
        )}
      </QueryView>
    </Screen>
  );
}
