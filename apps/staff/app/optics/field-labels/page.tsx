'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';

import { ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { apiData, apiPut } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * ⚙️ أسماء الحقول — the second tab of `Form_WPF/frmGlasses.xaml`
 * («👓 بيانات النظارات»).
 *
 * The ten boxes of «👓  القياسات» are not named in the markup: `loadNameLbl` reads them
 * at runtime — `select isnull(L1,'LE-SPH') … isnull(R5,'RE-IPD') from Other_Column` — so
 * what is typed here is what the optician sees beside every number.
 *
 * The window is two columns and one save:
 *
 *   • «R (Right)» — «حقل 1» … «حقل 5», written to `R1` … `R5`.
 *   • «L (Left)» — «حقل 6» … «حقل 10», written to `L1` … `L5`. The left eye is the
 *     **second** half of the row, which is why حقل 6 is `L1`.
 *   • «💾 حفظ الأسماء» — `insertglasses()`: `delete from Other_Column` then
 *     `insert into Other_Column (R1,R2,R3,R4,R5,L1,L2,L3,L4,L5)`, then
 *     «تم الحفظ بنجاح». The row is replaced, never patched: a box left blank is a name
 *     given up, and the default answers in its place.
 *   • «✖ خروج» — back to 👓 بيانات النظارات.
 */
type FieldLabels = {
  id: string | null;
  r1: string;
  r2: string;
  r3: string;
  r4: string;
  r5: string;
  l1: string;
  l2: string;
  l3: string;
  l4: string;
  l5: string;
  right: Array<{ key: string; label: string }>;
  left: Array<{ key: string; label: string }>;
  fields: Array<{ slot: string; index: number; key: string; side: 'R' | 'L'; label: string; placeholder: string }>;
  version: number | null;
};

type Draft = Record<string, string>;

const SLOTS = ['r1', 'r2', 'r3', 'r4', 'r5', 'l1', 'l2', 'l3', 'l4', 'l5'] as const;
const SLOT_NAMES: Record<string, string> = {
  r1: 'R1',
  r2: 'R2',
  r3: 'R3',
  r4: 'R4',
  r5: 'R5',
  l1: 'L1',
  l2: 'L2',
  l3: 'L3',
  l4: 'L4',
  l5: 'L5',
};

const draftOf = (labels: FieldLabels): Draft =>
  Object.fromEntries(SLOTS.map((slot) => [slot, labels[slot] ?? '']));

function OpticsFieldLabels() {
  const { can } = useSession();
  const canManage = can('optics.manage');

  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const labels = useQuery<FieldLabels>(() => apiData<FieldLabels>('/optics/field-labels'), []);
  const rows = labels.data;

  /** «💾 حفظ الأسماء» — `loadcolumnOther` is what the window shows when it opens again. */
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await apiPut<FieldLabels>('/optics/field-labels', draft);
      setNotice('تم الحفظ بنجاح');
      setDraft(draftOf(saved));
      labels.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const value = (slot: string): string =>
    draft?.[slot] ?? (rows?.[slot as keyof FieldLabels] as string) ?? '';

  const set = (slot: string, next: string) =>
    setDraft((current) => ({ ...(current ?? draftOf(rows as FieldLabels)), [slot]: next }));

  return (
    <Screen
      title="⚙️ أسماء الحقول"
      subtitle="ما يُكتب بجانب كل رقم في «👓 القياسات»: عشرة أسماء، خمسة لليمين وخمسة لليسار. والصندوق الفارغ يُقرأ باسمه الأصلي — «RE-SPH» … «LE-IPD»."
      crumbs={['النظارات', 'أسماء الحقول']}
      actions={
        <div className="row" style={{ gap: 6 }}>
          <Link className="btn" href="/optics/prescriptions">
            👓 بيانات النظارات
          </Link>
          {canManage && rows && draft && (
            <button
              className="btn primary"
              type="button"
              disabled={busy}
              onClick={() => void save()}
            >
              💾 حفظ الأسماء
            </button>
          )}
        </div>
      }
    >
      {error && <p className="alert danger">{error}</p>}
      {notice && <p className="alert ok">{notice}</p>}

      {labels.status === 'loading' && <Loading rows={6} />}
      {labels.status === 'forbidden' && <Forbidden />}
      {labels.status === 'error' && <ErrorBox message={labels.error} onRetry={labels.reload} />}
      {labels.status === 'success' && rows && (
        <form
          className="card tight"
          onSubmit={(event) => {
            event.preventDefault();
            if (canManage) void save();
          }}
        >
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="group-label" style={{ margin: 0 }}>⚙️ أسماء الحقول</span>
            {canManage ? (
              <span className="muted"> عدّل ما شئت ثم «💾 حفظ الأسماء»</span>
            ) : (
              <span className="muted">للقراءة فقط</span>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            {(['R', 'L'] as const).map((side) => (
              <fieldset key={side} className="card tight" style={{ margin: 0 }}>
                <legend className="group-label" style={{ margin: 0 }}>
                  {side === 'R' ? '🔴 R (Right)' : '🟢 L (Left)'}
                </legend>
                <div style={{ display: 'grid', gap: 10 }}>
                  {SLOTS.filter((slot) => slot.startsWith(side.toLowerCase())).map((slot) => {
                    const index = SLOTS.indexOf(slot) + 1;
                    return (
                      <label key={slot} className="field" style={{ margin: 0 }}>
                        {/* «حقل 1» … «حقل 10» — `frmGlasses.xaml` names the boxes this way. */}
                        <span>
                          حقل {index} <span className="muted" dir="ltr">({SLOT_NAMES[slot]})</span>
                        </span>
                        <input
                          className="input"
                          value={value(slot)}
                          disabled={!canManage}
                          placeholder={rows.fields.find((field) => field.slot === slot)?.placeholder ?? `حقل ${index}`}
                          onChange={(event) => set(slot, event.target.value)}
                        />
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>

          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            {canManage && (
              <button className="btn primary" type="submit" disabled={busy}>
                💾 حفظ الأسماء
              </button>
            )}
            {draft && (
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setNotice('');
                }}
              >
                ↩️ إلغاء
              </button>
            )}
            <Link className="btn danger" href="/optics/prescriptions">
              ✖ خروج
            </Link>
          </div>

          <p className="muted" style={{ marginBottom: 0 }}>
            حقل 1…5 هي العين اليمنى (R1…R5) وحقل 6…10 هي العين اليسرى (L1…L5) — بترتيب
            «💾 حفظ الأسماء» نفسه في الديسكتوب.
          </p>
        </form>
      )}
    </Screen>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading rows={6} />}>
      <OpticsFieldLabels />
    </Suspense>
  );
}
