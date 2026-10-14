'use client';

import { useState } from 'react';

import { ApiError, apiData, apiPost } from '../../../lib/api';
import { ErrorBox, Loading, Screen } from '../../../components/screen';
import { useQuery } from '../../../lib/use-query';

type Subscription = {
  status: string;
  provider: string;
  plan_name?: string;
  plan_code?: string;
  amount?: string;
  currency?: string;
  activated_at?: string | null;
  current_period_start?: string | null;
  current_period_end?: string | null;
} | null;

type Plan = { id: string; code: string; name: string; interval: string; amount: string; currency: string };

export default function LicensePage() {
  const subscription = useQuery<Subscription>(() => apiData<Subscription>('/billing/subscription'), []);
  const plans = useQuery<Plan[]>(() => apiData<Plan[]>('/billing/plans'), []);
  const planList = plans.data ?? [];
  const [selected, setSelected] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function requestActivation() {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      await apiPost('/billing/activation-requests', { planId: selected, notes: notes.trim() || undefined });
      setSent(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'تعذر إرسال الطلب');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title="الترخيص" subtitle="حالة اشتراك منشأتك في الخدمة." crumbs={['الدعم الفني']}>
      {subscription.status === 'loading' && <Loading rows={3} />}
      {subscription.status === 'error' && <ErrorBox message={subscription.error} onRetry={subscription.reload} />}
      {subscription.status === 'success' && (
        <section className="card">
          {!subscription.data ? (
            <p className="alert warn">لا يوجد ترخيص فعّال لهذه المنشأة.</p>
          ) : (
            <dl className="kv">
              <dt>الحالة</dt>
              <dd>
                <span className={`badge ${subscription.data.status}`}>{subscription.data.status}</span>
              </dd>
              <dt>الباقة</dt>
              <dd>{subscription.data.plan_name ?? '—'}</dd>
              <dt>القيمة</dt>
              <dd dir="ltr">
                {subscription.data.amount ?? '—'} {subscription.data.currency ?? ''}
              </dd>
              <dt>المصدر</dt>
              <dd>{subscription.data.provider === 'stripe' ? 'Stripe' : 'تفعيل يدوي'}</dd>
              <dt>تاريخ التفعيل</dt>
              <dd dir="ltr">
                {subscription.data.activated_at ? new Date(subscription.data.activated_at).toLocaleDateString('ar-SA') : '—'}
              </dd>
              <dt>ينتهي في</dt>
              <dd dir="ltr">
                {subscription.data.current_period_end
                  ? new Date(subscription.data.current_period_end).toLocaleDateString('ar-SA')
                  : '—'}
              </dd>
            </dl>
          )}
        </section>
      )}

      <section className="card" style={{ marginTop: 18 }}>
        <h2>طلب تفعيل</h2>
        <p className="muted">اختر باقة وأرسل طلب تفعيل يدوي — تعتمده إدارة المنصة من لوحة التحكم.</p>
        {plans.status === 'loading' && <Loading rows={2} />}
        {plans.status === 'error' && <ErrorBox message={plans.error} onRetry={plans.reload} />}
        {plans.status === 'success' &&
          (planList.length === 0 ? (
            <p className="muted">لا توجد باقات مفعلة حالياً.</p>
          ) : sent ? (
            <p className="alert ok" role="status">
              تم إرسال طلب الاشتراك. ستتم مراجعته من الإدارة.
            </p>
          ) : (
            <div className="grid">
              <label className="field">
                <span>الباقة</span>
                <select className="input" value={selected} onChange={(event) => setSelected(event.target.value)}>
                  <option value="">— اختر باقة —</option>
                  {planList.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name} — {plan.amount} {plan.currency} / {plan.interval === 'year' ? 'سنة' : 'شهر'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>ملاحظات (اختياري)</span>
                <input
                  className="input"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="مثال: نحتاج التفعيل قبل نهاية الأسبوع"
                />
              </label>
              {error && (
                <p className="alert danger" role="alert">
                  {error}
                </p>
              )}
              <div>
                <button className="btn primary" type="button" disabled={!selected || busy} onClick={() => void requestActivation()}>
                  {busy ? 'جارٍ الإرسال…' : 'إرسال طلب التفعيل'}
                </button>
              </div>
            </div>
          ))}
      </section>
    </Screen>
  );
}
