'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Gauge,
  History,
  ListChecks,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  UserRound,
  CreditCard,
} from 'lucide-react';
import { useState } from 'react';
import {
  usageMetricRegistry,
  type PlatformSettingView,
  type PlatformTenantDetailResponse,
  type PlatformTenantHealthResponse,
  type PlatformTenantMember,
  type PlatformTenantSubscription,
  type PlatformTenantUsageResponse,
  type TenantBrandingResponse,
  type TenantFlagsResponse,
  type TenantNotesResponse,
  type TenantSettingsResponse,
} from '@erp/contracts';

import { Empty, ErrorBox, Loading, Screen } from '../../../components/screen';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Tabs as TabsBar } from '../../../components/ui/tabs';
import { MeterBar, SourceTag } from '../../../components/ui';
import { ApiError, apiData, apiDelete, apiPatch, apiPost, apiPut } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * بطاقة العميل — `/tenants/[id]` (P-C2 «العملاء في العمق», `PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * One card per customer, and its tab names are the plan's own list, in its order:
 * **نظرة عامة · الاشتراك · المستخدمون · الاستخدام · الرايات · الصحة · التدقيق · الملاحظات**.
 *
 * The screen reads the endpoints the API actually serves and never invents a field:
 * `GET/PATCH /platform/tenants/:id` · `…/usage` · `…/health` · `…/notes` · `…/settings` ·
 * `…/flags` · `…/branding` · `POST …/status` · `…/owner/transfer` · `GET /platform/audit`
 * (filtered by this customer's `tenantId`).
 *
 * Two rules the console learned the hard way:
 *
 *  1. **Nothing destructive happens without a reason.** Suspending a customer and moving
 *     ownership both require «السبب» — the API refuses without it, and the screen asks for it
 *     *before* the click, not after the 400.
 *  2. **A number nobody can explain is not shown.** Every usage bar prints where its limit
 *     came from (`SourceTag`: تجاوزٌ خاص بالعميل / الحدّ الافتراضي / بلا حدّ), because
 *     «لماذا هذا الحدّ؟» is the question the tab exists to answer.
 */

/** The eight tabs, verbatim from the plan (`PLATFORM_CONSOLE_PLAN.md` §4/‏P-C2) — now with icons. */
const TABS = [
  { id: 'overview', label: 'نظرة عامة', icon: <Building2 size={15} /> },
  { id: 'subscription', label: 'الاشتراك', icon: <CreditCard size={15} /> },
  { id: 'users', label: 'المستخدمون', icon: <UserRound size={15} /> },
  { id: 'usage', label: 'الاستخدام', icon: <Gauge size={15} /> },
  { id: 'flags', label: 'الرايات', icon: <ListChecks size={15} /> },
  { id: 'health', label: 'الصحة', icon: <ShieldCheck size={15} /> },
  { id: 'audit', label: 'التدقيق', icon: <History size={15} /> },
  { id: 'notes', label: 'الملاحظات', icon: <ScrollText size={15} /> },
  { id: 'tickets', label: 'تذاكر الدعم', icon: <ScrollText size={15} /> },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** The status words the customers list already uses (`app/tenants/page.tsx`), verbatim. */
const STATUS_LABEL: Record<string, string> = {
  active: 'نشط',
  suspended: 'موقوف',
  archived: 'مؤرشف',
  invited: 'مدعو',
  pending: 'قيد الانتظار',
};

/** Audit action → its Arabic name. The four names the plan's tests name are here. */
const ACTION_LABEL: Record<string, string> = {
  create: 'إنشاء',
  update: 'تعديل',
  delete: 'حذف',
  'tenant.status': 'تغيير الحالة',
  'tenant.owner_transfer': 'نقل الملكية',
  'tenant.flag': 'تغيير راية',
  'tenant.note': 'ملاحظة',
  'tenant.setting': 'تعديل إعداد',
};

const SUBSCRIPTION_LABEL: Record<string, string> = {
  active: 'سارٍ',
  pending: 'قيد الانتظار',
  past_due: 'متأخر السداد',
  canceled: 'ملغى',
  incomplete: 'غير مكتمل',
};

const HEALTH_LABEL: Record<string, string> = { ok: 'سليم', attention: 'يحتاج انتباهاً', critical: 'حرج' };

type Notice = { kind: 'ok' | 'danger'; text: string };

function noticeFrom(error: unknown): Notice {
  if (error instanceof ApiError) {
    return { kind: 'danger', text: error.detail ? `${error.message} — ${error.detail}` : error.message };
  }
  return { kind: 'danger', text: error instanceof Error ? error.message : String(error) };
}

function when(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('ar-SA');
}

function money(text: string | null, code: string | null): string {
  if (text === null) return '—';
  return `${text} ${code ?? ''}`.trim();
}

// --------------------------------------------------------------------------- page

export default function TenantCardPage() {
  const params = useParams<{ id: string }>();
  const tenantId = String(params.id);
  const { canConsole } = useSession();
  const canManage = canConsole('console.tenants.manage');
  const canSettings = canConsole('console.settings.manage');

  const [tab, setTab] = useState<TabId>('overview');
  const [notice, setNotice] = useState<Notice | undefined>();

  const card = useQuery<PlatformTenantDetailResponse>(
    () => apiData<PlatformTenantDetailResponse>(`/platform/tenants/${tenantId}`),
    [tenantId],
  );

  const tenant = card.data?.tenant;

  return (
    <Screen
      title={tenant ? `${tenant.name} (${tenant.code})` : 'بطاقة العميل'}
      subtitle="من هو؟ ماذا يستهلك؟ ماذا حدث له؟ — كل ما تعرفه المنصة عن هذا العميل في مكان واحد."
      crumbs={['المنصة', 'العملاء', tenant?.name ?? tenantId]}
      actions={
        <>
          <Link href="/tenants">
            <Button variant="secondary" icon={<ArrowLeft size={14} />}>رجوع إلى العملاء</Button>
          </Link>
          <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={card.reload}>
            تحديث
          </Button>
        </>
      }
    >
      {card.status === 'loading' && <Loading rows={4} />}
      {card.status === 'error' && <ErrorBox message={card.error} onRetry={card.reload} />}
      {card.status === 'forbidden' && <Empty title="لا تملك صلاحية قراءة بطاقة العميل" />}

      {card.status === 'success' && tenant && (
        <>
          {/* identity strip */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-[10px] border border-line bg-surface px-4 py-3 shadow-1">
            <span className="grid size-11 flex-none place-items-center rounded-xl bg-inverse font-mono text-[14px] font-bold text-on-accent" dir="ltr">
              {tenant.code.slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[16px] font-extrabold text-ink">{tenant.name}</span>
              <span className="block font-mono text-[11.5px] text-muted" dir="ltr">
                {tenant.code} · {tenant.baseCurrency ?? ''} {tenant.timezone ? `· ${tenant.timezone}` : ''}
              </span>
            </span>
            <span className="ms-auto flex flex-wrap items-center gap-2">
              <Badge tone={tenant.status === 'active' ? 'green' : tenant.status === 'suspended' ? 'red' : 'neutral'} dot>
                {STATUS_LABEL[tenant.status] ?? tenant.status}
              </Badge>
              <span className="text-[12px] font-semibold text-muted">
                أُنشئ {when(tenant.createdAt)} · آخر نشاط {when(tenant.lastActivityAt)} · آخر دخول {when(tenant.lastLoginAt)}
              </span>
            </span>
          </div>

          <TabsBar
            items={TABS.map((entry) => ({ key: entry.id, label: <span className="inline-flex items-center gap-1.5">{entry.icon}{entry.label}</span> }))}
            value={tab}
            onChange={(key) => setTab(key as TabId)}
          />

          {notice ? (
            <div
              className={`flex items-center gap-2 rounded-[10px] border px-4 py-2.5 text-[13px] font-semibold ${
                notice.kind === 'ok' ? 'border-ok-line bg-ok-soft text-ok-ink' : 'border-danger-line bg-danger-soft text-danger-ink'
              }`}
            >
              {notice.text}
            </div>
          ) : null}

          {tab === 'overview' && (
            <OverviewTab
              tenantId={tenantId}
              card={card.data as PlatformTenantDetailResponse}
              canManage={canManage}
              canSettings={canSettings}
              onNotice={setNotice}
              onChanged={card.reload}
            />
          )}
          {tab === 'subscription' && <SubscriptionTab card={card.data as PlatformTenantDetailResponse} />}
          {tab === 'users' && (
            <UsersTab
              tenantId={tenantId}
              members={(card.data as PlatformTenantDetailResponse).members}
              canManage={canManage}
              onNotice={setNotice}
              onChanged={card.reload}
            />
          )}
          {tab === 'usage' && <UsageTab tenantId={tenantId} canSettings={canSettings} onNotice={setNotice} />}
          {tab === 'flags' && <FlagsTab tenantId={tenantId} canSettings={canSettings} onNotice={setNotice} />}
          {tab === 'tickets' && <CustomerTicketsTab tenantId={tenantId} />}
          {tab === 'health' && <HealthTab tenantId={tenantId} />}
          {tab === 'audit' && <AuditTab tenantId={tenantId} />}
          {tab === 'notes' && <NotesTab tenantId={tenantId} canManage={canManage} onNotice={setNotice} />}
        </>
      )}
    </Screen>
  );
}

// ------------------------------------------------------------------- نظرة عامة

function OverviewTab({
  tenantId,
  card,
  canManage,
  canSettings,
  onNotice,
  onChanged,
}: {
  tenantId: string;
  card: PlatformTenantDetailResponse;
  canManage: boolean;
  canSettings: boolean;
  onNotice: (notice: Notice | undefined) => void;
  onChanged: () => void;
}) {
  const tenant = card.tenant;
  const [form, setForm] = useState({
    name: tenant.name,
    code: tenant.code,
    timezone: tenant.timezone,
    currency: tenant.baseCurrency,
  });
  const [statusReason, setStatusReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    onNotice(undefined);
    try {
      await apiPatch(`/platform/tenants/${tenantId}`, {
        name: form.name,
        code: form.code,
        timezone: form.timezone,
        currency: form.currency,
      });
      onNotice({ kind: 'ok', text: 'حُفظت بيانات العميل، وسُجِّل الفرق في التدقيق.' });
      onChanged();
    } catch (error) {
      onNotice(noticeFrom(error));
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(status: 'active' | 'suspended' | 'archived') {
    if (status !== 'active' && statusReason.trim().length < 3) {
      onNotice({ kind: 'danger', text: 'اكتب سبب التعليق (٣ أحرف على الأقل) قبل تنفيذه.' });
      return;
    }
    setBusy(true);
    onNotice(undefined);
    try {
      await apiPost(`/platform/tenants/${tenantId}/status`, {
        status,
        reason: statusReason.trim(),
      });
      onNotice({
        kind: 'ok',
        text: status === 'active' ? 'أُعيد تنشيط العميل، والسبب محفوظ في تدقيقه.' : 'حُدِّثت حالة العميل، والسبب محفوظ في تدقيقه.',
      });
      setStatusReason('');
      onChanged();
    } catch (error) {
      onNotice(noticeFrom(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid">
      <div className="grid cols">
        <div className="card">
          <h2>الحالة</h2>
          <p>
            <span className={`chip ${tenant.status}`}>{STATUS_LABEL[tenant.status] ?? tenant.status}</span>
          </p>
          <p className="muted small">التعليق يقطع الدخول عن المنشأة، ولهذا لا يمرّ بلا سبب مكتوب.</p>
          <label className="field">
            <span>سبب التعليق أو الأرشفة</span>
            <input
              className="input"
              value={statusReason}
              onChange={(event) => setStatusReason(event.target.value)}
              placeholder="مثال: فاتورة متأخرة منذ تسعين يوماً"
              disabled={!canManage}
            />
          </label>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            {tenant.status !== 'active' && (
              <button className="btn primary" type="button" disabled={!canManage || busy} onClick={() => void changeStatus('active')}>
                إعادة تنشيط
              </button>
            )}
            {tenant.status !== 'suspended' && (
              <button className="btn danger" type="button" disabled={!canManage || busy} onClick={() => void changeStatus('suspended')}>
                تعليق
              </button>
            )}
            {tenant.status !== 'archived' && (
              <button className="btn" type="button" disabled={!canManage || busy} onClick={() => void changeStatus('archived')}>
                أرشفة
              </button>
            )}
          </div>
        </div>

        <div className="card">
          <h2>الأعداد</h2>
          <div className="kv">
            <div>
              <span className="muted">المستخدمون</span>
              <strong>{tenant.userCount}</strong>
            </div>
            <div>
              <span className="muted">الفروع</span>
              <strong>{tenant.branchCount}</strong>
            </div>
            <div>
              <span className="muted">فواتير آخر ٣٠ يوماً</span>
              <strong>{tenant.invoicesLast30Days}</strong>
            </div>
            <div>
              <span className="muted">إجمالي الفواتير</span>
              <strong>{tenant.invoicesLifetime}</strong>
            </div>
            <div>
              <span className="muted">الملاحظات</span>
              <strong>{card.noteCount}</strong>
            </div>
            <div>
              <span className="muted">العملة</span>
              <strong>{tenant.baseCurrency}</strong>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>المالك والبيانات الأساسية</h2>
        <p className="muted">
          المالك الحالي: {tenant.owner ? `${tenant.owner.displayName} — ${tenant.owner.email}` : 'لا يوجد مالك نشط لهذه المنشأة.'}
        </p>
        <div className="form-grid">
          <label className="field">
            <span>اسم المنشأة</span>
            <input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} disabled={!canManage} />
          </label>
          <label className="field">
            <span>الرمز</span>
            <input className="input" dir="ltr" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} disabled={!canManage} />
          </label>
          <label className="field">
            <span>المنطقة الزمنية</span>
            <input className="input" dir="ltr" value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} disabled={!canManage} />
          </label>
          <label className="field">
            <span>العملة</span>
            <input className="input" dir="ltr" value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })} disabled={!canManage} />
          </label>
        </div>
        <button className="btn primary" type="button" style={{ marginTop: 8 }} disabled={!canManage || busy} onClick={() => void save()}>
          {busy ? 'جارٍ الحفظ…' : 'حفظ البيانات'}
        </button>
      </div>

      <BrandingSection tenantId={tenantId} canSettings={canSettings} onNotice={onNotice} />
    </div>
  );
}

/** «الشعار والألوان واسم المُرسِل» — the three fields the plan names for الهوية. */
function BrandingSection({
  tenantId,
  canSettings,
  onNotice,
}: {
  tenantId: string;
  canSettings: boolean;
  onNotice: (notice: Notice | undefined) => void;
}) {
  const branding = useQuery<TenantBrandingResponse>(
    () => apiData<TenantBrandingResponse>(`/platform/tenants/${tenantId}/branding`),
    [tenantId],
  );
  const [draft, setDraft] = useState<TenantBrandingResponse | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const value = draft ?? branding.data;

  async function save() {
    if (!value) return;
    setBusy(true);
    onNotice(undefined);
    try {
      await apiPut(`/platform/tenants/${tenantId}/branding`, {
        primaryColor: value.primaryColor,
        logoUrl: value.logoUrl,
        senderName: value.senderName,
      });
      onNotice({ kind: 'ok', text: 'حُفظت هوية العميل.' });
      setDraft(undefined);
      branding.reload();
    } catch (error) {
      onNotice(noticeFrom(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>الشعار والألوان واسم المُرسِل</h2>
      {branding.status === 'loading' && <Loading rows={2} />}
      {branding.status === 'error' && <ErrorBox message={branding.error} onRetry={branding.reload} />}
      {branding.status === 'success' && value && (
        <>
          <div className="form-grid">
            <label className="field">
              <span>اللون الأساسي</span>
              <input
                className="input"
                dir="ltr"
                value={value.primaryColor}
                onChange={(event) => setDraft({ ...value, primaryColor: event.target.value })}
                disabled={!canSettings}
              />
            </label>
            <label className="field">
              <span>رابط الشعار</span>
              <input
                className="input"
                dir="ltr"
                value={value.logoUrl}
                onChange={(event) => setDraft({ ...value, logoUrl: event.target.value })}
                disabled={!canSettings}
              />
            </label>
            <label className="field">
              <span>اسم المُرسِل</span>
              <input
                className="input"
                value={value.senderName}
                onChange={(event) => setDraft({ ...value, senderName: event.target.value })}
                disabled={!canSettings}
              />
            </label>
          </div>
          <p className="muted small">
            آخر تعديل: {when(value.updatedAt)} — والقيمة تُحفظ في إعدادات المنصة كتجاوزٍ يخصّ هذا العميل وحده.
          </p>
          <button className="btn primary" type="button" disabled={!canSettings || busy || !draft} onClick={() => void save()}>
            {busy ? 'جارٍ الحفظ…' : 'حفظ الهوية'}
          </button>
        </>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- الاشتراك

function SubscriptionTab({ card }: { card: PlatformTenantDetailResponse }) {
  const rows: PlatformTenantSubscription[] = card.subscriptions;
  return (
    <div className="card">
      <h2>الاشتراك والتراخيص</h2>
      {rows.length === 0 ? (
        <Empty
          title="لا يوجد اشتراك لهذا العميل"
          detail="يمكن إصدار ترخيص من صفحة «التراخيص» أو من قائمة العملاء."
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الباقة</th>
                <th>الحالة</th>
                <th>القيمة</th>
                <th>بداية الفترة</th>
                <th>نهاية الفترة</th>
                <th>أُلغيت في</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.planName ?? row.planCode ?? '—'}</td>
                  <td>{SUBSCRIPTION_LABEL[row.status] ?? row.status}</td>
                  <td dir="ltr">{money(row.amount, row.currency)}</td>
                  <td dir="ltr">{when(row.startedAt)}</td>
                  <td dir="ltr">{when(row.currentPeriodEnd)}</td>
                  <td dir="ltr">{when(row.cancelledAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small" style={{ marginTop: 8 }}>
        <Link href="/subscriptions">إدارة التراخيص في القائمة الكاملة ←</Link>
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ المستخدمون

function UsersTab({
  tenantId,
  members,
  canManage,
  onNotice,
  onChanged,
}: {
  tenantId: string;
  members: PlatformTenantMember[];
  canManage: boolean;
  onNotice: (notice: Notice | undefined) => void;
  onChanged: () => void;
}) {
  const [transferTo, setTransferTo] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function transfer() {
    if (reason.trim().length < 3) {
      onNotice({ kind: 'danger', text: 'اكتب سبب نقل الملكية (٣ أحرف على الأقل).' });
      return;
    }
    setBusy(true);
    onNotice(undefined);
    try {
      await apiPost(`/platform/tenants/${tenantId}/owner/transfer`, {
        membershipId: transferTo,
        reason: reason.trim(),
      });
      onNotice({ kind: 'ok', text: 'نُقلت الملكية، وسُجِّل النقل في تدقيق العميل.' });
      setTransferTo('');
      setReason('');
      onChanged();
    } catch (error) {
      onNotice(noticeFrom(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid">
      <div className="card">
        <h2>مستخدمو المنشأة ({members.length})</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الاسم</th>
                <th>البريد</th>
                <th>الحالة</th>
                <th>العضوية</th>
                <th>الأدوار</th>
                <th>آخر دخول</th>
                <th>المالك</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.membershipId}>
                  <td>{member.fullName}</td>
                  <td dir="ltr">{member.email}</td>
                  <td>{STATUS_LABEL[member.status] ?? member.status}</td>
                  <td>{STATUS_LABEL[member.membershipStatus] ?? member.membershipStatus}</td>
                  <td>{member.roleCount}</td>
                  <td dir="ltr">{when(member.lastLoginAt)}</td>
                  <td>{member.isOwner ? '✔' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>نقل الملكية</h2>
        <p className="muted small">المالك هو من يحمل صلاحيات المنشأة كلها؛ والنقل يقع على عضو قائم داخل المنشأة.</p>
        <div className="form-grid">
          <label className="field">
            <span>العضو الجديد</span>
            <select className="input" value={transferTo} onChange={(event) => setTransferTo(event.target.value)} disabled={!canManage}>
              <option value="">— اختر عضواً —</option>
              {members
                .filter((member) => !member.isOwner)
                .map((member) => (
                  <option key={member.membershipId} value={member.membershipId}>
                    {member.fullName} — {member.email}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>السبب</span>
            <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} disabled={!canManage} />
          </label>
        </div>
        <button className="btn primary" type="button" disabled={!canManage || busy || transferTo === ''} onClick={() => void transfer()}>
          {busy ? 'جارٍ النقل…' : 'نقل الملكية'}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- الاستخدام

function UsageTab({
  tenantId,
  canSettings,
  onNotice,
}: {
  tenantId: string;
  canSettings: boolean;
  onNotice: (notice: Notice | undefined) => void;
}) {
  const usage = useQuery<PlatformTenantUsageResponse>(
    () => apiData<PlatformTenantUsageResponse>(`/platform/tenants/${tenantId}/usage`),
    [tenantId],
  );
  const settings = useQuery<TenantSettingsResponse>(
    () => apiData<TenantSettingsResponse>(`/platform/tenants/${tenantId}/settings`),
    [tenantId],
  );
  const [busy, setBusy] = useState(false);
  const metrics = usage.data?.metrics ?? [];
  // مفتاح الحدّ يأتي من فهرس المقاييس نفسه (P-C5) لا من خريطةٍ في الشاشة: إضافة مقياسٍ
  // تاسعٍ للفهرس تجعل عموده قابلاً للتجاوز هنا بلا تحرير هذه الصفحة.
  const limitKeyFor = (metricKey: string) =>
    usageMetricRegistry.find((entry) => entry.key === metricKey)?.limitKey;

  async function setLimit(metricKey: string, raw: string) {
    const key = limitKeyFor(metricKey);
    if (!key) return;
    setBusy(true);
    onNotice(undefined);
    try {
      const trimmed = raw.trim();
      await apiPut(`/platform/tenants/${tenantId}/settings/${key}`, {
        // An empty box removes the override and hands the customer back to the platform value.
        value: trimmed.length === 0 ? null : Number(trimmed),
      });
      onNotice({ kind: 'ok', text: trimmed.length === 0 ? 'أُزيل التجاوز، ورجع العميل إلى الحدّ الافتراضي.' : 'حُفظ تجاوز الحدّ لهذا العميل.' });
      usage.reload();
      settings.reload();
    } catch (error) {
      onNotice(noticeFrom(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid">
      {usage.status === 'loading' && <Loading rows={3} />}
      {usage.status === 'error' && <ErrorBox message={usage.error} onRetry={usage.reload} />}
      {usage.status === 'success' && (
        <div className="card">
          <h2>الاستهلاك مقابل الحدود</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>البند</th>
                  <th>المستخدم</th>
                  <th>الحدّ</th>
                  <th>النسبة</th>
                  <th>من أين جاء الحدّ؟</th>
                  <th>تجاوز خاص بالعميل</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((metric) => (
                  <tr key={metric.key}>
                    <td>
                      {metric.labelAr}
                      <div className="muted small">{metric.unitAr ?? ''}</div>
                    </td>
                    <td>{metric.used}</td>
                    <td>{metric.limit ?? 'بلا حدّ'}</td>
                    <td>
                      <MeterBar
                        ratio={metric.limit === null ? 0 : metric.used / Math.max(metric.limit, 1)}
                        tone={
                          metric.limit === null
                            ? 'ok'
                            : metric.used >= metric.limit
                              ? 'danger'
                              : metric.used / metric.limit >= 0.8
                                ? 'warn'
                                : 'ok'
                        }
                      />
                      <span className="muted small">{metric.percentUsed === null ? '—' : `${metric.percentUsed}%`}</span>
                      {metric.state && (
                        <span className={`badge ${metric.state === 'ok' ? 'ready' : metric.state}`} style={{ marginInlineStart: 6 }}>
                          {USAGE_STATE_LABEL[metric.state]}
                        </span>
                      )}
                    </td>
                    <td>
                      <SourceTag source={metric.limitSource} />
                      {/* المغلّف الافتراضي يُبلَّغ عنه ولا يمنع — والعمود يقول أيّهما هذا. */}
                      {metric.enforced !== undefined && (
                        <div className="muted small">{metric.enforced ? 'يُطبَّق' : 'يُبلَّغ عنه فقط'}</div>
                      )}
                    </td>
                    <td>
                      <LimitEditor
                        metricKey={metric.key}
                        current={metric.limitSource === 'tenant' ? metric.limit : null}
                        disabled={!canSettings || busy}
                        onSave={(raw) => void setLimit(metric.key, raw)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {metrics
            .filter((metric) => metric.noticeAr && metric.state !== 'ok' && metric.state !== 'unlimited')
            .map((metric) => (
              <p
                key={metric.key}
                className={`alert ${metric.state === 'hard' ? 'danger' : 'warn'}`}
                style={{ marginTop: 8 }}
              >
                {metric.noticeAr}
              </p>
            ))}
          {metricNote(metrics)}
        </div>
      )}

      {settings.status === 'success' && <AllSettingsCard settings={settings.data?.settings ?? []} />}

      {usage.status === 'success' && (
        <div className="card">
          <h2>فواتير آخر ٣٠ يوماً</h2>
          <div className="day-bars" dir="ltr">
            {(usage.data?.invoicesPerDay ?? []).map((day) => {
              const max = Math.max(1, ...(usage.data?.invoicesPerDay ?? []).map((entry) => entry.count));
              return (
                <div
                  key={day.day}
                  className="day-bar"
                  style={{ height: `${Math.max(3, (day.count / max) * 100)}%` }}
                  title={`${day.day}: ${day.count}`}
                />
              );
            })}
          </div>
          <p className="muted small">
            إجمالي الفترة:{' '}
            {(usage.data?.invoicesPerDay ?? []).reduce((sum, day) => sum + day.count, 0)} فاتورة · أحدث توليد{' '}
            {when(usage.data?.generatedAt)}
          </p>
        </div>
      )}
    </div>
  );
}

const USAGE_STATE_LABEL: Record<string, string> = {
  ok: 'طبيعي',
  soft: 'قريب من الحدّ',
  hard: 'بلغ الحدّ',
  unlimited: 'بلا حدّ',
};

function metricNote(metrics: PlatformTenantUsageResponse['metrics']) {
  const atCeiling = metrics.filter((metric) => metric.state === 'hard' && metric.enforced !== false);
  const approaching = metrics.filter((metric) => metric.state === 'soft');
  const reportedOnly = metrics.filter((metric) => metric.state === 'hard' && metric.enforced === false);
  return (
    <>
      {atCeiling.length > 0 && (
        <p className="alert danger" style={{ marginTop: 8 }}>
          بلغ الحدّ ويُرفض التجاوز: {atCeiling.map((metric) => metric.labelAr).join(' · ')} — ارفع الحدّ من العمود
          الأخير أو اتّفق مع العميل على باقةٍ أوسع.
        </p>
      )}
      {approaching.length > 0 && (
        <p className="alert warn" style={{ marginTop: 8 }}>
          يقترب من الحدّ (٨٠٪ فأكثر): {approaching.map((metric) => metric.labelAr).join(' · ')}.
        </p>
      )}
      {reportedOnly.length > 0 && (
        <p className="muted small" style={{ marginTop: 8 }}>
          عند مغلّف الفهرس بلا تجاوز مكتوب: {reportedOnly.map((metric) => metric.labelAr).join(' · ')} — يُبلَّغ عنه ولا
          يمنع، لأن الفهرس يصف منشأةً جديدة لا عميلاً قائماً.
        </p>
      )}
      {atCeiling.length === 0 && approaching.length === 0 && reportedOnly.length === 0 && (
        <p className="muted small">لا بند عند حدّه الآن. الأرقام مجمّعة من جداول المنشأة نفسها.</p>
      )}
    </>
  );
}

function LimitEditor({
  metricKey,
  current,
  disabled,
  onSave,
}: {
  metricKey: string;
  current: number | null;
  disabled: boolean;
  onSave: (raw: string) => void;
}) {
  const [value, setValue] = useState(current === null ? '' : String(current));
  return (
    <span className="row" style={{ gap: 4 }}>
      <input
        className="input"
        dir="ltr"
        style={{ maxWidth: 80 }}
        placeholder="بلا تجاوز"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={disabled}
        aria-label={`تجاوز الحدّ — ${metricKey}`}
      />
      <button className="btn" type="button" disabled={disabled} onClick={() => onSave(value)}>
        حفظ
      </button>
    </span>
  );
}

/** The keys the customer card may change: the tenant-scoped ones, exactly as the API sends them. */
function AllSettingsCard({ settings }: { settings: PlatformSettingView[] }) {
  const rows = settings.filter((setting) => setting.key.startsWith('limits.'));
  return (
    <div className="card">
      <h2>الحدود الافتراضية للتطبيق</h2>
      <p className="muted small">
        هذه هي القيم الفعّالة لهذا العميل (`GET /platform/tenants/:id/settings`): تجاوزٌ خاص، أو حدّ المنصّة، أو
        القيمة الافتراضية للفهرس.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>المفتاح</th>
              <th>القيمة الفعّالة</th>
              <th>المصدر</th>
              <th>آخر تعديل</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>{row.labelAr}</td>
                <td dir="ltr">{String(row.value)}</td>
                <td>
                  <SourceTag source={row.source} />
                </td>
                <td dir="ltr">{when(row.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------- الرايات

type TenantAddonRow = {
  code: string;
  nameAr: string;
  category: string;
  priceMonthlySar: number;
  enabled: boolean;
  latestRequestStatus: string | null;
};

function FlagsTab({
  tenantId,
  canSettings,
  onNotice,
}: {
  tenantId: string;
  canSettings: boolean;
  onNotice: (notice: Notice | undefined) => void;
}) {
  const flags = useQuery<TenantFlagsResponse>(
    () => apiData<TenantFlagsResponse>(`/platform/tenants/${tenantId}/flags`),
    [tenantId],
  );
  const addons = useQuery<{ apps: TenantAddonRow[] }>(
    () => apiData<{ apps: TenantAddonRow[] }>(`/marketplace/platform/tenants/${tenantId}/apps`),
    [tenantId],
  );
  const [busy, setBusy] = useState(false);

  async function toggle(key: string, enabled: boolean) {
    setBusy(true);
    onNotice(undefined);
    try {
      await apiPut(`/platform/tenants/${tenantId}/flags`, { values: { [key]: enabled } });
      onNotice({ kind: 'ok', text: enabled ? 'فُتحت الحزمة لهذا العميل.' : 'أُعيدت الحزمة إلى الوضع الافتراضي.' });
      flags.reload();
    } catch (error) {
      onNotice(noticeFrom(error));
    } finally {
      setBusy(false);
    }
  }

  async function toggleAddon(code: string, enabled: boolean) {
    setBusy(true);
    onNotice(undefined);
    try {
      await apiPost(`/marketplace/platform/tenants/${tenantId}/apps`, { code, enabled });
      onNotice({
        kind: 'ok',
        text: enabled ? 'تم تفعيل الباقة القطاعية للعميل فوراً.' : 'تم إيقاف الباقة القطاعية عن العميل.',
      });
      addons.reload();
    } catch (error) {
      onNotice(noticeFrom(error));
    } finally {
      setBusy(false);
    }
  }

  const CORE_DEFAULT_OPEN = new Set(['feature.pos', 'feature.hrm']);

  return (
    <div className="grid">
      <div className="card">
        <h2>حِزم المزايا الأساسية (الرايات)</h2>
        <p className="muted small">
          الخدمات الأساسية للعميل (نقطة البيع POS والموارد البشرية HRM) <strong>مفعّلة ومفتوحة افتراضياً</strong> لجميع العملاء دون تقييد.
        </p>
        {flags.status === 'loading' && <Loading rows={3} />}
        {flags.status === 'error' && <ErrorBox message={flags.error} onRetry={flags.reload} />}
        {flags.status === 'success' && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الحزمة</th>
                  <th>الوصف</th>
                  <th>الحالة الفعلية للعميل</th>
                  <th>المصدر</th>
                  <th>آخر تغيير</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(flags.data?.flags ?? []).map((flag) => {
                  const isCore = CORE_DEFAULT_OPEN.has(flag.key);
                  const effectivelyOpen = flag.enabled || (isCore && flag.isDefault);
                  return (
                    <tr key={flag.key}>
                      <td>
                        <strong>{flag.labelAr}</strong>
                      </td>
                      <td className="muted small">{flag.descriptionAr}</td>
                      <td>
                        {effectivelyOpen ? (
                          <span className="badge active">
                            {flag.enabled ? 'مفتوحة (مثبّتة)' : 'مفعّلة ضمن النظام الأساسي'}
                          </span>
                        ) : (
                          <span className="badge">اختيارية — تُفعّل حسب الطلب</span>
                        )}
                      </td>
                      <td>{flag.isDefault ? 'النظام الأساسي الافتراضي' : 'مضبوطة خصيصاً لهذا العميل'}</td>
                      <td dir="ltr">{when(flag.updatedAt)}</td>
                      <td>
                        <button
                          className="btn"
                          type="button"
                          disabled={!canSettings || busy}
                          onClick={() => void toggle(flag.key, !flag.enabled)}
                        >
                          {flag.enabled ? 'إرجاع للافتراضي' : 'تثبيت الفتح'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>🛒 الباقات والأنظمة القطاعية للعميل (سوق الإضافات)</h2>
        <p className="muted small">
          تحكّم مباشر في تفعيل أو إيقاف الباقات القطاعية والتكاملات السحابية الخاصة بهذا العميل (مثل توزيع المناديب والمخابز، التصنيع، تطبيق الموظف، والمشاريع).
        </p>
        {addons.status === 'loading' && <Loading rows={3} />}
        {addons.status === 'error' && <ErrorBox message={addons.error} onRetry={addons.reload} />}
        {addons.status === 'success' && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الباقة / الإضافة</th>
                  <th>الفئة</th>
                  <th>الاشتراك الشهري</th>
                  <th>الحالة لدى العميل</th>
                  <th>طلب العميل</th>
                  <th>الإجراء</th>
                </tr>
              </thead>
              <tbody>
                {(addons.data?.apps ?? []).map((app) => (
                  <tr key={app.code}>
                    <td>
                      <strong>{app.nameAr}</strong>
                    </td>
                    <td>{app.category === 'sector_addon' ? 'باقة قطاعية' : 'تكامل سحابي'}</td>
                    <td dir="ltr">{app.priceMonthlySar} SAR</td>
                    <td>
                      <span className={`badge ${app.enabled ? 'active' : ''}`}>
                        {app.enabled ? 'مفعّلة للعميل' : 'غير مفعّلة'}
                      </span>
                    </td>
                    <td>
                      {app.latestRequestStatus === 'pending' ? (
                        <span className="badge pending">طلب تفعيل معلق</span>
                      ) : app.latestRequestStatus === 'approved' ? (
                        <span className="badge active">تمت الموافقة</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <button
                        className={`btn sm ${app.enabled ? '' : 'primary'}`}
                        type="button"
                        disabled={busy}
                        onClick={() => void toggleAddon(app.code, !app.enabled)}
                      >
                        {app.enabled ? 'إيقاف الباقة' : 'تفعيل للعميل'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- تذاكر الدعم

type CustomerTicketRow = {
  id: string;
  subject: string;
  status: string;
  priority: string;
  category: string | null;
  messageCount: number;
  createdAt: string;
};

const TICKET_STATUS_AR: Record<string, string> = {
  open: 'مفتوحة — بانتظار الرد',
  pending: 'تم الرد — بانتظار العميل',
  resolved: 'محلولة',
  closed: 'مغلقة',
};

const TICKET_PRIORITY_AR: Record<string, string> = {
  urgent: 'عاجلة',
  high: 'عالية',
  normal: 'عادية',
  low: 'منخفضة',
};

function CustomerTicketsTab({ tenantId }: { tenantId: string }) {
  const tickets = useQuery<CustomerTicketRow[]>(
    () => apiData<CustomerTicketRow[]>(`/platform/tenants/${tenantId}/tickets`),
    [tenantId],
  );
  const rows = Array.isArray(tickets.data) ? tickets.data : [];

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0 }}>🛟 تذاكر الدعم وطلبات المساعدة من هذا العميل ({rows.length})</h2>
          <p className="muted small">جميع طلبات المساعدة والرسائل المرسلة من المنشأة إلى إدارة المنصة.</p>
        </div>
        <button className="btn" type="button" onClick={tickets.reload}>
          تحديث
        </button>
      </div>
      {tickets.status === 'loading' && <Loading rows={3} />}
      {tickets.status === 'error' && <ErrorBox message={tickets.error} onRetry={tickets.reload} />}
      {tickets.status === 'success' && rows.length === 0 && (
        <Empty title="لا توجد تذاكر دعم لهذا العميل" detail="عند إرسال العميل لطلب مساعدة سيظهر هنا فوراً." />
      )}
      {tickets.status === 'success' && rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الموضوع</th>
                <th>التصنيف</th>
                <th>الحالة</th>
                <th>الأولوية</th>
                <th>عدد الرسائل</th>
                <th>تاريخ الفتح</th>
                <th>الإجراء</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>
                    <strong>{t.subject}</strong>
                  </td>
                  <td>{t.category ?? 'عام'}</td>
                  <td>
                    <span className={`badge ${t.status === 'open' ? 'pending' : t.status === 'resolved' ? 'active' : ''}`}>
                      {TICKET_STATUS_AR[t.status] ?? t.status}
                    </span>
                  </td>
                  <td>{TICKET_PRIORITY_AR[t.priority] ?? t.priority}</td>
                  <td className="num">{t.messageCount}</td>
                  <td dir="ltr">{when(t.createdAt)}</td>
                  <td>
                    <Link className="btn sm primary" href={`/tickets/${t.id}`}>
                      فتح والرد ←
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------- الصحة

function HealthTab({ tenantId }: { tenantId: string }) {
  const health = useQuery<PlatformTenantHealthResponse>(
    () => apiData<PlatformTenantHealthResponse>(`/platform/tenants/${tenantId}/health`),
    [tenantId],
  );

  return (
    <div className="grid">
      {health.status === 'loading' && <Loading rows={3} />}
      {health.status === 'error' && <ErrorBox message={health.error} onRetry={health.reload} />}
      {health.status === 'success' && health.data && (
        <>
          <div className="grid cols">
            <div className="card">
              <h2>الحالة العامة</h2>
              <p>
                <strong>{HEALTH_LABEL[health.data.status] ?? health.data.status}</strong>
              </p>
              <p className="muted small">
                الاشتراك: {SUBSCRIPTION_LABEL[health.data.subscriptionState] ?? health.data.subscriptionState} · نهاية الفترة:{' '}
                {when(health.data.currentPeriodEnd)}
              </p>
              <p className="muted small">
                آخر نشاط: {when(health.data.lastActivityAt)} · آخر دخول: {when(health.data.lastLoginAt)}
              </p>
            </div>
            <div className="card">
              <h2>طابور المهام</h2>
              <div className="kv">
                <div>
                  <span className="muted">بالانتظار</span>
                  <strong>{health.data.outbox.pending}</strong>
                </div>
                <div>
                  <span className="muted">نُشرت</span>
                  <strong>{health.data.outbox.published}</strong>
                </div>
                <div>
                  <span className="muted">فشلت نهائياً</span>
                  <strong>{health.data.outbox.dead}</strong>
                </div>
                <div>
                  <span className="muted">آخر فشل</span>
                  <strong dir="ltr">{when(health.data.outbox.lastFailureAt)}</strong>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>ما يستحق الانتباه</h2>
            {health.data.findings.length === 0 ? (
              <p className="muted">لا ملاحظات: كل ما تقيسه اللوحة داخل الحدّ.</p>
            ) : (
              <ul>
                {health.data.findings.map((finding, index) => (
                  <li key={index} className={`alert ${finding.severity === 'info' ? 'ok' : finding.severity}`}>
                    {finding.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- التدقيق

type AuditRow = {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  actorLabel: string | null;
  createdAt: string;
  before: unknown;
  after: unknown;
  meta: Record<string, unknown>;
};

function AuditTab({ tenantId }: { tenantId: string }) {
  const audit = useQuery<{ items: AuditRow[]; total: number }>(() => {
    const params = new URLSearchParams({ limit: '50', [`filter[tenantId]`]: tenantId });
    return apiData<{ items: AuditRow[]; total: number }>(`/platform/audit?${params.toString()}`);
  }, [tenantId]);

  return (
    <div className="card">
      <h2>تدقيق هذا العميل</h2>
      <p className="muted small">
        كل عملية مؤثّرة على هذه المنشأة — من فعلها، وماذا تغيّر، ولماذا. للسجل نفسه في اللوحة الكاملة:{' '}
        <Link href="/audit">التدقيق</Link>.
      </p>
      {audit.status === 'loading' && <Loading rows={4} />}
      {audit.status === 'error' && <ErrorBox message={audit.error} onRetry={audit.reload} />}
      {audit.status === 'success' && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الوقت</th>
                <th>الإجراء</th>
                <th>الكيان</th>
                <th>المستخدم</th>
                <th>قبل</th>
                <th>بعد</th>
                <th>السبب</th>
              </tr>
            </thead>
            <tbody>
              {(audit.data?.items ?? []).map((row) => (
                <tr key={row.id}>
                  <td dir="ltr">{when(row.createdAt)}</td>
                  <td>{ACTION_LABEL[row.action] ?? row.action}</td>
                  <td>
                    {row.entity}
                    <br />
                    <span className="muted small" dir="ltr">
                      {row.entityId ?? ''}
                    </span>
                  </td>
                  <td>{row.actorLabel ?? '—'}</td>
                  <td dir="ltr" className="muted small">
                    {row.before ? JSON.stringify(row.before) : '—'}
                  </td>
                  <td dir="ltr" className="muted small">
                    {row.after ? JSON.stringify(row.after) : '—'}
                  </td>
                  <td>{typeof row.meta?.reason === 'string' ? row.meta.reason : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ الملاحظات

function NotesTab({
  tenantId,
  canManage,
  onNotice,
}: {
  tenantId: string;
  canManage: boolean;
  onNotice: (notice: Notice | undefined) => void;
}) {
  const notes = useQuery<TenantNotesResponse>(
    () => apiData<TenantNotesResponse>(`/platform/tenants/${tenantId}/notes`),
    [tenantId],
  );
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    if (body.trim().length < 3) {
      onNotice({ kind: 'danger', text: 'الملاحظة قصيرة: ثلاثة أحرف على الأقل.' });
      return;
    }
    setBusy(true);
    onNotice(undefined);
    try {
      await apiPost(`/platform/tenants/${tenantId}/notes`, { body: body.trim() });
      setBody('');
      onNotice({ kind: 'ok', text: 'أُضيفت الملاحظة، وكاتبها محفوظ معها.' });
      notes.reload();
    } catch (error) {
      onNotice(noticeFrom(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('حذف الملاحظة؟ يبقى نصّها في سجل التدقيق.')) return;
    setBusy(true);
    try {
      await apiDelete(`/platform/tenants/${tenantId}/notes/${id}`);
      onNotice({ kind: 'ok', text: 'حُذفت الملاحظة، ونصّها باقٍ في التدقيق.' });
      notes.reload();
    } catch (error) {
      onNotice(noticeFrom(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid">
      <div className="card">
        <h2>ملاحظة جديدة</h2>
        <p className="muted small">ما لا تحتمله الحقول: ما قيل في المكالمة، وما وُعد به العميل، ولماذا استثنينا حالة.</p>
        <textarea
          className="input"
          rows={3}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          disabled={!canManage}
          placeholder="اكتب الملاحظة…"
        />
        <button className="btn primary" type="button" style={{ marginTop: 8 }} disabled={!canManage || busy} onClick={() => void add()}>
          {busy ? 'جارٍ الحفظ…' : 'إضافة الملاحظة'}
        </button>
      </div>

      <div className="card">
        <h2>الملاحظات المسجّلة ({notes.data?.total ?? 0})</h2>
        {notes.status === 'loading' && <Loading rows={2} />}
        {notes.status === 'error' && <ErrorBox message={notes.error} onRetry={notes.reload} />}
        {notes.status === 'success' &&
          ((notes.data?.items ?? []).length === 0 ? (
            <Empty title="لا ملاحظات بعد" detail="أول ملاحظة تكتبها ستظهر هنا مع اسم كاتبها ووقتها." />
          ) : (
            <ul className="grid">
              {(notes.data?.items ?? []).map((note) => (
                <li key={note.id} className="card tight">
                  <p style={{ margin: 0 }}>{note.body}</p>
                  <p className="muted small" style={{ margin: '6px 0 0' }}>
                    {note.authorLabel || 'مشغّل'} · <span dir="ltr">{when(note.createdAt)}</span>
                    {canManage && (
                      <>
                        {' · '}
                        <button className="btn" type="button" disabled={busy} onClick={() => void remove(note.id)}>
                          حذف
                        </button>
                      </>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </div>
  );
}
