'use client';

import { useEffect, useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiList, apiPost } from '../../../lib/api';
import { cashLocationLabel, listCashLocations, type CashLocation } from '../../../lib/lookups';

type Provider = 'moyasar' | 'hyperpay' | 'tap';
type Config = {
  provider: Provider;
  label: string;
  isActive: boolean;
  simulation: boolean;
  currency: string;
  publishableKey: string | null;
  cashLocationId: string | null;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  webhookUrl: string;
  configured: boolean;
};

const fallback: Config[] = (['moyasar', 'hyperpay', 'tap'] as Provider[]).map((provider) => ({
  provider,
  label: provider === 'moyasar' ? 'ميسر' : provider === 'hyperpay' ? 'HyperPay' : 'Tap',
  isActive: false,
  simulation: true,
  currency: 'SAR',
  publishableKey: null,
  cashLocationId: null,
  hasApiKey: false,
  hasWebhookSecret: false,
  webhookUrl: '',
  configured: false,
}));

export default function PaymentSettingsPage() {
  const [configs, setConfigs] = useState<Config[]>(fallback);
  const [locations, setLocations] = useState<CashLocation[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { apiKey: string; webhookSecret: string; publishableKey: string; cashLocationId: string; simulation: boolean; isActive: boolean }>>({});
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string }>();

  async function reload() {
    const [next, cash] = await Promise.all([apiList<Config>('/payments/providers'), listCashLocations()]);
    setConfigs(next.length ? next : fallback);
    setLocations(cash);
    setDrafts(Object.fromEntries((next.length ? next : fallback).map((row) => [row.provider, {
      apiKey: '',
      webhookSecret: '',
      publishableKey: row.publishableKey ?? '',
      cashLocationId: row.cashLocationId ?? '',
      simulation: row.simulation,
      isActive: row.isActive,
    }])));
  }

  useEffect(() => {
    void reload().catch((error: unknown) => setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) }));
  }, []);

  return (
    <Screen title="روابط الدفع" subtitle="اربط ميسر أو HyperPay أو Tap. المفتاح السري لا يُعرض بعد الحفظ، والرواتب لا تُدفع من هنا." crumbs={['الإعدادات', 'المدفوعات']}>
      <Notice notice={notice} />
      <div className="grid cols">
        {configs.map((config) => {
          const draft = drafts[config.provider] ?? { apiKey: '', webhookSecret: '', publishableKey: '', cashLocationId: '', simulation: true, isActive: false };
          return (
            <form key={config.provider} className="card" onSubmit={(event) => {
              event.preventDefault();
              setBusy(config.provider);
              setNotice(undefined);
              void apiPost('/payments/providers', {
                provider: config.provider,
                apiKey: draft.apiKey || undefined,
                webhookSecret: draft.webhookSecret || undefined,
                publishableKey: draft.publishableKey,
                cashLocationId: draft.cashLocationId || null,
                simulation: draft.simulation,
                isActive: draft.isActive,
              })
                .then(async () => {
                  setNotice({ kind: 'ok', text: `تم حفظ ${config.label}` });
                  await reload();
                })
                .catch((error: unknown) => setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) }))
                .finally(() => setBusy(''));
            }}>
              <h2>{config.label}</h2>
              <p className="muted">{config.configured ? (config.hasApiKey ? 'المفتاح محفوظ' : 'بدون مفتاح') : 'غير مربوط'} · {draft.simulation ? 'محاكاة' : 'مباشر'}</p>
              <label className="field"><span>مفتاح API</span><input className="input" dir="ltr" type="password" autoComplete="off" value={draft.apiKey} placeholder={config.hasApiKey ? '•••• محفوظ' : 'sk_...'} onChange={(event) => setDrafts({ ...drafts, [config.provider]: { ...draft, apiKey: event.target.value } })} /></label>
              <label className="field"><span>سر الويبهوك</span><input className="input" dir="ltr" type="password" autoComplete="off" value={draft.webhookSecret} placeholder={config.hasWebhookSecret ? '•••• محفوظ' : ''} onChange={(event) => setDrafts({ ...drafts, [config.provider]: { ...draft, webhookSecret: event.target.value } })} /></label>
              <label className="field"><span>المفتاح العام / Entity ID</span><input className="input" dir="ltr" value={draft.publishableKey} onChange={(event) => setDrafts({ ...drafts, [config.provider]: { ...draft, publishableKey: event.target.value } })} /></label>
              <label className="field">
                <span>صندوق سند القبض</span>
                <select className="input" value={draft.cashLocationId} onChange={(event) => setDrafts({ ...drafts, [config.provider]: { ...draft, cashLocationId: event.target.value } })}>
                  <option value="">— الافتراضي للفرع —</option>
                  {locations.map((row) => <option key={row.id} value={row.id}>{cashLocationLabel(row)}</option>)}
                </select>
              </label>
              <label className="check"><input type="checkbox" checked={draft.simulation} onChange={(event) => setDrafts({ ...drafts, [config.provider]: { ...draft, simulation: event.target.checked } })} /> وضع المحاكاة</label>
              <label className="check"><input type="checkbox" checked={draft.isActive} onChange={(event) => setDrafts({ ...drafts, [config.provider]: { ...draft, isActive: event.target.checked } })} /> مفعّل</label>
              {config.webhookUrl && <p className="muted" dir="ltr">{config.webhookUrl}</p>}
              <button className="btn primary" type="submit" disabled={busy === config.provider}>حفظ</button>
            </form>
          );
        })}
      </div>
    </Screen>
  );
}
