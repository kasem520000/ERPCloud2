'use client';

import { useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Forbidden, Screen } from '../../../components/screen';
import { apiDelete, apiList, apiPatch, apiPost } from '../../../lib/api';
import {
  branchOptions,
  listBranches,
  listCashLocations,
  listWarehouses,
  type Branch,
  type CashLocation,
  type Warehouse,
} from '../../../lib/lookups';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Role = { id: string; name: string; description?: string | null; isSystem?: boolean };
type Scope = { roleId: string; scopeType: 'branch' | 'warehouse' | 'cash_location' | 'pos_terminal'; scopeId: string };
type Membership = {
  id: string;
  displayName: string;
  status: 'active' | 'invited' | 'suspended';
  isOwner: boolean;
  branchScope: string[] | null;
  roles: Role[];
  kind: 'staff' | 'portal';
  scopes: Scope[];
  /** R1 — حدّ الخصم على العضوية (بديل `OperMaxDiscount` في الديسكتوب). `null` = بلا حدّ. */
  maxDiscountPct: string | null;
  maxDiscountAmount: string | null;
};

type NoticeState = { kind: 'ok' | 'danger' | 'info' | 'warn'; text: string };

const SCOPE_TYPES = [
  { value: 'branch', label: 'فرع' },
  { value: 'warehouse', label: 'مستودع' },
  { value: 'cash_location', label: 'صندوق / بنك' },
] as const;

const TENANT_WIDE_SCOPE_ID = '00000000-0000-0000-0000-000000000000';

const scopeTypeLabel = (scopeType: Scope['scopeType']): string =>
  SCOPE_TYPES.find((item) => item.value === scopeType)?.label ??
  (scopeType === 'pos_terminal' ? 'طرفية نقاط البيع' : scopeType);

function scopeLabel(
  scope: Scope,
  roles: Role[],
  branches: Branch[],
  warehouses: Warehouse[],
  cashLocations: CashLocation[],
): string {
  const role = roles.find((item) => item.id === scope.roleId)?.name ?? scope.roleId;
  const type = scopeTypeLabel(scope.scopeType);
  if (scope.scopeId === TENANT_WIDE_SCOPE_ID) {
    return `${role} ← ${type}: كل المنشأة (وصول شامل صريح)`;
  }
  const target =
    scope.scopeType === 'branch'
      ? (branchOptions(branches).find((item) => item.id === scope.scopeId)?.label ?? scope.scopeId)
      : scope.scopeType === 'warehouse'
        ? (warehouses.find((item) => item.id === scope.scopeId)?.name ?? scope.scopeId)
        : scope.scopeType === 'cash_location'
          ? (cashLocations.find((item) => item.id === scope.scopeId)?.name ?? scope.scopeId)
          : scope.scopeId;
  return `${role} ← ${type}: ${target}`;
}

/**
 * نصّ عمود «حدّ الخصم». الفراغ يعني «بلا حدّ» لا «صفر»: العضوية التي لا حدّ لها تمرّ كما
 * كانت، والصفر المشحون يمنع الخصم رأساً — والفرق يُقرأ في الشاشة لا في التوثيق فقط.
 */
function discountLimitLabel(row: Pick<Membership, 'maxDiscountPct' | 'maxDiscountAmount'>): string {
  const parts: string[] = [];
  if (row.maxDiscountPct !== null) parts.push(`${row.maxDiscountPct}%`);
  if (row.maxDiscountAmount !== null) parts.push(row.maxDiscountAmount);
  return parts.length > 0 ? parts.join(' · ') : 'بلا حدّ';
}

/** يحوّل حقل الشاشة إلى ما يُرسل: النصّ الفارغ `null` صراحةً (رفع الحدّ)، والصفر رقماً. */
const toLimit = (value: string): string | null => (value.trim() === '' ? null : value.trim());

const toggle = (list: string[], id: string): string[] =>
  list.includes(id) ? list.filter((item) => item !== id) : [...list, id];

