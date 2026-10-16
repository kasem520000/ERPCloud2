'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useSession } from '@erp/web-core/session';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../components/screen';
import { useQuery } from '../../lib/use-query';
import { listAccounts, type Account } from '../../lib/accounting';
import {
  createAssetCategory,
  currentPeriod,
  isValidPeriod,
  listAssetCategories,
  listFixedAssets,
  nameOfCategory,
  previewMonthlyAmount,
  registerFixedAsset,
  runDepreciation,
  statusLabelOf,
  type DepreciationRunResult,
  type FixedAsset,
} from '../../lib/assets';

/**
 * M6.1 — 🏭 الأصول الثابتة: the register + categories + the monthly depreciation run.
 *
 * This is the accounting app's first writing surface (M3 was read-only by contract):
 *   • تصنيف جديد — `POST /asset-categories` (accounting.assets.manage);
 *   • تسجيل أصل — `POST /fixed-assets` (accounting.assets.manage);
 *   • تشغيل إهلاك الشهر — `POST /fixed-assets/depreciation-runs`
 *     (accounting.assets.depreciate) — قيد واحد متوازن عبر postJournalInTx.
 * Everything else (register, schedule, run ledger) stays read-only. The write forms
 * render only when the session holds the matching permission; the API enforces the
 * same guard regardless.
 */
