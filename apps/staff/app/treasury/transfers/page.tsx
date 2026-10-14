'use client';

import { useMemo, useState } from 'react';

import { DataTable, Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { FilterBar, StatTile, StatTiles, Tabs } from '../../../components/ui';
import { ApiError, apiList, apiPost } from '../../../lib/api';
import {
  branchOptions,
  cashLocationLabel,
  dateTime,
  defaultOf,
  listBranches,
  listCashLocations,
  money,
  today,
  type Branch,
  type CashLocation,
} from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * مناقلة الخزن — money from one safe to another.
 *
 * The desktop's transfer window is `Form_WPF/frmSafesTransfer.xaml` (window title
 * `مناقلة`), and it is three tabs carrying the whole workflow:
 *
 *   📦 التحويل      «📋 إدخال بيانات التحويل» — `🔢 رقم المناقلة` · `📅 التاريخ` ·
 *                   `🏪 من مخزن` · `🏪 إلى مخزن` · `✅ اعتماد الإرسال`
 *   📥 استلام تحويل «📥 استلام تحويل» — `🔢 رقم المناقلة` · `🏪 من مخزن` ·
 *                   `🏪 إلى مخزن` · `👁️ عرض` · `✅ تأكيد الاستلام` · `📦 استلام الكل`
 *   🔍 البحث        «🔍 معايير البحث» — `🔢 رقم التحويل` · `📅 من تاريخ` ·
 *                   `📅 إلى تاريخ` · `📋 كل الفترة` · `🔍 بحث` over «📊 نتائج البحث»
 *
 * One honest finding, recorded before the code: the desktop's `SafesTransfer` table has
 * **no amount column** — it stores `safe_from`, `safe_to`, `IsSent`, `IsReceived` and a
 * sub-table of *items* (`ItemId`, `value` = quantity, `AvrgCost`, `ReceivedValue`,
 * `Diff`). So `frmSafesTransfer` is a **مناقلة أصناف بين المخازن** in the desktop, and
 * money between safes is moved there by a سند صرف and a سند قبض. This screen is the
 * money equivalent, built on the cloud's `/cash-transfers` and named in the window's
 * own words: `🏦 من خزنة` / `🏦 إلى خزنة` are `🏪 من مخزن` / `🏪 إلى مخزن` with the
 * store replaced by the safe, because this is the الخزينة module and the thing being
 * moved is cash.
 *
 * The lifecycle the window encodes is kept exactly: a transfer is written as a draft,
 * then **sent** (`IsSent`) — money leaves the source — then **received** (`IsReceived`)
 * — money lands in the destination. Nothing in between counts in either safe, and a
 * transfer that has left cannot be quietly deleted: the desktop keeps `IS_Deleted` for
 * drafts, and after that the only honest way back is a transfer the other way.
 */

type Transfer = {
  id: string;
  branchId: string;
  fromCashLocationId: string;
  toCashLocationId: string;
  fromName: string | null;
  toName: string | null;
  number: string | null;
  amount: string;
  currency: string;
  status: 'draft' | 'sent' | 'received' | 'voided';
  sentJournalEntryId: string | null;
  receivedJournalEntryId: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  createdAt: string;
};

/** 📋 الحالة — the four states `IsSent`/`IsReceived`/`IS_Deleted` actually produce. */
const STATUS_LABELS: Record<string, string> = {
  draft: 'مسودة',
  sent: 'مُرسَلة',
  received: 'مُستلَمة',
  voided: 'مُلغاة',
};
/** The stylesheet's own tones, so a state never renders in another state's colour. */
const STATUS_TONE: Record<string, string> = {
  draft: 'draft',
  sent: 'pending',
  received: 'posted',
  voided: 'voided',
};

