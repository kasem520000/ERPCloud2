'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { PermissionDto, PlatformDirectoryUser, PlatformRoleMatrixEntry } from '@erp/contracts';

import { Empty, ErrorBox, Loading, Screen } from '../../components/screen';
import { ApiError, apiData, apiPut } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useQuery } from '../../lib/use-query';

/**
 * مصفوفة الأدوار — `/roles` (P-C3 «الهوية والوصول على المنصة»).
 *
 * The plan calls for «الأدوار الخمسة × رموز console.*». Two things make that matrix real
 * rather than decorative:
 *
 *  1. **The write is a whole role, with a reason.** `PUT /platform/roles/:code/permissions`
 *     replaces one role's set, demands «السبب», and records the difference — what was added
 *     and what was removed — in the platform audit trail.
 *  2. **The API enforces it immediately.** The guard reads the same store this screen writes
 *     (`PlatformRolePermissionsService`), so unchecking `console.audit.view` from
 *     «تشغيل المنصة» closes that door on the next request, not on the next login.
 *
 * The catalogue column is drawn from `GET /platform/permissions` (the registry) and the
 * catalogue *default* comes with each role, so an operator can always see what the code says
 * and what was overridden — and restore it with one button.
 *
 * Labels kept verbatim from the pre-P-C3 console: «أدوار المنصة» · «الرمز» · «الوصف» ·
 * «الحائزون» · «صلاحيات» · the five role names. New ones («الفهرس» · «تجاوز» ·
 * «إرجاع إلى الفهرس» · «حفظ بسببه») are justified in the part document.
 */

type Draft = Record<string, string[]>;

const CONSOLE_PERM_AR: Record<string, string> = {
  'console.tenants.view': 'عرض العملاء والمنشآت',
  'console.tenants.manage': 'إدارة العملاء والتعليق والتفعيل',
  'console.plans.manage': 'إدارة الخطط والتراخيص والاشتراكات',
  'console.users.view': 'عرض دليل المستخدمين والجلسات',
  'console.users.manage': 'إدارة المستخدمين وأدوار المنصة و2FA',
  'console.audit.view': 'عرض سجل التدقيق العابر للمنشآت',
  'console.settings.manage': 'إدارة إعدادات المنصة والرايات والحدود',
  'console.support.manage': 'مكتب الدعم الفني والدخول المؤقّت',
  'console.email.manage': 'إدارة البريد والقوالب والحملات',
  'console.jobs.manage': 'إدارة المهام والطوابير والنسخ الاحتياطية',
  'console.analytics.view': 'عرض تحليلات الإيرادات والـ MRR والتسرّب',
  'console.developer.manage': 'إدارة مفاتيح API والويبهوك',
  'console.compliance.manage': 'إدارة الامتثال وطلبات البيانات',
  'console.content.manage': 'إدارة المحتوى والإعلانات والصفحات',
};

const ROLE_DESC_AR: Record<string, string> = {
  platform_owner: 'صلاحيات كاملة لإدارة المنصة والعملاء والخطط والأدوار والإعدادات الحساسة.',
  platform_operations: 'تشغيل المنصة اليومي ومتابعة العملاء والمهام والطوابير والصحة.',
  platform_billing: 'إدارة خطط الأسعار والاشتراكات والفواتير وطلبات التفعيل والتحصيل.',
  platform_support: 'استقبال تذاكر الدعم والمساعدة والرد على العملاء والدخول المؤقّت المشروط بـالسبب.',
  platform_auditor: 'صلاحيات قراءة شاملة لسجل التدقيق والعملاء والمستخدمين لأغراض الرقابة والمراجعة.',
};

const ROLE_NAME_AR: Record<string, string> = {
  platform_owner: 'مالك المنصة',
  platform_operations: 'تشغيل المنصة',
  platform_billing: 'فوترة المنصة',
  platform_support: 'دعم المنصة',
  platform_auditor: 'مدقّق المنصة',
};

