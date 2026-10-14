'use client';

import { useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { apiData, apiDelete, apiPatch, apiPost, ApiError } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * 🗂️ إدارة الفترات المحاسبية — `Form_WPF/FrmAccountingPeriods.xaml`.
 *
 * The window is one card above one grid. The card is
 * `رقم الفترة:` (read-only) · `اسم الفترة:` · `تاريخ من:` · `تاريخ إلى:` ·
 * `✔️ فترة نشطة حالياً` · `ملاحظات:`; the action bar is
 * `➕ إضافة · ✏️ تعديل · ⚡ تفعيل · 🔒 إغلاق الفترة · 🔓 إعادة فتح · 🆕 جديد · 🗑️ حذف ·
 * 🔄 تحديث`; and the grid is
 * `الرقم · اسم الفترة · تاريخ البداية · تاريخ النهاية · نشطة · مغلقة · أغلقت بواسطة ·
 * تاريخ الإغلاق · ملاحظات`. The header carries `الفترة النشطة: …` or «لا توجد فترة نشطة».
 *
 * `Class/AccountingPeriodManager.cs` is every statement behind it, and the refusals the
 * operator sees here are that class's own sentences.
 */
type Period = {
  id: string;
  number: number;
  name: string;
  startDate: string;
  endDate: string;
  status: string;
  isActive: boolean;
  notes: string | null;
  closedBy: string | null;
  closedByName: string | null;
  closedAt: string | null;
  yearName: string | null;
};

type FiscalYear = { id: string; name: string; startDate: string; endDate: string; status: string };

const EMPTY_FORM = { id: '', name: '', startDate: '', endDate: '', isActive: false, notes: '' };

const firstOfYear = `${new Date().getFullYear()}-01-01`;
const lastOfYear = `${new Date().getFullYear()}-12-31`;

const stamp = (value: string | null) => (value ? new Date(value).toLocaleString('ar-SA') : '—');

export default function FiscalPeriodsPage() {
  const { can } = useSession();
  const periods = useQuery<Period[]>(() => apiData<Period[]>('/fiscal-periods'), []);
  const years = useQuery<FiscalYear[]>(() => apiData<FiscalYear[]>('/fiscal-years'), []);

  const [form, setForm] = useState({ ...EMPTY_FORM, startDate: firstOfYear, endDate: lastOfYear });
  const [busy, setBusy] = useState<string | undefined>();
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  const rows = periods.data ?? [];
  const active = rows.find((row) => row.isActive);
  const canManage = can('accounting.period.close');
  const editing = form.id !== '';

  const reload = () => {
    periods.reload();
    years.reload();
  };

  const fail = (error: unknown) => {
    const caught = error instanceof ApiError ? error : undefined;
    setMessage({ kind: 'danger', text: caught ? `${caught.message}${caught.detail ? ` — ${caught.detail}` : ''}` : String(error) });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy('form');
    setMessage(undefined);
    try {
      const body = {
        name: form.name,
        startDate: form.startDate,
        endDate: form.endDate,
        isActive: form.isActive,
        notes: form.notes || null,
      };
      if (editing) await apiPatch(`/fiscal-periods/${form.id}`, body);
      else await apiPost('/fiscal-periods', body);
      setMessage({ kind: 'ok', text: editing ? 'تم تحديث الفترة المحاسبية بنجاح' : 'تم إضافة الفترة المحاسبية بنجاح' });
      setForm({ ...EMPTY_FORM, startDate: firstOfYear, endDate: lastOfYear });
      reload();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(undefined);
    }
  };

  const act = async (period: Period, action: 'activate' | 'close' | 'reopen' | 'delete') => {
    setBusy(period.id);
    setMessage(undefined);
    try {
      if (action === 'activate') await apiPost(`/fiscal-periods/${period.id}/activate`, {});
      else if (action === 'close') {
        // «هل أنت متأكد من إغلاق الفترة المحاسبية '…'? بعد الإغلاق لن تستطيع إدخال أي
        // عمليات جديدة في هذه الفترة» — the window's own confirmation.
        if (!window.confirm(`هل أنت متأكد من إغلاق الفترة المحاسبية «${period.name}»؟`)) {
          setBusy(undefined);
          return;
        }
        await apiPost(`/fiscal-periods/${period.id}/close`, {});
      } else if (action === 'reopen') {
        const reason = window.prompt('سبب إعادة الفتح (إلزامي):');
        if (!reason) {
          setBusy(undefined);
          return;
        }
        await apiPost(`/fiscal-periods/${period.id}/reopen`, { reason });
      } else {
        if (!window.confirm(`هل أنت متأكد من حذف الفترة المحاسبية «${period.name}»؟`)) {
          setBusy(undefined);
          return;
        }
        await apiDelete(`/fiscal-periods/${period.id}`);
      }
      setMessage({
        kind: 'ok',
        text:
          action === 'activate'
            ? 'تم تفعيل الفترة المحاسبية بنجاح'
            : action === 'close'
              ? 'تم إغلاق الفترة المحاسبية بنجاح'
              : action === 'reopen'
                ? 'تم إعادة فتح الفترة المحاسبية بنجاح'
                : 'تم حذف الفترة المحاسبية بنجاح',
      });
      if (form.id === period.id) setForm({ ...EMPTY_FORM, startDate: firstOfYear, endDate: lastOfYear });
      reload();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Screen
      title="إدارة الفترات المحاسبية"
      subtitle={
        active
          ? `الفترة النشطة: ${active.name} (${active.startDate} - ${active.endDate})`
          : 'لا توجد فترة نشطة'
      }
      crumbs={['المحاسبة', 'العمليات']}
      actions={
        <>
          <button className="btn" type="button" onClick={reload} disabled={periods.status === 'loading'}>
            🔄 تحديث
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => setForm({ ...EMPTY_FORM, startDate: firstOfYear, endDate: lastOfYear })}
          >
            🆕 جديد
          </button>
        </>
      }
    >
      {message && <p className={`alert ${message.kind}`}>{message.text}</p>}

      <section className="card">
        <h2>{editing ? `✏️ تعديل — ${form.name}` : '➕ إضافة فترة محاسبية'}</h2>
        <form className="form-grid" onSubmit={submit}>
          <label className="field">
            <span>رقم الفترة</span>
            <input className="input" value={form.id ? String(rows.find((row) => row.id === form.id)?.number ?? '') : ''} readOnly placeholder="—" />
          </label>
          <label className="field">
            <span>اسم الفترة *</span>
            <input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
          </label>
          <label className="field">
            <span>تاريخ من *</span>
            <input className="input" type="date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} required />
          </label>
          <label className="field">
            <span>تاريخ إلى *</span>
            <input className="input" type="date" value={form.endDate} onChange={(event) => setForm({ ...form, endDate: event.target.value })} required />
          </label>
          <label className="field">
            <span>ملاحظات</span>
            <input className="input" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
          </label>
          <label className="check" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} />
            ✔️ فترة نشطة حالياً
          </label>
          {canManage && (
            <div className="toolbar">
              <button className="btn primary" type="submit" disabled={busy === 'form'}>
                {busy === 'form' ? '…' : editing ? '✏️ تعديل' : '➕ إضافة'}
              </button>
              {editing && (
                <button className="btn" type="button" onClick={() => setForm({ ...EMPTY_FORM, startDate: firstOfYear, endDate: lastOfYear })}>
                  إلغاء
                </button>
              )}
            </div>
          )}
        </form>
      </section>

      <section className="card">
        <h2>الفترات المحاسبية</h2>
        {periods.status === 'loading' && <Loading rows={3} />}
        {periods.status === 'forbidden' && <Forbidden />}
        {periods.status === 'error' && <ErrorBox message={periods.error} onRetry={periods.reload} />}
        {periods.status === 'success' &&
          (rows.length === 0 ? (
            <Empty title="لا توجد فترات محاسبية" detail="أنشئ فترة ليُعرف أين تُرحَّل القيود." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الرقم</th>
                    <th>اسم الفترة</th>
                    <th>السنة</th>
                    <th>تاريخ البداية</th>
                    <th>تاريخ النهاية</th>
                    <th>نشطة</th>
                    <th>مغلقة</th>
                    <th>أغلقت بواسطة</th>
                    <th>تاريخ الإغلاق</th>
                    <th>ملاحظات</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((period) => (
                    <tr key={period.id}>
                      <td dir="ltr">{period.number}</td>
                      <td>{period.name}</td>
                      <td dir="ltr">{period.yearName ?? '—'}</td>
                      <td dir="ltr">{period.startDate}</td>
                      <td dir="ltr">{period.endDate}</td>
                      <td>{period.isActive ? '✔️' : '—'}</td>
                      <td>{period.status === 'closed' ? '🔒' : '—'}</td>
                      <td>{period.closedByName ?? '—'}</td>
                      <td dir="ltr">{stamp(period.closedAt)}</td>
                      <td>{period.notes ?? '—'}</td>
                      <td>
                        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                          {canManage && period.status !== 'closed' && (
                            <>
                              <button
                                className="btn sm"
                                type="button"
                                disabled={busy === period.id}
                                onClick={() => {
                                  setForm({
                                    id: period.id,
                                    name: period.name,
                                    startDate: period.startDate,
                                    endDate: period.endDate,
                                    isActive: period.isActive,
                                    notes: period.notes ?? '',
                                  });
                                }}
                              >
                                ✏️ تعديل
                              </button>
                              {!period.isActive && (
                                <button className="btn sm" type="button" disabled={busy === period.id} onClick={() => void act(period, 'activate')}>
                                  ⚡ تفعيل
                                </button>
                              )}
                              <button className="btn sm" type="button" disabled={busy === period.id} onClick={() => void act(period, 'close')}>
                                🔒 إغلاق الفترة
                              </button>
                              <button className="btn sm" type="button" disabled={busy === period.id} onClick={() => void act(period, 'delete')}>
                                🗑️ حذف
                              </button>
                            </>
                          )}
                          {can('accounting.period.reopen') && period.status === 'closed' && (
                            <button className="btn sm" type="button" disabled={busy === period.id} onClick={() => void act(period, 'reopen')}>
                              🔓 إعادة فتح
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </section>

      <section className="card">
        <h2>السنوات المالية</h2>
        {years.status === 'loading' && <Loading rows={2} />}
        {years.status === 'success' &&
          ((years.data ?? []).length === 0 ? (
            <p className="muted">لا توجد سنة مالية بعد — أضف فترة لتبدأ، وستُفتح سنتها وحدها.</p>
          ) : (
            <div className="table-wrap" style={{ maxHeight: 240 }}>
              <table>
                <thead>
                  <tr>
                    <th>الاسم</th>
                    <th>من</th>
                    <th>إلى</th>
                    <th>الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {(years.data ?? []).map((year) => (
                    <tr key={year.id}>
                      <td>{year.name}</td>
                      <td dir="ltr">{year.startDate}</td>
                      <td dir="ltr">{year.endDate}</td>
                      <td>
                        <span className={`badge ${year.status === 'open' ? 'active' : ''}`}>{year.status === 'open' ? 'مفتوحة' : 'مغلقة'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </section>
    </Screen>
  );
}
