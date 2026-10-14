'use client';

import Link from 'next/link';
import { useState } from 'react';

import { Screen } from '../../../components/screen';
import { ApiError, apiData, apiPost } from '../../../lib/api';
import { useQuery } from '../../../lib/use-query';

type Plan = { id: string; name: string; amount: string; currency: string; interval: string; active: boolean };

type Created = {
  tenantId: string;
  tenantCode: string;
  ownerUserId: string;
  ownerStatus: string;
  defaults?: { branchId: string; warehouseId: string; cashLocationId: string };
};

export default function NewTenantPage() {
  const plans = useQuery<Plan[]>(() => apiData<Plan[]>('/platform/plans'), []);

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [baseCurrency, setBaseCurrency] = useState('SAR');
  const [timezone, setTimezone] = useState('Asia/Riyadh');
  const [countryCode, setCountryCode] = useState('SA');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerFullName, setOwnerFullName] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [planId, setPlanId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [created, setCreated] = useState<Created | undefined>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await apiPost<Created>('/platform/tenants', {
        code: code.trim().toLowerCase(),
        name: name.trim(),
        baseCurrency,
        timezone,
        countryCode,
        ownerEmail: ownerEmail.trim(),
        ownerFullName: ownerFullName.trim(),
        ownerPassword: ownerPassword.length > 0 ? ownerPassword : undefined,
        planId: planId || undefined,
      });
      setCreated(result);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? `${caught.message}${caught.detail ? ` — ${caught.detail}` : ''}` : String(caught),
      );
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <Screen title="تم إنشاء العميل" crumbs={['المنصة', 'العملاء والتراخيص']}>
        <div className="card">
          <p className="alert ok">أنشئت المنشأة وحساب المالك وتم تجهيز الفرع والمستودع والخزنة الافتراضية.</p>
          <dl className="kv">
            <dt>رمز المنشأة</dt>
            <dd dir="ltr">{created.tenantCode}</dd>
            <dt>معرف المنشأة</dt>
            <dd dir="ltr">{created.tenantId}</dd>
            <dt>حالة المالك</dt>
            <dd>{created.ownerStatus === 'active' ? 'نشط — يمكنه الدخول الآن' : 'مدعو — يجب ضبط كلمة المرور'}</dd>
          </dl>
          <p className="muted small" style={{ marginTop: 10 }}>
            يسجّل العميل الدخول بـ: رمز المنشأة <b dir="ltr">{created.tenantCode}</b> + بريده الإلكتروني + كلمة المرور.
          </p>
          <div className="toolbar">
            <Link className="btn primary" href="/tenants">
              قائمة العملاء
            </Link>
            <button className="btn" type="button" onClick={() => setCreated(undefined)}>
              إنشاء عميل آخر
            </button>
          </div>
        </div>
      </Screen>
    );
  }

  return (
    <Screen
      title="إنشاء عميل جديد"
      subtitle="ينشئ المنشأة وحساب المالك والأدوار الأساسية والفرع/المستودع/الخزنة الافتراضية دفعة واحدة."
      crumbs={['المنصة', 'العملاء والتراخيص']}
    >
      <form className="card" onSubmit={submit}>
        <h2>بيانات المنشأة</h2>
        <div className="form-grid">
          <label className="field">
            <span>رمز المنشأة * (حروف إنجليزية صغيرة وأرقام)</span>
            <input
              className="input"
              dir="ltr"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              pattern="[a-z0-9][a-z0-9-]{1,62}"
              placeholder="acme"
              required
            />
          </label>
          <label className="field">
            <span>اسم المنشأة *</span>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label className="field">
            <span>العملة الأساسية</span>
            <select className="input" value={baseCurrency} onChange={(event) => setBaseCurrency(event.target.value)}>
              <option value="SAR">SAR — ريال سعودي</option>
              <option value="YER">YER — ريال يمني</option>
              <option value="AED">AED — درهم إماراتي</option>
              <option value="USD">USD — دولار</option>
              <option value="EGP">EGP — جنيه مصري</option>
            </select>
          </label>
          <label className="field">
            <span>المنطقة الزمنية</span>
            <select className="input" value={timezone} onChange={(event) => setTimezone(event.target.value)}>
              <option value="Asia/Riyadh">Asia/Riyadh</option>
              <option value="Asia/Aden">Asia/Aden</option>
              <option value="Asia/Dubai">Asia/Dubai</option>
              <option value="Africa/Cairo">Africa/Cairo</option>
            </select>
          </label>
          <label className="field">
            <span>الدولة</span>
            <input
              className="input"
              dir="ltr"
              maxLength={2}
              value={countryCode}
              onChange={(event) => setCountryCode(event.target.value.toUpperCase())}
            />
          </label>
          <label className="field">
            <span>الباقة (اختياري)</span>
            <select className="input" value={planId} onChange={(event) => setPlanId(event.target.value)}>
              <option value="">— بدون ترخيص الآن</option>
              {(plans.data ?? [])
                .filter((plan) => plan.active)
                .map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name} — {plan.amount} {plan.currency}
                  </option>
                ))}
            </select>
          </label>
        </div>

        <h2 style={{ marginTop: 16 }}>حساب المالك</h2>
        <div className="form-grid">
          <label className="field">
            <span>الاسم الكامل *</span>
            <input
              className="input"
              value={ownerFullName}
              onChange={(event) => setOwnerFullName(event.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>البريد الإلكتروني *</span>
            <input
              className="input"
              dir="ltr"
              type="email"
              value={ownerEmail}
              onChange={(event) => setOwnerEmail(event.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>كلمة المرور (12 حرفاً على الأقل — اتركها فارغة لإرسال دعوة)</span>
            <input
              className="input"
              dir="ltr"
              type="password"
              minLength={12}
              value={ownerPassword}
              onChange={(event) => setOwnerPassword(event.target.value)}
            />
          </label>
        </div>

        {error && <p className="alert danger">{error}</p>}

        <div className="toolbar">
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ الإنشاء…' : 'إنشاء العميل'}
          </button>
          <Link className="btn" href="/tenants">
            إلغاء
          </Link>
        </div>
      </form>
    </Screen>
  );
}
