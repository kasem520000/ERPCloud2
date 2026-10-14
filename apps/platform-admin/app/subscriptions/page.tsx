'use client';

import { KeyRound } from 'lucide-react';
import { useState } from 'react';

import { Empty, ErrorBox, Loading, Screen } from '../../components/screen';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Select } from '../../components/ui/input';
import { Table } from '../../components/ui/table';
import { ApiError, apiData, apiPost } from '../../lib/api';
import { useQuery } from '../../lib/use-query';

const SUB_STATUS_TONE: Record<Status, 'blue' | 'purple' | 'green' | 'amber' | 'red' | 'neutral'> = {
  pending: 'amber',
  trialing: 'blue',
  active: 'green',
  past_due: 'amber',
  paused: 'amber',
  canceled: 'neutral',
  expired: 'red',
  incomplete: 'neutral',
};

/**
 * الاشتراكات والتراخيص — P-C4: **دورة حياة** الترخيص لا صفًّا يُقرأ.
 *
 * الخطة تسمّي الحالات التي تُدار من هنا: «تجربة · تفعيل · ترقية/تخفيض · إيقاف مؤقّت · إلغاء».
 * وكل إجراء يقابل نقطة نهاية حقيقية:
 *
 * | الإجراء | النقطة | ما تعيده |
 * |---|---|---|
 * | إصدار ترخيص (وإصداره بتجربة) | `POST /platform/subscriptions` | الترخيص بحالته `trialing` أو `active` |
 * | ترقية / تخفيض | `POST /platform/subscriptions/:id/change-plan` | التقويم ومستند الفرق |
 * | إيقاف مؤقّت | `POST /platform/subscriptions/:id/pause` | `paused` بتاريخ الإيقاف |
 * | استئناف | `POST /platform/subscriptions/:id/resume` | إرجاع أيام الإيقاف إلى نهاية المدة |
 * | إلغاء (فوري أو بانتهاء المدة) | `POST /platform/subscriptions/:id/cancel` | `canceled` أو علامة نهاية المدة |
 *
 * وكل إجراء يمرّ بسببٍ مكتوب: تغيير باقة عميلٍ يمسّ فاتورته القادمة، وسؤال «لماذا أُلغي هذا
 * العميل؟» يُسأل بعد شهور.
 */

type Status = 'pending' | 'trialing' | 'active' | 'past_due' | 'paused' | 'canceled' | 'expired' | 'incomplete';

type Subscription = {
  id: string;
  status: Status;
  provider: string;
  tenantId: string;
  tenantCode: string;
  tenantName: string;
  tenantStatus: string;
  planId: string;
  planCode: string;
  planName: string;
  amount: string;
  currency: string;
  interval: 'month' | 'year';
  monthlyAmount: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  pausedAt: string | null;
  resumedAt: string | null;
  cancelAtPeriodEnd: boolean;
  canceledReason: string | null;
  billingEmail: string | null;
  activatedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  dueInvoiceCount: number;
};

type Plan = { id: string; code: string; name: string; amount: string; currency: string; interval: 'month' | 'year'; active: boolean };
type Tenant = { id: string; code: string; name: string };
type ChangeResult = {
  proration: {
    periodDays: number;
    remainingDays: number;
    fromPlanCode: string;
    toPlanCode: string;
    credit: string;
    charge: string;
    net: string;
    currency: string;
  };
  invoiceId: string | null;
  invoiceNumber: string | null;
  /** المستند كما سمّاه الخادم (`invoice` · `credit_note` · `null` إن كان الفرق صفراً). */
  invoiceKind: 'invoice' | 'credit_note' | null;
};

const STATUS_LABEL: Record<Status, string> = {
  pending: 'بانتظار التفعيل',
  trialing: 'تجربة',
  active: 'فعّال',
  past_due: 'متأخر',
  paused: 'موقوف مؤقتاً',
  canceled: 'ملغى',
  expired: 'منتهٍ',
  incomplete: 'غير مكتمل',
};

/** الحالات التي لا يزال الترخيص فيها حيّاً — عليها تظهر إجراءات الحياة. */
const LIVE: readonly Status[] = ['trialing', 'active', 'past_due', 'paused'];

