'use client';

import { useEffect, useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiData, apiPost, apiPut } from '../../../lib/api';

type Settings = {
  enabled: boolean;
  platformSuspended: boolean;
  platformEnabled: boolean;
  provider: string | null;
  effectiveProvider: string;
  model: string | null;
  effectiveModel: string;
  baseUrl?: string | null;
  effectiveBaseUrl?: string;
  monthlyTokenLimit: number | null;
  monthlyCostLimit: string | null;
  hasPlatformKey: boolean;
  hasTenantApiKey?: boolean;
  apiKeyMasked?: string | null;
  usage: {
    tokens: number;
    spent: string;
    tokenLimit: number | null;
    costLimit: string | null;
    period: string;
  };
};

const MODEL_SUGGESTIONS: Record<string, string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  anthropic: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest'],
  gemini: ['gemini-2.0-flash', 'gemini-1.5-pro'],
  custom: ['gpt-4o-mini', 'llama-3.3-70b-instruct', 'deepseek-chat'],
  local: ['local-grounded'],
};

export default function AiSettingsPage() {
  const [settings, setSettings] = useState<Settings>();
  const [enabled, setEnabled] = useState(true);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [tokenLimit, setTokenLimit] = useState('');
  const [costLimit, setCostLimit] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string }>();

  async function reload() {
    const next = await apiData<Settings>('/ai/settings');
    setSettings(next);
    setEnabled(next.enabled);
    setProvider(next.provider ?? '');
    setModel(next.model ?? '');
    setBaseUrl(next.baseUrl ?? '');
    setApiKey('');
    setTokenLimit(next.monthlyTokenLimit === null ? '' : String(next.monthlyTokenLimit));
    setCostLimit(next.monthlyCostLimit ?? '');
  }

  useEffect(() => {
    void reload().catch((error: unknown) =>
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) }),
    );
  }, []);

  async function testConnection() {
    setTesting(true);
    setNotice(undefined);
    try {
      const res = await apiPost<{
        data: { ok: boolean; provider: string; model: string; latencyMs: number; reply: string };
      }>('/ai/settings/test', {});
      const payload = ('provider' in res ? res : res.data) as {
        provider: string;
        model: string;
        latencyMs: number;
        reply: string;
      };
      setNotice({
        kind: 'ok',
        text: `نجح فحص الاتصال (${payload.provider} · ${payload.model} · ${payload.latencyMs}ms): ${payload.reply}`,
      });
    } catch (error) {
      setNotice({
        kind: 'danger',
        text: error instanceof ApiError ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  }

  async function clearSavedKey() {
    setBusy(true);
    setNotice(undefined);
    try {
      await apiPut('/ai/settings', {
        enabled,
        provider: provider || null,
        model: model || null,
        baseUrl: baseUrl || null,
        clearApiKey: true,
        monthlyTokenLimit: tokenLimit === '' ? null : Number(tokenLimit),
        monthlyCostLimit: costLimit || null,
      });
      await reload();
      setNotice({ kind: 'info', text: 'تم حذف مفتاح API الخاص بالمنشأة.' });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const activeProviderKey = provider || settings?.effectiveProvider || 'local';
  const suggestedModels = MODEL_SUGGESTIONS[activeProviderKey] ?? [];

  return (
    <Screen
      title="إعدادات المساعد الذكي وربط API"
      subtitle="تكوين مزوّد الذكاء الاصطناعي (OpenAI / Anthropic Claude / Google Gemini / OpenAI-Compatible API) ومفتاح الـ API وحدود الاستهلاك."
      crumbs={['الإعدادات', 'المساعد الذكي']}
    >
      <Notice notice={notice} />
      {settings?.platformSuspended ? (
        <p className="alert warn">أوقف مشغّل المنصة المساعد لهذه المنشأة.</p>
      ) : null}

      <div className="kpi-grid">
        <div className="kpi">
          <span>حالة المساعد</span>
          <strong>{enabled ? 'مفعّل' : 'متوقف'}</strong>
        </div>
        <div className="kpi">
          <span>المزوّد الفعّال</span>
          <strong dir="ltr">{settings?.effectiveProvider ?? 'local'}</strong>
        </div>
        <div className="kpi">
          <span>النموذج الفعّال</span>
          <strong dir="ltr">{settings?.effectiveModel ?? 'local-grounded'}</strong>
        </div>
        <div className="kpi">
          <span>استهلاك الشهر ({settings?.usage.period ?? '—'})</span>
          <strong>{(settings?.usage.tokens ?? 0).toLocaleString('ar-SA')} توكن</strong>
        </div>
      </div>

      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setNotice(undefined);
          void apiPut('/ai/settings', {
            enabled,
            provider: provider || null,
            model: model || null,
            baseUrl: baseUrl.trim() || null,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            monthlyTokenLimit: tokenLimit === '' ? null : Number(tokenLimit),
            monthlyCostLimit: costLimit || null,
          })
            .then(() => reload())
            .then(() => setNotice({ kind: 'ok', text: 'حُفظت إعدادات المساعد الذكي ومفتاح API بنجاح.' }))
            .catch((error: unknown) =>
              setNotice({
                kind: 'danger',
                text: error instanceof ApiError ? error.message : String(error),
              }),
            )
            .finally(() => setBusy(false));
        }}
      >
        <h3 style={{ marginTop: 0 }}>إعدادات مزوّد الذكاء الاصطناعي (AI API)</h3>
        <div className="form-grid">
          <label className="field">
            <span>تفعيل المساعد في المنشأة</span>
            <select
              className="input"
              value={enabled ? 'on' : 'off'}
              onChange={(event) => setEnabled(event.target.value === 'on')}
            >
              <option value="on">مفعّل</option>
              <option value="off">متوقف</option>
            </select>
          </label>

          <label className="field">
            <span>مزوّد الذكاء الاصطناعي (Provider)</span>
            <select
              className="input"
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
            >
              <option value="">وراثة إعداد المنصة الافتراضي</option>
              <option value="openai">OpenAI (GPT-4o / GPT-4.1)</option>
              <option value="anthropic">Anthropic (Claude 3.5 Sonnet / Haiku)</option>
              <option value="gemini">Google Gemini API</option>
              <option value="custom">مزوّد متوافق مع OpenAI API (OpenRouter / Groq / vLLM)</option>
              <option value="local">محلي مدمج — إجابات محاسبية مباشرة من مجاميع المنشأة</option>
            </select>
          </label>

          <label className="field">
            <span>اسم النموذج (Model)</span>
            <input
              className="input mono"
              dir="ltr"
              list="ai-models-list"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={settings?.effectiveModel || 'gpt-4o-mini'}
            />
            <datalist id="ai-models-list">
              {suggestedModels.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </label>

          <label className="field">
            <span>مفتاح API السري (API Key)</span>
            <input
              className="input mono"
              type="password"
              dir="ltr"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                settings?.apiKeyMasked
                  ? `محفوظ (${settings.apiKeyMasked}) — اتركه فارغاً للإبقاء عليه`
                  : 'sk-... أو claude-... أو AIza...'
              }
            />
          </label>

          <label className="field">
            <span>رابط نقطة النهاية المخصّص (Base URL — اختياري)</span>
            <input
              className="input mono"
              dir="ltr"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={
                provider === 'anthropic'
                  ? 'https://api.anthropic.com'
                  : provider === 'gemini'
                    ? 'https://generativelanguage.googleapis.com/v1beta/openai'
                    : 'https://api.openai.com'
              }
            />
          </label>

          <label className="field">
            <span>حد التوكنز الشهري</span>
            <input
              className="input"
              dir="ltr"
              inputMode="numeric"
              value={tokenLimit}
              placeholder="200000"
              onChange={(event) => setTokenLimit(event.target.value)}
            />
          </label>

          <label className="field">
            <span>سقف التكلفة الشهري (USD)</span>
            <input
              className="input"
              dir="ltr"
              value={costLimit}
              placeholder="25.00"
              onChange={(event) => setCostLimit(event.target.value)}
            />
          </label>
        </div>

        <p className="muted" style={{ marginTop: 12 }}>
          الاستهلاك هذا الشهر ({settings?.usage.period ?? '—'}):{' '}
          <strong>{settings?.usage.tokens ?? 0}</strong> توكن · التكلفة التقديرية:{' '}
          <strong>${settings?.usage.spent ?? '0.00'}</strong>.{' '}
          {settings?.hasTenantApiKey
            ? `مفتاح API خاص بالمنشأة محفوظ ومشفّر (${settings.apiKeyMasked ?? '••••'}).`
            : settings?.hasPlatformKey
              ? 'يستخدم مفتاح المنصة السحابي المشترك.'
              : 'لا يوجد مفتاح API خارجي حالياً — يعمل بالمحرك المحاسبي المحلي المدمج.'}
        </p>

        <div className="toolbar" style={{ marginTop: 14 }}>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ الحفظ…' : 'حفظ إعدادات المساعد'}
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy || testing}
            onClick={() => void testConnection()}
          >
            {testing ? 'جارٍ الاختبار…' : 'فحص الاتصال بـ AI API'}
          </button>
          {settings?.hasTenantApiKey ? (
            <button
              className="btn danger"
              type="button"
              disabled={busy}
              onClick={() => void clearSavedKey()}
            >
              مسح مفتاح API المحفوظ
            </button>
          ) : null}
        </div>
      </form>
    </Screen>
  );
}
