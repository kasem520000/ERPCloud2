'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import type { PlatformRoleMatrixEntry, PlatformSessionView, PlatformUserDetailResponse } from '@erp/contracts';

import { Empty, ErrorBox, Loading, Screen } from '../../../components/screen';
import { ApiError, apiData, apiDelete, apiPost } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * بطاقة المستخدم — `/users/[id]` (P-C3 «الهوية والوصول على المنصة»).
 *
 * The plan asks this card to answer: *his memberships · his roles · his sessions · reset
 * 2FA · revoke sessions*. It does exactly that, and nothing is a picture: every button
 * calls a real endpoint and every table renders a field the API returns —
 * `GET /platform/users/:id` · `POST/DELETE …/:id/roles[/:code]` · `POST …/:id/mfa/reset` ·
 * `DELETE /platform/sessions/:id`.
 *
 * Three rules, learned in P-C2 and kept here:
 *
 *  1. **A destructive act asks for its reason first.** Resetting 2FA and revoking a session
 *     both demand «السبب» before the click; the API refuses a missing one, and the reason
 *     ends up in the audit trail of the person it happened to.
 *  2. **The session is a device, not a row.** A refresh-token *family* is one login on one
 *     device; the card shows the IP and the user agent, because «أيّ جهاز أبطل؟» is the
 *     whole question when an account is suspected.
 *  3. **A revoked role is shown, greyed.** Losing a role is part of the history; hiding it
 *     would make the card look like the grant never existed.
 */

type RoleOption = Pick<PlatformRoleMatrixEntry, 'code' | 'nameAr'>;

const USER_STATUS_AR: Record<string, string> = {
  active: 'نشط',
  invited: 'مدعو',
  suspended: 'موقوف',
  archived: 'مؤرشف',
};

const PLATFORM_ROLE_AR: Record<string, string> = {
  platform_owner: 'مالك المنصة',
  platform_operations: 'تشغيل المنصة',
  platform_billing: 'فوترة المنصة',
  platform_support: 'دعم المنصة',
  platform_auditor: 'مدقّق المنصة',
};