function dateText(value: string | null): string {
  return value ? new Date(value).toLocaleDateString('ar-SA') : '—';
}

export default function SubscriptionsPage() {
  const [status, setStatus] = useState('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();
  const [granting, setGranting] = useState(false);
  const [changeTarget, setChangeTarget] = useState<Subscription>();
  const [actionTarget, setActionTarget] = useState<{ subscription: Subscription; kind: 'pause' | 'resume' | 'cancel' }>();

  const subscriptions = useQuery<Subscription[]>(
    () => apiData<Subscription[]>(`/platform/subscriptions${status ? `?status=${status}` : ''}`),
    [status],
  );
  const plans = useQuery<Plan[]>(() => apiData<Plan[]>('/platform/plans'), []);

  const rows = subscriptions.data ?? [];

  return (
    <Screen
      title="الاشتراكات والتراخيص"
      subtitle="كل ترخيص صادر عبر المنصة: يدوي أو عبر Stripe — مع دورة حياته كاملة."
      crumbs={['المنصة', 'العملاء والتراخيص']}
      actions={
        <>
          <div style={{ width: 180 }}>
            <Select label="الحالة" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">كل الحالات</option>
              {(Object.keys(STATUS_LABEL) as Status[]).map((key) => (
                <option key={key} value={key}>
                  {STATUS_LABEL[key]}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="primary" icon={<KeyRound size={14} />} onClick={() => setGranting(!granting)}>
            {granting ? 'إغلاق' : 'ترخيص جديد'}
          </Button>
        </>
      }
    >
      {granting && (
        <GrantForm
          plans={plans.data ?? []}
          onDone={() => {
            setGranting(false);
            setMessage({ kind: 'ok', text: 'صدر الترخيص.' });
            subscriptions.reload();
          }}
          onCancel={() => setGranting(false)}
        />
      )}
      {changeTarget && (
        <ChangePlanForm
          subscription={changeTarget}
          plans={plans.data ?? []}
          onDone={(result) => {
            setChangeTarget(undefined);
            setMessage({
              kind: 'ok',
              text:
                result.invoiceKind === null
                  ? 'تم تغيير الباقة بلا مستند (الفرق صفر).'
                  : `تم تغيير الباقة. الفرق ${result.proration.net} ${result.proration.currency} — ${
                      result.invoiceKind === 'credit_note' ? 'إشعار دائن مسودّة' : 'فاتورة مسودّة'
                    } في صفحة الفواتير.`,
            });
            subscriptions.reload();
          }}
          onCancel={() => setChangeTarget(undefined)}
        />
      )}
      {actionTarget && (
        <LifecycleForm
          subscription={actionTarget.subscription}
          kind={actionTarget.kind}
          onDone={(text) => {
            setActionTarget(undefined);
            setMessage({ kind: 'ok', text });
            subscriptions.reload();
          }}
          onCancel={() => setActionTarget(undefined)}
        />
      )}
      {message && (
        <div
          className={`mb-4 flex items-center gap-2 rounded-[10px] border px-4 py-2.5 text-[13px] font-semibold ${
            message.kind === 'ok' ? 'border-ok-line bg-ok-soft text-ok-ink' : 'border-danger-line bg-danger-soft text-danger-ink'
          }`}
        >
          {message.text}
        </div>
      )}

      {subscriptions.status === 'loading' && <Loading />}
      {subscriptions.status === 'error' && <ErrorBox message={subscriptions.error} onRetry={subscriptions.reload} />}
      {subscriptions.status === 'success' &&
        (rows.length === 0 ? (
          <Empty title="لا توجد تراخيص" detail="أصدر ترخيصاً من هنا أو من صفحة العملاء." />
        ) : (
          <div className="overflow-hidden rounded-[10px] border border-line bg-surface shadow-1">
            <Table
              rows={rows}
              rowKey={(row) => row.id}
              dense
              columns={[
                {
                  key: 'tenant',
                  header: 'العميل',
                  grow: true,
                  cell: (row) => (
                    <span className="block">
                      <span className="block text-[13px] font-bold text-ink">{row.tenantName}</span>
                      <span className="block font-mono text-[11px] text-muted" dir="ltr">{row.tenantCode}</span>
                    </span>
                  ),
                },
                {
                  key: 'plan',
                  header: 'الباقة',
                  cell: (row) => (
                    <span className="block">
                      <span className="block text-[12.5px] font-semibold text-ink-2">{row.planName}</span>
                      <span className="block font-mono text-[11px] text-muted" dir="ltr">{row.planCode}</span>
                    </span>
                  ),
                },
                {
                  key: 'amount',
                  header: 'القيمة',
                  numeric: true,
                  ltr: true,
                  cell: (row) => (
                    <span className="block">
                      <span className="block font-mono text-[12px] font-bold">
                        {Number(row.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })} {row.currency}
                      </span>
                      <span className="block text-[11px] text-muted">
                        {row.interval === 'year' ? 'سنوي' : 'شهري'} · {row.monthlyAmount} شهرياً
                      </span>
                    </span>
                  ),
                },
                {
                  key: 'provider',
                  header: 'المصدر',
                  cell: (row) =>
                    row.provider === 'stripe' ? (
                      <Badge tone="purple" dot>Stripe</Badge>
                    ) : (
                      <Badge tone="neutral" dot>يدوي</Badge>
                    ),
                },
                {
                  key: 'status',
                  header: 'الحالة',
                  cell: (row) => (
                    <span className="block">
                      <Badge tone={SUB_STATUS_TONE[row.status]} dot>{STATUS_LABEL[row.status]}</Badge>
                      {row.cancelAtPeriodEnd && <span className="mt-0.5 block text-[11px] font-semibold text-warn">يُنتهي بانتهاء المدة</span>}
                      {row.status === 'trialing' && row.trialEndsAt && (
                        <span className="mt-0.5 block text-[11px] text-muted">تنتهي التجربة {dateText(row.trialEndsAt)}</span>
                      )}
                      {row.status === 'paused' && row.pausedAt && (
                        <span className="mt-0.5 block text-[11px] text-muted">موقوف منذ {dateText(row.pausedAt)}</span>
                      )}
                    </span>
                  ),
                },
                { key: 'start', header: 'يبدأ', ltr: true, cell: (row) => <span className="font-mono text-[11.5px] text-muted">{dateText(row.currentPeriodStart)}</span> },
                { key: 'end', header: 'ينتهي', ltr: true, cell: (row) => <span className="font-mono text-[11.5px] text-muted">{dateText(row.currentPeriodEnd)}</span> },
                { key: 'due', header: 'فواتير', numeric: true, ltr: true, cell: (row) => <span className={`font-mono text-[12px] font-bold ${row.dueInvoiceCount > 0 ? 'text-danger' : 'text-muted'}`}>{row.dueInvoiceCount}</span> },
                {
                  key: 'actions',
                  header: '',
                  numeric: true,
                  cell: (row) =>
                    LIVE.includes(row.status) ? (
                      <span className="flex flex-wrap items-center justify-end gap-1.5">
                        <Button variant="secondary" size="sm" onClick={() => setChangeTarget(row)}>ترقية/تخفيض</Button>
                        {row.status === 'paused' ? (
                          <Button variant="secondary" size="sm" onClick={() => setActionTarget({ subscription: row, kind: 'resume' })}>استئناف</Button>
                        ) : (
                          <Button variant="secondary" size="sm" onClick={() => setActionTarget({ subscription: row, kind: 'pause' })}>إيقاف</Button>
                        )}
                        <Button variant="danger" size="sm" onClick={() => setActionTarget({ subscription: row, kind: 'cancel' })}>إلغاء</Button>
                      </span>
                    ) : row.status === 'canceled' && row.canceledReason ? (
                      <span className="block max-w-[220px] truncate text-left text-[11px] text-muted" title={row.canceledReason}>{row.canceledReason}</span>
                    ) : null,
                },
              ]}
            />
          </div>
        ))}
    </Screen>
  );
}

function GrantForm({
  plans,
  onDone,
  onCancel,
}: {
  plans: Plan[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const tenants = useQuery<Tenant[]>(() => apiData<Tenant[]>('/platform/tenants'), []);
  const [tenantId, setTenantId] = useState('');
  const [planId, setPlanId] = useState('');
  const [months, setMonths] = useState(12);
  const [trialDays, setTrialDays] = useState(0);
  const [billingEmail, setBillingEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const chosenTenant = tenantId || tenants.data?.[0]?.id || '';
  const chosenPlan = planId || plans[0]?.id || '';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await apiPost('/platform/subscriptions', {
        tenantId: chosenTenant,
        planId: chosenPlan,
        months,
        trialDays,
        ...(billingEmail.trim() ? { billingEmail: billingEmail.trim() } : {}),
      });
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>ترخيص جديد</h2>
      <p className="muted small">
        «تجربة» = مدة بلا فاتورة تنتهي في تاريخها، و«تفعيل» = ترخيص فعّال يبدأ من اليوم. الإصدار يلغي أي ترخيص
        حيّ سابق للعميل — ترخيص واحد حيّ لكل عميل.
      </p>
      <div className="form-grid">
        <label className="field">
          <span>العميل *</span>
          <select className="input" value={chosenTenant} onChange={(event) => setTenantId(event.target.value)} required>
            <option value="">اختر عميلاً…</option>
            {(tenants.data ?? []).map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name} ({tenant.code})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>الباقة *</span>
          <select className="input" value={chosenPlan} onChange={(event) => setPlanId(event.target.value)} required>
            <option value="">اختر باقة…</option>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name} — {plan.amount} {plan.currency} / {plan.interval === 'year' ? 'سنوي' : 'شهري'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>المدة (أشهر) *</span>
          <input
            className="input"
            dir="ltr"
            type="number"
            min={1}
            max={60}
            value={months}
            onChange={(event) => setMonths(Number(event.target.value))}
            required
          />
        </label>
        <label className="field">
          <span>أيام التجربة (0 = تفعيل فوري)</span>
          <input
            className="input"
            dir="ltr"
            type="number"
            min={0}
            max={90}
            value={trialDays}
            onChange={(event) => setTrialDays(Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span>بريد الفوترة (اختياري)</span>
          <input className="input" dir="ltr" type="email" value={billingEmail} onChange={(event) => setBillingEmail(event.target.value)} />
        </label>
      </div>
      {error && <p className="alert danger">{error}</p>}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy || !chosenTenant || !chosenPlan}>
          {busy ? 'جارٍ الإصدار…' : trialDays > 0 ? 'إصدار بتجربة' : 'تفعيل الترخيص'}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          إلغاء
        </button>
      </div>
    </form>
  );
}

/**
 * ترقية/تخفيض — الشاشة تعرض الحساب **قبل** الحفظ: أيام المدة، والأيام المتبقية، ورصيد الباقة
 * القديمة، ومقابل الجديدة، والفرق. هذه الأرقام تأتي من الخدمة لا من جمعٍ في المتصفّح
 * (`platformProration` في العقود)، فما يقرؤه المشغّل هو ما ستكتبه الفاتورة.
 */
function ChangePlanForm({
  subscription,
  plans,
  onDone,
  onCancel,
}: {
  subscription: Subscription;
  plans: Plan[];
  onDone: (result: ChangeResult) => void;
  onCancel: () => void;
}) {
  const targets = plans.filter((plan) => plan.id !== subscription.planId && plan.active);
  const [planId, setPlanId] = useState(targets[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<ChangeResult['proration']>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await apiPost<ChangeResult>(`/platform/subscriptions/${subscription.id}/change-plan`, {
        planId,
        reason: reason.trim(),
      });
      setPreview(result.proration);
      onDone(result);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>تغيير باقة — {subscription.tenantName}</h2>
      <p className="muted small">
        الترقية/التخفيض يبدأ مدة جديدة كاملة من اليوم ({subscription.interval === 'year' ? 'سنة' : 'شهر'})، ويُخصم من
        مقابلها رصيد الباقة الحالية عن الأيام غير المستهلكة. الفرق الموجب فاتورة، والسالب إشعار دائن، والصفر بلا مستند.
      </p>
      <div className="form-grid">
        <label className="field">
          <span>الباقة الحالية</span>
          <input className="input" value={`${subscription.planName} — ${subscription.amount} ${subscription.currency}`} readOnly />
        </label>
        <label className="field">
          <span>الباقة الجديدة *</span>
          <select className="input" value={planId} onChange={(event) => setPlanId(event.target.value)} required>
            <option value="">اختر باقة…</option>
            {targets.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name} — {plan.amount} {plan.currency} / {plan.interval === 'year' ? 'سنوي' : 'شهري'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>السبب *</span>
          <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} required minLength={3} />
        </label>
      </div>
      {preview && (
        <dl className="kv">
          <dt>أيام المدة</dt>
          <dd>{preview.periodDays}</dd>
          <dt>الأيام المتبقية</dt>
          <dd>{preview.remainingDays}</dd>
          <dt>رصيد الباقة السابقة</dt>
          <dd>
            {preview.credit} {preview.currency}
          </dd>
          <dt>مقابل الباقة الجديدة</dt>
          <dd>
            {preview.charge} {preview.currency}
          </dd>
          <dt>الفرق</dt>
          <dd>
            {preview.net} {preview.currency}
          </dd>
        </dl>
      )}
      {error && <p className="alert danger">{error}</p>}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy || !planId}>
          {busy ? 'جارٍ التغيير…' : 'تنفيذ التغيير'}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          إغلاق
        </button>
      </div>
    </form>
  );
}

function LifecycleForm({
  subscription,
  kind,
  onDone,
  onCancel,
}: {
  subscription: Subscription;
  kind: 'pause' | 'resume' | 'cancel';
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [atPeriodEnd, setAtPeriodEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const title =
    kind === 'pause' ? 'إيقاف مؤقّت' : kind === 'resume' ? 'استئناف الترخيص' : 'إلغاء الترخيص';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (kind === 'cancel') {
        await apiPost(`/platform/subscriptions/${subscription.id}/cancel`, {
          reason: reason.trim(),
          atPeriodEnd,
        });
        onDone(atPeriodEnd ? 'سيُنتهي الترخيص بانتهاء المدة المدفوعة.' : 'أُلغي الترخيص فوراً، والسبب مسجَّل.');
      } else {
        await apiPost(`/platform/subscriptions/${subscription.id}/${kind}`, { reason: reason.trim() });
        onDone(kind === 'pause' ? 'أُوقف الترخيص مؤقتاً.' : 'استُؤنف الترخيص وأُعيدت أيام الإيقاف إلى نهاية المدة.');
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>
        {title} — {subscription.tenantName} ({subscription.planName})
      </h2>
      {kind === 'pause' && (
        <p className="muted small">
          الإيقاف يحجز الترخيص بلا إنهائه: الفواتير القائمة تبقى، وأيام الإيقاف تُعاد إلى نهاية المدة عند الاستئناف.
        </p>
      )}
      {kind === 'cancel' && (
        <p className="muted small">
          الإلغاء الفوري يقطع الخدمة اليوم، و«بانتهاء المدة» يترك الترخيص حيّاً حتى آخر يوم دفعه العميل.
        </p>
      )}
      <div className="form-grid">
        <label className="field">
          <span>السبب *</span>
          <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} required minLength={3} />
        </label>
        {kind === 'cancel' && (
          <label className="field">
            <span>التوقيت</span>
            <select className="input" value={atPeriodEnd ? 'period' : 'now'} onChange={(event) => setAtPeriodEnd(event.target.value === 'period')}>
              <option value="now">فوري</option>
              <option value="period">بانتهاء المدة المدفوعة</option>
            </select>
          </label>
        )}
      </div>
      {error && <p className="alert danger">{error}</p>}
      <div className="row">
        <button className={`btn ${kind === 'cancel' ? 'danger' : 'primary'}`} type="submit" disabled={busy}>
          {busy ? 'جارٍ التنفيذ…' : title}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          إغلاق
        </button>
      </div>
    </form>
  );
}
