'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { PlatformDirectoryUser } from '@erp/contracts';

import { Empty, ErrorBox, Loading, Screen } from '../../components/screen';
import { ApiError, apiData, apiPost } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useQuery } from '../../lib/use-query';

/**
 * دليل المستخدمين — `/users` (P-C3 «الهوية والوصول على المنصة»).
 *
 * The table answers the three questions an operator actually asks, in one pass:
 * **من هو؟** (الاسم والبريد) · **أين هو؟** (المنشأة/المنشآت: a platform user can belong to
 * more than one customer, and a platform operator belongs to none) · **هل حسابه محميّ؟**
 * (حالة 2FA وآخر دخول وعدد الجلسات المفتوحة). The name links to the user card, which is
 * where anything is actually *done* — the same shape the customers list took in P-C2.
 *
 * The invite form lives here rather than on its own page: inviting an operator is the one
 * act that creates a directory row, so it belongs next to the directory it changes.
 *
 * Labels: «المستخدمون» · «البحث» · «الحالة» · «آخر دخول» are carried verbatim from the
 * pre-P-C3 console (`app/users/page.tsx`, `app/roles/page.tsx`); «المنشأة» · «2FA» ·
 * «جلسات» · «دعوة مشغّل» are new and justified in the part document (§«ما اخترعناه»).
 */
type InviteState = {
  email: string;
  fullName: string;
  roleCode: string;
  temporaryPassword: string;
  reason: string;
};

const EMPTY_INVITE: InviteState = { email: '', fullName: '', roleCode: 'platform_operations', temporaryPassword: '', reason: '' };

const USER_STATUS_AR: Record<string, string> = {
  active: 'نشط',
  invited: 'مدعو',
  suspended: 'موقوف',
};

const PLATFORM_ROLE_AR: Record<string, string> = {
  platform_owner: 'مالك المنصة',
  platform_operations: 'تشغيل المنصة',
  platform_billing: 'فوترة المنصة',
  platform_support: 'دعم المنصة',
  platform_auditor: 'مدقّق المنصة',
};