export default function PlatformUserCardPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const session = useSession();
  const canManage = session.canConsole('console.users.manage');

  const detail = useQuery<PlatformUserDetailResponse>(() => apiData<PlatformUserDetailResponse>(`/platform/users/${id}`), [id]);
  const roles = useQuery<RoleOption[]>(() => apiData<RoleOption[]>('/platform/roles'));
  const sessions = useQuery<PlatformSessionView[]>(
    () => apiData<PlatformUserDetailResponse>(`/platform/users/${id}`).then((payload) => payload.sessions),
    [id],
  );

  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [grantRole, setGrantRole] = useState('platform_operations');
  const [mfaReason, setMfaReason] = useState('');
  const [revokeReasons, setRevokeReasons] = useState<Record<string, string>>({});

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
      await detail.reload();
      await sessions.reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'تعذّر تنفيذ العملية');
    } finally {
      setBusy(undefined);
    }
  }

  const data = detail.data;
  const catalogue = roles.data ?? [];
  const activeRoles = data?.platformRoles ?? [];
  const revokedRoles = data?.revokedPlatformRoles ?? [];
  const openSessions = (sessions.data ?? []).filter((entry) => !entry.revoked);
  const closedSessions = (sessions.data ?? []).filter((entry) => entry.revoked);

  return (
    <Screen
      title={data ? data.user.fullName : 'بطاقة مستخدم'}
      subtitle={data ? data.user.email : '—'}
      crumbs={['المنصة', 'المستخدمون']}
    >
      <p className="no-print">
        <Link href="/users">→ عودة إلى المستخدمين</Link>
      </p>

      {detail.status === 'loading' && <Loading />}
      {detail.status === 'error' && <ErrorBox message={detail.error} onRetry={detail.reload} />}
      {error && <p className="alert danger">{error}</p>}
      {notice && <p className="alert ok">{notice}</p>}

      {data && (
        <>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>التعرّف</h3>
            <div className="grid cols">
              <div>
                <div className="muted">الحالة</div>
                <div>
                  <span className={`badge ${data.user.status}`}>{USER_STATUS_AR[data.user.status] ?? data.user.status}</span>
                  {data.user.mustChangePassword && <span className="badge pending" style={{ marginInlineStart: 4 }}>تغيير كلمة المرور</span>}
                </div>
              </div>
              <div>
                <div className="muted">البريد</div>
                <div dir="ltr">{data.user.email}</div>
              </div>
              <div>
                <div className="muted">الجوال</div>
                <div dir="ltr">{data.user.phone ?? '—'}</div>
              </div>
              <div>
                <div className="muted">آخر دخول</div>
                <div dir="ltr">{data.user.lastLoginAt ? new Date(data.user.lastLoginAt).toLocaleString('ar-SA') : '—'}</div>
              </div>
              <div>
                <div className="muted">أُنشئ في</div>
                <div dir="ltr">{new Date(data.user.createdAt).toLocaleString('ar-SA')}</div>
              </div>
              <div>
                <div className="muted">مقفول حتى</div>
                <div dir="ltr">{data.user.lockedUntil ? new Date(data.user.lockedUntil).toLocaleString('ar-SA') : '—'}</div>
              </div>
            </div>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>أدوار المنصة</h3>
            <p className="muted">
              الأدوار تحدّد ما يستطيع هذا الحساب فعله في اللوحة. صفوف الأدوار المسحوبة تبقى ظاهرة باهتة — تاريخ المنح جزء من الصورة.
            </p>
            <div>
              {activeRoles.length === 0 && <span className="muted">لا دور فعّال</span>}
              {activeRoles.map((code) => (
                <span key={code} className="badge active" style={{ marginInlineEnd: 6 }}>
                  <span>{PLATFORM_ROLE_AR[code] ?? code}</span>
                  {canManage && (
                    <button
                      className="btn sm"
                      type="button"
                      style={{ marginInlineStart: 6 }}
                      disabled={busy === `revoke:${code}`}
                      onClick={() =>
                        run(`revoke:${code}`, async () => {
                          await apiDelete(`/platform/users/${id}/roles/${code}`);
                        })
                      }
                    >
                      سحب
                    </button>
                  )}
                </span>
              ))}
              {revokedRoles.map((code) => (
                <span key={`revoked:${code}`} className="badge" style={{ marginInlineEnd: 6, opacity: 0.55 }}>
                  <span>{PLATFORM_ROLE_AR[code] ?? code}</span>
                </span>
              ))}
            </div>
            {canManage && (
              <div className="row" style={{ marginTop: 12 }}>
                <select className="input" style={{ maxWidth: 240 }} value={grantRole} onChange={(event) => setGrantRole(event.target.value)}>
                  {catalogue.map((role) => (
                    <option key={role.code} value={role.code}>
                      {role.nameAr}
                    </option>
                  ))}
                </select>
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy === 'grant'}
                  onClick={() =>
                    run('grant', async () => {
                      await apiPost(`/platform/users/${id}/roles`, { roleCode: grantRole });
                    })
                  }
                >
                  منح الدور
                </button>
              </div>
            )}
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>العضويات</h3>
            {data.memberships.length === 0 ? (
              <Empty title="لا عضويات" detail="حساب منصة بحت — لا ينتمي إلى أي منشأة." />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>المنشأة</th>
                      <th>الرمز</th>
                      <th>الاسم داخلها</th>
                      <th>حالة العضوية</th>
                      <th>حالة المنشأة</th>
                      <th>الانضمام</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.memberships.map((member) => (
                      <tr key={member.id}>
                        <td>
                          <Link href={`/tenants/${member.tenantId}`}>{member.tenantName}</Link>
                          {member.isOwner && <span className="tag tenant" style={{ marginInlineStart: 6 }}>مالك</span>}
                        </td>
                        <td dir="ltr">{member.tenantCode}</td>
                        <td>{member.displayName}</td>
                        <td>
                          <span className={`badge ${member.status}`}>{USER_STATUS_AR[member.status] ?? member.status}</span>
                        </td>
                        <td>
                          <span className={`badge ${member.tenantStatus}`}>{USER_STATUS_AR[member.tenantStatus] ?? member.tenantStatus}</span>
                        </td>
                        <td dir="ltr">{new Date(member.createdAt).toLocaleString('ar-SA')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>الجلسات</h3>
            <p className="muted">
              الجلسة هنا **جهاز واحد**: عائلة دوران توكن التجديد. إبطال الجلسة ينفّذ خروجًا فوريًّا على ذلك الجهاز.
            </p>
            {openSessions.length === 0 ? (
              <Empty title="لا جلسات مفتوحة" />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>الجهاز</th>
                      <th>الآيبي</th>
                      <th>المنشأة</th>
                      <th>بدأت</th>
                      <th>آخر ظهور</th>
                      <th>تنتهي</th>
                      <th>تدويرات</th>
                      <th>السبب والإبطال</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openSessions.map((entry) => (
                      <tr key={entry.id}>
                        <td style={{ maxWidth: 240 }} title={entry.userAgent ?? ''}>
                          {entry.userAgent ? entry.userAgent.slice(0, 48) : '— غير معروف'}
                        </td>
                        <td dir="ltr">{entry.ip ?? '—'}</td>
                        <td>{entry.tenantCode ?? 'منصة'}</td>
                        <td dir="ltr">{new Date(entry.createdAt).toLocaleString('ar-SA')}</td>
                        <td dir="ltr">{new Date(entry.lastSeenAt).toLocaleString('ar-SA')}</td>
                        <td dir="ltr">{new Date(entry.expiresAt).toLocaleString('ar-SA')}</td>
                        <td className="num">{entry.rotationCount}</td>
                        <td>
                          {canManage ? (
                            <div className="row" style={{ gap: 6 }}>
                              <input
                                className="input"
                                style={{ maxWidth: 200 }}
                                placeholder="السبب (٣ أحرف)"
                                value={revokeReasons[entry.id] ?? ''}
                                onChange={(event) => setRevokeReasons({ ...revokeReasons, [entry.id]: event.target.value })}
                              />
                              <button
                                className="btn danger"
                                type="button"
                                disabled={busy === `session:${entry.id}` || (revokeReasons[entry.id] ?? '').trim().length < 3}
                                onClick={() =>
                                  run(`session:${entry.id}`, async () => {
                                    await apiDelete(
                                      `/platform/sessions/${entry.id}?reason=${encodeURIComponent((revokeReasons[entry.id] ?? '').trim())}`,
                                    );
                                    setNotice('أُبطلت الجلسة.');
                                  })
                                }
                              >
                                إبطال
                              </button>
                            </div>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {canManage && openSessions.length > 1 && (
              <div className="row" style={{ marginTop: 12 }}>
                <input
                  className="input"
                  style={{ maxWidth: 240 }}
                  placeholder="سبب إبطال كل الجلسات"
                  value={revokeReasons.all ?? ''}
                  onChange={(event) => setRevokeReasons({ ...revokeReasons, all: event.target.value })}
                />
                <button
                  className="btn danger"
                  type="button"
                  disabled={busy === 'sessions:all' || (revokeReasons.all ?? '').trim().length < 3}
                  onClick={() =>
                    run('sessions:all', async () => {
                      const reason = (revokeReasons.all ?? '').trim();
                      for (const entry of openSessions) {
                        // One reason, one act per device: the audit trail stays per-session.
                        await apiDelete(`/platform/sessions/${entry.id}?reason=${encodeURIComponent(reason)}`);
                      }
                      setNotice(`أُبطلت ${openSessions.length} جلسة.`);
                    })
                  }
                >
                  إبطال كل الجلسات
                </button>
              </div>
            )}

            {closedSessions.length > 0 && (
              <details style={{ marginTop: 12 }}>
                <summary className="muted">جلسات مُبطَلة ({closedSessions.length})</summary>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>الجهاز</th>
                        <th>الآيبي</th>
                        <th>آخر ظهور</th>
                        <th>أُبطلت</th>
                      </tr>
                    </thead>
                    <tbody>
                      {closedSessions.map((entry) => (
                        <tr key={entry.id}>
                          <td>{entry.userAgent ? entry.userAgent.slice(0, 48) : '—'}</td>
                          <td dir="ltr">{entry.ip ?? '—'}</td>
                          <td dir="ltr">{new Date(entry.lastSeenAt).toLocaleString('ar-SA')}</td>
                          <td dir="ltr">{entry.revokedAt ? new Date(entry.revokedAt).toLocaleString('ar-SA') : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>التحقّق بخطوتين (2FA)</h3>
            <p>
              الحالة:{' '}
              {data.user.mfaEnabled ? (
                <span className="tag platform">مُفعَّلة</span>
              ) : data.user.mfaEnrolled ? (
                <span className="tag default">مُسجَّلة ولم تُفعَّل</span>
              ) : (
                <span className="tag default">غير مُفعَّلة</span>
              )}
            </p>
            {canManage ? (
              <div className="row" style={{ gap: 6 }}>
                <input
                  className="input"
                  style={{ maxWidth: 240 }}
                  placeholder="سبب إعادة التعيين"
                  value={mfaReason}
                  onChange={(event) => setMfaReason(event.target.value)}
                />
                <button
                  className="btn danger"
                  type="button"
                  disabled={busy === 'mfa' || mfaReason.trim().length < 3}
                  onClick={() =>
                    run('mfa', async () => {
                      const result = await apiPost<{ hadMfa: boolean }>(`/platform/users/${id}/mfa/reset`, {
                        reason: mfaReason.trim(),
                      });
                      setNotice(result.hadMfa ? 'أُعيد تعيين 2FA وسيُطلب من المستخدم تسجيلها من جديد.' : 'لم يكن على الحساب 2FA فعّالة — سُجّل الفعل في التدقيق.');
                      setMfaReason('');
                    })
                  }
                >
                  إعادة تعيين 2FA
                </button>
              </div>
            ) : (
              <p className="muted">قراءة فقط — تحتاج `console.users.manage` لإعادة التعيين.</p>
            )}
          </div>
        </>
      )}
    </Screen>
  );
}
