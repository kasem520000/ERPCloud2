'use client';

import { useEffect, useMemo, useState } from 'react';

import { DataTable, Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import {
  gatewayTransactions,
  payWithGateway,
  paymentGatewaysView,
  refreshGatewayTransaction,
  savePaymentGateway,
  STATUS_LABELS,
  testPaymentGateway,
  type GatewayProvider,
  type GatewayView,
  type TransactionRow,
} from '../../../lib/payment-gateways';
import { ApiError } from '../../../lib/api';

/**
 * 💳 بوابات الدفع — the tab «إعدادات جيديا» of
 * `Desktop_ERP/SmartAuditERP/Form_WPF/frmSettings.xaml` (L1726-L1831) with the GroupBox
 * «NeoLeap» inside it, and the two POS save paths that charge a card
 * (`frmPOSBill.xaml.cs` L460-L492, `frmPOSPay.xaml.cs` L428-L441).
 *
 * The labels are the window's own, in its own order:
 *
 *   💳 إعدادات جيديا — تفعيل الدفع عن طريق جيديا · طباعة ايصال · المنفذ · المبلغ ·
 *   🧪 TEST · 💾 حفظ
 *   NeoLeap — تفعيل NeoLeap · طباعة إيصال NeoLeap · المنفذ · المبلغ · Token · Logging ·
 *   🧪 Test · 💾 حفظ
 *
 * Four things are here that the desktop had no room for, and each is forced by the
 * platform rather than invented:
 *   1. «المنفذ» is joined by «عنوان البوابة». The desktop wrote to COM1 at 38400 baud
 *      (`Geidea.cs` L54) or to a socket on the till; a server dials a URL, and the port
 *      alone is not an address.
 *   2. «رابط الإرجاع» (callbackUrl) — جيديا posts the result of a hosted session
 *      somewhere; the desktop read its answer off the serial cable and needed none.
 *   3. 🧪 Simulation, so a demo and a test suite can press 💳 without a live acquirer.
 *   4. 📜 آخر العمليات — the desktop kept no record at all: it printed a receipt and let
 *      the invoice's payment method say شبكة. Money taken through a server has to be
 *      provable after the fact, and a جيديا session has to be refreshable, because the
 *      cardholder finishes paying on the gateway's page, not in our tab.
 */
const PROVIDER_ORDER: GatewayProvider[] = ['geidea', 'neoleap'];

const blank = (provider: GatewayProvider): GatewayView => ({
  provider,
  labelAr: provider === 'geidea' ? 'جيديا' : 'NeoLeap',
  active: false,
  printReceipt: false,
  port: null,
  baseUrl: '',
  currency: 'SAR',
  merchantKey: '',
  hasSecret: false,
  secretMasked: null,
  callbackUrl: '',
  simulation: true,
  lastTest: null,
  updatedAt: null,
});

export default function PaymentGatewaysPage() {
  const [views, setViews] = useState<GatewayView[]>([]);
  const [forms, setForms] = useState<Record<string, GatewayView>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [testValues, setTestValues] = useState<Record<string, string>>({ geidea: '0.01', neoleap: '0.50' });
  const [payValues, setPayValues] = useState<Record<string, string>>({ geidea: '125.00', neoleap: '125.00' });
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string } | undefined>();

  async function reload() {
    const next = await paymentGatewaysView();
    setViews(next.providers);
    setForms((previous) => {
      const after: Record<string, GatewayView> = {};
      for (const provider of next.providers) after[provider.provider] = previous[provider.provider] ?? provider;
      return after;
    });
    const log = await gatewayTransactions({ limit: 25 });
    setTransactions(log.transactions);
    setLoading(false);
  }

  useEffect(() => {
    reload().catch((error: unknown) => {
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

  const setField = <K extends keyof GatewayView>(provider: GatewayProvider, key: K, value: GatewayView[K]) =>
    setForms((previous) => ({ ...previous, [provider]: { ...(previous[provider] ?? blank(provider)), [key]: value } }));

  const activeCount = useMemo(() => views.filter((view) => view.active).length, [views]);

  return (
    <Screen
      title="💳 بوابات الدفع — إعدادات جيديا · NeoLeap"
      subtitle="تفعيل البوابة، واختبارها بمبلغٍ رمزي، ثم أخذ الدفع بها من نقطة البيع. كل عملية تُسجَّل في «آخر العمليات»: ما طلبناه، وما أجابت به البوابة، وهل قُيّد المبلغ على الفاتورة."
      crumbs={['الإعدادات', 'بوابات الدفع']}
      actions={<span className="chip">{activeCount === 0 ? 'كل البوابات موقوفة' : `${activeCount} من ${PROVIDER_ORDER.length} بوابة مفعّلة`}</span>}
    >
      <Notice notice={notice} />
      {loading && (
        <div className="card grid" aria-busy="true">
          <p className="muted">جارٍ التحميل…</p>
        </div>
      )}

      {PROVIDER_ORDER.map((provider) => {
        const form = forms[provider] ?? blank(provider);
        const saved = views.find((view) => view.provider === provider);
        const geidea = provider === 'geidea';
        return (
          <div className="card" key={provider}>
            <h3>{geidea ? '💳 إعدادات جيديا' : 'NeoLeap'}</h3>
            <div className="form-grid">
              <div className="field">
                <span>التفعيل</span>
                <label className="check">
                  <input type="checkbox" checked={form.active} onChange={(event) => setField(provider, 'active', event.target.checked)} />
                  <span>{geidea ? 'تفعيل الدفع عن طريق جيديا' : 'تفعيل NeoLeap'}</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={form.printReceipt} onChange={(event) => setField(provider, 'printReceipt', event.target.checked)} />
                  <span>{geidea ? 'طباعة ايصال' : 'طباعة إيصال NeoLeap'}</span>
                </label>
                <label className="check">
                  <input type="checkbox" checked={form.simulation} onChange={(event) => setField(provider, 'simulation', event.target.checked)} />
                  <span>🧪 Simulation تجريبي</span>
                </label>
              </div>
              <label className="field">
                <span>المنفذ</span>
                <input dir="ltr" value={form.port ?? ''} onChange={(event) => setField(provider, 'port', event.target.value === '' ? null : Number(event.target.value))} />
              </label>
              <label className="field">
                <span>المبلغ</span>
                <input dir="ltr" value={testValues[provider] ?? ''} onChange={(event) => setTestValues((previous) => ({ ...previous, [provider]: event.target.value }))} />
                <small className="muted">{geidea ? 'يُستخدم في 🧪 TEST (0.01 افتراضياً)' : 'الاختبار يخصم 0.50 دائماً بمرجع تجريبي'}</small>
              </label>
              <label className="field wide">
                <span>{geidea ? 'عنوان البوابة' : 'عنوان الخدمة (يُشتقّ من المنفذ إن تُرك فارغاً)'}</span>
                <input dir="ltr" value={form.baseUrl} onChange={(event) => setField(provider, 'baseUrl', event.target.value)} placeholder={geidea ? 'https://api.ksamerchant.geidea.net' : 'http://127.0.0.1:8080'} />
              </label>
              <label className="field">
                <span>{geidea ? 'المعرّف العام (Merchant Key)' : 'Tranportal ID'}</span>
                <input dir="ltr" value={form.merchantKey} onChange={(event) => setField(provider, 'merchantKey', event.target.value)} />
              </label>
              <label className="field">
                <span>{geidea ? 'كلمة سرّ الـ API' : 'Token'}</span>
                <input
                  dir="ltr"
                  type="password"
                  value={secrets[provider] ?? ''}
                  placeholder={form.hasSecret ? `محفوظ (${form.secretMasked ?? '****'})` : 'يُكتب مرة واحدة ولا يُعرض'}
                  onChange={(event) => setSecrets((previous) => ({ ...previous, [provider]: event.target.value }))}
                />
              </label>
              <label className="field">
                <span>العملة</span>
                <input dir="ltr" value={form.currency} onChange={(event) => setField(provider, 'currency', event.target.value)} />
              </label>
              {geidea ? (
                <label className="field wide">
                  <span>رابط الإرجاع</span>
                  <input dir="ltr" value={form.callbackUrl} onChange={(event) => setField(provider, 'callbackUrl', event.target.value)} placeholder="https://example.com/hooks/geidea" />
                </label>
              ) : null}
            </div>

            <div className="toolbar">
              <button
                type="button"
                className="btn primary"
                disabled={busy !== ''}
                onClick={() => void run(`save-${provider}`, async () => {
                  const savedView = await savePaymentGateway(provider, {
                    active: form.active,
                    printReceipt: form.printReceipt,
                    port: form.port,
                    baseUrl: form.baseUrl,
                    currency: form.currency,
                    merchantKey: form.merchantKey,
                    ...(secrets[provider] ? { merchantSecret: secrets[provider] } : {}),
                    callbackUrl: form.callbackUrl,
                    simulation: form.simulation,
                  });
                  setSecrets((previous) => ({ ...previous, [provider]: '' }));
                  setNotice({ kind: 'ok', text: `تم حفظ الإعدادات · ${savedView.secretMasked ?? 'بلا مفتاح'}` });
                })}
              >
                💾 حفظ
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy !== ''}
                onClick={() => void run(`test-${provider}`, async () => {
                  const result = await testPaymentGateway(provider);
                  setNotice({ kind: result.ok ? 'ok' : 'warn', text: `${STATUS_LABELS[result.status] ?? result.status} — ${result.message ?? 'بلا رسالة'}` });
                })}
              >
                🧪 {geidea ? 'TEST' : 'Test'}
              </button>
              <span className="field inline">
                <span>💳 دفع</span>
                <input dir="ltr" value={payValues[provider] ?? ''} onChange={(event) => setPayValues((previous) => ({ ...previous, [provider]: event.target.value }))} />
              </span>
              <button
                type="button"
                className="btn"
                disabled={busy !== ''}
                onClick={() => void run(`pay-${provider}`, async () => {
                  const result = await payWithGateway(provider, { amount: payValues[provider] ?? '0' });
                  setNotice({
                    kind: result.transaction.status === 'approved' ? 'ok' : 'warn',
                    text: `${STATUS_LABELS[result.transaction.status] ?? result.transaction.status} — ${result.transaction.message ?? result.transaction.reference}${result.settled ? ' · قُيّد على الفاتورة' : ''}`,
                  });
                })}
              >
                💳 ادفع الآن
              </button>
              {busy.startsWith(`${provider}`) || busy.startsWith('save-') || busy.startsWith('test-') || busy.startsWith('pay-') ? <span className="chip">…</span> : null}
            </div>

            <h4>Logging</h4>
            <pre className="log" dir="ltr">
              {(saved?.lastTest?.lines ?? []).join('\n') || (saved?.lastTest ? JSON.stringify(saved.lastTest, null, 2) : '— لم يُجرَ اختبار بعد —')}
            </pre>
          </div>
        );
      })}

      <div className="card">
        <div className="toolbar">
          <h3>📜 آخر العمليات</h3>
          <button type="button" className="btn" disabled={busy !== ''} onClick={() => void run('reload', async () => reload())}>
            🔄 تحديث
          </button>
        </div>
        {transactions.length === 0 ? (
          <p className="muted">لا توجد عمليات بعد.</p>
        ) : (
          <DataTable
            rows={transactions}
            rowKey={(row) => row.id}
            columns={[
              { key: 'createdAt', header: 'التاريخ', cell: (row) => (row.createdAt ? new Date(row.createdAt).toLocaleString('ar') : '—') },
              { key: 'provider', header: 'البوابة', cell: (row) => (row.provider === 'geidea' ? 'جيديا' : 'NeoLeap') },
              { key: 'reference', header: 'المرجع', align: 'ltr', cell: (row) => row.reference },
              { key: 'amount', header: 'المبلغ', align: 'num', cell: (row) => `${row.amount} ${row.currency}` },
              { key: 'status', header: 'الحالة', cell: (row) => STATUS_LABELS[row.status] ?? row.status },
              { key: 'message', header: 'الرسالة', cell: (row) => row.message ?? '—' },
              { key: 'approvalCode', header: 'رقم الموافقة', align: 'ltr', cell: (row) => row.approvalCode ?? '—' },
              { key: 'cardScheme', header: 'الشبكة', cell: (row) => row.cardScheme ?? '—' },
              { key: 'panMasked', header: 'البطاقة', align: 'ltr', cell: (row) => row.panMasked ?? '—' },
              { key: 'settled', header: 'الفاتورة', cell: (row) => (row.settled ? <span className="chip">✓ قُيّدت</span> : row.invoiceId ? 'لم تُقيَّد' : '—') },
              {
                key: 'actions',
                header: 'إجراء',
                cell: (row) =>
                  row.status === 'initiated' ? (
                    <button
                      type="button"
                      className="btn small"
                      disabled={busy !== ''}
                      onClick={() => void run(`refresh-${row.id}`, async () => {
                        const result = await refreshGatewayTransaction(row.id);
                        setNotice({ kind: result.transaction.status === 'approved' ? 'ok' : 'warn', text: STATUS_LABELS[result.transaction.status] ?? result.transaction.status });
                      })}
                    >
                      🔄 تحديث الحالة
                    </button>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
        )}
      </div>
    </Screen>
  );
}
