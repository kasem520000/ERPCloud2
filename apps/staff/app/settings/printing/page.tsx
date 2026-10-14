'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import { Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError } from '../../../lib/api';
import {
  fetchReportCatalog,
  fetchPrintSettings,
  fetchPrinterLinks,
  createPrinterLink,
  deletePrinterLink,
  PRINT_SCOPES,
  resetPrintSettings,
  savePrintSettings,
  type PrintSettings,
  type PrinterLink,
} from '../../../lib/reports';
import { useQuery } from '../../../lib/use-query';

const EMPTY: PrintSettings = {
  scope: 'default',
  printType: 1,
  printHeader: true,
  printFooter: false,
  printStamp: true,
  printItemDetails: false,
  printItemGroups: false,
  printComponentsIndividually: false,
  printMakePay: false,
  printNo: 1,
  printItemType: 1,
  casherPrinter: '',
  kitchenPrinter: '',
  rptName: '',
  rptUrl: '',
  note: '',
  headerImageUrl: '',
  footerImageUrl: '',
  stampImageUrl: '',
  saved: false,
};

export default function PrintingSettingsPage() {
  const settings = useQuery<PrintSettings[]>(() => fetchPrintSettings(), []);
  const catalog = useQuery<Array<{ key: string; titleAr: string }>>(() => fetchReportCatalog(), []);
  const printerLinks = useQuery<PrinterLink[]>(() => fetchPrinterLinks(), []);
  const [scope, setScope] = useState('default');
  const [form, setForm] = useState<PrintSettings>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();
  const [linkForm, setLinkForm] = useState({ scope: 'default', printName: '', printerName: '', rptUrl: '', rptName: '' });
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkNotice, setLinkNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>();

  const rows = settings.data ?? [];
  const current = rows.find((row) => row.scope === scope) ?? EMPTY;

  useEffect(() => {
    setForm({ ...EMPTY, ...current, scope });
    setNotice(undefined);
  }, [scope, current.printNo, current.note, current.saved, current.printType, current.casherPrinter]);

  const reports = useMemo(() => (catalog.data ?? []).slice(0, 200), [catalog.data]);

  const set = <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) => setForm((previous) => ({ ...previous, [key]: value }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(undefined);
    try {
      const saved = await savePrintSettings(scope, {
        printType: form.printType,
        printHeader: form.printHeader,
        printFooter: form.printFooter,
        printStamp: form.printStamp,
        printItemDetails: form.printItemDetails,
        printItemGroups: form.printItemGroups,
        printComponentsIndividually: form.printComponentsIndividually,
        printMakePay: form.printMakePay,
        printNo: Number(form.printNo) || 1,
        printItemType: Number((form as any).printItemType) || 1,
        casherPrinter: form.casherPrinter,
        kitchenPrinter: form.kitchenPrinter,
        rptName: form.rptName,
        rptUrl: form.rptUrl,
        note: form.note,
        headerImageUrl: form.headerImageUrl,
        footerImageUrl: form.footerImageUrl,
        stampImageUrl: form.stampImageUrl,
      });
      setForm(saved);
      setNotice({ kind: 'ok', text: 'تم حفظ إعدادات الطباعة.' });
      settings.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setNotice(undefined);
    try {
      const cleared = await resetPrintSettings(scope);
      setForm(cleared);
      setNotice({ kind: 'info', text: 'عادت الإعدادات إلى إعدادات الديسكتوب الافتراضية.' });
      settings.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function addLink(event: React.FormEvent) {
    event.preventDefault();
    if (!linkForm.printName.trim() || !linkForm.printerName.trim()) {
      setLinkNotice({ kind: 'danger', text: 'أدخل اسم الطباعة واسم الطابعة.' });
      return;
    }
    setLinkBusy(true);
    setLinkNotice(undefined);
    try {
      await createPrinterLink({
        scope: linkForm.scope,
        printName: linkForm.printName.trim(),
        printerName: linkForm.printerName.trim(),
        rptUrl: linkForm.rptUrl.trim(),
        rptName: linkForm.rptName.trim(),
      });
      setLinkForm((p) => ({ ...p, printName: '', printerName: '', rptUrl: '', rptName: '' }));
      setLinkNotice({ kind: 'ok', text: 'تم حفظ ربط الطابعة.' });
      printerLinks.reload();
    } catch (error) {
      setLinkNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setLinkBusy(false);
    }
  }

  async function removeLink(id: string) {
    setLinkBusy(true);
    try {
      await deletePrinterLink(id);
      printerLinks.reload();
    } catch (error) {
      setLinkNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setLinkBusy(false);
    }
  }

  return (
    <Screen
      title="إعدادات الطباعة"
      subtitle="ما تُطبع به الفواتير والتقارير: الترويسة والتذييل والختم وعدد النسخ ونوع الورق — لكل قسم على حدة، وما لا يُحدَّد يرجع إلى «الإفتراضي»."
      crumbs={['الإعدادات', 'إعدادات الطباعة']}
      actions={
        <span className="chip">
          محفوظ: {rows.filter((row) => row.saved).length} من {PRINT_SCOPES.length}
        </span>
      }
    >
      <div className="card toolbar">
        <span className="chip">🧩 تفعيل إعدادات الطباعة</span>
        {PRINT_SCOPES.map((entry) => (
          <button
            key={entry.scope}
            type="button"
            className={`btn${scope === entry.scope ? ' primary' : ''}`}
            onClick={() => setScope(entry.scope)}
          >
            {entry.labelAr}
            {rows.find((row) => row.scope === entry.scope)?.saved ? ' ✓' : ''}
          </button>
        ))}
      </div>

      <form className="card" onSubmit={save}>
        <h3>🖨️ إعدادات الطباعة — {PRINT_SCOPES.find((entry) => entry.scope === scope)?.labelAr ?? scope}</h3>

        <div className="form-grid">
          <label className="field">
            <span>طابعة الكاشير</span>
            <input value={form.casherPrinter} onChange={(event) => set('casherPrinter', event.target.value)} placeholder="HP LaserJet" />
          </label>
          <label className="field">
            <span>طابعة المطبخ</span>
            <input value={form.kitchenPrinter} onChange={(event) => set('kitchenPrinter', event.target.value)} placeholder="EPSON TM-T82" />
          </label>
          <label className="field">
            <span>عدد النسخ</span>
            <input type="number" min={1} max={50} value={form.printNo} onChange={(event) => set('printNo', Number(event.target.value))} />
          </label>
          <label className="field">
            <span>🔢 ترتيب بنود الفاتورة</span>
            <select value={(form as any).printItemType ?? 1} onChange={(e) => set('printItemType' as any, Number(e.target.value) as any)}>
              <option value={1}>1 — ترتيب الإدخال</option>
              <option value={2}>2 — حسب الرمز</option>
              <option value={3}>3 — حسب اسم الصنف</option>
              <option value={4}>4 — حسب الكمية تنازلي</option>
              <option value={5}>5 — حسب السعر تنازلي</option>
            </select>
          </label>
          <label className="field">
            <span>اسم التقرير</span>
            <input value={form.rptName} onChange={(event) => set('rptName', event.target.value)} placeholder="RptSalesInPeriod1.repx" dir="ltr" />
          </label>
          <label className="field">
            <span>مسار التقرير</span>
            <input value={form.rptUrl} onChange={(event) => set('rptUrl', event.target.value)} placeholder="C:\\SmartAuditERP\\Reports" dir="ltr" />
          </label>
          <label className="field wide">
            <span>ملاحظات التقرير</span>
            <input value={form.note} onChange={(event) => set('note', event.target.value)} placeholder="تُطبع تحت الجدول" />
          </label>
        </div>

        <h3>📄 نوع الورق — «🖨️ افتراضي طباعة الفواتير»</h3>
        <div className="toolbar">
          <label className="check">
            <input type="radio" name="paper" checked={form.printType === 1} onChange={() => set('printType', 1)} />
            <span>📄 ورقة A4</span>
          </label>
          <label className="check">
            <input type="radio" name="paper" checked={form.printType === 2} onChange={() => set('printType', 2)} />
            <span>🧾 ورق صغير</span>
          </label>
        </div>

        <h3>🧩 ما يُطبع على الورقة</h3>
        <div className="toolbar">
          <label className="check">
            <input type="checkbox" checked={form.printHeader} onChange={(event) => set('printHeader', event.target.checked)} />
            <span>طباعة ترويسة الفاتورة</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={form.printFooter} onChange={(event) => set('printFooter', event.target.checked)} />
            <span>طباعة تذييل الفاتورة</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={form.printStamp} onChange={(event) => set('printStamp', event.target.checked)} />
            <span>طباعة الختم</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={form.printItemDetails} onChange={(event) => set('printItemDetails', event.target.checked)} />
            <span>طباعة تفاصيل الأصناف</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={form.printItemGroups} onChange={(event) => set('printItemGroups', event.target.checked)} />
            <span>طباعة مجموعات الأصناف مع إغلاق اليومية</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={form.printComponentsIndividually}
              onChange={(event) => set('printComponentsIndividually', event.target.checked)}
            />
            <span>طباعة مكونات الأصناف المركبة بشكل منفرد</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={form.printMakePay} onChange={(event) => set('printMakePay', event.target.checked)} />
            <span>طباعة make pay</span>
          </label>
        </div>

        <h3>🖼️ الصور — الترويـسة · التـذيـيـل · الخـتـم</h3>
        <p className="small muted">
          يحفظ الديسكتوب هذه الصور بايتاتٍ في <code>HeaderImage</code> · <code>FooterImage</code> · <code>StampImage</code>؛
          السحابة لا تخزّن ملفات، فهي روابط <span dir="ltr">https://</span> تُدرج في الورقة كما هي.
        </p>
        <div className="form-grid">
          <label className="field">
            <span>الترويـسة</span>
            <input dir="ltr" value={form.headerImageUrl} onChange={(event) => set('headerImageUrl', event.target.value)} placeholder="https://…/header.png" />
          </label>
          <label className="field">
            <span>التـذيـيـل</span>
            <input dir="ltr" value={form.footerImageUrl} onChange={(event) => set('footerImageUrl', event.target.value)} placeholder="https://…/footer.png" />
          </label>
          <label className="field">
            <span>الخـتـم</span>
            <input dir="ltr" value={form.stampImageUrl} onChange={(event) => set('stampImageUrl', event.target.value)} placeholder="https://…/stamp.png" />
          </label>
        </div>

        <Notice notice={notice} />
        <div className="toolbar">
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'جارٍ الحفظ…' : '💾 حفظ'}
          </button>
          <button className="btn" type="button" disabled={busy || !current.saved} onClick={() => void reset()}>
            🗑️ إرجاع إلى الإفتراضي
          </button>
        </div>
      </form>

      {/* 📑 شبكة ربط الطابعات — `PrinterSettings` L2163-L2180 (`Inv_Id, PrintName, Printer, RptUrl, RptName`) */}
      <div className="card">
        <h3>📑 ربط الطابعات بالتقارير — `PrinterSettings` (Inv_Id, PrintName, Printer, RptUrl, RptName)</h3>
        <p className="small muted">
          الديسكتوب يحفظ في <code>PrinterSettings</code> ربط كل تقرير بطابعة واسم ملف <code>RptName</code> ومسار <code>RptUrl</code> (txtRptPath المشترك).
          السحابة تحفظ نفس الحقول في <code>printer_report_links</code> وتظهرها بجانب زر الطباعة — الطابعة الفعلية يختارها المتصفح.
        </p>

        <form className="toolbar" onSubmit={addLink} style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          <select className="input" value={linkForm.scope} onChange={(e) => setLinkForm((p) => ({ ...p, scope: e.target.value }))} style={{ minWidth: 120 }}>
            {PRINT_SCOPES.map((s) => (
              <option key={s.scope} value={s.scope}>{s.labelAr}</option>
            ))}
            {reports.slice(0, 40).map((r) => (
              <option key={`report:${r.key}`} value={`report:${r.key}`}>تقرير:{r.key}</option>
            ))}
          </select>
          <input className="input" placeholder="اسم الطباعة (PrintName)" value={linkForm.printName} onChange={(e) => setLinkForm((p) => ({ ...p, printName: e.target.value }))} style={{ minWidth: 140 }} />
          <input className="input" placeholder="اسم الطابعة (Printer)" value={linkForm.printerName} onChange={(e) => setLinkForm((p) => ({ ...p, printerName: e.target.value }))} style={{ minWidth: 140 }} />
          <input className="input" placeholder="مسار التقرير (RptUrl)" dir="ltr" value={linkForm.rptUrl} onChange={(e) => setLinkForm((p) => ({ ...p, rptUrl: e.target.value }))} style={{ minWidth: 160 }} />
          <input className="input" placeholder="اسم الملف (RptName)" dir="ltr" value={linkForm.rptName} onChange={(e) => setLinkForm((p) => ({ ...p, rptName: e.target.value }))} style={{ minWidth: 160 }} />
          <button className="btn primary" type="submit" disabled={linkBusy}>{linkBusy ? 'جارٍ الحفظ…' : '➕ إضافة'}</button>
        </form>

        {linkNotice ? <Notice notice={linkNotice} /> : null}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>النطاق</th>
                <th>اسم الطباعة</th>
                <th>الطابعة</th>
                <th>مسار التقرير</th>
                <th>اسم الملف</th>
                <th>إجراء</th>
              </tr>
            </thead>
            <tbody>
              {(printerLinks.data ?? []).length === 0 ? (
                <tr><td colSpan={6} className="small muted" style={{ textAlign: 'center' }}>لا توجد روابط محفوظة — أضف واحداً أعلاه (كما في DgvName · DgvPrinterName · DgvReport).</td></tr>
              ) : (
                (printerLinks.data ?? []).map((link) => (
                  <tr key={link.id}>
                    <td>{link.scopeLabelAr} <span dir="ltr" className="small muted">({link.scope})</span></td>
                    <td>{link.printName}</td>
                    <td>{link.printerName}</td>
                    <td dir="ltr" className="small">{link.rptUrl || '—'}</td>
                    <td dir="ltr" className="small">{link.rptName || '—'}</td>
                    <td><button className="btn" disabled={linkBusy} onClick={() => void removeLink(link.id)}>🗑️ حذف</button></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {scope === 'reports' && (
        <div className="card">
          <h3>🖨️ إعدادات تقرير بعينه</h3>
          <p className="small muted">
            كل تقرير يقرأ إعداداته أولاً، ثم «تقارير»، ثم «الإفتراضي». افتح التقرير من{' '}
            <Link href="/reports">التقارير</Link> واضغط «🖨️ معاينة الطباعة» لترى الورقة بهذه الإعدادات.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>التقرير</th>
                  <th>المفتاح</th>
                  <th>الإعدادات</th>
                </tr>
              </thead>
              <tbody>
                {reports.slice(0, 12).map((report) => (
                  <tr key={report.key}>
                    <td>
                      <Link href={`/reports/${report.key}`}>{report.titleAr}</Link>
                    </td>
                    <td dir="ltr" className="small">
                      report:{report.key}
                    </td>
                    <td className="small">من «تقارير» ثم «الإفتراضي»</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Screen>
  );
}
