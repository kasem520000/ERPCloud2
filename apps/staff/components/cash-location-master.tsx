'use client';

import { useMemo, useState } from 'react';

import { accountLabel, listAccounts, postableOf, type Account } from '../lib/accounts';
import { ApiError, apiDelete, apiList, apiPatch, apiPost } from '../lib/api';
import {
  branchOptions,
  listBranches,
  listEmployees,
  type Branch,
  type Employee,
} from '../lib/lookups';
import { useSession } from '../lib/session';
import { useQuery } from '../lib/use-query';

import { ActionBar, DocField, DocHead, StatTile, StatTiles, Tabs } from './ui';
import { Screen } from './screen';
import { Notice, QueryView } from './data-view';

/**
 * 🏦 تعريف الخزن · 🏦 تعريف البنوك — one table, one screen shape, two masters.
 *
 * `Form_WPF/frmTreasury.xaml` (`Title="تعريف الخزن"`) is three group boxes sitting on
 * one card: `📋 بيانات الصناديق` (name, branch, status, ⭐ الافتراضي), `👤 مسئولي
 * الصندوق` (the employees who sign for it, stored in `Stock_Emps`), and `📝 ملاحظات`.
 * `frmBanks.xaml` is the same card for a bank, plus 🌍 الدولة، 🏙️ المدينة، 📍 المنطقة،
 * تليفون، موبايل، 💰 نسبة الاقتطاع % and ✅ تغيير في نقطة البيع.
 *
 * The save in `frmTreasury.xaml.cs:222` is the part worth keeping: it refuses a الصندوق
 * with no مسئول — «يجب اختيار موظف مسئول» — and replaces the whole responsible set
 * inside the treasury's own transaction. The API holds that rule, so the screen only has
 * to ask.
 */

export type CashLocation = {
  id: string;
  branchId: string;
  kind: 'safe' | 'bank';
  name: string;
  accountId?: string | null;
  currencyCode?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
  changeInPos?: boolean;
  notes?: string | null;
  custodianIds?: string[];
  version?: number;
  bank?: {
    bankName?: string;
    iban?: string;
    swift?: string;
    accountNo?: string;
    country?: string;
    city?: string;
    region?: string;
    phone?: string;
    mobile?: string;
    deductionPct?: string;
  } | null;
};

type Tab = 'data' | 'custodians' | 'notes';

const BLANK = {
  name: '',
  branchId: '',
  accountId: '',
  currency: 'SAR',
  isDefault: false,
  isActive: true,
  changeInPos: false,
  bankName: '',
  iban: '',
  swift: '',
  accountNo: '',
  country: '',
  city: '',
  region: '',
  phone: '',
  mobile: '',
  deductionPct: '',
};

