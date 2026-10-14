'use client';

import { useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { accountLabel, listAccounts, postableOf, type Account } from '../../../lib/accounts';
import { ApiError, apiList, apiPost } from '../../../lib/api';
import { branchOptions, listBranches, type Branch } from '../../../lib/lookups';
import { POSTING_ACCOUNT_LABELS, type PostingProfile } from '../../../lib/posting';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Profile = { id: string; branchId: string | null; docType: string; mapping: PostingProfile };

const DOC_TYPES: Array<{ id: string; label: string }> = [
  { id: '*', label: 'الافتراضي لكل المستندات' },
  { id: 'sales_invoice', label: 'فاتورة مبيعات' },
  { id: 'sales_return', label: 'مردود مبيعات' },
  { id: 'purchase_invoice', label: 'فاتورة مشتريات' },
  { id: 'purchase_return', label: 'مردود مشتريات' },
  { id: 'receipt_voucher', label: 'سند قبض' },
  { id: 'payment_voucher', label: 'سند صرف' },
  { id: 'payroll_run', label: 'مسيّر رواتب' },
  { id: 'progress_bill', label: 'مستخلص مشروع' },
  { id: 'rent_invoice', label: 'فاتورة تأجير' },
  // 🏭 الإنتاج (PHASE_E) — نوعا المستند الرسميان اللذان يربط عليهما المخبز/المصنع حسابَي المواد الخام والمنتج التام.
  { id: 'manufacturing_order', label: 'أمر تصنيع (BOM)' },
  { id: 'production_order', label: 'أمر إنتاج (مكوّنات)' },
];

const KEYS = Object.keys(POSTING_ACCOUNT_LABELS);

/**
 * الربط المحاسبي — the table that tells every document which accounts to hit.
 * Nothing posts without it: the API answers `ACCOUNT_PROFILE_MISSING` rather than guess
 * an account, so this screen is the prerequisite for sales, purchases and treasury.
 */
export default function PostingProfilesPage() {
  const { can } = useSession();
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const accounts = useQuery<Account[]>(() => listAccounts(), []);
  const profiles = useQuery<Profile[]>(() => apiList<Profile>('/branch-posting-profiles'), []);

  const [branchId, setBranchId] = useState('');
  const [docType, setDocType] = useState('*');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();

  const postable = (accounts.data ?? []).filter((account) => postableOf(account));
  const existing = (profiles.data ?? []).find((row) => (row.branchId ?? '') === branchId && row.docType === docType);
  const current: Record<string, string> = touched
    ? draft
    : Object.fromEntries(KEYS.map((key) => [key, String((existing?.mapping as Record<string, unknown> | undefined)?.[key] ?? '')]));

  async function save() {
    setBusy(true);
    setNotice(undefined);
    try {
      const mapping: Record<string, unknown> = { version: 1 };
      for (const key of KEYS) if (current[key]) mapping[key] = current[key];
      if (Object.keys(mapping).length === 1) throw new ApiError(422, 'VALIDATION_FAILED', 'حدّد حساباً واحداً على الأقل.');
      await apiPost('/branch-posting-profiles', { branchId: branchId || null, docType, mapping });
      setNotice({ kind: 'ok', text: 'تم حفظ الربط المحاسبي.' });
      setTouched(false);
      profiles.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="الربط المحاسبي"
      subtitle="أي حساب يستقبل كل نوع مستند. الفرع يتقدّم على الافتراضي العام، والمستند المحدد يتقدّم على «الافتراضي لكل المستندات»."
      crumbs={['الإعدادات', 'المحاسبة']}
    >
      <div className="card toolbar">
        <label className="field">
          <span>النطاق</span>
          <select
            className="input"
            value={branchId}
            onChange={(event) => {
              setBranchId(event.target.value);
              setTouched(false);
            }}
          >
            <option value="">افتراضي المنشأة (كل الفروع)</option>
            {branchOptions(branches.data ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>نوع المستند</span>
          <select
            className="input"
            value={docType}
            onChange={(event) => {
              setDocType(event.target.value);
              setTouched(false);
            }}
          >
            {DOC_TYPES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="card">
        <h2>{existing ? 'تعديل الربط' : 'ربط جديد'}</h2>
        <div className="form-grid">
          {KEYS.map((key) => (
            <label className="field" key={key}>
              <span>{POSTING_ACCOUNT_LABELS[key]}</span>
              <select
                className="input"
                value={current[key] ?? ''}
                disabled={!can('organization.postingprofile.manage')}
                onChange={(event) => {
                  setTouched(true);
                  setDraft({ ...current, [key]: event.target.value });
                }}
              >
                <option value="">— بدون —</option>
                {postable.map((account) => (
                  <option key={account.id} value={account.id}>
                    {accountLabel(account)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>

        <Notice notice={notice} />
        {can('organization.postingprofile.manage') ? (
          <button className="btn primary" type="button" disabled={busy} onClick={save}>
            {busy ? 'جارٍ الحفظ…' : 'حفظ الربط'}
          </button>
        ) : (
          <p className="muted">لا تملك صلاحية تعديل الربط المحاسبي.</p>
        )}
      </div>
    </Screen>
  );
}