export default function PlatformUsersPage() {
  const session = useSession();
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [scopeFilter, setScopeFilter] = useState<'customers' | 'operators' | 'all'>('customers');
  const users = useQuery<PlatformDirectoryUser[]>(
    () => apiData<PlatformDirectoryUser[]>(`/platform/users${applied ? `?search=${encodeURIComponent(applied)}` : ''}`),
    [applied],
  );
  const canManage = session.canConsole('console.users.manage');

  const [invite, setInvite] = useState<InviteState>(EMPTY_INVITE);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | undefined>();
  const [invited, setInvited] = useState<string | undefined>();

  async function submitInvite(event: React.FormEvent) {
    event.preventDefault();
    setInviteBusy(true);
    setInviteError(undefined);
    setInvited(undefined);
    try {
      const created = await apiPost<PlatformDirectoryUser>('/platform/operators/invite', {
        email: invite.email,
        fullName: invite.fullName,
        roleCode: invite.roleCode,
        ...(invite.temporaryPassword ? { temporaryPassword: invite.temporaryPassword } : {}),
        ...(invite.reason ? { reason: invite.reason } : {}),
      });
      setInvited(
        created.status === 'active'
          ? `أُنشئ الحساب «${created.email}» بحالة نشط، وسيُطالَب بتغيير كلمة المرور عند أول دخول.`
          : `أُنشئ الحساب «${created.email}» بدعوة بلا كلمة مرور، ويدخل بعد أن يصل رابط التفعيل (جزء البريد P-C6).`,
      );
      setInvite(EMPTY_INVITE);
      setInviteOpen(false);
      await users.reload();
    } catch (caught) {
      setInviteError(caught instanceof ApiError ? caught.message : 'تعذّرت الدعوة');
    } finally {
      setInviteBusy(false);
    }
  }

  const allRows = users.data ?? [];
  const rows = allRows.filter((row) => {
    const customerTenants = row.tenants.filter(
      (t) => !['platform', 'platform-ops'].includes(t.code.toLowerCase()),
    );
    const isOperator = row.platformRoles.length > 0 || row.isPlatformAdmin;
    if (scopeFilter === 'customers') return customerTenants.length > 0;
    if (scopeFilter === 'operators') return isOperator;
    return true;
  });

  return (
    <Screen title="مستخدمو المنصة والعملاء" subtitle="افصل بين مستخدمي منشآت العملاء وبين مشغّلي المنصة الداخليين، مع إدارة الدعوات والأدوار." crumbs={['المنصة', 'التشغيل']}>
      <div className="card tight no-print">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 8 }}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <input
              className="input"
              style={{ maxWidth: 260 }}
              placeholder="بحث بالبريد أو الاسم"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button className="btn primary" type="button" onClick={() => setApplied(search)}>
              بحث
            </button>
            <button
              className={`btn ${scopeFilter === 'customers' ? 'primary' : ''}`}
              type="button"
              onClick={() => setScopeFilter('customers')}
            >
              مستخدمو العملاء
            </button>
            <button
              className={`btn ${scopeFilter === 'operators' ? 'primary' : ''}`}
              type="button"
              onClick={() => setScopeFilter('operators')}
            >
              مشغّلو المنصة
            </button>
            <button
              className={`btn ${scopeFilter === 'all' ? 'primary' : ''}`}
              type="button"
              onClick={() => setScopeFilter('all')}
            >
              الكل ({allRows.length})
            </button>
          </div>
          {canManage && (
            <button className="btn" type="button" onClick={() => setInviteOpen((open) => !open)}>
              دعوة مشغّل منصة
            </button>
          )}
        </div>

        {invited && <p className="alert ok" style={{ marginTop: 8 }}>{invited}</p>}

        {inviteOpen && canManage && (
          <form onSubmit={submitInvite} style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <label className="field">
                <span>البريد</span>
                <input
                  className="input"
                  dir="ltr"
                  required
                  value={invite.email}
                  onChange={(event) => setInvite({ ...invite, email: event.target.value })}
                />
              </label>
              <label className="field">
                <span>الاسم</span>
                <input
                  className="input"
                  required
                  value={invite.fullName}
                  onChange={(event) => setInvite({ ...invite, fullName: event.target.value })}
                />
              </label>
              <label className="field">
                <span>الدور</span>
                <select
                  className="input"
                  value={invite.roleCode}
                  onChange={(event) => setInvite({ ...invite, roleCode: event.target.value })}
                >
                  <option value="platform_owner">مالك المنصة</option>
                  <option value="platform_operations">تشغيل المنصة</option>
                  <option value="platform_billing">فوترة المنصة</option>
                  <option value="platform_support">دعم المنصة</option>
                  <option value="platform_auditor">مدقّق المنصة</option>
                </select>
              </label>
              <label className="field">
                <span>كلمة مرور مؤقّتة (اختياري)</span>
                <input
                  className="input"
                  dir="ltr"
                  autoComplete="new-password"
                  value={invite.temporaryPassword}
                  onChange={(event) => setInvite({ ...invite, temporaryPassword: event.target.value })}
                />
              </label>
              <label className="field">
                <span>ملاحظة (اختياري)</span>
                <input
                  className="input"
                  value={invite.reason}
                  onChange={(event) => setInvite({ ...invite, reason: event.target.value })}
                />
              </label>
              <button className="btn primary" type="submit" disabled={inviteBusy}>
                {inviteBusy ? 'جارٍ الإرسال…' : 'إرسال الدعوة'}
              </button>
            </div>
            <p className="muted" style={{ marginTop: 8 }}>
              بلا كلمة مرور مؤقّتة يُنشأ الحساب <span dir="ltr">invited</span> ولا يستطيع الدخول حتى يصل رابط التفعيل.
            </p>
          </form>
        )}

        {inviteError && <p className="alert danger" style={{ marginTop: 8 }}>{inviteError}</p>}
      </div>

      {users.status === 'loading' && <Loading />}
      {users.status === 'error' && <ErrorBox message={users.error} onRetry={users.reload} />}
      {users.status === 'success' &&
        (rows.length === 0 ? (
          <Empty title="لا توجد نتائج" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الاسم</th>
                  <th>البريد</th>
                  <th>المنشأة</th>
                  <th>الحالة</th>
                  <th>2FA</th>
                  <th>آخر دخول</th>
                  <th className="num">جلسات</th>
                  <th>أدوار المنصة</th>
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
                      {(() => {
                        const customerTenants = row.tenants.filter(
                          (t) => !['platform', 'platform-ops'].includes(t.code.toLowerCase()),
                        );
                        if (customerTenants.length === 0) {
                          return <span className="tag platform">مشغّل منصة داخلي</span>;
                        }
                        return customerTenants.map((tenant) => (
                          <span key={tenant.id} style={{ marginInlineEnd: 6 }}>
                            {tenant.name}
                            {tenant.isOwner && <span className="tag tenant" style={{ marginInlineStart: 4 }}>مالك</span>}
                          </span>
                        ));
                      })()}
                    </td>
                    <td>
                      <span className={`badge ${row.status}`}>{USER_STATUS_AR[row.status] ?? row.status}</span>
                      {row.mustChangePassword && (
                        <span className="badge pending" style={{ marginInlineStart: 4 }}>تغيير كلمة المرور</span>
                      )}
                    </td>
                    <td>
                      {row.mfaEnabled ? (
                        <span className="tag platform">مُفعَّلة</span>
                      ) : (
                        <span className="tag default">غير مُفعَّلة</span>
                      )}
                    </td>
                    <td dir="ltr">{row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString('ar-SA') : '—'}</td>
                    <td className="num">{row.activeSessionCount}</td>
                    <td>
                      {row.platformRoles.length > 0 ? (
                        row.platformRoles.map((code) => (
                          <span key={code} className="badge active" style={{ marginInlineEnd: 4 }}>
                            {PLATFORM_ROLE_AR[code] ?? code}
                          </span>
                        ))
                      ) : row.isPlatformAdmin ? (
                        <span className="badge active">مالك المنصة</span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </Screen>
  );
}
