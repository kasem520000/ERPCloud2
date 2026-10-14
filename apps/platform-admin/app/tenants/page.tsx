'use client';

import Link from 'next/link';
import {
  Building2,
  CheckCircle2,
  CreditCard,
  PauseCircle,
  PlayCircle,
  Plus,
  Search,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { Screen } from '../../components/screen';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { CountUp } from '../../components/ui/count-up';
import { EmptyState } from '../../components/ui/empty-state';
import { Input, Labeled, Select } from '../../components/ui/input';
import { Modal } from '../../components/ui/modal';
import { SkeletonRows } from '../../components/ui/skeleton';
import { Table } from '../../components/ui/table';
import { ApiError, apiData, apiPost } from '../../lib/api';
import { useQuery } from '../../lib/use-query';

type Tenant = {
  id: string;
  code: string;
  name: string;
  status: string;
  baseCurrency: string;
  timezone: string;
  createdAt: string;
  userCount: number;
  branchCount: number;
  subscriptionStatus: string | null;
  planName: string | null;
  planAmount: string | null;
  currentPeriodEnd: string | null;
};

type Plan = { id: string; code: string; name: string; amount: string; currency: string; interval: string; active: boolean };

const STATUS_LABEL: Record<string, string> = { active: 'نشط', suspended: 'موقوف', archived: 'مؤرشف' };
const SUB_LABEL: Record<string, string> = {
  active: 'فعّال',
  trialing: 'تجريبي',
  past_due: 'متأخر',
  paused: 'موقوف مؤقتاً',
  canceled: 'ملغى',
};
const SUB_TONE: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'purple' | 'neutral'> = {
  active: 'green',
  trialing: 'blue',
  past_due: 'red',
  paused: 'purple',
  canceled: 'neutral',
};

const gregDate = (iso: string) =>
  new Date(iso).toLocaleDateString('ar-SA-u-ca-gregory', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

export default function TenantsPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [applied, setApplied] = useState({ search: '', status: '' });
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();
  const [granting, setGranting] = useState<Tenant | undefined>();
  const [statusTarget, setStatusTarget] = useState<{ tenant: Tenant; next: 'active' | 'suspended' | 'archived' } | undefined>();

  const tenants = useQuery<Tenant[]>(() => {
    const params = new URLSearchParams();
    if (applied.search) params.set('search', applied.search);
    if (applied.status) params.set('status', applied.status);
    return apiData<Tenant[]>(`/platform/tenants?${params.toString()}`);
  }, [applied]);

  const plans = useQuery<Plan[]>(() => apiData<Plan[]>('/platform/plans'), []);

  const customerRows = useMemo(
    () => (tenants.data ?? []).filter((r) => !['platform', 'platform-ops'].includes(r.code.toLowerCase())),
    [tenants.data],
  );

  const counts = useMemo(() => {
    return {
      total: customerRows.length,
      active: customerRows.filter((r) => r.status === 'active').length,
      suspended: customerRows.filter((r) => r.status === 'suspended').length,
      licensed: customerRows.filter((r) => r.subscriptionStatus).length,
    };
  }, [customerRows]);

  async function changeStatus(tenant: Tenant, next: 'active' | 'suspended' | 'archived', reason: string) {
    setMessage(undefined);
    try {
      await apiPost(`/platform/tenants/${tenant.id}/status`, { status: next, reason });
      setMessage({ kind: 'ok', text: 'تم تحديث حالة العميل، والسبب محفوظ في تدقيقه.' });
      setStatusTarget(undefined);
      tenants.reload();
    } catch (error) {
      setMessage({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    }
  }

  return (
    <Screen
      title="العملاء (المستأجرون)"
      subtitle="كل منشأة مشتركة في الخدمة، حالتها، ترخيصها وعدد مستخدميها."
      crumbs={['المنصة', 'العملاء والتراخيص']}
      actions={
        <Link href="/tenants/new">
          <Button variant="primary" icon={<Plus size={15} />}>عميل جديد</Button>
        </Link>
      }
    >
      {/* filter bar */}
      <div className="rounded-[10px] border border-line bg-surface p-3 shadow-1 no-print">
        <div className="flex flex-wrap items-end gap-3">
          <div style={{ minWidth: 240 }}>
            <Input
              label="بحث بالاسم أو الرمز"
              placeholder="مثال: baraka أو BAR"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setApplied({ search, status });
              }}
            />
          </div>
          <div style={{ minWidth: 160 }}>
            <Select label="الحالة" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">كل الحالات</option>
                <option value="active">نشط</option>
                <option value="suspended">موقوف</option>
              <option value="archived">مؤرشف</option>
            </Select>
          </div>
          <Button variant="primary" icon={<Search size={15} />} onClick={() => setApplied({ search, status })}>
            بحث
          </Button>
          <div className="ms-auto flex flex-wrap gap-2">
            <Badge tone="neutral" dot>
              <CountUp value={counts.total} /> إجمالي
            </Badge>
            <Badge tone="green" dot>
              <CountUp value={counts.active} /> نشط
            </Badge>
            <Badge tone="amber" dot>
              <CountUp value={counts.suspended} /> موقوف
            </Badge>
            <Badge tone="blue" dot>
              <CountUp value={counts.licensed} /> مرخّص
            </Badge>
          </div>
        </div>
      </div>

      {message ? (
        <div
          className={`flex items-center gap-2 rounded-[10px] border px-4 py-2.5 text-[13px] font-semibold ${
            message.kind === 'ok' ? 'border-ok-line bg-ok-soft text-ok-ink' : 'border-danger-line bg-danger-soft text-danger-ink'
          }`}
        >
          {message.text}
        </div>
      ) : null}

      {/* table */}
      {tenants.status === 'loading' ? (
        <div className="rounded-[10px] border border-line bg-surface p-4 shadow-1">
          <SkeletonRows rows={8} />
        </div>
      ) : tenants.status === 'error' ? (
        <EmptyState
          tone="red"
          icon={<Building2 size={26} strokeWidth={1.5} />}
          title="تعذر تحميل العملاء"
          description={tenants.error}
          action={<Button variant="primary" onClick={tenants.reload}>إعادة المحاولة</Button>}
        />
      ) : customerRows.length === 0 ? (
        <EmptyState
          icon={<Building2 size={26} strokeWidth={1.5} />}
          title="لا يوجد عملاء"
          description="أنشئ أول عميل من زر «عميل جديد»."
        />
      ) : (
        <div className="rounded-[10px] border border-line bg-surface shadow-1 overflow-hidden">
          <Table
            rows={customerRows}
            rowKey={(row) => row.id}
            dense
            columns={[
              {
                key: 'name',
                header: 'المنشأة',
                cell: (tenant) => (
                  <Link href={`/tenants/${tenant.id}`} className="group grid gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="grid size-7 flex-none place-items-center rounded-md bg-inverse font-mono text-[10px] font-bold text-on-accent" dir="ltr">
                        {tenant.code.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="truncate font-bold text-ink group-hover:text-brand transition-colors duration-150">{tenant.name}</span>
                    </span>
                    <span className="font-mono text-[10.5px] text-muted" dir="ltr">
                      {gregDate(tenant.createdAt)}
                    </span>
                  </Link>
                ),
              },
              {
                key: 'code',
                header: 'الرمز',
                ltr: true,
                cell: (row) => <span className="font-mono text-[12px] text-ink-2">{row.code}</span>,
              },
              {
                key: 'status',
                header: 'الحالة',
                cell: (row) => (
                  <Badge tone={row.status === 'active' ? 'green' : row.status === 'suspended' ? 'red' : 'neutral'} dot>
                    {STATUS_LABEL[row.status] ?? row.status}
                  </Badge>
                ),
              },
              {
                key: 'sub',
                header: 'الترخيص',
                cell: (row) =>
                  row.subscriptionStatus ? (
                    <span className="grid gap-0.5">
                      <Badge tone={SUB_TONE[row.subscriptionStatus] ?? 'neutral'} dot>
                        {SUB_LABEL[row.subscriptionStatus] ?? row.subscriptionStatus}
                      </Badge>
                      <span className="text-[11px] text-muted font-semibold">{row.planName}</span>
                    </span>
                  ) : (
                    <Badge tone="neutral">بدون ترخيص</Badge>
                  ),
              },
              {
                key: 'amount',
                header: 'السعر',
                numeric: true,
                ltr: true,
                cell: (row) =>
                  row.planAmount ? (
                    <span className="font-mono text-[12px] font-bold text-ink">
                      {Number(row.planAmount).toLocaleString('en-US')} {row.baseCurrency}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  ),
              },
              {
                key: 'end',
                header: 'ينتهي في',
                ltr: true,
                cell: (row) => (
                  <span className="font-mono text-[12px] text-muted">{row.currentPeriodEnd ? gregDate(row.currentPeriodEnd) : '—'}</span>
                ),
              },
              {
                key: 'users',
                header: 'مستخدمون',
                numeric: true,
                ltr: true,
                cell: (row) => <span className="font-mono text-[12px]">{row.userCount}</span>,
              },
              {
                key: 'branches',
                header: 'فروع',
                numeric: true,
                ltr: true,
                cell: (row) => <span className="font-mono text-[12px]">{row.branchCount}</span>,
              },
              {
                key: 'actions',
                header: '',
                cell: (row) => (
                  <span className="flex items-center justify-end gap-1.5">
                    <Link href={`/tenants/${row.id}`}>
                      <Button size="sm" variant="secondary">البطاقة</Button>
                    </Link>
                    <Button size="sm" variant="primary" icon={<CreditCard size={12} />} onClick={() => setGranting(row)}>
                      ترخيص
                    </Button>
                    {row.status === 'active' ? (
                      <Button size="sm" variant="danger" icon={<PauseCircle size={12} />} onClick={() => setStatusTarget({ tenant: row, next: 'suspended' })}>
                        إيقاف
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" icon={<PlayCircle size={12} />} onClick={() => setStatusTarget({ tenant: row, next: 'active' })}>
                        تفعيل
                      </Button>
                    )}
                  </span>
                ),
              },
            ]}
          />
        </div>
      )}

      {/* status reason modal */}
      {statusTarget ? (
        <StatusReasonForm
          tenant={statusTarget.tenant}
          next={statusTarget.next}
          onClose={() => setStatusTarget(undefined)}
          onSubmit={(reason) => void changeStatus(statusTarget.tenant, statusTarget.next, reason)}
        />
      ) : null}

      {/* grant licence modal */}
      {granting ? (
        <GrantLicenceForm
          tenant={granting}
          plans={(plans.data ?? []).filter((plan) => plan.active)}
          onClose={() => setGranting(undefined)}
          onDone={() => {
            setGranting(undefined);
            setMessage({ kind: 'ok', text: 'تم إصدار الترخيص.' });
            tenants.reload();
          }}
        />
      ) : null}
    </Screen>
  );
}

/** «السبب» before the click — the same requirement the API enforces. */
function StatusReasonForm({
  tenant,
  next,
  onClose,
  onSubmit,
}: {
  tenant: Tenant;
  next: 'active' | 'suspended' | 'archived';
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const action = next === 'suspended' ? 'إيقاف' : next === 'archived' ? 'أرشفة' : 'إعادة تنشيط';

  return (
    <Modal
      open
      onClose={onClose}
      title={`${action} — ${tenant.name}`}
      description="يُحفظ السبب في تدقيق العميل نفسه، ويظهر في تبويب «التدقيق» من بطاقته."
      footer={
        <>
          <Button
            variant={next === 'suspended' ? 'danger' : 'primary'}
            icon={<CheckCircle2 size={15} />}
            disabled={reason.trim().length < 3}
            onClick={() => {
              if (reason.trim().length >= 3) onSubmit(reason.trim());
            }}
          >
            تأكيد {action}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            إلغاء
          </Button>
        </>
      }
    >
      <Input
        label="السبب (٣ أحرف على الأقل)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="مثال: انتهاء الاتفاق التجريبي"
        autoFocus
      />
    </Modal>
  );
}

function GrantLicenceForm({
  tenant,
  plans,
  onClose,
  onDone,
}: {
  tenant: Tenant;
  plans: Plan[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [planId, setPlanId] = useState(plans[0]?.id ?? '');
  const [months, setMonths] = useState(12);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      await apiPost('/platform/subscriptions', { tenantId: tenant.id, planId, months });
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`إصدار ترخيص — ${tenant.name}`}
      description="يلغي أي ترخيص فعّال حالياً ويصدر ترخيصاً جديداً، ويعيد تفعيل المنشأة إن كانت موقوفة."
      footer={
        <>
          <Button variant="primary" loading={busy} disabled={plans.length === 0} onClick={() => void submit()} icon={<CreditCard size={15} />}>
            إصدار الترخيص
          </Button>
          <Button variant="ghost" onClick={onClose}>
            إلغاء
          </Button>
        </>
      }
    >
      {plans.length === 0 ? (
        <p className="m-0 rounded-[10px] border border-warn-line bg-warn-soft px-4 py-2.5 text-[13px] font-semibold text-warn-ink">
          لا توجد باقات نشطة. أنشئ باقة أولاً من صفحة <Link href="/plans" className="underline">الباقات</Link>.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Labeled label="الباقة">
            <select
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              required
              className="w-full h-10 px-3 rounded-[8px] border border-line-strong bg-surface text-[13.5px] text-ink focus:outline-none focus:border-brand-600 focus:shadow-[var(--ring-brand)] transition-all duration-150"
            >
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name} — {plan.amount} {plan.currency} / {plan.interval === 'year' ? 'سنة' : 'شهر'}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="المدة (بالأشهر)">
            <input
              type="number"
              min={1}
              max={120}
              dir="ltr"
              value={months}
              onChange={(e) => setMonths(Number(e.target.value))}
              className="w-full h-10 px-3 rounded-[8px] border border-line-strong bg-surface text-[13.5px] font-mono text-ink focus:outline-none focus:border-brand-600 focus:shadow-[var(--ring-brand)] transition-all duration-150"
            />
          </Labeled>
        </div>
      )}
      {error ? (
        <p className="m-0 mt-3 rounded-[10px] border border-danger-line bg-danger-soft px-4 py-2.5 text-[13px] font-semibold text-danger-ink">{error}</p>
      ) : null}
    </Modal>
  );
}