/** The three tabs, in the window's order and with its own words. */
const TABS = [
  { id: 'send', label: '📦 التحويل' },
  { id: 'receive', label: '📥 استلام تحويل' },
  { id: 'search', label: '🔍 البحث' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function CashTransfersPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<TabId>('send');

  const [branchId, setBranchId] = useState('');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  // 🔍 معايير البحث
  const [allPeriod, setAllPeriod] = useState(true);
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [numberQuery, setNumberQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [searched, setSearched] = useState(true);

  // 📥 استلام تحويل — the window picks `🔢 رقم المناقلة` and then reads the two sides back.
  const [selectedId, setSelectedId] = useState('');
  const [preview, setPreview] = useState(false);

  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const cashLocations = useQuery<CashLocation[]>(() => listCashLocations(), []);
  const branchRows = branches.data ?? [];
  const drawerRows = cashLocations.data ?? [];
  const effectiveBranch = branchId || defaultOf(branchRows)?.id || '';
  const safeRows = drawerRows.filter((row) => !effectiveBranch || !row.branchId || row.branchId === effectiveBranch);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (numberQuery.trim()) params.set('number', numberQuery.trim());
    if (!allPeriod) {
      if (from) params.set('from', from);
      if (to) params.set('to', to);
    }
    return params.toString();
  }, [statusFilter, numberQuery, allPeriod, from, to, searched]);

  const transfers = useQuery<Transfer[]>(() => apiList<Transfer>(`/cash-transfers?${query}`), [query]);
  const rows = transfers.data ?? [];
  const canManage = can('treasury.transfer.manage');
  const inTransitRows = rows.filter((row) => row.status === 'sent');
  const selected = rows.find((row) => row.id === selectedId);

  const totals = useMemo(() => {
    const inTransitValue = rows
      .filter((row) => row.status === 'sent')
      .reduce((running, row) => running + Number(row.amount ?? 0), 0);
    return {
      count: rows.length,
      drafts: rows.filter((row) => row.status === 'draft').length,
      sent: rows.filter((row) => row.status === 'sent').length,
      received: rows.filter((row) => row.status === 'received').length,
      inTransit: inTransitValue,
    };
  }, [rows]);

  async function run(action: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: okText });
      setAmountText('');
      transfers.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const createDraft = () =>
    run(
      () =>
        apiPost('/cash-transfers', {
          branchId: effectiveBranch,
          fromCashLocationId: fromId,
          toCashLocationId: toId,
          amount: amountText,
        }),
      'حُفظت المناقلة كمسودة — اعتمد الإرسال ليخرج المبلغ من الخزنة.',
    );

  const send = (id: string) => run(() => apiPost(`/cash-transfers/${id}/send`, {}), '✅ تم اعتماد الإرسال.');
  const receive = (id: string) =>
    run(() => apiPost(`/cash-transfers/${id}/receive`, {}), '✅ تم تأكيد الاستلام.');
  const cancel = (id: string) => run(() => apiPost(`/cash-transfers/${id}/cancel`, {}), '🗑️ أُلغيت المناقلة.');

  /** 📦 استلام الكل — the window's button: everything that is on the road lands at once. */
  const receiveAll = () =>
    run(
      async () => {
        for (const row of inTransitRows) await apiPost(`/cash-transfers/${row.id}/receive`, {});
      },
      `📦 استُلمت ${inTransitRows.length} مناقلة.`,
    );

  if (!can('treasury.view')) {
    return (
      <Screen title="مناقلة الخزن" crumbs={['الخزينة']}>
        <div className="card state">
          <strong>لا تملك صلاحية عرض الخزينة</strong>
          <span>تحتاج صلاحية treasury.view.</span>
        </div>
      </Screen>
    );
  }

  return (
    <Screen
      title="مناقلة"
      subtitle="مناقلة الخزن — إرسال من خزنة واستلام في أخرى، كما في frmSafesTransfer: مسودة ثم إرسال ثم استلام."
      crumbs={['الخزينة', 'العمليات']}
    >
      <StatTiles>
        <StatTile label="📊 عدد المناقلات" value={totals.count} hint="في نتيجة البحث الحالية" />
        <StatTile label="📝 مسودات" value={totals.drafts} />
        <StatTile label="📤 مُرسَلة" value={totals.sent} tone="warn" />
        <StatTile label="📥 مُستلَمة" value={totals.received} tone="ok" />
        <StatTile
          label="🚧 في الطريق"
          value={money(totals.inTransit.toFixed(4))}
          hint="أُرسلت ولم تُستلم بعد"
          tone={totals.inTransit > 0 ? 'warn' : 'default'}
        />
      </StatTiles>

      <Tabs items={TABS.map((entry) => ({ id: entry.id, label: entry.label }))} value={tab} onChange={setTab} />

      {tab === 'send' ? (
        <div className="card">
          <h2>📋 إدخال بيانات التحويل</h2>
          <Notice notice={notice} />
          <div className="form-grid">
            <label className="field">
              <span>🏢 الفرع</span>
              <select className="input" value={effectiveBranch} onChange={(event) => setBranchId(event.target.value)}>
                {branchOptions(branchRows).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>📅 التاريخ</span>
              <input className="input" value={today()} readOnly />
            </label>
            <label className="field">
              <span>🏦 من خزنة</span>
              <select className="input" value={fromId} onChange={(event) => setFromId(event.target.value)}>
                <option value="">— اختر —</option>
                {safeRows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {cashLocationLabel(row)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>🏦 إلى خزنة</span>
              <select className="input" value={toId} onChange={(event) => setToId(event.target.value)}>
                <option value="">— اختر —</option>
                {safeRows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {cashLocationLabel(row)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>💰 المبلغ</span>
              <input
                className="input"
                dir="ltr"
                inputMode="decimal"
                value={amountText}
                onChange={(event) => setAmountText(event.target.value)}
              />
            </label>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button type="button" className="btn primary" disabled={busy || !canManage || !fromId || !toId || !amountText} onClick={createDraft}>
              💾 حفظ كمسودة
            </button>
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>
            المناقلة لا تخرج من الخزنة إلا بعد <strong>✅ اعتماد الإرسال</strong> من تبويب الاستلام أو من الشبكة أدناه.
          </p>
        </div>
      ) : null}

      {tab === 'receive' ? (
        <div className="card">
          <h2>📥 استلام تحويل</h2>
          <Notice notice={notice} />
          <div className="form-grid">
            <label className="field">
              <span>🔢 رقم المناقلة</span>
              <select
                className="input"
                value={selectedId}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                <option value="">— اختر مناقلة مُرسَلة —</option>
                {inTransitRows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.number ?? row.id.slice(0, 8)} — {money(row.amount)} {row.currency}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>🏦 من خزنة</span>
              <input className="input" value={selected?.fromName ?? '—'} readOnly />
            </label>
            <label className="field">
              <span>🏦 إلى خزنة</span>
              <input className="input" value={selected?.toName ?? '—'} readOnly />
            </label>
            <label className="field">
              <span>💰 المبلغ</span>
              <input className="input" dir="ltr" value={selected ? money(selected.amount) : '—'} readOnly />
            </label>
          </div>

          <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn"
              disabled={!selected}
              onClick={() => setPreview(!preview)}
            >
              👁️ عرض
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !canManage || !selected || selected.status !== 'sent'}
              onClick={() => selected && receive(selected.id)}
            >
              ✅ تأكيد الاستلام
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !canManage || inTransitRows.length === 0}
              onClick={receiveAll}
            >
              📦 استلام الكل ({inTransitRows.length})
            </button>
          </div>

          {!canManage ? (
            <p className="muted small" style={{ marginTop: 8 }}>
              تحتاج صلاحية <code>treasury.transfer.manage</code> لاعتماد الإرسال أو الاستلام.
            </p>
          ) : null}

          {preview && selected ? (
            <div className="doc-head" style={{ marginTop: 12 }}>
              <div className="doc-field">
                <span className="muted small">🔢 رقم المناقلة</span>
                <b dir="ltr">{selected.number ?? '—'}</b>
              </div>
              <div className="doc-field">
                <span className="muted small">📅 تاريخ الإرسال</span>
                <b>{selected.sentAt ? dateTime(selected.sentAt) : 'لم تُرسل بعد'}</b>
              </div>
              <div className="doc-field">
                <span className="muted small">🏦 من خزنة</span>
                <b>{selected.fromName ?? '—'}</b>
              </div>
              <div className="doc-field">
                <span className="muted small">🏦 إلى خزنة</span>
                <b>{selected.toName ?? '—'}</b>
              </div>
              <div className="doc-field">
                <span className="muted small">💰 المبلغ</span>
                <b dir="ltr">
                  {money(selected.amount)} {selected.currency}
                </b>
              </div>
              <div className="doc-field">
                <span className="muted small">📋 الحالة</span>
                <b>
                  <span className={`badge ${STATUS_TONE[selected.status] ?? ''}`}>
                    {STATUS_LABELS[selected.status] ?? selected.status}
                  </span>
                </b>
              </div>
              <div className="doc-field">
                <span className="muted small">📒 قيد الإرسال</span>
                <b dir="ltr">{selected.sentJournalEntryId ? selected.sentJournalEntryId.slice(0, 8) : '—'}</b>
              </div>
              <div className="doc-field">
                <span className="muted small">📒 قيد الاستلام</span>
                <b dir="ltr">{selected.receivedJournalEntryId ? selected.receivedJournalEntryId.slice(0, 8) : '—'}</b>
              </div>
            </div>
          ) : null}

          {inTransitRows.length === 0 ? (
            <p className="muted small" style={{ marginTop: 8 }}>
              لا توجد مناقلات في الطريق — ما أُرسل استُلم، وما لم يُرسل ما زال مسودة.
            </p>
          ) : null}
        </div>
      ) : null}

      {tab === 'search' ? (
        <FilterBar>
          <label className="field">
            <span>🔢 رقم التحويل</span>
            <input className="input" dir="ltr" value={numberQuery} onChange={(event) => setNumberQuery(event.target.value)} />
          </label>
          <label className="field">
            <span>📅 من تاريخ</span>
            <input className="input" type="date" value={from} onChange={(event) => setFrom(event.target.value)} disabled={allPeriod} />
          </label>
          <label className="field">
            <span>📅 إلى تاريخ</span>
            <input className="input" type="date" value={to} onChange={(event) => setTo(event.target.value)} disabled={allPeriod} />
          </label>
          <label className="field" style={{ justifyContent: 'center' }}>
            <span>📋 كل الفترة</span>
            <input type="checkbox" checked={allPeriod} onChange={(event) => setAllPeriod(event.target.checked)} />
          </label>
          <label className="field">
            <span>📋 الحالة</span>
            <select className="input" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="">الكل</option>
              <option value="draft">مسودة</option>
              <option value="sent">مُرسَلة</option>
              <option value="received">مُستلَمة</option>
              <option value="voided">مُلغاة</option>
            </select>
          </label>
          <button type="button" className="btn primary" onClick={() => setSearched(!searched)}>
            🔍 بحث
          </button>
        </FilterBar>
      ) : null}

      <div className="card">
        <div className="section-title">
          <h2>📊 نتائج البحث</h2>
          <span className="muted small">{rows.length} مناقلة</span>
        </div>
        <DataTable
          rows={rows}
          rowKey={(row) => row.id}
          columns={[
            { key: 'number', header: '🔢 الرقم', cell: (row) => row.number ?? '—' },
            { key: 'date', header: '📅 التاريخ', cell: (row) => dateTime(row.createdAt) },
            { key: 'from', header: '🏦 من خزنة', cell: (row) => row.fromName ?? '—' },
            { key: 'to', header: '🏦 إلى خزنة', cell: (row) => row.toName ?? '—' },
            { key: 'amount', header: '💰 المبلغ', align: 'num', cell: (row) => money(row.amount) },
            {
              key: 'status',
              header: '📋 الحالة',
              cell: (row) => <span className={`badge ${STATUS_TONE[row.status] ?? ''}`}>{STATUS_LABELS[row.status] ?? row.status}</span>,
            },
            {
              key: 'entry',
              header: '📒 القيد',
              cell: (row) =>
                row.sentJournalEntryId || row.receivedJournalEntryId ? (
                  <span className="muted small" dir="ltr">
                    {row.sentJournalEntryId ? '📤' : ''}
                    {row.receivedJournalEntryId ? '📥' : ''}
                  </span>
                ) : (
                  '—'
                ),
            },
            {
              key: 'actions',
              header: 'إجراء',
              cell: (row) => (
                <div className="row" style={{ gap: 6 }}>
                  {row.status === 'draft' ? (
                    <>
                      <button type="button" className="btn sm" disabled={busy || !canManage} onClick={() => send(row.id)}>
                        ✅ اعتماد الإرسال
                      </button>
                      <button type="button" className="btn sm" disabled={busy || !canManage} onClick={() => cancel(row.id)}>
                        🗑️ حذف
                      </button>
                    </>
                  ) : null}
                  {row.status === 'sent' ? (
                    <button type="button" className="btn sm" disabled={busy || !canManage} onClick={() => receive(row.id)}>
                      ✅ تأكيد الاستلام
                    </button>
                  ) : null}
                </div>
              ),
            },
          ]}
          footer={[
            <strong key="label">الإجمالي</strong>,
            '',
            '',
            '',
            <strong key="value">
              {money(
                rows
                  .reduce((running, row) => running + Number(row.amount ?? 0), 0)
                  .toFixed(4),
              )}
            </strong>,
            '',
            '',
            '',
          ]}
        />
      </div>
    </Screen>
  );
}