export function CashLocationMaster({ kind }: { kind: 'safe' | 'bank' }) {
  const isBank = kind === 'bank';
  const { can } = useSession();
  const manage = can('organization.cashlocation.manage');

  const path = `/cash-locations?filter[kind]=${kind}&limit=200`;
  const locations = useQuery<CashLocation[]>(() => apiList<CashLocation>(path), [path]);
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const accounts = useQuery<Account[]>(() => listAccounts(), []);
  const employees = useQuery<Employee[]>(() => listEmployees(), []);

  const [tab, setTab] = useState<Tab>('data');
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState(BLANK);
  const [custodians, setCustodians] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  const rows = locations.data ?? [];
  const branchRows = branches.data ?? [];
  const accountRows = (accounts.data ?? []).filter((row) => postableOf(row));
  const employeeRows = employees.data ?? [];
  const selected = rows.find((row) => row.id === selectedId);
  const effectiveBranch = form.branchId || branchRows[0]?.id || '';
  const employeeName = (id: string) =>
    employeeRows.find((row) => row.id === id)?.name ?? id.slice(0, 8);

  const stats = useMemo(
    () => ({
      all: rows.length,
      active: rows.filter((row) => row.isActive !== false).length,
      closed: rows.filter((row) => row.isActive === false).length,
      unsigned: rows.filter((row) => (row.custodianIds ?? []).length === 0).length,
      defaultName: rows.find((row) => row.isDefault)?.name ?? '—',
    }),
    [rows],
  );

  const set = <K extends keyof typeof BLANK>(key: K, value: (typeof BLANK)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function run(action: () => Promise<unknown>, okText: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: okText });
      locations.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  function select(row: CashLocation) {
    setSelectedId(row.id);
    setCustodians(row.custodianIds ?? []);
    setNotes(row.notes ?? '');
  }

  const bankBlock = () =>
    isBank
      ? {
          bankName: form.bankName.trim(),
          iban: form.iban.trim() || undefined,
          swift: form.swift.trim() || undefined,
          accountNo: form.accountNo.trim() || undefined,
          country: form.country.trim() || undefined,
          city: form.city.trim() || undefined,
          region: form.region.trim() || undefined,
          phone: form.phone.trim() || undefined,
          mobile: form.mobile.trim() || undefined,
          deductionPct: form.deductionPct.trim() || undefined,
        }
      : null;

  async function create(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      await apiPost('/cash-locations', {
        branchId: effectiveBranch,
        kind,
        name: form.name.trim(),
        accountId: form.accountId || undefined,
        currencyCode: form.currency || undefined,
        isDefault: form.isDefault,
        isActive: form.isActive,
        changeInPos: isBank ? form.changeInPos : undefined,
        bank: bankBlock(),
        notes: notes.trim() || undefined,
        custodianIds: custodians,
      });
      setForm({ ...BLANK, branchId: form.branchId });
      setCustodians([]);
      setNotes('');
    }, isBank ? 'تم حفظ البنك.' : 'تم حفظ الخزينة.');
  }

  async function saveSelected() {
    if (!selected) return;
    await run(async () => {
      await apiPatch(`/cash-locations/${selected.id}`, {
        name: selected.name,
        branchId: selected.branchId,
        accountId: selected.accountId ?? undefined,
        isDefault: selected.isDefault,
        isActive: selected.isActive,
        custodianIds: custodians,
        notes: notes.trim() || null,
        version: selected.version,
      });
    }, 'تم حفظ التعديلات.');
  }

  return (
    <Screen
      title={isBank ? '🏦 تعريف البنوك' : '🏦 تعريف الخزينة'}
      subtitle={
        isBank
          ? '🏦 تعريف البنوك — كما في frmBanks: اسم البنك، الدولة والمدينة، الحساب والآيبان، ونسبة الاقتطاع.'
          : '🏦 تعريف الخزن — كما في frmTreasury: بيانات الصندوق، مسئولوه، وملاحظاته.'
      }
      crumbs={['الخزينة', 'تعاريف']}
    >
      <StatTiles>
        <StatTile label="📋 عدد الصناديق" value={stats.all} />
        <StatTile label="✅ نشط" value={stats.active} tone="ok" />
        <StatTile label="⛔ مغلق" value={stats.closed} tone="warn" />
        <StatTile label="⭐ الافتراضي" value={stats.defaultName} />
        <StatTile
          label="👤 بلا مسئول"
          value={stats.unsigned}
          hint={isBank ? 'مسموح للبنك' : 'الصندوق يحتاج مسئولاً'}
          tone={stats.unsigned > 0 && !isBank ? 'warn' : undefined}
        />
      </StatTiles>

      <Tabs
        items={[
          { id: 'data' as const, label: isBank ? '📋 بيانات البنوك' : '📋 بيانات الصناديق' },
          { id: 'custodians' as const, label: '👤 مسئولي الصندوق' },
          { id: 'notes' as const, label: '📝 ملاحظات' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'data' && (
        <form className="card" onSubmit={create}>
          <DocHead>
            <DocField label="🔢 الرقم">
              <span className="muted">تلقائي</span>
            </DocField>
            <DocField label={isBank ? '🏦 اسم البنك *' : '🏦 اسم الصندوق *'}>
              <input
                className="input"
                value={form.name}
                onChange={(event) => set('name', event.target.value)}
                required
              />
            </DocField>
            <DocField label="🏢 الفرع *">
              <select
                className="input"
                value={effectiveBranch}
                onChange={(event) => set('branchId', event.target.value)}
                required
              >
                {branchOptions(branchRows).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </DocField>
            <DocField label="📋 حالة الصندوق">
              <select
                className="input"
                value={form.isActive ? 'active' : 'closed'}
                onChange={(event) => set('isActive', event.target.value === 'active')}
              >
                <option value="active">نشط</option>
                <option value="closed">مغلق</option>
              </select>
            </DocField>
            <DocField label="⭐ الافتراضي">
              <label className="row">
                <input
                  type="checkbox"
                  checked={form.isDefault}
                  onChange={(event) => set('isDefault', event.target.checked)}
                />
                <span className="muted small">يجعله الصندوق الافتراضي لهذا النوع</span>
              </label>
            </DocField>
            <DocField label="💱 العملة">
              <select
                className="input"
                value={form.currency}
                onChange={(event) => set('currency', event.target.value)}
              >
                <option value="SAR">ريال سعودي</option>
                <option value="USD">دولار</option>
                <option value="YER">ريال يمني</option>
                <option value="EUR">يورو</option>
              </select>
            </DocField>
            <DocField label="🧾 الحساب المرتبط">
              <select
                className="input"
                value={form.accountId}
                onChange={(event) => set('accountId', event.target.value)}
              >
                <option value="">— بلا حساب —</option>
                {accountRows.map((account) => (
                  <option key={account.id} value={account.id}>
                    {accountLabel(account)}
                  </option>
                ))}
              </select>
            </DocField>
          </DocHead>

          {isBank && (
            <div className="card">
              <h4>🏦 بيانات البنك</h4>
              <div className="form-grid">
                <label className="field">
                  <span>🏦 اسم البنك *</span>
                  <input
                    className="input"
                    value={form.bankName}
                    onChange={(event) => set('bankName', event.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span>🔢 رقم الحساب</span>
                  <input
                    className="input"
                    dir="ltr"
                    value={form.accountNo}
                    onChange={(event) => set('accountNo', event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>🏦 الآيبان</span>
                  <input
                    className="input"
                    dir="ltr"
                    placeholder="SA0380000000608010167519"
                    value={form.iban}
                    onChange={(event) => set('iban', event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>🏦 سويفت</span>
                  <input
                    className="input"
                    dir="ltr"
                    value={form.swift}
                    onChange={(event) => set('swift', event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>🌍 الدولة</span>
                  <input
                    className="input"
                    value={form.country}
                    onChange={(event) => set('country', event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>🏙️ المدينة</span>
                  <input
                    className="input"
                    value={form.city}
                    onChange={(event) => set('city', event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>📍 المنطقة</span>
                  <input
                    className="input"
                    value={form.region}
                    onChange={(event) => set('region', event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>📞 تليفون</span>
                  <input
                    className="input"
                    dir="ltr"
                    value={form.phone}
                    onChange={(event) => set('phone', event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>📱 موبايل</span>
                  <input
                    className="input"
                    dir="ltr"
                    value={form.mobile}
                    onChange={(event) => set('mobile', event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>💰 نسبة الاقتطاع %</span>
                  <input
                    className="input"
                    dir="ltr"
                    inputMode="decimal"
                    placeholder="0"
                    value={form.deductionPct}
                    onChange={(event) => set('deductionPct', event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>✅ تغيير في نقطة البيع</span>
                  <label className="row">
                    <input
                      type="checkbox"
                      checked={form.changeInPos}
                      onChange={(event) => set('changeInPos', event.target.checked)}
                    />
                    <span className="muted small">يسمح للكاشير بأخذ الباقي منه</span>
                  </label>
                </label>
              </div>
            </div>
          )}

          <Notice notice={notice} />
          {manage && (
            <ActionBar>
              <button className="btn primary" type="submit" disabled={busy}>
                {busy ? 'جارٍ الحفظ…' : '💾 حفظ'}
              </button>
            </ActionBar>
          )}
        </form>
      )}

      {tab === 'custodians' && (
        <div className="card">
          <h4>👤 مسئولي الصندوق</h4>
          <label className="field">
            <span>{isBank ? '🏦 البنك' : '🏦 الصندوق'}</span>
            <select
              className="input"
              value={selectedId}
              onChange={(event) => {
                const next = rows.find((row) => row.id === event.target.value);
                if (next) select(next);
                else setSelectedId('');
              }}
            >
              <option value="">— اختر —</option>
              {rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <>
              <div className="form-grid">
                {employeeRows.map((employee) => (
                  <label className="row" key={employee.id}>
                    <input
                      type="checkbox"
                      checked={custodians.includes(employee.id)}
                      onChange={(event) =>
                        setCustodians((current) =>
                          event.target.checked
                            ? [...current, employee.id]
                            : current.filter((id) => id !== employee.id),
                        )
                      }
                    />
                    <span>
                      {employee.name}
                      <span className="muted small"> · {employee.employeeNo}</span>
                    </span>
                  </label>
                ))}
              </div>
              {employeeRows.length === 0 && <p className="muted">لا يوجد موظفون بعد.</p>}
              <Notice notice={notice} />
              {manage && (
                <ActionBar>
                  <button className="btn primary" type="button" disabled={busy} onClick={() => void saveSelected()}>
                    💾 حفظ المسئولين
                  </button>
                </ActionBar>
              )}
            </>
          ) : (
            <p className="muted">اختر صندوقاً لتحديد مسئوليه.</p>
          )}
        </div>
      )}

      {tab === 'notes' && (
        <div className="card">
          <h4>📝 ملاحظات</h4>
          <label className="field">
            <span>{isBank ? '🏦 البنك' : '🏦 الصندوق'}</span>
            <select
              className="input"
              value={selectedId}
              onChange={(event) => {
                const next = rows.find((row) => row.id === event.target.value);
                if (next) select(next);
                else setSelectedId('');
              }}
            >
              <option value="">— اختر —</option>
              {rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <>
              <label className="field">
                <span>📝 ملاحظات</span>
                <textarea
                  className="input"
                  rows={4}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                />
              </label>
              <Notice notice={notice} />
              {manage && (
                <ActionBar>
                  <button className="btn primary" type="button" disabled={busy} onClick={() => void saveSelected()}>
                    💾 حفظ الملاحظات
                  </button>
                </ActionBar>
              )}
            </>
          ) : (
            <p className="muted">اختر صندوقاً لكتابة ملاحظاته.</p>
          )}
        </div>
      )}

      <QueryView
        query={locations}
        isEmpty={() => rows.length === 0}
        empty={isBank ? 'لا توجد بنوك' : 'لا توجد صناديق'}
        emptyDetail={isBank ? 'أضف بنكاً لتبدأ.' : 'أضف صندوقاً لتبدأ.'}
      >
        {() => (
          <div className="table-wrap">
            <table className="zebra">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{isBank ? '🏦 اسم البنك' : '🏦 اسم الصندوق'}</th>
                  <th>🏢 الفرع</th>
                  <th>👤 الموظف المسئول</th>
                  <th>🧾 الحساب</th>
                  <th>📋 حالة الصندوق</th>
                  <th>⭐</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.id}>
                    <td className="num">{index + 1}</td>
                    <td>
                      <button className="btn sm" type="button" onClick={() => select(row)}>
                        {row.name}
                      </button>
                    </td>
                    <td>{branchRows.find((entry) => entry.id === row.branchId)?.nameAr ?? '—'}</td>
                    <td>
                      {(row.custodianIds ?? []).length
                        ? (row.custodianIds ?? []).map(employeeName).join(' · ')
                        : '—'}
                    </td>
                    <td>
                      {row.accountId
                        ? accountLabel(
                            (accounts.data ?? []).find((entry) => entry.id === row.accountId) ??
                              ({ id: row.accountId, code: '—' } as Account),
                          )
                        : '—'}
                    </td>
                    <td>
                      <span className="badge">{row.isActive === false ? 'مغلق' : 'نشط'}</span>
                    </td>
                    <td>{row.isDefault ? '⭐' : ''}</td>
                    <td>
                      {manage && !row.isDefault && (
                        <button
                          className="btn sm danger"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            run(
                              () => apiDelete(`/cash-locations/${row.id}`),
                              isBank ? 'تم حذف البنك.' : 'تم حذف الصندوق.',
                            )
                          }
                        >
                          🗑️
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryView>
    </Screen>
  );
}
