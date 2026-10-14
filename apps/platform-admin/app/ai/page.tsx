'use client';

import { useEffect, useState } from 'react';

import { Screen } from '../../components/screen';
import { ApiError, apiData, apiPost, apiPut } from '../../lib/api';
import { useSession } from '../../lib/session';

type PlatformAi = {
  provider: string;
  model: string;
  baseUrl: string;
  enabled: boolean;
  defaultMonthlyTokenLimit: number;
  costPerMillionIn: string;
  costPerMillionOut: string;
  hasApiKey: boolean;
};

export default function PlatformAiPage() {
  const { canConsole } = useSession();
  const canWrite = canConsole('console.settings.manage');
  const [settings, setSettings] = useState<PlatformAi>();
  const [provider, setProvider] = useState('local');
  const [model, setModel] = useState('local-grounded');
  const [baseUrl, setBaseUrl] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [tokenLimit, setTokenLimit] = useState('200000');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [perIn, setPerIn] = useState('0');
  const [perOut, setPerOut] = useState('0');
  const [tenantId, setTenantId] = useState('');
  const [suspended, setSuspended] = useState(true);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function reload() {
    const next = await apiData<PlatformAi>('/platform/ai/settings');
    setSettings(next);
    setProvider(next.provider);
    setModel(next.model);
    setBaseUrl(next.baseUrl);
    setEnabled(next.enabled);
    setTokenLimit(String(next.defaultMonthlyTokenLimit));
    setPerIn(next.costPerMillionIn);
    setPerOut(next.costPerMillionOut);
  }

  useEffect(() => {
    void reload().catch((error: unknown) => setMessage(error instanceof ApiError ? error.message : String(error)));
  }, []);

  return (
    <Screen
      title="المساعد المحاسبي"
      subtitle="مزود النموذج ومفتاحه المشفر، وإيقاف المساعد لمنشأة بعينها. المفتاح لا يُعرض بعد الحفظ."
      crumbs={['المنصة', 'المساعد']}
    >
      {message ? <p className="muted">{message}</p> : null}
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setMessage('');
          void apiPut('/platform/ai/settings', {
            provider,
            model,
            baseUrl,
            enabled,
            defaultMonthlyTokenLimit: Number(tokenLimit),
            apiKey: apiKey || undefined,
            clearApiKey: clearKey,
            costPerMillionIn: perIn,
            costPerMillionOut: perOut,
          })
            .then(() => {
              setApiKey('');
              setClearKey(false);
              return reload();
            })
            .then(() => setMessage('حُفظ إعداد المساعد. المفتاح يبقى مشفراً.'))
            .catch((error: unknown) => setMessage(error instanceof ApiError ? error.message : String(error)))
            .finally(() => setBusy(false));
        }}
      >
        <div className="form-grid">
          <label className="field">
            <span>المزود</span>
            <select className="input" value={provider} disabled={!canWrite} onChange={(event) => setProvider(event.target.value)}>
              <option value="local">محلي</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label className="field">
            <span>النموذج</span>
            <input className="input" dir="ltr" value={model} disabled={!canWrite} onChange={(event) => setModel(event.target.value)} />
          </label>
          <label className="field">
            <span>رابط الأساس</span>
            <input className="input" dir="ltr" value={baseUrl} disabled={!canWrite} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com" />
          </label>
          <label className="field">
            <span>حد التوكنز الافتراضي</span>
            <input className="input" dir="ltr" value={tokenLimit} disabled={!canWrite} onChange={(event) => setTokenLimit(event.target.value)} />
          </label>
          <label className="field">
            <span>مفتاح API</span>
            <input className="input" dir="ltr" type="password" value={apiKey} disabled={!canWrite} onChange={(event) => setApiKey(event.target.value)} placeholder={settings?.hasApiKey ? 'محفوظ — اكتب لاستبداله' : 'غير محفوظ'} />
          </label>
          <label className="field">
            <span>التفعيل العام</span>
            <select className="input" value={enabled ? 'on' : 'off'} disabled={!canWrite} onChange={(event) => setEnabled(event.target.value === 'on')}>
              <option value="on">مفعّل</option>
              <option value="off">متوقف لكل المنشآت</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>
            <input type="checkbox" checked={clearKey} disabled={!canWrite} onChange={(event) => setClearKey(event.target.checked)} /> حذف المفتاح المحفوظ
          </span>
        </label>
        <button className="btn primary" type="submit" disabled={!canWrite || busy}>
          {busy ? 'جارٍ الحفظ…' : 'حفظ'}
        </button>
      </form>

      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setMessage('');
          void apiPost(`/platform/ai/tenants/${tenantId}/suspension`, { suspended })
            .then(() => setMessage(suspended ? 'تم إيقاف المساعد لهذه المنشأة.' : 'تم إعادة تفعيل المساعد.'))
            .catch((error: unknown) => setMessage(error instanceof ApiError ? error.message : String(error)))
            .finally(() => setBusy(false));
        }}
      >
        <h2>إيقاف منشأة</h2>
        <div className="form-grid">
          <label className="field">
            <span>معرّف المنشأة</span>
            <input className="input" dir="ltr" value={tenantId} onChange={(event) => setTenantId(event.target.value)} />
          </label>
          <label className="field">
            <span>الحالة</span>
            <select className="input" value={suspended ? 'off' : 'on'} onChange={(event) => setSuspended(event.target.value === 'off')}>
              <option value="off">إيقاف</option>
              <option value="on">تفعيل</option>
            </select>
          </label>
        </div>
        <button className="btn" type="submit" disabled={!canWrite || busy || !tenantId}>
          تطبيق
        </button>
      </form>
    </Screen>
  );
}
