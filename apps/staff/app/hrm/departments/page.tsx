'use client';

import { useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { apiDelete, apiList, apiPatch, apiPost, ApiError } from '../../../lib/api';
import { branchOptions, listBranches, type Branch } from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * 🏢 الإدارات والأقسام — `Form_WPF/frmManagement.xaml` («الإدارات») and
 * `Form_WPF/frmDepartments.xaml` («إدخال بيانات الإدارات والأقسام»).
 *
 * The two windows are one parent/child pair: `Managements(id, name)` above
 * `Departments(id, manag_id, name)`, and `frmDepartments.xaml.cs` joins them for its grid
 * (`SELECT d.id, m.id, m.name AS manag, d.name AS dep FROM Departments d INNER JOIN
 * Managements m ON d.manag_id = m.id`) — «اسم الإدارة التابع لها» beside every قسم.
 *
 * Saving a department refuses an empty name («يجب إدخال اسم القسم») and an empty إدارة
 * («يجب اختيار إدارة أولاً»); both sentences come back from the API unchanged. Deleting
 * an إدارة that still has أقسام is refused too — the desktop deletes the row and leaves
 * its departments pointing at a management that no longer exists.
 */
type Department = {
  id: string;
  code: string;
  name: string;
  branchId?: string | null;
  parentId?: string | null;
  kind?: 'management' | 'section';
  parentName?: string | null;
  employeeCount?: number;
  sectionCount?: number;
};

const BLANK = { id: '', code: '', name: '', branchId: '', parentId: '' };

export default function DepartmentsPage() {
  const { can } = useSession();
  const [managementForm, setManagementForm] = useState({ ...BLANK });
  const [sectionForm, setSectionForm] = useState({ ...BLANK });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  const departments = useQuery<Department[]>(() => apiList<Department>('/hrm/departments'), []);
  const branches = useQuery<Branch[]>(() => listBranches(), []);

  const rows = departments.data ?? [];
  const managements = rows.filter((row) => row.kind === 'management');
  const sections = rows.filter((row) => row.kind === 'section');
  const canManage = can('hrm.manage');

  const fail = (error: unknown) => {
    const caught = error instanceof ApiError ? error : undefined;
    setMessage({ kind: 'danger', text: caught ? `${caught.message}${caught.detail ? ` — ${caught.detail}` : ''}` : String(error) });
  };

  /** `frmManagement.xaml.cs` L120 — insert/update `Managements(name)`; the الرقم is the id. */
  const saveManagement = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(undefined);
    const body = { code: managementForm.code.trim(), name: managementForm.name.trim(), branchId: managementForm.branchId || null };
    try {
      if (managementForm.id) await apiPatch(`/hrm/departments/${managementForm.id}`, body);
      else await apiPost('/hrm/departments', body);
      setMessage({ kind: 'ok', text: '✅ تم الحفظ بنجاح' });
      setManagementForm({ ...BLANK });
      departments.reload();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  /** `frmDepartments.xaml.cs` L120 — a قسم is always saved under an إدارة. */
  const saveSection = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(undefined);
    const body = { code: sectionForm.code.trim(), name: sectionForm.name.trim(), branchId: sectionForm.branchId || null, parentId: sectionForm.parentId || null };
    try {
      if (sectionForm.id) await apiPatch(`/hrm/departments/${sectionForm.id}`, body);
      else await apiPost('/hrm/departments', body);
      setMessage({ kind: 'ok', text: '✅ تم الحفظ بنجاح' });
      setSectionForm({ ...BLANK });
      departments.reload();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: Department) => {
    if (!window.confirm(`⚠️ هل أنت متأكد من حذف ${row.kind === 'section' ? 'هذا القسم' : 'هذه الإدارة'}؟ — ${row.name}`)) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await apiDelete(`/hrm/departments/${row.id}`);
      setMessage({ kind: 'ok', text: '✅ تم الحذف بنجاح' });
      if (managementForm.id === row.id) setManagementForm({ ...BLANK });
      if (sectionForm.id === row.id) setSectionForm({ ...BLANK });
      departments.reload();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const branchField = (value: string, onChange: (next: string) => void) => (
    <label className="field">
      <span>الفرع</span>
      <select className="input" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">كل الفروع</option>
        {branchOptions(branches.data ?? []).map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Screen
      title="الإدارات والأقسام"
      subtitle={`${managements.length} إدارة · ${sections.length} قسم`}
      crumbs={['الموظفين والرواتب', 'التعاريف']}
      actions={
        <button className="btn" type="button" onClick={departments.reload} disabled={departments.status === 'loading'}>
          🔄 تحديث
        </button>
      }
    >
      {message && <p className={`alert ${message.kind}`}>{message.text}</p>}

      {departments.status === 'loading' && <Loading rows={3} />}
      {departments.status === 'forbidden' && <Forbidden />}
      {departments.status === 'error' && <ErrorBox message={departments.error} onRetry={departments.reload} />}

      {departments.status === 'success' && canManage && (
        <section className="card">
          <h2>الإدارات</h2>
          <form className="form-grid" onSubmit={saveManagement}>
            <label className="field">
              <span>الرقم *</span>
              <input className="input" dir="ltr" value={managementForm.code} onChange={(event) => setManagementForm({ ...managementForm, code: event.target.value })} required />
            </label>
            <label className="field">
              <span>اسم الإدارة *</span>
              <input className="input" value={managementForm.name} onChange={(event) => setManagementForm({ ...managementForm, name: event.target.value })} required />
            </label>
            {branchField(managementForm.branchId, (next) => setManagementForm({ ...managementForm, branchId: next }))}
            <div className="toolbar">
              <button className="btn primary" type="submit" disabled={busy}>
                {managementForm.id ? '✏️ تعديل' : '➕ إضافة إدارة جديدة'}
              </button>
              {managementForm.id && (
                <button className="btn" type="button" onClick={() => setManagementForm({ ...BLANK })}>
                  🆕 جديد
                </button>
              )}
            </div>
          </form>

          {managements.length === 0 ? (
            <Empty title="لا توجد إدارات" detail="الإدارة هي المستوى الأعلى الذي تُبنى عليه الأقسام." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الرقم</th>
                    <th>اسم الإدارة</th>
                    <th>الأقسام</th>
                    <th>الموظفون</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {managements.map((row) => (
                    <tr key={row.id}>
                      <td dir="ltr">{row.code}</td>
                      <td>{row.name}</td>
                      <td dir="ltr">{row.sectionCount ?? 0}</td>
                      <td dir="ltr">{row.employeeCount ?? 0}</td>
                      <td>
                        <button
                          className="btn small"
                          type="button"
                          onClick={() => setManagementForm({ id: row.id, code: row.code, name: row.name, branchId: row.branchId ?? '', parentId: '' })}
                        >
                          ✏️
                        </button>{' '}
                        <button className="btn small danger" type="button" disabled={busy} onClick={() => void remove(row)}>
                          🗑️
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {departments.status === 'success' && canManage && (
        <section className="card">
          <h2>الأقسام</h2>
          <form className="form-grid" onSubmit={saveSection}>
            <label className="field">
              <span>الرقم *</span>
              <input className="input" dir="ltr" value={sectionForm.code} onChange={(event) => setSectionForm({ ...sectionForm, code: event.target.value })} required />
            </label>
            <label className="field">
              <span>اسم القسم *</span>
              <input className="input" value={sectionForm.name} onChange={(event) => setSectionForm({ ...sectionForm, name: event.target.value })} required />
            </label>
            <label className="field">
              <span>اسم الإدارة التابع لها *</span>
              <select className="input" value={sectionForm.parentId} onChange={(event) => setSectionForm({ ...sectionForm, parentId: event.target.value })} required>
                <option value="">اختر الإدارة...</option>
                {managements.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
            {branchField(sectionForm.branchId, (next) => setSectionForm({ ...sectionForm, branchId: next }))}
            <div className="toolbar">
              <button className="btn primary" type="submit" disabled={busy}>
                {sectionForm.id ? '✏️ تعديل' : '💾 حفظ'}
              </button>
              {sectionForm.id && (
                <button className="btn" type="button" onClick={() => setSectionForm({ ...BLANK })}>
                  🆕 جديد
                </button>
              )}
            </div>
          </form>

          {sections.length === 0 ? (
            <Empty title="لا توجد أقسام" detail="القسم يُضاف تحت إدارة قائمة." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الرقم</th>
                    <th>اسم القسم</th>
                    <th>اسم الإدارة التابع لها</th>
                    <th>الموظفون</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sections.map((row) => (
                    <tr key={row.id}>
                      <td dir="ltr">{row.code}</td>
                      <td>{row.name}</td>
                      <td>{row.parentName ?? '—'}</td>
                      <td dir="ltr">{row.employeeCount ?? 0}</td>
                      <td>
                        <button
                          className="btn small"
                          type="button"
                          onClick={() => setSectionForm({ id: row.id, code: row.code, name: row.name, branchId: row.branchId ?? '', parentId: row.parentId ?? '' })}
                        >
                          ✏️
                        </button>{' '}
                        <button className="btn small danger" type="button" disabled={busy} onClick={() => void remove(row)}>
                          🗑️
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {departments.status === 'success' && !canManage && (
        <section className="card">
          {rows.length === 0 ? (
            <Empty title="لا توجد إدارات أو أقسام" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الرقم</th>
                    <th>الاسم</th>
                    <th>اسم الإدارة التابع لها</th>
                    <th>الموظفون</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td dir="ltr">{row.code}</td>
                      <td>{row.name}</td>
                      <td>{row.parentName ?? (row.kind === 'management' ? '— إدارة —' : '—')}</td>
                      <td dir="ltr">{row.employeeCount ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </Screen>
  );
}