export default function AssetsPage() {
  const { can } = useSession();
  const canManage = can('accounting.assets.manage');
  const canDepreciate = can('accounting.assets.depreciate');

  const [status, setStatus] = useState('');
  const assets = useQuery(() => listFixedAssets(status ? { status } : {}), [status]);
  const categories = useQuery(() => listAssetCategories(), []);
  const accounts = useQuery(() => listAccounts(), []);

  return (
    <Screen
      title="الأصول الثابتة"
      subtitle="سجل الأصول والتصنيفات وجدول الإهلاك — القسط الشهري بطريقة القسط الثابت، وترحيله قيدًا واحدًا متوازنًا"
      crumbs={['المحاسبة', 'الأصول الثابتة']}
      actions={
        <select className="input" style={{ width: 170 }} value={status} onChange={(event) => setStatus(event.target.value)} aria-label="الحالة">
          <option value="">كل الحالات</option>
          <option value="active">نشِط</option>
          <option value="fully_depreciated">مستوفى عمره</option>
          <option value="disposed">مُتخلَّص منه</option>
        </select>
      }
    >
      {canDepreciate ? <RunForm onDone={() => assets.reload()} /> : null}

      {assets.status === 'loading' ? <Loading rows={6} /> : null}
      {assets.status === 'forbidden' ? <Forbidden /> : null}
      {assets.status === 'error' ? <ErrorBox message={assets.error} onRetry={assets.reload} /> : null}
      {assets.status === 'success' && (assets.data ?? []).length === 0 ? (
        <Empty hint="لا توجد أصول مسجّلة بعد — أضِف تصنيفًا ثم سجّل أول أصل." />
      ) : null}
      {assets.status === 'success' && (assets.data ?? []).length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الرمز</th>
                <th>الأصل</th>
                <th>التصنيف</th>
                <th>تاريخ الاقتناء</th>
                <th className="num">التكلفة</th>
                <th className="num">الإنقاذ</th>
                <th className="num">العمر (شهر)</th>
                <th className="num">مجمع الإهلاك</th>
                <th className="num">القيمة الدفترية</th>
                <th>الحالة</th>
                <th>الجدول</th>
              </tr>
            </thead>
            <tbody>
              {(assets.data ?? []).map((asset: FixedAsset) => (
                <tr key={asset.id}>
                  <td >{asset.code}</td>
                  <td>{asset.nameAr ?? asset.name_ar ?? asset.code}</td>
                  <td className="muted small">{categoryNameOf(categories.data ?? [], asset)}</td>
                  <td>{(asset.acquisitionDate ?? asset.acquisition_date ?? '').slice(0, 10) || '—'}</td>
                  <td className="num">{fmt(asset.acquisitionCost ?? asset.acquisition_cost)}</td>
                  <td className="num">{fmt(asset.salvageValue ?? asset.salvage_value)}</td>
                  <td className="num">{asset.usefulLifeMonths ?? asset.useful_life_months ?? '—'}</td>
                  <td className="num">{fmt(asset.accumulatedDepreciation ?? asset.accumulated_depreciation)}</td>
                  <td className="num">{fmt(asset.netBookValue ?? asset.net_book_value)}</td>
                  <td>
                    <span className={`badge ${asset.status === 'active' ? 'posted' : 'draft'}`}>{statusLabelOf(asset)}</span>
                  </td>
                  <td>
                    <Link className="btn ghost sm" href={`/assets/${asset.id}`}>
                      الجدول
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {canManage ? <RegisterForm categories={categories.data ?? []} accounts={accounts.data ?? []} onDone={() => { assets.reload(); categories.reload(); }} /> : null}
      {canManage ? <CategoryForm accounts={accounts.data ?? []} onDone={() => categories.reload()} /> : null}

      <section className="card">
        <h2 className="m-0">التصنيفات</h2>
        <p className="muted small m-0">
          كل تصنيف يحمل العمر الافتراضي وحسابات الترحيل الثلاثة (الأصل / مجمع الإهلاك / مصروف الإهلاك) التي يورثها أصوله.
        </p>
        {categories.status === 'success' && (categories.data ?? []).length === 0 ? (
          <Empty hint="لا توجد تصنيفات بعد." />
        ) : null}
        {categories.status === 'success' && (categories.data ?? []).length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الرمز</th>
                  <th>التصنيف</th>
                  <th className="num">العمر الافتراضي (شهر)</th>
                  <th>حساب الأصل</th>
                  <th>مجمع الإهلاك</th>
                  <th>مصروف الإهلاك</th>
                </tr>
              </thead>
              <tbody>
                {(categories.data ?? []).map((category) => {
                  const byId = new Map((accounts.data ?? []).map((account: Account) => [account.id, account]));
                  return (
                    <tr key={category.id}>
                      <td >{category.code}</td>
                      <td>{nameOfCategory(category)}</td>
                      <td className="num">{category.defaultUsefulLifeMonths ?? category.default_useful_life_months ?? '—'}</td>
                      <td className="muted small">{accountLabel(byId.get(category.assetAccountId ?? category.asset_account_id ?? ''))}</td>
                      <td className="muted small">{accountLabel(byId.get(category.accumulatedAccountId ?? category.accumulated_account_id ?? ''))}</td>
                      <td className="muted small">{accountLabel(byId.get(category.depreciationAccountId ?? category.depreciation_account_id ?? ''))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────── تشغيل إهلاك الشهر

function RunForm({ onDone }: { onDone: () => void }) {
  const [period, setPeriod] = useState(currentPeriod());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<DepreciationRunResult | null>(null);

  const valid = isValidPeriod(period);

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const run = await runDepreciation({ period });
      setResult(run);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="m-0">تشغيل إهلاك الشهر</h2>
      <p className="muted small">
        قيد واحد متوازن لكل الشهر: مدين مصروف الإهلاك ودائن مجمعه، لكل أصل بلغ شهره. إعادة التشغيل للشهر نفسه لا تضيف شيئًا.
      </p>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <input
          className="input"
          style={{ width: 130 }}
          value={period}
          onChange={(event) => setPeriod(event.target.value)}
          placeholder="YYYY-MM"
          aria-label="الشهر"
          inputMode="numeric"
        />
        <button type="button" className="btn" disabled={busy || !valid} onClick={() => void submit()}>
          {busy ? 'جارٍ الترحيل…' : 'رحِّل إهلاك الشهر'}
        </button>
        {!valid ? <span className="muted small">صيغة الشهر: 2026-01</span> : null}
      </div>
      {error ? (
        <p className="small" role="alert" style={{ color: 'var(--danger, #b42318)', margin: '8px 0 0' }}>
          {error}
        </p>
      ) : null}
      {result ? <RunResult result={result} /> : null}
    </section>
  );
}

function RunResult({ result }: { result: DepreciationRunResult }) {
  const journalNumber = result.journalEntry?.number ?? result.journal_entry?.number ?? null;
  const totalText = result.totalDepreciation ?? result.total_depreciation ?? '0';
  return (
    <div role="status" style={{ marginTop: 10 }}>
      <p className="small m-0">
        <strong>{result.processed ?? 0}</strong> أصلًا أُهلك — إجمالي <strong>{fmt(totalText)}</strong>
        {journalNumber ? (
          <>
            {' '}
            عبر القيد <span >{String(journalNumber)}</span>
          </>
        ) : (
          ' — بلا قيد'
        )}
        .
      </p>
      {(result.skipped ?? []).length > 0 ? (
        <details style={{ marginTop: 6 }}>
          <summary className="small muted">الأصول المتخطاة ({(result.skipped ?? []).length})</summary>
          <ul className="small muted" style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
            {(result.skipped ?? []).map((row, index) => (
              <li key={`${row.code ?? index}`}>
                <span >{row.code ?? '—'}</span> — {row.reason ?? ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {(result.assets ?? []).length > 0 ? (
        <details style={{ marginTop: 6 }}>
          <summary className="small muted">تفصيل الأقساط ({(result.assets ?? []).length})</summary>
          <ul className="small muted" style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
            {(result.assets ?? []).map((row, index) => (
              <li key={`${row.code ?? index}`}>
                <span >{row.code ?? '—'}</span> — {fmt(row.amount)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────── تسجيل أصل جديد

function RegisterForm({
  categories,
  accounts,
  onDone,
}: {
  categories: Array<{ id: string; code: string }>;
  accounts: Account[];
  onDone: () => void;
}) {
  const [form, setForm] = useState({
    code: '',
    nameAr: '',
    categoryId: '',
    acquisitionDate: `${new Date().getFullYear()}-01-01`,
    acquisitionCost: '',
    salvageValue: '0',
    usefulLifeMonths: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const preview = useMemo(
    () => previewMonthlyAmount(form.acquisitionCost, form.salvageValue, Number(form.usefulLifeMonths)),
    [form.acquisitionCost, form.salvageValue, form.usefulLifeMonths],
  );

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError('');
    setOk('');
    try {
      const asset = await registerFixedAsset({
        code: form.code.trim(),
        nameAr: form.nameAr.trim(),
        categoryId: form.categoryId,
        acquisitionDate: form.acquisitionDate,
        acquisitionCost: form.acquisitionCost,
        salvageValue: form.salvageValue || '0',
        usefulLifeMonths: Number(form.usefulLifeMonths),
      });
      setOk(`سُجّل الأصل ${asset.code}.`);
      setForm((current) => ({ ...current, code: '', nameAr: '', acquisitionCost: '', usefulLifeMonths: '' }));
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const complete = form.code.trim() && form.nameAr.trim() && form.categoryId && form.acquisitionDate && form.acquisitionCost && Number(form.usefulLifeMonths) > 0;

  return (
    <section className="card">
      <h2 className="m-0">تسجيل أصل جديد</h2>
      <p className="muted small">شهر الاقتناء هو أول أشهر الإهلاك — لا تاريخ تشغيل منفصل.</p>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <label className="small">
          الرمز
          <input className="input" value={form.code} onChange={set('code')} placeholder="VAN-001" />
        </label>
        <label className="small">
          الاسم
          <input className="input" value={form.nameAr} onChange={set('nameAr')} placeholder="سيارة توزيع" />
        </label>
        <label className="small">
          التصنيف
          <select className="input" value={form.categoryId} onChange={set('categoryId')}>
            <option value="">— اختر تصنيفًا —</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.code}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          تاريخ الاقتناء
          <input className="input" type="date" value={form.acquisitionDate} onChange={set('acquisitionDate')} />
        </label>
        <label className="small">
          التكلفة
          <input className="input" inputMode="decimal" value={form.acquisitionCost} onChange={set('acquisitionCost')} placeholder="240000" />
        </label>
        <label className="small">
          قيمة الإنقاذ
          <input className="input" inputMode="decimal" value={form.salvageValue} onChange={set('salvageValue')} placeholder="0" />
        </label>
        <label className="small">
          العمر (شهر)
          <input className="input" inputMode="numeric" value={form.usefulLifeMonths} onChange={set('usefulLifeMonths')} placeholder="60" />
        </label>
      </div>
      <div className="row" style={{ marginTop: 8, gap: 8, alignItems: 'center' }}>
        <button type="button" className="btn" disabled={busy || !complete} onClick={() => void submit()}>
          {busy ? 'جارٍ التسجيل…' : 'سجِّل الأصل'}
        </button>
        {preview ? <span className="muted small">القسط الشهري التقديري: {fmt(preview)}</span> : null}
        {ok ? <span className="small" role="status">{ok}</span> : null}
      </div>
      {error ? (
        <p className="small" role="alert" style={{ color: 'var(--danger, #b42318)', margin: '8px 0 0' }}>
          {error}
        </p>
      ) : null}
      <p className="muted small" style={{ margin: '6px 0 0' }}>
        الحسابات ({accounts.length} متاحة) تُورَث من التصنيف — لا تُختار لكل أصل.
      </p>
    </section>
  );
}

// ─────────────────────────────────────────────────────────── تصنيف جديد

function CategoryForm({ accounts, onDone }: { accounts: Account[]; onDone: () => void }) {
  const postable = accounts.filter((account) => account.isPostable ?? account.is_postable ?? true);
  const [form, setForm] = useState({
    code: '',
    nameAr: '',
    defaultUsefulLifeMonths: '',
    assetAccountId: '',
    accumulatedAccountId: '',
    depreciationAccountId: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError('');
    setOk('');
    try {
      const category = await createAssetCategory({
        code: form.code.trim(),
        nameAr: form.nameAr.trim(),
        defaultUsefulLifeMonths: Number(form.defaultUsefulLifeMonths),
        ...(form.assetAccountId ? { assetAccountId: form.assetAccountId } : {}),
        ...(form.accumulatedAccountId ? { accumulatedAccountId: form.accumulatedAccountId } : {}),
        ...(form.depreciationAccountId ? { depreciationAccountId: form.depreciationAccountId } : {}),
      });
      setOk(`أُنشئ التصنيف ${category.code}.`);
      setForm((current) => ({ ...current, code: '', nameAr: '', defaultUsefulLifeMonths: '' }));
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const complete = form.code.trim() && form.nameAr.trim() && Number(form.defaultUsefulLifeMonths) > 0;

  return (
    <section className="card">
      <h2 className="m-0">تصنيف جديد</h2>
      <p className="muted small">العمر وحسابات الترحيل اختيارية هنا وتُكمَّل لاحقًا — لكن لا يعمل تشغيل الإهلاك قبل اكتمال الحسابات الثلاثة.</p>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <label className="small">
          الرمز
          <input className="input" value={form.code} onChange={set('code')} placeholder="VEHICLES" />
        </label>
        <label className="small">
          الاسم
          <input className="input" value={form.nameAr} onChange={set('nameAr')} placeholder="سيارات ومركبات" />
        </label>
        <label className="small">
          العمر الافتراضي (شهر)
          <input className="input" inputMode="numeric" value={form.defaultUsefulLifeMonths} onChange={set('defaultUsefulLifeMonths')} placeholder="60" />
        </label>
        <label className="small">
          حساب الأصل
          <select className="input" value={form.assetAccountId} onChange={set('assetAccountId')}>
            <option value="">— لاحقًا —</option>
            {postable.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} — {account.nameAr ?? account.name_ar ?? ''}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          حساب مجمع الإهلاك
          <select className="input" value={form.accumulatedAccountId} onChange={set('accumulatedAccountId')}>
            <option value="">— لاحقًا —</option>
            {postable.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} — {account.nameAr ?? account.name_ar ?? ''}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          حساب مصروف الإهلاك
          <select className="input" value={form.depreciationAccountId} onChange={set('depreciationAccountId')}>
            <option value="">— لاحقًا —</option>
            {postable.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} — {account.nameAr ?? account.name_ar ?? ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row" style={{ marginTop: 8, gap: 8, alignItems: 'center' }}>
        <button type="button" className="btn" disabled={busy || !complete} onClick={() => void submit()}>
          {busy ? 'جارٍ الإنشاء…' : 'أنشئ التصنيف'}
        </button>
        {ok ? <span className="small" role="status">{ok}</span> : null}
      </div>
      {error ? (
        <p className="small" role="alert" style={{ color: 'var(--danger, #b42318)', margin: '8px 0 0' }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── مساعدات

function categoryNameOf(categories: Array<{ id: string; code: string; nameAr?: string; name_ar?: string }>, asset: FixedAsset): string {
  const id = asset.categoryId ?? asset.category_id ?? '';
  return nameOfCategory(categories.find((category) => category.id === id) ?? { id, code: '—' });
}

function accountLabel(account?: Account): string {
  if (!account) return '—';
  return `${account.code} — ${account.nameAr ?? account.name_ar ?? ''}`;
}

function fmt(value?: string): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}
