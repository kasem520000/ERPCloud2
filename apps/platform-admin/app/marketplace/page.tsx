'use client';

import { useEffect, useState } from 'react';

import { Screen } from '../../components/screen';
import { ApiError, apiData, apiPost, apiPut } from '../../lib/api';
import { useSession } from '../../lib/session';

type CatalogApp = {
  code: string;
  nameAr: string;
  nameEn?: string;
  descriptionAr: string;
  icon?: string;
  category?: string;
  monthlyPrice: string;
  isCore: boolean;
  isActive: boolean;
  screens: string[];
};

type AddonRequestRow = {
  id: string;
  tenantId: string;
  tenantCode: string;
  tenantName: string;
  appCode: string;
  appNameAr: string;
  appIcon: string;
  monthlyPrice: string;
  status: 'pending' | 'approved' | 'rejected';
  note: string;
  decisionNote: string;
  requesterLabel: string;
  createdAt: string;
  decidedAt: string | null;
};

type TenantRow = {
  id: string;
  code: string;
  name: string;
};

export default function PlatformMarketplacePage() {
  const { canConsole } = useSession();
  const canWrite = canConsole('console.marketplace.manage');
  const [tab, setTab] = useState<'requests' | 'tenant_direct' | 'catalog'>('requests');
  const [apps, setApps] = useState<CatalogApp[]>([]);
  const [requests, setRequests] = useState<AddonRequestRow[]>([]);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');

  async function reload() {
    const [nextApps, nextReqs, nextTenants] = await Promise.all([
      apiData<CatalogApp[]>('/platform/marketplace/apps'),
      apiData<AddonRequestRow[]>('/platform/marketplace/requests').catch(() => []),
      apiData<TenantRow[]>('/platform/tenants?limit=100').catch(() => []),
    ]);
    setApps(nextApps ?? []);
    setRequests(Array.isArray(nextReqs) ? nextReqs : []);
    const tenantList = Array.isArray(nextTenants) ? nextTenants : [];
    setTenants(tenantList);
    if (!selectedTenantId && tenantList[0]?.id) {
      setSelectedTenantId(tenantList[0].id);
    }
    setDrafts(Object.fromEntries((nextApps ?? []).map((app) => [app.code, app.monthlyPrice])));
  }

  useEffect(() => {
    reload().catch((error: unknown) => setMessage(messageOf(error)));
  }, []);

  async function decide(req: AddonRequestRow, decision: 'approved' | 'rejected') {
    setBusy(req.id);
    setMessage('');
    try {
      await apiPost(`/platform/marketplace/requests/${req.id}/decide`, {
        decision,
        note: decisionNotes[req.id]?.trim() || undefined,
      });
      setMessage(
        decision === 'approved'
          ? `تمت الموافقة وتفعيل باقة «${req.appNameAr}» لمنشأة ${req.tenantName} وإرسال إشعار للعميل.`
          : `تم رفض طلب تفعيل باقة «${req.appNameAr}» لمنشأة ${req.tenantName}.`,
      );
      await reload();
    } catch (error) {
      setMessage(messageOf(error));
    } finally {
      setBusy('');
    }
  }

  async function toggleForTenant(code: string, enabled: boolean, nameAr: string) {
    if (!selectedTenantId) return;
    setBusy(`${selectedTenantId}:${code}`);
    setMessage('');
    try {
      await apiPut(`/platform/marketplace/tenants/${selectedTenantId}/apps/${code}`, { enabled });
      setMessage(`${enabled ? 'فُعّلت' : 'أُوقفت'} باقة «${nameAr}» للمنشأة المحددة.`);
    } catch (error) {
      setMessage(messageOf(error));
    } finally {
      setBusy('');
    }
  }

  async function save(app: CatalogApp, isActive: boolean) {
    setBusy(app.code);
    setMessage('');
    try {
      await apiPut(`/platform/marketplace/apps/${app.code}`, {
        monthlyPrice: drafts[app.code] ?? app.monthlyPrice,
        isActive,
      });
      setMessage(`حُفظت ${app.nameAr}.`);
      await reload();
    } catch (error) {
      setMessage(messageOf(error));
    } finally {
      setBusy('');
    }
  }

  const pendingCount = requests.filter((r) => r.status === 'pending').length;

  return (
    <Screen
      title="سوق الإضافات وطلبات التفعيل"
      subtitle="مراجعة واعتماد طلبات تفعيل الباقات القطاعية للمنشآت، أو تفعيل/إيقاف أي باقة مباشرة لمنشأة، وتسعير الكتالوج."
      crumbs={['المنصة', 'سوق الإضافات']}
    >
      {message ? <p className="alert ok">{message}</p> : null}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button
          type="button"
          className={tab === 'requests' ? 'btn primary' : 'btn'}
          onClick={() => setTab('requests')}
        >
          📩 طلبات التفعيل من المنشآت ({pendingCount} بانتظار الموافقة)
        </button>
        <button
          type="button"
          className={tab === 'tenant_direct' ? 'btn primary' : 'btn'}
          onClick={() => setTab('tenant_direct')}
        >
          🏢 تفعيل/إيقاف مباشر لمنشأة
        </button>
        <button
          type="button"
          className={tab === 'catalog' ? 'btn primary' : 'btn'}
          onClick={() => setTab('catalog')}
        >
          💰 كتالوج وأسعار الباقات ({apps.length})
        </button>
      </div>

      {tab === 'requests' && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>طلبات تفعيل الإضافات والباقات القطاعية</h2>
          {requests.length === 0 ? (
            <p className="muted">لا توجد طلبات تفعيل باقات حالياً.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>المنشأة</th>
                    <th>الباقة المطلوبة</th>
                    <th>مقدم الطلب</th>
                    <th>ملاحظة العميل</th>
                    <th>الحالة</th>
                    <th>رد/ملاحظة المنصة</th>
                    <th>الإجراء</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((req) => (
                    <tr key={req.id}>
                      <td>
                        <strong>{req.tenantName}</strong>
                        <div className="muted" style={{ fontSize: 12 }} dir="ltr">
                          {req.tenantCode}
                        </div>
                      </td>
                      <td>
                        <strong>
                          {req.appIcon} {req.appNameAr}
                        </strong>
                        <div className="muted" style={{ fontSize: 12 }} dir="ltr">
                          {req.appCode} · {Number(req.monthlyPrice).toFixed(2)} SAR
                        </div>
                      </td>
                      <td>{req.requesterLabel}</td>
                      <td>{req.note || '—'}</td>
                      <td>
                        <span className={`chip${req.status === 'pending' ? ' on' : ''}`}>
                          {req.status === 'pending'
                            ? 'بانتظار الموافقة'
                            : req.status === 'approved'
                              ? 'تمت الموافقة'
                              : 'مرفوض'}
                        </span>
                      </td>
                      <td>
                        <input
                          className="input"
                          placeholder="ملاحظة للعميل (اختياري)…"
                          value={decisionNotes[req.id] ?? req.decisionNote ?? ''}
                          onChange={(event) =>
                            setDecisionNotes((curr) => ({ ...curr, [req.id]: event.target.value }))
                          }
                        />
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6 }}>
                          <button
                            className="btn primary"
                            type="button"
                            disabled={!canWrite || busy === req.id}
                            onClick={() => void decide(req, 'approved')}
                          >
                            موافقة وتفعيل
                          </button>
                          <button
                            className="btn"
                            type="button"
                            disabled={!canWrite || busy === req.id}
                            onClick={() => void decide(req, 'rejected')}
                          >
                            رفض
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'tenant_direct' && (
        <section className="card" style={{ display: 'grid', gap: 12 }}>
          <h2 style={{ marginTop: 0 }}>تفعيل أو إيقاف باقة مباشرة لأي منشأة</h2>
          <label className="field" style={{ maxWidth: 420 }}>
            <span>اختر المنشأة</span>
            <select
              className="input"
              value={selectedTenantId}
              onChange={(event) => setSelectedTenantId(event.target.value)}
            >
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name} ({tenant.code})
                </option>
              ))}
            </select>
          </label>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
            {apps
              .filter((app) => !app.isCore)
              .map((app) => (
                <article key={app.code} className="card" style={{ display: 'grid', gap: 8 }}>
                  <strong>
                    {app.icon ?? '📦'} {app.nameAr} <span dir="ltr">({app.code})</span>
                  </strong>
                  <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                    {app.descriptionAr}
                  </p>
                  <div className="row" style={{ gap: 6 }}>
                    <button
                      className="btn primary"
                      type="button"
                      disabled={!canWrite || !selectedTenantId || busy === `${selectedTenantId}:${app.code}`}
                      onClick={() => void toggleForTenant(app.code, true, app.nameAr)}
                    >
                      تفعيل للمنشأة
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={!canWrite || !selectedTenantId || busy === `${selectedTenantId}:${app.code}`}
                      onClick={() => void toggleForTenant(app.code, false, app.nameAr)}
                    >
                      إيقاف
                    </button>
                  </div>
                </article>
              ))}
          </div>
        </section>
      )}

      {tab === 'catalog' && (
        <div className="grid" style={{ gap: 12 }}>
          {apps.map((app) => (
            <article key={app.code} className="card" style={{ display: 'grid', gap: 8 }}>
              <strong>
                {app.icon ?? '📦'} {app.nameAr} <span dir="ltr">({app.code})</span>
              </strong>
              <p className="muted" style={{ margin: 0 }}>
                {app.descriptionAr}
                {app.isCore ? ' · مشحونة مع النظام' : ''}
              </p>
              <label className="field">
                <span>السعر الشهري (SAR)</span>
                <input
                  className="input"
                  dir="ltr"
                  value={drafts[app.code] ?? app.monthlyPrice}
                  disabled={!canWrite}
                  onChange={(event) => setDrafts({ ...drafts, [app.code]: event.target.value })}
                />
              </label>
              <span>
                <button
                  className="btn primary"
                  type="button"
                  disabled={!canWrite || busy === app.code}
                  onClick={() => void save(app, app.isActive)}
                >
                  حفظ السعر
                </button>{' '}
                <button
                  className="btn"
                  type="button"
                  disabled={!canWrite || busy === app.code}
                  onClick={() => void save(app, !app.isActive)}
                >
                  {app.isActive ? 'إيقاف البيع' : 'إعادة البيع'}
                </button>
              </span>
            </article>
          ))}
        </div>
      )}
    </Screen>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : 'تعذر إكمال الطلب';
}
