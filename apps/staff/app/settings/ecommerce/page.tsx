'use client';

import { useEffect, useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError } from '../../../lib/api';
import {
  connectEcommerceStore,
  deleteEcommerceStore,
  ecommerceProviders,
  ecommerceStores,
  syncEcommerceStore,
  type EcommerceProvider,
  type EcommerceProviderView,
  type EcommerceStore,
} from '../../../lib/ecommerce';

const labels: Record<EcommerceProvider, string> = { salla: 'سلة', zid: 'زد', shopify: 'Shopify' };

export default function EcommerceSettingsPage() {
  const [providers, setProviders] = useState<EcommerceProviderView[]>([]);
  const [stores, setStores] = useState<EcommerceStore[]>([]);
  const [provider, setProvider] = useState<EcommerceProvider>('salla');
  const [apiKey, setApiKey] = useState('');
  const [storeUrl, setStoreUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [branchId, setBranchId] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string }>();

  async function reload() {
    const [nextProviders, nextStores] = await Promise.all([ecommerceProviders(), ecommerceStores()]);
    setProviders(nextProviders);
    setStores(nextStores);
  }

  useEffect(() => {
    void reload().catch((error: unknown) =>
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) }),
    );
  }, []);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setNotice(undefined);
    try {
      await action();
      await reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy('');
    }
  }

  return (
    <Screen
      title="🛒 تكامل المتاجر الإلكترونية"
      subtitle="متجري في سلة · متجري في زد · Shopify — اربط المتجر، اختبر الرمز، ثم ابدأ مزامنة الطلبات والمخزون. مفاتيح الربط لا تُعرض بعد الحفظ."
      crumbs={['الإعدادات', 'التجارة الإلكترونية']}
      actions={<span className="chip">{stores.length} متجر</span>}
    >
      <Notice notice={notice} />

      <div className="card">
        <h3>🔗 ربط متجر</h3>
        <div className="form-grid">
          <label className="field">
            <span>المزوّد</span>
            <select
              value={provider}
              onChange={(event) => setProvider(event.target.value as EcommerceProvider)}
            >
              {(providers.length
                ? providers
                : (['salla', 'zid', 'shopify'] as EcommerceProvider[]).map((value) => ({
                    provider: value,
                    label: labels[value],
                    supports: [],
                  }))
              ).map((item) => (
                <option key={item.provider} value={item.provider}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field wide">
            <span>{provider === 'shopify' ? 'Store URL' : 'API Key / OAuth code'}</span>
            <input
              dir="ltr"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="يُشفّر ولا يُعرض بعد الحفظ"
            />
          </label>
          {provider === 'shopify' ? (
            <label className="field wide">
              <span>عنوان متجر Shopify</span>
              <input
                dir="ltr"
                value={storeUrl}
                onChange={(event) => setStoreUrl(event.target.value)}
                placeholder="https://shop.example.com"
              />
            </label>
          ) : null}
          <label className="field">
            <span>رمز HMAC للويب هوك (اختياري)</span>
            <input
              dir="ltr"
              type="password"
              value={webhookSecret}
              onChange={(event) => setWebhookSecret(event.target.value)}
              placeholder="إن تركته فارغاً يُستخدم الرمز"
            />
          </label>
          <label className="field">
            <span>معرّف الفرع الافتراضي (اختياري)</span>
            <input
              dir="ltr"
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
              placeholder="يُختار أول فرع إن تركته فارغاً"
            />
          </label>
        </div>
        <div className="toolbar">
          <button
            className="btn primary"
            type="button"
            disabled={busy !== '' || apiKey.trim() === ''}
            onClick={() =>
              void run('connect', async () => {
                const saved = await connectEcommerceStore({
                  provider,
                  apiKey,
                  ...(storeUrl ? { storeUrl } : {}),
                  ...(webhookSecret ? { webhookSecret } : {}),
                  ...(branchId ? { settings: { branchId } } : {}),
                });
                setApiKey('');
                setWebhookSecret('');
                setNotice({
                  kind: saved.status === 'active' ? 'ok' : 'warn',
                  text:
                    saved.status === 'active'
                      ? `تم ربط متجر ${labels[provider]}`
                      : `تم الحفظ لكن حالة الرمز: ${saved.lastError ?? 'error'}`,
                });
              })
            }
          >
            🔗 ربط واختبار
          </button>
          {busy ? <span className="chip">جارٍ التنفيذ…</span> : null}
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <h3>🏪 المتاجر المرتبطة</h3>
          <button className="btn" type="button" onClick={() => void run('reload', reload)}>
            🔄 تحديث
          </button>
        </div>
        {stores.length === 0 ? (
          <p className="muted">لا توجد متاجر مرتبطة بعد.</p>
        ) : (
          <div className="stack">
            {stores.map((store) => (
              <div className="card inset" key={store.id}>
                <div className="toolbar">
                  <div>
                    <strong>
                      {labels[store.provider]} — {store.storeUrl ?? store.remoteStoreId ?? 'متجر تجريبي'}
                    </strong>
                    <div className="muted">
                      الرمز: {store.accessTokenMasked} · آخر مزامنة:{' '}
                      {store.lastSyncAt ? new Date(store.lastSyncAt).toLocaleString('ar') : 'لم تبدأ'}
                    </div>
                  </div>
                  <span className={`chip ${store.status === 'active' ? 'success' : 'danger'}`}>
                    {store.status === 'active' ? 'مفعّل' : 'error'}
                  </span>
                </div>
                {store.lastError ? <p className="notice danger">⚠️ {store.lastError}</p> : null}
                <div className="toolbar">
                  <button
                    className="btn primary"
                    type="button"
                    disabled={busy !== ''}
                    onClick={() =>
                      void run(`sync-${store.id}`, async () => {
                        const result = await syncEcommerceStore(store.id);
                        setNotice({
                          kind: result.failed ? 'warn' : 'ok',
                          text: `مزامنة الطلبات: جُلب ${result.fetched} · أُنشئ ${result.created} · استورد ${result.imported}`,
                        });
                      })
                    }
                  >
                    🔄 مزامنة الطلبات
                  </button>
                  <button
                    className="btn danger"
                    type="button"
                    disabled={busy !== ''}
                    onClick={() => {
                      if (window.confirm('حذف ربط المتجر؟'))
                        void run(`delete-${store.id}`, async () => deleteEcommerceStore(store.id));
                    }}
                  >
                    حذف الربط
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Screen>
  );
}
