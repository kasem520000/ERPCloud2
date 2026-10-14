'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { apiDelete, apiFetch, apiList, apiPatch, apiPost } from '../../../lib/api';
import { listParties, type Party } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * ⚠️ المخالفات — `Form_WPF/frmViolationM.xaml` («المخالفات»).
 *
 * «⚠️ إدخال بيانات المخالفة»: 🔢 الرقم (`MAX(id) + 1`) · 📅 التاريخ · ⛵ المركب ·
 * ⚠️ نوع المخالفة · ⏱️ مدة المخالفة (يوم) · 📝 ملاحظة. والحفظ بثلاثة رفوض بترتيبها:
 * «يجب اختيار المركب» · «يجب تحديد مدة المخالفة» · «يجب تحديد نوع المخالفة».
 *
 * «⚠️ قائمة المخالفات»: الرقم · ⛵ المركب · الحالة · 📅 التاريخ · ⚠️ نوع المخالفة. وعند
 * الديسكتوب عمود «الحالة» مربوطٌ بالمدة (`Binding="{Binding period}"`) فيعرضها، و⛵ المركب
 * يُظهر رقم المركب لا اسمه؛ فأُصلح الاثنان: كل عمودٍ باسمه، والمدة تحت «⏱️ مدة المخالفة
 * (يوم)».
 *
 * الأزرار: «➕ جديد» · «💾 حفظ» · «🗑️ حذف» («اختر المخالفة ليتم حذفها» ثم «هل أنت متأكد
 * من حذف المخالفة؟») · «✖ خروج»؛ و«🖨️ طباعة» مؤجَّلة مع التقارير.
 */
type Violation = {
  id: string;
  number: string | null;
  vesselId: string | null;
  vesselName: string;
  partyId: string | null;
  customerName: string;
  violationDate: string;
  periodDays: string | null;
  violationType: string | null;
  amount: string;
  description: string;
  status: string;
  statusText: string;
  version: number;
};

type Draft = {
  id?: string;
  version?: number;
  vesselId: string;
  partyId: string;
  violationDate: string;
  violationType: string;
  periodDays: string;
  amount: string;
  description: string;
  status: string;
};

type Vessel = { id: string; code: string; name: string };
type Marina = { groups: Array<{ id: string; name: string }>; vessels: Vessel[] };

const today = () => new Date().toISOString().slice(0, 10);

const emptyDraft = (vesselId = ''): Draft => ({
  vesselId,
  partyId: '',
  violationDate: today(),
  violationType: '',
  periodDays: '1',
  amount: '0',
  description: '',
  status: 'open',
});

const draftOf = (violation: Violation): Draft => ({
  id: violation.id,
  version: violation.version,
  vesselId: violation.vesselId ?? '',
  partyId: violation.partyId ?? '',
  violationDate: violation.violationDate,
  violationType: violation.violationType ?? '',
  periodDays: violation.periodDays ? Number(violation.periodDays).toString() : '1',
  amount: violation.amount,
  description: violation.description,
  status: violation.status,
});

