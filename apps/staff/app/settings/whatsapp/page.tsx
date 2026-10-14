'use client';

import { useEffect, useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError } from '../../../lib/api';
import {
  saveWhatsappSettings,
  testWhatsapp,
  whatsappSettings,
  type WhatsappSettingsInput,
  type WhatsappSettingsView,
} from '../../../lib/whatsapp';

/**
 * 📱 إعدادات واتساب — everything `Class/WhatsAppSender.cs` (267) kept inside itself.
 *
 * The desktop had no settings window for this at all: `Class/Session.cs` (L12-L31)
 * opened a Chrome profile on the cashier's machine and `WhatsAppSender.cs` drove it with
 * Selenium, so «which number am I?» was answered by whoever had scanned the QR code
 * (`Class/WhatsAppSender.cs` L28-L60), the country code was a literal
 * (`if (!text.StartsWith("966")) text = "966" + text.TrimStart('0');` — L113-L116), and
 * the invoice was always attached as a PDF of `rptPOSA4.repx`.
 *
 * A tenant on a server cannot scan a QR code, so the same questions are asked here, in
 * the desktop's own words wherever the desktop had words:
 *
 *   تفعيل — the gateway is off until someone switches it on.
 *   عنوان الواتساب — Meta's phone-number-id; what the QR scan used to supply.
 *   الرمز — the access token, written once and never shown again (masked as `****…`).
 *   رمز الدولة — «966» by default, for the tenant whose customers are elsewhere.
 *   📎 إرفاق الفاتورة — the desktop always did; here a tenant may want words only.
 *   🧪 محاكاة — so a demo tenant can press 💬 without a live WhatsApp number.
 *   🧪 اختبار + Logging — the desktop's answer was a message box that closed; here the
 *     answer is kept on the row and printed under the buttons.
 */
const blank: WhatsappSettingsView = {
  active: false,
  phoneNumberId: '',
  hasToken: false,
  tokenMasked: null,
  defaultCountryCode: '966',
  attachDocument: true,
  simulation: true,
  baseUrl: 'https://graph.facebook.com',
  lastTest: null,
  updatedAt: null,
};

export default function WhatsappSettingsPage() {
  const [saved, setSaved] = useState<WhatsappSettingsView>(blank);
  const [form, setForm] = useState<WhatsappSettingsView>(blank);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string } | undefined>();

  async function reload() {
    const next = await whatsappSettings();
    setSaved(next.settings);
    // The first paint is the saved row; after that the user's typing stays, and only what
    // the server knows and the screen cannot type (the token) is refreshed.
    setForm((previous) => ({
      ...previous,
      hasToken: next.settings.hasToken,
      tokenMasked: next.settings.tokenMasked,
      phoneNumberId: previous.phoneNumberId || next.settings.phoneNumberId,
      defaultCountryCode: previous.defaultCountryCode || next.settings.defaultCountryCode,
    }));
    setLoading(false);
  }

  useEffect(() => {
    void reload().catch((error: unknown) => {
      setLoading(false);
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    });
  }, []);

  async function run(label: string, action: () => Promise<unknown>) {
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

  const setField = <K extends keyof WhatsappSettingsView>(key: K, value: WhatsappSettingsView[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }));

  const input: WhatsappSettingsInput = {
    active: form.active,
    phoneNumberId: form.phoneNumberId,
    defaultCountryCode: form.defaultCountryCode,
    attachDocument: form.attachDocument,
    simulation: form.simulation,
    ...(token ? { accessToken: token } : {}),
  };

  return (
    <Screen
      title="📱 إعدادات واتساب"
      subtitle="من أي رقم تخرج الرسائل، وبأي رمز، وإلى أي بلد يُضاف رقم العميل الناقص. 💬 «واتساب» على نافذة الفاتورة يقرأ هذه الإعدادات، ولا يُرسل منها إلا ما كان مفعّلاً."
      crumbs={['الإعدادات', 'واتساب']}
      actions={<span className="chip">{saved.active ? 'مفعّل' : 'موقوف'}{saved.simulation ? ' · 🧪 محاكاة' : ''}</span>}
    >
      <Notice notice={notice} />
      {loading && (
        <div className="card grid" aria-busy="true">
          <p className="muted">جارٍ التحميل…</p>
        </div>
      )}

      <div className="card">
        <h3>⚙️ الإعدادات</h3>
        <div className="form-grid">
          <div className="field">
            <span>التفعيل</span>
            <label className="check">
              <input type="checkbox" checked={form.active} onChange={(event) => setField('active', event.target.checked)} />
              <span>تفعيل إرسال الفواتير عبر واتساب</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={form.attachDocument} onChange={(event) => setField('attachDocument', event.target.checked)} />
              <span>📎 إرفاق الفاتورة مع الرسالة</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={form.simulation} onChange={(event) => setField('simulation', event.target.checked)} />
              <span>🧪 محاكاة (لا تُرسل رسالة حقيقية)</span>
            </label>
          </div>
          <label className="field wide">
            <span>عنوان الواتساب (Phone Number ID)</span>
            <input dir="ltr" value={form.phoneNumberId} onChange={(event) => setField('phoneNumberId', event.target.value)} placeholder="109357128475620" />
            <small className="muted">يأتي من لوحة Meta · وهو ما كان يعطيه مسح رمز QR في النسخة المكتبية.</small>
          </label>
          <label className="field">
            <span>الرمز (Access Token)</span>
            <input
              dir="ltr"
              type="password"
              value={token}
              placeholder={form.hasToken ? `محفوظ (${form.tokenMasked ?? '****'})` : 'يُكتب مرة واحدة ولا يُعرض'}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <label className="field">
            <span>رمز الدولة</span>
            <input dir="ltr" value={form.defaultCountryCode} onChange={(event) => setField('defaultCountryCode', event.target.value)} placeholder="966" />
            <small className="muted">يُضاف إلى رقم العميل بعد حذف أصفاره الأولى — كان «966» ثابتاً في النسخة المكتبية.</small>
          </label>
          <label className="field wide">
            <span>عنوان الخدمة</span>
            <input dir="ltr" value={form.baseUrl} readOnly />
            <small className="muted">WhatsApp Cloud API · لا يحتاج إلى متصفّح ولا إلى جهاز الكاشير.</small>
          </label>
        </div>

        <div className="toolbar">
          <button
            type="button"
            className="btn primary"
            disabled={busy !== ''}
            onClick={() =>
              void run('save', async () => {
                const result = await saveWhatsappSettings(input);
                setToken('');
                setNotice({ kind: 'ok', text: `تم حفظ الإعدادات · ${result.settings.tokenMasked ?? 'بلا رمز'}` });
              })
            }
          >
            💾 حفظ
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== ''}
            onClick={() =>
              void run('test', async () => {
                const result = await testWhatsapp();
                setNotice({
                  kind: result.ok ? 'ok' : 'warn',
                  text: `${result.ok ? '✅' : '❌'} ${result.displayPhoneNumber ?? '—'} — ${result.message ?? result.status}`,
                });
              })
            }
          >
            🧪 اختبار
          </button>
          {busy !== '' ? <span className="chip">…</span> : null}
        </div>

        <h4>Logging</h4>
        <pre className="log" dir="ltr">
          {(saved.lastTest?.lines ?? []).join('\n') || (saved.lastTest ? JSON.stringify(saved.lastTest, null, 2) : '— لم يُجرَ اختبار بعد —')}
        </pre>
      </div>
    </Screen>
  );
}