export default function TenantUsersPage() {
  const { can } = useSession();
  const memberships = useQuery<Membership[]>(() => apiList('/memberships'), []);
  const roles = useQuery<Role[]>(() => apiList('/memberships/assignable-roles'), []);
  const branches = useQuery<Branch[]>(listBranches, []);
  const warehouses = useQuery<Warehouse[]>(listWarehouses, []);
  const cashLocations = useQuery<CashLocation[]>(listCashLocations, []);

  const [notice, setNotice] = useState<NoticeState | undefined>();
  const [busy, setBusy] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [inviteRoles, setInviteRoles] = useState<string[]>([]);
  const [inviteScopeAll, setInviteScopeAll] = useState(true);
  const [inviteScope, setInviteScope] = useState<string[]>([]);
  const [inviteMaxPct, setInviteMaxPct] = useState('');
  const [inviteMaxAmount, setInviteMaxAmount] = useState('');

  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState<Membership['status']>('active');
  const [editRoles, setEditRoles] = useState<string[]>([]);
  const [scopeAll, setScopeAll] = useState(true);
  const [scope, setScope] = useState<string[]>([]);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [capPct, setCapPct] = useState('');
  const [capAmount, setCapAmount] = useState('');
  const [scopeRole, setScopeRole] = useState('');
  const [scopeType, setScopeType] = useState<(typeof SCOPE_TYPES)[number]['value']>('branch');
  const [scopeTarget, setScopeTarget] = useState('');

  if (!can('tenant.membership.manage')) {
    return (
      <Screen title="بطاقة مستخدم" subtitle="مستخدمو هذه المنشأة وأدوارهم." crumbs={['الإعدادات', 'إعدادات المستخدمين']}>
        <Forbidden />
      </Screen>
    );
  }

  const startEdit = (row: Membership): void => {
    setEditingId(row.id);
    setDisplayName(row.displayName);
    setStatus(row.status);
    setEditRoles(row.roles.map((item) => item.id));
    setScopeAll(row.branchScope === null);
    setScope(row.branchScope ?? []);
    setCapPct(row.maxDiscountPct ?? '');
    setCapAmount(row.maxDiscountAmount ?? '');
    setScopes(row.scopes ?? []);
    setScopeRole(row.roles[0]?.id ?? '');
    setScopeTarget('');
    setNotice(undefined);
  };

  const run = async (label: string, work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    try {
      await work();
      setNotice({ kind: 'ok', text: label });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const invite = (): Promise<void> =>
    run('تمت دعوة المستخدم.', async () => {
      await apiPost('/memberships', {
        email: email.trim(),
        ...(fullName.trim() ? { fullName: fullName.trim() } : {}),
        roleIds: inviteRoles,
        branchScope: inviteScopeAll ? null : inviteScope,
        maxDiscountPct: toLimit(inviteMaxPct),
        maxDiscountAmount: toLimit(inviteMaxAmount),
      });
      setEmail('');
      setFullName('');
      setInviteRoles([]);
      setInviteScopeAll(true);
      setInviteScope([]);
      setInviteMaxPct('');
      setInviteMaxAmount('');
      setShowInvite(false);
      memberships.reload();
    });

  const saveEdit = (id: string): Promise<void> =>
    run('تم حفظ المستخدم.', async () => {
      await apiPatch(`/memberships/${id}`, {
        displayName: displayName.trim(),
        status,
        roleIds: editRoles,
        branchScope: scopeAll ? null : scope,
        maxDiscountPct: toLimit(capPct),
        maxDiscountAmount: toLimit(capAmount),
      });
      await apiPost(`/memberships/${id}/scopes`, { scopes });
      setEditingId(null);
      memberships.reload();
    });

  const remove = (row: Membership): Promise<void> =>
    run('تم حذف المستخدم.', async () => {
      await apiDelete(`/memberships/${row.id}`);
      memberships.reload();
    });

  const roleRows = roles.data ?? [];
  const branchRows = branches.data ?? [];
  const warehouseRows = warehouses.data ?? [];
  const cashRows = cashLocations.data ?? [];
  const editing = (memberships.data ?? []).find((row) => row.id === editingId);

  const scopeTargets =
    scopeType === 'branch'
      ? branchOptions(branchRows)
      : scopeType === 'warehouse'
        ? warehouseRows.map((item) => ({ id: item.id, label: item.name ?? item.code ?? item.id }))
        : cashRows.map((item) => ({ id: item.id, label: item.name }));

  return (
    <Screen title="بطاقة مستخدم" subtitle="مستخدمو هذه المنشأة وأدوارهم ونطاقات فروعهم." crumbs={['الإعدادات', 'إعدادات المستخدمين']}>
      <Notice notice={notice} />

      <section className="card">
        <div className="row">
          {/* «📋 قائمة المستخدمين» — `frmAddUsers.xaml` س325. */}
          <h2>📋 قائمة المستخدمين ({(memberships.data ?? []).length})</h2>
          <button type="button" className="btn primary" disabled={busy} onClick={() => setShowInvite(!showInvite)}>
            {showInvite ? 'إغلاق الدعوة' : 'دعوة مستخدم'}
          </button>
        </div>

        {showInvite && (
          <div className="form-grid">
            {/* «🔑 اسم المستخدم» — `frmAddUsers.xaml` س243: في السحابة اسم الدخول هو البريد. */}
            <label>
              🔑 اسم المستخدم (البريد الإلكتروني)
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="user@company.sa" dir="ltr" />
            </label>
            {/* «👤 الموظف» — `frmAddUsers.xaml` س234: في الديسكتوب اختيارٌ من الموظفين، وهنا كتابةٌ للاسم. */}
            <label>
              👤 الموظف
              <input value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="اختياري" />
            </label>
            <fieldset>
              <legend>الأدوار (دور واحد على الأقل)</legend>
              {roleRows.map((role) => (
                <label key={role.id}>
                  <input type="checkbox" checked={inviteRoles.includes(role.id)} onChange={() => setInviteRoles(toggle(inviteRoles, role.id))} />
                  {role.name}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>نطاق الفروع</legend>
              <label>
                <input type="checkbox" checked={inviteScopeAll} onChange={() => setInviteScopeAll(!inviteScopeAll)} />
                كل الفروع
              </label>
              {!inviteScopeAll &&
                branchOptions(branchRows).map((option) => (
                  <label key={option.id}>
                    <input type="checkbox" checked={inviteScope.includes(option.id)} onChange={() => setInviteScope(toggle(inviteScope, option.id))} />
                    {option.label}
                  </label>
                ))}
              {!inviteScopeAll && inviteScope.length === 0 && <p className="muted">اختر فرعاً واحداً على الأقل أو فعّل «كل الفروع».</p>}
            </fieldset>
            <fieldset>
              <legend>💰 حدود الخصم (فارغ = بلا حدّ)</legend>
              <label>
                أعلى نسبة للخصم %
                <input
                  value={inviteMaxPct}
                  onChange={(event) => setInviteMaxPct(event.target.value)}
                  inputMode="decimal"
                  placeholder="مثال: 10"
                  dir="ltr"
                />
              </label>
              <label>
                أعلى قيمة للخصم
                <input
                  value={inviteMaxAmount}
                  onChange={(event) => setInviteMaxAmount(event.target.value)}
                  inputMode="decimal"
                  placeholder="مثال: 50.0000"
                  dir="ltr"
                />
              </label>
            </fieldset>
            <button
              type="button"
              className="btn primary"
              disabled={busy || inviteRoles.length === 0 || !email.trim() || (!inviteScopeAll && inviteScope.length === 0)}
              onClick={() => void invite()}
            >
              إرسال الدعوة
            </button>
          </div>
        )}

        <QueryView
          query={memberships}
          empty="لا يوجد مستخدمون"
          children={(list) => (
            <DataTable
              rows={list}
              rowKey={(row) => row.id}
              columns={[
                { key: 'name', header: '👤 الموظف', cell: (row) => row.displayName },
                { key: 'status', header: 'الحالة', cell: (row) => <span className={`badge ${row.status}`}>{row.status}</span> },
                { key: 'owner', header: 'مالك', cell: (row) => (row.isOwner ? 'نعم' : '—') },
                { key: 'roles', header: 'الأدوار', cell: (row) => row.roles.map((role) => role.name).join('، ') || '—' },
                { key: 'scope', header: 'النطاق', cell: (row) => (row.branchScope === null ? 'كل الفروع' : `${row.branchScope.length} فروع`) },
                { key: 'discount', header: 'حدّ الخصم', cell: (row) => discountLimitLabel(row) },
                {
                  key: 'actions',
                  header: 'إجراءات',
                  cell: (row) => (
                    <span className="row">
                      <button type="button" className="btn sm" disabled={busy} onClick={() => startEdit(row)}>
                        تعديل
                      </button>
                      <button
                        type="button"
                        className="btn sm danger"
                        disabled={busy || row.isOwner}
                        title={row.isOwner ? 'لا يمكن حذف المالك' : 'حذف'}
                        onClick={() => {
                          if (window.confirm(`حذف ${row.displayName}؟`)) void remove(row);
                        }}
                      >
                        حذف
                      </button>
                    </span>
                  ),
                },
              ]}
            />
          )}
        />
      </section>

      {editing && (
        <section className="card">
          <div className="row">
            <h2>تعديل: {editing.displayName}</h2>
            <button type="button" className="btn sm" onClick={() => setEditingId(null)}>
              إلغاء
            </button>
          </div>
          <div className="form-grid">
            <label>
              👤 الموظف
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </label>
            <label>
              الحالة
              <select value={status} onChange={(event) => setStatus(event.target.value as Membership['status'])}>
                <option value="active">نشط</option>
                <option value="invited">مدعو</option>
                <option value="suspended">موقوف</option>
              </select>
            </label>
            <fieldset>
              <legend>الأدوار</legend>
              {roleRows.map((role) => (
                <label key={role.id}>
                  <input type="checkbox" checked={editRoles.includes(role.id)} onChange={() => setEditRoles(toggle(editRoles, role.id))} />
                  {role.name}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>نطاق الفروع</legend>
              <label>
                <input type="checkbox" checked={scopeAll} onChange={() => setScopeAll(!scopeAll)} />
                كل الفروع
              </label>
              {!scopeAll &&
                branchOptions(branchRows).map((option) => (
                  <label key={option.id}>
                    <input type="checkbox" checked={scope.includes(option.id)} onChange={() => setScope(toggle(scope, option.id))} />
                    {option.label}
                  </label>
                ))}
              {!scopeAll && scope.length === 0 && <p className="muted">اختر فرعاً واحداً على الأقل أو فعّل «كل الفروع».</p>}
            </fieldset>
            <fieldset>
              <legend>تقييدات النطاق الدقيقة (فارغ = كل المنشأة)</legend>
              {scopes.length === 0 && <p className="muted">لا توجد تقييدات — المنح سارية على كل المنشأة.</p>}
              {scopes.map((item, index) => (
                <p key={`${item.roleId}-${item.scopeType}-${item.scopeId}`} className="row">
                  <span>{scopeLabel(item, roleRows, branchRows, warehouseRows, cashRows)}</span>
                  <button type="button" className="btn sm danger" onClick={() => setScopes(scopes.filter((_, i) => i !== index))}>
                    إزالة
                  </button>
                </p>
              ))}
              <div className="form-grid">
                <select value={scopeRole} onChange={(event) => setScopeRole(event.target.value)}>
                  {roleRows
                    .filter((role) => editRoles.includes(role.id))
                    .map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                </select>
                <select value={scopeType} onChange={(event) => setScopeType(event.target.value as typeof scopeType)}>
                  {SCOPE_TYPES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <select value={scopeTarget} onChange={(event) => setScopeTarget(event.target.value)}>
                  <option value="">— اختر —</option>
                  <option value={TENANT_WIDE_SCOPE_ID}>🌐 كل المنشأة (وصول شامل صريح)</option>
                  {scopeTargets.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn sm"
                  disabled={!scopeRole || !scopeTarget}
                  onClick={() => {
                    setScopes([...scopes, { roleId: scopeRole, scopeType: scopeType, scopeId: scopeTarget }]);
                    setScopeTarget('');
                  }}
                >
                  إضافة تقييد
                </button>
              </div>
            </fieldset>
            <fieldset>
              <legend>💰 حدود الخصم (فارغ = بلا حدّ)</legend>
              <label>
                أعلى نسبة للخصم %
                <input value={capPct} onChange={(event) => setCapPct(event.target.value)} inputMode="decimal" placeholder="مثال: 10" dir="ltr" />
              </label>
              <label>
                أعلى قيمة للخصم
                <input value={capAmount} onChange={(event) => setCapAmount(event.target.value)} inputMode="decimal" placeholder="مثال: 50.0000" dir="ltr" />
              </label>
              <p className="muted">
                الحدّ يُفحص في الخادم عند كتابة الخصم في فاتورة البيع أو الكاشير، ومجموع الخصم = خصم
                السطور + خصم الفاتورة.
              </p>
            </fieldset>
            <button
              type="button"
              className="btn primary"
              disabled={busy || editRoles.length === 0 || !displayName.trim() || (!scopeAll && scope.length === 0)}
              onClick={() => void saveEdit(editing.id)}
            >
              حفظ
            </button>
          </div>
        </section>
      )}
    </Screen>
  );
}