export default function PlatformRolesPage() {
  const session = useSession();
  const canManage = session.canConsole('console.users.manage');

  const roles = useQuery<PlatformRoleMatrixEntry[]>(() => apiData<PlatformRoleMatrixEntry[]>('/platform/roles'));
  const permissions = useQuery<PermissionDto[]>(() => apiData<PermissionDto[]>('/platform/permissions'));

  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  const catalogue = roles.data ?? [];
  const codes = (permissions.data ?? []).map((entry) => entry.code);

  // Seed the draft from the server state whenever it (re)loads — a matrix that starts as a
  // blank slate would silently mean «no permissions» rather than «what is there now».
  useEffect(() => {
    if (!roles.data) return;
    setDraft(Object.fromEntries(roles.data.map((role) => [role.code, [...role.permissions]])));
  }, [roles.data]);

  function toggle(roleCode: string, code: string, on: boolean) {
    setDraft((current) => {
      const set = new Set(current[roleCode] ?? []);
      if (on) set.add(code);
      else set.delete(code);
      return { ...current, [roleCode]: [...set].sort() };
    });
  }

  function dirty(role: PlatformRoleMatrixEntry): boolean {
    const current = [...(draft[role.code] ?? [])].sort();
    return current.join('\u0000') !== [...role.permissions].sort().join('\u0000');
  }

  async function save(role: PlatformRoleMatrixEntry, reason: string) {
    setBusy(role.code);
    setError(undefined);
    setNotice(undefined);
    try {
      await apiPut(`/platform/roles/${role.code}/permissions`, {
        permissions: draft[role.code] ?? [],
        reason,
      });
      setNotice(`حُفظت صلاحيات «${role.nameAr}».`);
      await roles.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'تعذّر الحفظ');
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Screen
      title="أدوار المنصة"
      subtitle="مصفوفة الأدوار الخمسة × رموز اللوحة — ما ينصّ عليه الفهرس، وما صار فعّالًا."
      crumbs={['المنصة', 'التشغيل']}
    >
      {error && <p className="alert danger">{error}</p>}
      {notice && <p className="alert ok">{notice}</p>}
      {roles.status === 'loading' && <Loading />}
      {roles.status === 'error' && <ErrorBox message={roles.error} onRetry={roles.reload} />}

      {roles.status === 'success' &&
        (catalogue.length === 0 ? (
          <Empty title="لا توجد أدوار" />
        ) : (
          catalogue.map((role) => (
            <RoleMatrix
              key={role.code}
              role={role}
              codes={codes}
              draft={draft[role.code] ?? []}
              canManage={canManage}
              busy={busy === role.code}
              dirty={dirty(role)}
              onToggle={(code, on) => toggle(role.code, code, on)}
              onSave={(reason) => save(role, reason)}
            />
          ))
        ))}

      <UsersAndHolders />
    </Screen>
  );
}

function RoleMatrix({
  role,
  codes,
  draft,
  canManage,
  busy,
  dirty,
  onToggle,
  onSave,
}: {
  role: PlatformRoleMatrixEntry;
  codes: string[];
  draft: string[];
  canManage: boolean;
  busy: boolean;
  dirty: boolean;
  onToggle: (code: string, on: boolean) => void;
  onSave: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const granted = new Set(draft);
  const catalogued = new Set(role.catalogPermissions);

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }}>
          {role.nameAr} <span className="muted" dir="ltr">({role.code})</span>
        </h3>
        <span className="muted">
          الحائزون: {role.holderCount} ·{' '}
          {role.overridden ? <span className="tag tenant">تجاوز مسجَّل</span> : <span className="tag default">كما في الفهرس</span>}
        </span>
      </div>
      <p className="muted">{ROLE_DESC_AR[role.code] ?? role.description}</p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {codes.map((code) => {
          const on = granted.has(code);
          const inCatalogue = catalogued.has(code);
          return (
            <label
              key={code}
              className="chip"
              title={`${CONSOLE_PERM_AR[code] ?? code} (${code})`}
              style={{ opacity: on ? 1 : 0.6 }}
            >
              <input type="checkbox" checked={on} disabled={!canManage || busy} onChange={(event) => onToggle(code, event.target.checked)} />
              <span>{CONSOLE_PERM_AR[code] ?? code.replace('console.', '')}</span>
              <span className="muted small" dir="ltr">({code.replace('console.', '')})</span>
              {inCatalogue !== on && <span className="muted">{inCatalogue ? '−' : '+'}</span>}
            </label>
          );
        })}
      </div>

      {canManage && (
        <div className="row" style={{ marginTop: 12 }}>
          <input
            className="input"
            style={{ maxWidth: 280 }}
            placeholder="سبب التغيير (٣ أحرف)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button className="btn primary" type="button" disabled={!dirty || busy || reason.trim().length < 3} onClick={() => onSave(reason.trim())}>
            {busy ? 'جارٍ الحفظ…' : 'حفظ مجموعة هذا الدور'}
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy}
            onClick={() => {
              // Restoring the catalogue is itself a write: it clears the override row.
              for (const code of codes) onToggle(code, catalogued.has(code));
              setReason('إرجاع إلى الفهرس');
            }}
          >
            إرجاع إلى الفهرس
          </button>
          {!dirty && <span className="muted">لا تغييرات غير محفوظة</span>}
        </div>
      )}
    </div>
  );
}

/** «مَن يحمل ماذا» — الجدول الذي كان في صفحة الأدوار قبل P-C3، مع رابطٍ لبطاقة كل حساب. */
function UsersAndHolders() {
  const users = useQuery<PlatformDirectoryUser[]>(() => apiData<PlatformDirectoryUser[]>('/platform/users'));
  const rows = (users.data ?? []).filter((row) => row.platformRoles.length > 0 || row.isPlatformAdmin);

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>الحائزون</h3>
      {users.status === 'loading' && <Loading />}
      {users.status === 'error' && <ErrorBox message={users.error} onRetry={users.reload} />}
      {users.status === 'success' &&
        (rows.length === 0 ? (
          <Empty title="لا حائزين" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>المشغّل</th>
                  <th>البريد</th>
                  <th>الأدوار</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/users/${row.id}`}>{row.fullName}</Link>
                    </td>
                    <td dir="ltr">{row.email}</td>
                    <td>
                      {row.platformRoles.map((code) => (
                        <span key={code} className="badge active" style={{ marginInlineEnd: 4 }}>
                          {ROLE_NAME_AR[code] ?? code}
                        </span>
                      ))}
                      {row.platformRoles.length === 0 && row.isPlatformAdmin && <span className="badge active">مالك المنصة</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}
