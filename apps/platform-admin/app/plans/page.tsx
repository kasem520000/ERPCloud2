'use client';

import { useState } from 'react';

import { Empty, ErrorBox, Loading, Screen } from '../../components/screen';
import { ApiError, apiData, apiPatch, apiPost, apiPut } from '../../lib/api';
import { useQuery } from '../../lib/use-query';

/**
 * الباقات والأسعار — P-C4 (`docs/roadmap/PLATFORM_CONSOLE_PLAN.md` §4).
 *
 * الشاشة كانت تعرض السعر والدورة؛ صار السؤال الذي تجيب عنه «ماذا يشتري العميل بهذا السعر؟»
 * عبر **جدول الحقوق**: كل حقّ بنوعه — «وحدة» تُفتح · «حدّ» يُقاس · «راية» تُفعَّل — وقيمته،
 * مع المكافئ الشهري للباقة السنوية (أساس لوحة الإيراد). والحقوق لا تُخترع في الشاشة: قائمة
 * المفاتيح تأتي من نقطة النهاية `GET /platform/plans/entitlement-keys`، وهي المفاتيح التي
 * يعرفها المنتج فعلاً.
 *
 * التسميات المنقولة من سطح المكتب محفوظة بنصّها (الرمز · الاسم · السعر · الدورة · العملة)،
 * وما استُحدث — «الحقوق» وأعمدتها وإجراءاتها — مذكور في جدول «ما اخترعناه» في تقرير الجزء.
 */

type EntitlementValue = boolean | number | string;

type Entitlement = {
  kind: 'module' | 'limit' | 'flag';
  key: string;
  value: EntitlementValue;
  labelAr: string;
  registry: 'tenant' | 'platform';
};

type Plan = {
  id: string;
  code: string;
  name: string;
  interval: 'month' | 'year';
  amount: string;
  currency: string;
  stripePriceId: string | null;
  active: boolean;
  activeSubscriptions: number;
  monthlyAmount: string;
  entitlements: Entitlement[];
  createdAt: string;
};

type EntitlementKey = {
  key: string;
  kind: 'module' | 'limit' | 'flag';
  labelAr: string;
  valueKind: 'boolean' | 'number' | 'string';
  registry: 'tenant' | 'platform';
  max?: number;
};

const KIND_LABEL: Record<Entitlement['kind'], string> = {
  module: 'وحدة',
  limit: 'حدّ',
  flag: 'راية',
};

function valueText(entry: Entitlement): string {
  if (typeof entry.value === 'boolean') return entry.value ? 'مُفعَّلة' : 'مُطفأة';
  return String(entry.value);
}

