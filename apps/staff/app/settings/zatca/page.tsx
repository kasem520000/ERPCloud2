'use client';

import { useEffect, useState } from 'react';

import { DataTable, Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import {
  fillCsrFromCompany,
  generateCsr,
  renewCsid,
  requestComplianceCsid,
  requestProductionCsid,
  runComplianceCheck,
  saveZatcaSettings,
  toggleZatcaLink,
  zatcaView,
  type CsrProperties,
  type GeneratedCsr,
  type ZatcaView,
} from '../../../lib/einvoice';
import { ApiError } from '../../../lib/api';

/**
 * ⚙️ إعدادات الربط الضريبي - زاتكا ZATCA — the window, ported from
 * `Desktop_ERP/SmartAuditERP/Form_WPF/frmZatcaSetting.xaml` (472 lines) and `.xaml.cs`
 * (1160 lines). The labels are the desktop's own, in its own order:
 *
 *   📅 التاريخ · 🔑 OTP · ✅ تمكين Activate · 🧪 Simulation تجريبي · Sync manual ·
 *   🔴 Production ربط فعلي · 🔵 Compliance تجريبي ·
 *   📋 خصائص شهادة CSR — 🖥️ Serial Number (سريال الجهاز) · 🌍 Country Name (الدولة) ·
 *   🏢 Common Name (اسم المنشأة) · 🔢 Organization Identifier (الرقم الضريبي) ·
 *   🏭 Organization Name (اسم المنشأة) · 📄 Invoice Type (نوع الفواتير) ·
 *   🏗️ Industry (النشاط التجاري) · 🏬 Organization Unit (اسم الفرع) ·
 *   📍 Address (العنوان المختصر) ·
 *   🔄 تعبئة تلقائي · 💾 حفظ الإعدادات — Save Settings · 🧪 اختبار الربط —
 *   Test Compliance · 🔐 حفظ مفتاح التشفير — Get PCSID ·
 *   🔄 Renews CSID — تجديد الشهادة بعد 5 سنوات · ⚡ توليد — Generate ·
 *   ⏸ إيقاف الربط / ▶ تشغيل
 *
 * Three differences from the desktop, all forced by the platform and none of them a
 * behaviour change:
 *   1. «☁️ Load Data» is gone. It read `ProductionCsrResponse.txt` and
 *      `ComplianceCsrResponse.txt` from a folder on the cashier's own disk — there is no
 *      such folder on a server, and the credentials are entered where they are issued.
 *   2. 💾 حفظ الإعدادات no longer silently runs ⚡ توليد and the compliance request as the
 *      desktop did (`Generate(); SaveCSR(); ComplianceCSID();` L193-L196). They are separate
 *      buttons here, so a failed request is visible as such instead of being hidden inside
 *      a «تم الحفظ» message.
 *   3. The six «🧪 اختبار الربط» verdicts stay on the screen instead of appearing once in a
 *      message box, and the private key is shown once — at the moment it is generated.
 */
const CSR_FIELDS: Array<{ key: keyof CsrProperties; labelAr: string; readOnly?: boolean; dir?: 'ltr' }> = [
  { key: 'serialNumber', labelAr: '🖥️ Serial Number (سريال الجهاز)', readOnly: true, dir: 'ltr' },
  { key: 'countryName', labelAr: '🌍 Country Name (الدولة)', dir: 'ltr' },
  { key: 'commonName', labelAr: '🏢 Common Name (اسم المنشأة)' },
  { key: 'organizationIdentifier', labelAr: '🔢 Organization Identifier (الرقم الضريبي)', dir: 'ltr' },
  { key: 'organizationName', labelAr: '🏭 Organization Name (اسم المنشأة)' },
  { key: 'invoiceType', labelAr: '📄 Invoice Type (نوع الفواتير)', dir: 'ltr' },
  { key: 'industry', labelAr: '🏗️ Industry (النشاط التجاري)' },
  { key: 'organizationUnitName', labelAr: '🏬 Organization Unit (اسم الفرع)' },
  { key: 'address', labelAr: '📍 Address (العنوان المختصر)' },
];

export default function ZatcaSettingsPage() {
  const [view, setView] = useState<ZatcaView | undefined>();
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<ZatcaView['settings']>({ environment: 'compliance', simulation: false, active: true, syncManual: false, startDate: '', endDate: '' });
  const [csr, setCsr] = useState<CsrProperties>({ commonName: '', serialNumber: '', organizationIdentifier: '', organizationUnitName: '', organizationName: '', countryName: 'SA', invoiceType: '1100', address: '', industry: '' });
  const [otp, setOtp] = useState('');
  const [generated, setGenerated] = useState<GeneratedCsr | undefined>();
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string } | undefined>();

  async function reload() {
    const next = await zatcaView();
    setView(next);
    setSettings(next.settings);
    setCsr(next.csr);
    setLoading(false);
  }

  useEffect(() => {
    reload().catch((error: unknown) => {
      setLoading(false);
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    });
  }, []);

  async function run(label: string, action: () => Promise<{ message?: string; [key: string]: unknown }>) {
    setBusy(label);
    setNotice(undefined);
    try {
      const result = await action();
      setNotice({ kind: 'ok', text: String(result.message ?? 'تم') });
      await reload();
      return result;
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
      return undefined;
    } finally {
      setBusy('');
    }
  }

  const setField = <K extends keyof CsrProperties>(key: K, value: CsrProperties[K]) => setCsr((previous) => ({ ...previous, [key]: value }));

  const done = (key: string) => view?.checklist.find((row) => row.key === key)?.done ?? false;

  return (
    <Screen
      title="⚙️ إعدادات الربط الضريبي - زاتكا ZATCA"
      subtitle="التأهيل خطوة بخطوة: توليد الشهادة، ثم شهادة الامتثال بالـ OTP، ثم مفتاح التشفير، ثم اختبار الربط بالستة وثائق — وآخرها تشغيل الربط أو إيقافه."
      crumbs={['الإعدادات', 'إعدادات الربط الضريبي']}
      actions={
        <span className="chip">
          {view ? `${view.checklist.filter((row) => row.done).length} من ${view.checklist.length} خطوة` : '…'}
        </span>
      }
    >
      <Notice notice={notice} />
      {loading && <div className="card grid" aria-busy="true"><p className="muted">جارٍ التحميل…</p></div>}

      {view && (
        <>
          {/* ═══ Card 1: OTP + Activate + Mode ═══ */}
          <div className="card">
            <div className="form-grid">
              <label className="field">
                <span>📅 التاريخ</span>
                <input type="date" value={settings.startDate} onChange={(event) => setSettings({ ...settings, startDate: event.target.value })} />
              </label>
              <label className="field">
                <span>🔑 OTP</span>
                <input dir="ltr" value={otp} onChange={(event) => setOtp(event.target.value)} placeholder="الكود المرسل من هيئة الزكاة" />
              </label>
              <div className="field">
                <span>التفعيل ووضع الاتصال</span>
                <label className="check"><input type="checkbox" checked={settings.active} onChange={(event) => setSettings({ ...settings, active: event.target.checked })} /><span>✅ تمكين Activate</span></label>
                <label className="check"><input type="checkbox" checked={settings.simulation} onChange={(event) => setSettings({ ...settings, simulation: event.target.checked })} /><span>🧪 Simulation تجريبي</span></label>
                <label className="check"><input type="checkbox" checked={settings.syncManual} onChange={(event) => setSettings({ ...settings, syncManual: event.target.checked })} /><span>Sync manual</span></label>
              </div>
              <div className="field">
                <span>نوع الربط</span>
                <label className="check"><input type="radio" name="environment" checked={settings.environment === 'production'} onChange={() => setSettings({ ...settings, environment: 'production' })} /><span>🔴 Production ربط فعلي</span></label>
                <label className="check"><input type="radio" name="environment" checked={settings.environment === 'compliance'} onChange={() => setSettings({ ...settings, environment: 'compliance' })} /><span>🔵 Compliance تجريبي</span></label>
                <p className="small muted">من {settings.startDate || '—'} إلى {settings.endDate || '—'}</p>
              </div>
            </div>
          </div>

          {/* ═══ Card 2: CSR Properties ═══ */}
          <div className="card">
            <h3>📋 خصائص شهادة CSR</h3>
            <div className="toolbar">
              <button type="button" className="btn" disabled={busy !== ''} onClick={() => void run('fill', async () => {
                const filled = await fillCsrFromCompany();
                setCsr(filled.settings.csr);
                setSettings({ ...settings, startDate: filled.settings.settings.startDate, endDate: filled.settings.settings.endDate });
                if (filled.warnings.length > 0) setNotice({ kind: 'warn', text: filled.warnings.join(' · ') });
                return filled;
              })}>
                🔄 تعبئة تلقائي
              </button>
              {busy === 'fill' && <span className="chip">…</span>}
            </div>
            <div className="form-grid">
              {CSR_FIELDS.map((field) => (
                <label key={field.key} className="field wide">
                  <span>{field.labelAr}</span>
                  <input
                    dir={field.dir}
                    readOnly={field.readOnly}
                    value={csr[field.key]}
                    onChange={(event) => setField(field.key, event.target.value)}
                  />
                </label>
              ))}
            </div>
          </div>

          {/* ═══ Card 3: actions ═══ */}
          <div className="card">
            <div className="toolbar">
              <button type="button" className="btn primary" disabled={busy !== ''} onClick={() => void run('save', () => saveZatcaSettings({ ...settings, csr }))}>
                💾 حفظ الإعدادات — Save Settings
              </button>
              <button type="button" className="btn" disabled={busy !== '' || !otp} onClick={() => void run('compliance', () => requestComplianceCsid(otp))}>
                🔵 إصدار شهادة امتثال — Compliance CSID
              </button>
              <button type="button" className="btn" disabled={busy !== '' || !done('compliance-csid')} onClick={() => void run('production', () => requestProductionCsid())}>
                🔐 حفظ مفتاح التشفير — Get PCSID
              </button>
              <button type="button" className="btn" disabled={busy !== '' || !done('csr')} onClick={() => void run('check', () => runComplianceCheck())}>
                🧪 اختبار الربط — Test Compliance
              </button>
              <button type="button" className="btn" disabled={busy !== '' || !done('production-csid')} onClick={() => void run('renew', () => renewCsid())}>
                🔄 Renews CSID — تجديد الشهادة بعد 5 سنوات
              </button>
              <button type="button" className="btn" disabled={busy !== ''} onClick={() => void run('generate', async () => {
                const next = await generateCsr();
                setGenerated(next);
                return next;
              })}>
                ⚡ توليد — Generate
              </button>
              <button type="button" className="btn" disabled={busy !== '' || !view.link.canToggle} onClick={() => void run('link', () => toggleZatcaLink())}>
                {view.link.active ? '⏸ إيقاف الربط' : '▶ تشغيل'}
              </button>
            </div>

            <h3>خطوات التأهيل</h3>
            <div className="toolbar">
              {view.checklist.map((row) => (
                <span key={row.key} className="chip">
                  {row.done ? '✓' : '○'} {row.labelAr}
                </span>
              ))}
            </div>

            <h3>🔐 المفاتيح والشهادات</h3>
            <div className="form-grid">
              <label className="field"><span>شهادة CSR</span><input readOnly value={view.credential.csr ? `${view.credential.csr.slice(0, 42)}…` : '—'} dir="ltr" /></label>
              <label className="field"><span>المفتاح الخاص</span><input readOnly value={view.credential.privateKeyMasked ?? '—'} dir="ltr" /></label>
              <label className="field"><span>معرّف طلب الامتثال</span><input readOnly value={view.credential.requestId ?? '—'} dir="ltr" /></label>
              <label className="field"><span>شهادة الامتثال (CSID)</span><input readOnly value={view.credential.csidMasked ?? '—'} dir="ltr" /></label>
              <label className="field"><span>سرّ الامتثال</span><input readOnly value={view.credential.secretMasked ?? '—'} dir="ltr" /></label>
              <label className="field"><span>معرّف طلب الإنتاج</span><input readOnly value={view.credential.productionRequestId ?? '—'} dir="ltr" /></label>
              <label className="field"><span>شهادة الإنتاج (PCSID)</span><input readOnly value={view.credential.productionCsidMasked ?? '—'} dir="ltr" /></label>
              <label className="field"><span>سرّ الإنتاج</span><input readOnly value={view.credential.productionSecretMasked ?? '—'} dir="ltr" /></label>
            </div>
          </div>

          {generated && (
            <div className="card">
              <h3>⚡ الشهادة المولّدة — تُعرض مرة واحدة</h3>
              <p className="small muted">البصمة: <span dir="ltr">{generated.fingerprint}</span> · السريال: <span dir="ltr">{generated.serialNumber}</span></p>
              <label className="field wide">
                <span>المفتاح الخاص (انسخه الآن — لن يظهر مرة أخرى)</span>
                <textarea readOnly rows={5} dir="ltr" value={generated.privateKey} />
              </label>
              <label className="field wide">
                <span>طلب التوقيع CSR</span>
                <textarea readOnly rows={3} dir="ltr" value={generated.csr} />
              </label>
              {generated.revokedCredentials && <p className="small muted">🔄 أُلغيت الشهادات القديمة: الشهادة مرتبطة بالمفتاح الذي طُلبت به.</p>}
            </div>
          )}

          {view.onboarding.lastComplianceCheck && (
            <div className="card">
              <h3>🧪 آخر اختبار ربط — {view.onboarding.lastComplianceCheck.passed ? 'تم بنجاح' : 'فشل'}</h3>
              <DataTable
                rows={view.onboarding.lastComplianceCheck.checks}
                rowKey={(row) => row.key}
                columns={[
                  { key: 'labelAr', header: 'الوثيقة', cell: (row) => `${row.success ? '✓' : '✗'} ${row.labelAr}` },
                  { key: 'labelEn', header: 'الاسم في الديسكتوب', cell: (row) => row.labelEn },
                  { key: 'invoiceTypeCode', header: 'النوع', cell: (row) => row.invoiceTypeCode },
                  { key: 'typeName', header: 'الصنف', cell: (row) => row.typeName },
                  { key: 'status', header: 'الحالة', cell: (row) => row.status },
                  { key: 'messages', header: 'الملاحظات', cell: (row) => row.messages.join(' · ') || '—' },
                ]}
              />
            </div>
          )}
        </>
      )}
    </Screen>
  );
}