function MarinaViolations() {
  const { can } = useSession();
  const canManage = can('marina.manage');

  const [filters, setFilters] = useState({ type: '', from: '', to: '' });
  const [applied, setApplied] = useState<typeof filters | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const violations = useQuery<Violation[]>(() => {
    const params = new URLSearchParams();
    if (applied) {
      if (applied.type.trim()) params.set('type', applied.type.trim());
      if (applied.from) params.set('from', applied.from);
      if (applied.to) params.set('to', applied.to);
    }
    const query = params.toString();
    return apiList<Violation>(`/marina/violations${query ? `?${query}` : ''}`);
  }, [applied]);

  const marina = useQuery<Marina>(() => apiFetch<Marina>('/marina').then((body) => ((body as { data?: Marina }).data ?? body) as Marina), []);
  const parties = useQuery<Party[]>(() => listParties(), []);

  const rows = violations.data ?? [];
  const vessels = marina.data?.vessels ?? [];

  const setField = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        vesselId: draft.vesselId || undefined,
        partyId: draft.partyId || undefined,
        violationDate: draft.violationDate,
        violationType: draft.violationType,
        periodDays: draft.periodDays,
        amount: draft.amount || '0',
        description: draft.description,
        ...(draft.id ? { status: draft.status } : {}),
      };
      await (draft.id
        ? apiPatch(`/marina/violations/${draft.id}`, { ...payload, ...(draft.version ? { version: draft.version } : {}) })
        : apiPost('/marina/violations', payload));
      setNotice('تم الحفظ');
      setDraft(null);
      violations.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(violation: Violation) {
    if (!window.confirm(`هل أنت متأكد من حذف المخالفة؟\n\n${violation.number ?? ''} — ${violation.violationType ?? ''}`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiDelete(`/marina/violations/${violation.id}`);
      setNotice('تم الحذف');
      violations.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="⚠️ المخالفات"
      subtitle="مخالفةٌ على مركب: نوعها ومدتها بالأيام وتاريخها وملاحظتها. وحفظها لا يقبل مركباً بلا نوع، ولا نوعاً بلا مدة."
      crumbs={['إدارة المراسي', 'المخالفات']}
      actions={
        <div className="row" style={{ gap: 6 }}>
          <Link className="btn" href="/marina/bookings">
            ⛵ الحجوزات
          </Link>
          {canManage && (
            <button
              className="btn primary"
              type="button"
              onClick={() => {
                setError('');
                setNotice('');
                setDraft(emptyDraft(vessels[0]?.id ?? ''));
              }}
            >
              ➕ جديد
            </button>
          )}
        </div>
      }
    >
      {error && <p className="alert danger">{error}</p>}
      {notice && <p className="alert ok">{notice}</p>}

      <div className="card tight no-print">
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ margin: 0, minWidth: 180 }}>
            <span>⚠️ نوع المخالفة</span>
            <input className="input" value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value })} />
          </label>
          <label className="field" style={{ margin: 0, minWidth: 150 }}>
            <span>من تاريخ</span>
            <input className="input" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
          </label>
          <label className="field" style={{ margin: 0, minWidth: 150 }}>
            <span>إلى تاريخ</span>
            <input className="input" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
          </label>
          <button className="btn primary" type="button" onClick={() => setApplied(filters)}>
            🔍 بحث
          </button>
          {applied && (
            <button className="btn" type="button" onClick={() => { setFilters({ type: '', from: '', to: '' }); setApplied(null); }}>
              🗑️ تصفية الحقول
            </button>
          )}
        </div>
      </div>

      {violations.status === 'loading' && <Loading rows={5} />}
      {violations.status === 'forbidden' && <Forbidden />}
      {violations.status === 'error' && <ErrorBox message={violations.error} onRetry={violations.reload} />}
      {violations.status === 'success' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="group-label" style={{ margin: 0 }}>⚠️ قائمة المخالفات</span>
            <span className="muted">عدد السجلات: {rows.length}</span>
          </div>
          {rows.length === 0 ? (
            <Empty title="لا توجد مخالفات" detail="ابدأ بـ «➕ جديد»: مركب، ونوع، ومدة بالأيام." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>🔢 الرقم</th>
                    <th>⛵ المركب</th>
                    <th>الحالة</th>
                    <th>📅 التاريخ</th>
                    <th>⚠️ نوع المخالفة</th>
                    <th className="num">⏱️ مدة المخالفة (يوم)</th>
                    <th>📝 ملاحظة</th>
                    {canManage && <th>إجراءات</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} onDoubleClick={() => canManage && setDraft(draftOf(row))}>
                      <td dir="ltr">{row.number ?? '—'}</td>
                      <td>{row.vesselName || '—'}</td>
                      <td>
                        <span className={`badge${row.statusText === 'مفتوحة' ? '' : ' danger'}`}>{row.statusText}</span>
                      </td>
                      <td dir="ltr">{row.violationDate}</td>
                      <td>{row.violationType ?? '—'}</td>
                      <td className="num" dir="ltr">{row.periodDays ? Number(row.periodDays).toString() : '—'}</td>
                      <td>{row.description || '—'}</td>
                      {canManage && (
                        <td>
                          <div className="row" style={{ gap: 4 }}>
                            <button className="btn sm" type="button" onClick={() => setDraft(draftOf(row))}>
                              ✏️ تعديل
                            </button>
                            <button className="btn sm danger" type="button" onClick={() => remove(row)}>
                              🗑️ حذف
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {draft && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 620 }}>
            <div className="modal-head">
              <span className="modal-title">{draft.id ? '✏️ تعديل المخالفة' : '⚠️ إدخال بيانات المخالفة'}</span>
              <button className="btn sm" type="button" onClick={() => setDraft(null)}>
                ✖ خروج
              </button>
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 12 }}>
              <div className="form-grid">
                <label className="field">
                  <span>🔢 الرقم</span>
                  <input className="input" value={draft.id ? 'محفوظ' : 'يُصدر عند الحفظ'} disabled />
                </label>
                <label className="field">
                  <span>📅 التاريخ</span>
                  <input className="input" type="date" value={draft.violationDate} onChange={(event) => setField({ violationDate: event.target.value })} />
                </label>
                <label className="field">
                  <span>⛵ المركب *</span>
                  <select className="input" value={draft.vesselId} onChange={(event) => setField({ vesselId: event.target.value })}>
                    <option value="">— اختر مركباً —</option>
                    {vessels.map((vessel) => (
                      <option key={vessel.id} value={vessel.id}>{vessel.code} — {vessel.name}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>👤 العميل</span>
                  <select className="input" value={draft.partyId} onChange={(event) => setField({ partyId: event.target.value })}>
                    <option value="">— بلا عميل —</option>
                    {(parties.data ?? []).map((party) => (
                      <option key={party.id} value={party.id}>{party.name}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>⚠️ نوع المخالفة *</span>
                  <input className="input" value={draft.violationType} onChange={(event) => setField({ violationType: event.target.value })} />
                </label>
                <label className="field">
                  <span>⏱️ مدة المخالفة (يوم) *</span>
                  <input className="input numeric" value={draft.periodDays} onChange={(event) => setField({ periodDays: event.target.value })} />
                </label>
                <label className="field">
                  <span>💰 القيمة</span>
                  <input className="input numeric" value={draft.amount} onChange={(event) => setField({ amount: event.target.value })} />
                </label>
                {draft.id && (
                  <label className="field">
                    <span>الحالة</span>
                    <select className="input" value={draft.status} onChange={(event) => setField({ status: event.target.value })}>
                      <option value="open">مفتوحة</option>
                      <option value="closed">مغلقة</option>
                    </select>
                  </label>
                )}
              </div>
              <label className="field">
                <span>📝 ملاحظة</span>
                <textarea className="input" rows={2} value={draft.description} onChange={(event) => setField({ description: event.target.value })} />
              </label>
            </div>
            <div className="modal-foot">
              <button className="btn primary" type="button" onClick={() => void save()} disabled={busy}>
                💾 حفظ
              </button>
              <button className="btn" type="button" disabled={busy} onClick={() => setDraft(emptyDraft(draft.vesselId))}>
                🔄 جديد
              </button>
              <button className="btn danger" type="button" onClick={() => setDraft(null)} disabled={busy}>
                ✖ خروج
              </button>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading rows={5} />}>
      <MarinaViolations />
    </Suspense>
  );
}