export default function PlansPage() {
  const plans = useQuery<Plan[]>(() => apiData<Plan[]>('/platform/plans'), []);
  const keys = useQuery<EntitlementKey[]>(() => apiData<EntitlementKey[]>('/platform/plans/entitlement-keys'), []);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Plan>();
  const [entitlementTarget, setEntitlementTarget] = useState<Plan>();
  const [message, setMessage] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  async function toggle(plan: Plan) {
    // A plan's state used to be a switch with no body. P-C4 gives it the price fields too —
    // and a reason, because retiring a plan (or repricing it) touches the bill of every
    // customer on it.
    const reason = window.prompt(plan.active ? 'سبب إيقاف الباقة؟' : 'سبب تفعيل الباقة؟', '');
    if (!reason) return;
    try {
      await apiPatch(`/platform/plans/${plan.id}`, { active: !plan.active, reason });
      setMessage({ kind: 'ok', text: 'تم تحديث حالة الباقة، والسبب مسجَّل في التدقيق.' });
      plans.reload();
    } catch (error) {
      setMessage({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    }
  }

  return (
    <Screen
      title="الباقات والأسعار"
      subtitle="كتالوج الاشتراكات الذي يُصدر منه الترخيص، وحقوق كل باقة. يمكن ربط كل باقة بسعر Stripe."
      crumbs={['المنصة', 'العملاء والتراخيص']}
      actions={
        <>
          <button className="btn" type="button" onClick={plans.reload}>
            تحديث
          </button>
          <button className="btn primary" type="button" onClick={() => setCreating(!creating)}>
            {creating ? 'إغلاق' : 'باقة جديدة'}
          </button>
        </>
      }
    >
      {creating && (
        <PlanForm
          onDone={() => {
            setCreating(false);
            setMessage({ kind: 'ok', text: 'تم حفظ الباقة.' });
            plans.reload();
          }}
        />
      )}
      {editing && (
        <PlanForm
          plan={editing}
          onDone={() => {
            setEditing(undefined);
            setMessage({ kind: 'ok', text: 'تم تعديل الباقة، والتغيير مسجَّل في التدقيق.' });
            plans.reload();
          }}
          onCancel={() => setEditing(undefined)}
        />
      )}
      {entitlementTarget && (
        <EntitlementForm
          plan={entitlementTarget}
          keys={keys.data ?? []}
          onDone={() => {
            setEntitlementTarget(undefined);
            setMessage({ kind: 'ok', text: 'حُفظت حقوق الباقة.' });
            plans.reload();
          }}
          onCancel={() => setEntitlementTarget(undefined)}
        />
      )}
      {message && <p className={`alert ${message.kind}`}>{message.text}</p>}

      {plans.status === 'loading' && <Loading />}
      {plans.status === 'error' && <ErrorBox message={plans.error} onRetry={plans.reload} />}
      {plans.status === 'success' &&
        ((plans.data ?? []).length === 0 ? (
          <Empty title="لا توجد باقات" detail="أنشئ الباقة الأولى ليتمكن العملاء من الاشتراك." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>الرمز</th>
                  <th>الاسم</th>
                  <th className="num">السعر</th>
                  <th>الدورة</th>
                  <th className="num">المكافئ الشهري</th>
                  <th className="num">الحقوق</th>
                  <th className="num">اشتراكات فعّالة</th>
                  <th>الحالة</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(plans.data ?? []).map((plan) => (
                  <tr key={plan.id}>
                    <td dir="ltr">{plan.code}</td>
                    <td>{plan.name}</td>
                    <td className="num">
                      {Number(plan.amount).toLocaleString('ar-SA', { minimumFractionDigits: 2 })} {plan.currency}
                    </td>
                    <td>{plan.interval === 'year' ? 'سنوي' : 'شهري'}</td>
                    <td className="num">{plan.monthlyAmount}</td>
                    <td className="num">{plan.entitlements.length}</td>
                    <td className="num">{plan.activeSubscriptions}</td>
                    <td>
                      <span className={`badge ${plan.active ? 'active' : 'planned'}`}>
                        {plan.active ? 'نشطة' : 'متوقفة'}
                      </span>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn sm" type="button" onClick={() => setEntitlementTarget(plan)}>
                          الحقوق
                        </button>
                        <button className="btn sm" type="button" onClick={() => setEditing(plan)}>
                          تعديل
                        </button>
                        <button className="btn sm" type="button" onClick={() => void toggle(plan)}>
                          {plan.active ? 'إيقاف' : 'تفعيل'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {plans.status === 'success' && (plans.data ?? []).length > 0 && (
        <div className="grid cols-2">
          {(plans.data ?? []).map((plan) => (
            <section className="card" key={`entitlements-${plan.id}`}>
              <h2>
                حقوق «{plan.name}» <span className="muted small" dir="ltr">{plan.code}</span>
              </h2>
              {plan.entitlements.length === 0 ? (
                <p className="muted small">لا حقوق بعد — الباقة تبيع السعر وحده.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>النوع</th>
                      <th>الحقّ</th>
                      <th>القيمة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.entitlements.map((entry) => (
                      <tr key={entry.key}>
                        <td>
                          <span className="chip">{KIND_LABEL[entry.kind]}</span>
                        </td>
                        <td>
                          {entry.labelAr}
                          <div className="muted small" dir="ltr">
                            {entry.key}
                          </div>
                        </td>
                        <td>{valueText(entry)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))}
        </div>
      )}
    </Screen>
  );
}

function PlanForm({
  plan,
  onDone,
  onCancel,
}: {
  plan?: Plan;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [code, setCode] = useState(plan?.code ?? '');
  const [name, setName] = useState(plan?.name ?? '');
  const [priceText, setPriceText] = useState(plan?.amount ?? '0.00');
  const [interval, setInterval] = useState<'month' | 'year'>(plan?.interval ?? 'month');
  const [currency, setCurrency] = useState(plan?.currency ?? 'SAR');
  const [stripePriceId, setStripePriceId] = useState(plan?.stripePriceId ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const editing = plan !== undefined;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (editing) {
        await apiPatch(`/platform/plans/${plan.id}`, {
          name: name.trim(),
          interval,
          amount: priceText,
          currency,
          stripePriceId: stripePriceId.trim() || null,
          reason: reason.trim(),
        });
      } else {
        await apiPost('/platform/plans', {
          code: code.trim(),
          name: name.trim(),
          interval,
          amount: priceText,
          currency,
          stripePriceId: stripePriceId.trim() || null,
          active: true,
        });
      }
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{editing ? `تعديل الباقة ${plan.code}` : 'باقة جديدة'}</h2>
      <p className="muted small">
        {editing
          ? 'تعديل السعر يمسّ كل عميل على هذه الباقة، ولهذا يُطلب السبب ويُسجَّل في التدقيق.'
          : 'الحفظ بنفس الرمز يحدّث الباقة القائمة بدل إنشاء نسخة ثانية.'}
      </p>
      <div className="form-grid">
        <label className="field">
          <span>الرمز *</span>
          <input
            className="input"
            dir="ltr"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="pro-monthly"
            disabled={editing}
            required
          />
        </label>
        <label className="field">
          <span>الاسم *</span>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="الباقة الاحترافية" required />
        </label>
        <label className="field">
          <span>السعر *</span>
          <input className="input" dir="ltr" inputMode="decimal" value={priceText} onChange={(event) => setPriceText(event.target.value)} required />
        </label>
        <label className="field">
          <span>العملة</span>
          <select className="input" value={currency} onChange={(event) => setCurrency(event.target.value)}>
            <option value="SAR">SAR</option>
            <option value="YER">YER</option>
            <option value="AED">AED</option>
            <option value="USD">USD</option>
          </select>
        </label>
        <label className="field">
          <span>الدورة</span>
          <select className="input" value={interval} onChange={(event) => setInterval(event.target.value as 'month' | 'year')}>
            <option value="month">شهرية</option>
            <option value="year">سنوية</option>
          </select>
        </label>
        <label className="field">
          <span>معرّف سعر Stripe (اختياري)</span>
          <input className="input" dir="ltr" value={stripePriceId} onChange={(event) => setStripePriceId(event.target.value)} placeholder="price_..." />
        </label>
        {editing && (
          <label className="field">
            <span>سبب التعديل *</span>
            <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} required minLength={3} />
          </label>
        )}
      </div>
      {error && <p className="alert danger">{error}</p>}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'جارٍ الحفظ…' : 'حفظ'}
        </button>
        {onCancel && (
          <button className="btn" type="button" onClick={onCancel}>
            إلغاء
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * محرّر الحقوق — المجموعة كاملةً تُستبدل في نداء واحد (`PUT …/entitlements`)، لأن الحفظ
 * «بحقٍّ زائد» و«بحقٍّ ناقص» قراران مختلفان ولا يجوز أن يخلطا. وكل مفتاح يأتي من الفهرس،
 * فالشاشة لا تستطيع أن تكتب حقًّا لا يعرفه المنتج.
 */
function EntitlementForm({
  plan,
  keys,
  onDone,
  onCancel,
}: {
  plan: Plan;
  keys: EntitlementKey[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Record<string, EntitlementValue>>(() =>
    Object.fromEntries(plan.entitlements.map((entry) => [entry.key, entry.value])),
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function toggleKey(definition: EntitlementKey) {
    setSelected((current) => {
      const next = { ...current };
      if (definition.key in next) {
        delete next[definition.key];
        return next;
      }
      next[definition.key] =
        definition.valueKind === 'boolean' ? true : definition.valueKind === 'number' ? 1 : '';
      return next;
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await apiPut(`/platform/plans/${plan.id}/entitlements`, {
        entitlements: Object.entries(selected).map(([key, value]) => ({
          key,
          kind: keys.find((entry) => entry.key === key)?.kind ?? 'flag',
          value: typeof value === 'string' && value.trim() !== '' && /^-?\d+$/.test(value.trim()) ? Number(value) : value,
        })),
        reason: reason.trim(),
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
      <h2>حقوق «{plan.name}»</h2>
      <p className="muted small">
        اختر ما تفتحه هذه الباقة: الوحدة تُفتح، والحدّ يُقاس برقم، والراية تُفعَّل. الحفظ يستبدل المجموعة كاملة.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th />
              <th>النوع</th>
              <th>الحقّ</th>
              <th>القيمة</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((definition) => {
              const chosen = definition.key in selected;
              return (
                <tr key={definition.key}>
                  <td>
                    <input
                      type="checkbox"
                      checked={chosen}
                      onChange={() => toggleKey(definition)}
                      aria-label={definition.labelAr}
                    />
                  </td>
                  <td>
                    <span className="chip">{KIND_LABEL[definition.kind]}</span>
                  </td>
                  <td>
                    {definition.labelAr}
                    <div className="muted small" dir="ltr">
                      {definition.key}
                    </div>
                  </td>
                  <td>
                    {!chosen ? (
                      <span className="muted small">—</span>
                    ) : definition.valueKind === 'boolean' ? (
                      <select
                        className="input"
                        value={selected[definition.key] === true ? 'on' : 'off'}
                        onChange={(event) =>
                          setSelected((current) => ({ ...current, [definition.key]: event.target.value === 'on' }))
                        }
                      >
                        <option value="on">مُفعَّلة</option>
                        <option value="off">مُطفأة</option>
                      </select>
                    ) : (
                      <input
                        className="input"
                        dir="ltr"
                        type={definition.valueKind === 'number' ? 'number' : 'text'}
                        max={definition.max}
                        value={String(selected[definition.key] ?? '')}
                        onChange={(event) =>
                          setSelected((current) => ({ ...current, [definition.key]: event.target.value }))
                        }
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>سبب التغيير *</span>
          <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} required minLength={3} />
        </label>
      </div>
      {error && <p className="alert danger">{error}</p>}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'جارٍ الحفظ…' : 'حفظ الحقوق'}
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          إلغاء
        </button>
      </div>
    </form>
  );
}
