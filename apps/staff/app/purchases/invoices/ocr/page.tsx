'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';

import { Notice } from '../../../../components/data-view';
import { Screen } from '../../../../components/screen';
import { ApiError, apiData, apiPost } from '../../../../lib/api';
import {
  arabicName,
  branchOptions,
  defaultOf,
  listBranches,
  listItems,
  listParties,
  listWarehouses,
  partyLabel,
  type Branch,
  type Item,
  type Party,
  type Warehouse,
} from '../../../../lib/lookups';
import { useSession } from '../../../../lib/session';
import { useQuery } from '../../../../lib/use-query';

type OcrLine = {
  description: string;
  quantity?: string;
  unitPrice?: string;
  taxRate?: string;
  total?: string;
  confidence?: number;
};
type OcrJob = {
  id: string;
  file: { id: string; name: string; mime: string; downloadUrl: string };
  status: 'queued' | 'processing' | 'done' | 'failed';
  extracted: {
    supplierName: string | null;
    supplierTaxNumber: string | null;
    invoiceNumber: string | null;
    invoiceDate: string | null;
    subtotal: string | null;
    taxAmount: string | null;
    total: string | null;
    currency: string | null;
    lines: OcrLine[];
    confidenceByField: Record<string, number>;
    confidence: number;
    rawText?: string | null;
  };
  confidence: number | null;
  error: string | null;
  draftInvoiceId: string | null;
};
type Presign = { fileId: string; uploadUrl: string; requiredHeaders: Record<string, string> };
type ReviewValues = {
  supplierName: string;
  supplierTaxNumber: string;
  invoiceNumber: string;
  invoiceDate: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  currency: string;
};

const band = (score: number | undefined) =>
  score !== undefined && score > 0.9 ? { label: 'ثقة عالية', color: 'var(--ok)', background: 'var(--ok-soft)' } : score !== undefined && score >= 0.7 ? { label: 'تحتاج مراجعة', color: 'var(--warn)', background: 'var(--warn-soft)' } : { label: 'ثقة منخفضة', color: 'var(--danger)', background: 'var(--danger-soft)' };

function Confidence({ score }: { score?: number }) {
  const tone = band(score);
  return (
    <span style={{ background: tone.background, borderRadius: 999, color: tone.color, fontSize: 12, padding: '2px 8px' }}>
      {score === undefined ? 'غير متاح' : `${Math.round(score * 100)}% · ${tone.label}`}
    </span>
  );
}

export default function OcrPurchaseInvoicePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useSession();
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const suppliers = useQuery<Party[]>(() => listParties('supplier'), []);
  const items = useQuery<Item[]>(() => listItems(), []);

  const [selectedFile, setSelectedFile] = useState<File>();
  const [job, setJob] = useState<OcrJob>();
  const [branchId, setBranchId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [partyId, setPartyId] = useState('');
  const [mappedItems, setMappedItems] = useState<Record<number, string>>({});
  const [reviewValues, setReviewValues] = useState<ReviewValues>({ supplierName: '', supplierTaxNumber: '', invoiceNumber: '', invoiceDate: '', subtotal: '', taxAmount: '', total: '', currency: '' });
  const [reviewJobId, setReviewJobId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'warn'; text: string }>();

  const effectiveBranch = branchId || defaultOf(branches.data ?? [])?.id || '';
  const filteredWarehouses = useMemo(
    () => (warehouses.data ?? []).filter((row) => !effectiveBranch || row.branchId === effectiveBranch),
    [effectiveBranch, warehouses.data],
  );

  useEffect(() => {
    const existingJobId = searchParams.get('job');
    if (!existingJobId || job) return undefined;
    void apiData<OcrJob>(`/ocr/jobs/${existingJobId}`)
      .then(setJob)
      .catch((error: unknown) => setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) }));
    return undefined;
  }, [job, searchParams]);

  useEffect(() => {
    if (!job || job.status !== 'done' || reviewJobId === job.id) return;
    setReviewValues({
      supplierName: job.extracted.supplierName ?? '',
      supplierTaxNumber: job.extracted.supplierTaxNumber ?? '',
      invoiceNumber: job.extracted.invoiceNumber ?? '',
      invoiceDate: job.extracted.invoiceDate ?? '',
      subtotal: job.extracted.subtotal ?? '',
      taxAmount: job.extracted.taxAmount ?? '',
      total: job.extracted.total ?? '',
      currency: job.extracted.currency ?? '',
    });
    setReviewJobId(job.id);
  }, [job, reviewJobId]);

  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'failed') return undefined;
    const timer = setInterval(() => {
      void apiData<OcrJob>(`/ocr/jobs/${job.id}`)
        .then(setJob)
        .catch((error: unknown) => setNotice({ kind: 'danger', text: error instanceof Error ? error.message : String(error) }));
    }, 2_000);
    return () => clearInterval(timer);
  }, [job]);

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    setJob(undefined);
    setNotice(undefined);
  }

  async function startOcr(event: FormEvent) {
    event.preventDefault();
    if (!selectedFile) {
      setNotice({ kind: 'warn', text: 'اختر صورة أو ملف PDF أولاً.' });
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const presign = await apiPost<Presign>('/ocr/presign', {
        name: selectedFile.name,
        mime: selectedFile.type || 'application/pdf',
        sizeBytes: selectedFile.size,
      });
      const upload = await fetch(presign.uploadUrl, {
        method: 'PUT',
        headers: presign.requiredHeaders,
        body: selectedFile,
      });
      if (!upload.ok) throw new Error(`فشل رفع المستند (${upload.status}).`);
      await apiPost(`/files/${presign.fileId}/finalize`, {});
      const created = await apiPost<OcrJob>('/ocr/jobs', { fileId: presign.fileId, entityType: 'purchase_invoice' });
      setJob(created);
      setNotice({ kind: 'ok', text: 'تم رفع المستند. يجري استخراج الحقول الآن.' });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function createDraft(event: FormEvent) {
    event.preventDefault();
    if (!job || job.status !== 'done') return;
    if (!effectiveBranch) {
      setNotice({ kind: 'warn', text: 'اختر الفرع قبل إنشاء المسودة.' });
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const lines = job.extracted.lines
        .map((line, index) => ({
          itemId: mappedItems[index],
          description: line.description,
          quantity: line.quantity ?? '1',
          unitPrice: line.unitPrice ?? line.total ?? '0',
          taxRate: line.taxRate ?? '0',
        }))
        .filter((line) => line.itemId);
      const invoice = await apiPost<{ id: string }>('/purchases/invoices/from-ocr', {
        ocrJobId: job.id,
        branchId: effectiveBranch,
        warehouseId: warehouseId || undefined,
        partyId: partyId || undefined,
        supplierName: reviewValues.supplierName || undefined,
        supplierTaxNumber: reviewValues.supplierTaxNumber || undefined,
        currency: reviewValues.currency || undefined,
        supplierReferenceNo: reviewValues.invoiceNumber || undefined,
        supplierReferenceDate: reviewValues.invoiceDate || undefined,
        headerTotals: {
          subtotal: reviewValues.subtotal || '0',
          tax: reviewValues.taxAmount || '0',
          total: reviewValues.total || '0',
        },
        lines,
      });
      router.push(`/purchases/invoices/${invoice.id}?ocrJobId=${encodeURIComponent(job.id)}`);
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
      setBusy(false);
    }
  }

  if (!can('purchase.ocr.use')) {
    return (
      <Screen title="OCR فواتير الشراء" crumbs={['المشتريات', 'العمليات']}>
        <div className="card state">
          <strong>تحتاج صلاحية <code dir="ltr">purchase.ocr.use</code></strong>
        </div>
      </Screen>
    );
  }

  const canCreateInvoice = can('purchase.invoice.create');

  return (
    <Screen
      title="قراءة فاتورة شراء بالـ OCR"
      subtitle="ارفع المستند، راجع الحقول وألوان الثقة، ثم أنشئ مسودة قبل الترحيل. لا يُرحّل OCR أي فاتورة تلقائياً."
      crumbs={['المشتريات', 'العمليات']}
      actions={<Link className="btn" href="/purchases/invoices">العودة للفواتير</Link>}
    >
      <Notice notice={notice} />

      <form className="card" onSubmit={startOcr}>
        <div className="form-grid">
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span>المستند (PDF أو صورة) *</span>
            <input className="input" type="file" accept="application/pdf,image/png,image/jpeg,image/webp,image/gif" onChange={chooseFile} />
            <span className="muted small">تتم معالجة الصفحة الأولى من PDF متعدد الصفحات، وتبقى البايتات في التخزين الكائني.</span>
          </label>
        </div>
        <div className="actions">
          <button className="btn primary" type="submit" disabled={busy || !selectedFile}>
            {busy ? 'جارٍ الرفع…' : 'رفع وبدء القراءة'}
          </button>
          {job && <span className="badge">{job.status === 'queued' ? 'في الانتظار' : job.status === 'processing' ? 'جارٍ الاستخراج' : job.status === 'done' ? 'اكتمل' : 'فشل'}</span>}
        </div>
      </form>

      {job && (
        <div className="ocr-review-grid">
          <section className="card">
            <div className="section-heading">
              <div>
                <h3>المستند</h3>
                <p className="muted small">{job.file.name}</p>
              </div>
              <a className="btn sm" href={job.file.downloadUrl} target="_blank" rel="noreferrer">
                فتح المستند
              </a>
            </div>
            <div className="ocr-document-preview">
              {job.file.mime === 'application/pdf' ? <iframe title="معاينة الفاتورة" src={job.file.downloadUrl} /> : <img alt="معاينة فاتورة الشراء" src={job.file.downloadUrl} />}
            </div>
          </section>

          <section className="card">
            <div className="section-heading">
              <div>
                <h3>الحقول المستخرجة</h3>
                <p className="muted small">الأخضر فوق 90%، الأصفر من 70% إلى 90%، والأحمر تحت 70%.</p>
              </div>
              <Confidence score={job.confidence ?? job.extracted.confidence} />
            </div>
            {job.status === 'failed' && <div className="notice danger">تعذر إكمال OCR: {job.error ?? 'خطأ غير معروف'}</div>}
            {job.status === 'done' && (
              <div className="ocr-fields">
                {([
                  ['supplierName', 'المورد', job.extracted.supplierName],
                  ['supplierTaxNumber', 'الرقم الضريبي', job.extracted.supplierTaxNumber],
                  ['invoiceNumber', 'رقم الفاتورة', job.extracted.invoiceNumber],
                  ['invoiceDate', 'تاريخ الفاتورة', job.extracted.invoiceDate],
                  ['subtotal', 'قبل الضريبة', job.extracted.subtotal],
                  ['taxAmount', 'الضريبة', job.extracted.taxAmount],
                  ['total', 'الإجمالي', job.extracted.total],
                  ['currency', 'العملة', job.extracted.currency],
                ] as Array<[keyof ReviewValues, string, string | null]>).map(([key, label, value]) => (
                  <div className="ocr-field" key={key}>
                    <strong>{label}</strong>
                    <input
                      className="input"
                      dir="ltr"
                      type={key === 'invoiceDate' ? 'date' : 'text'}
                      value={reviewJobId === job.id ? reviewValues[key] : value ?? ''}
                      onChange={(event) => setReviewValues((current) => ({ ...current, [key]: event.target.value }))}
                    />
                    <Confidence score={job.extracted.confidenceByField[key]} />
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {job?.status === 'done' && !canCreateInvoice && (
        <div className="notice warn">يمكنك مراجعة نتيجة OCR، لكن إنشاء المسودة يحتاج صلاحية <code dir="ltr">purchase.invoice.create</code>.</div>
      )}

      {job?.status === 'done' && canCreateInvoice && (
        <form className="card" onSubmit={createDraft}>
          <div className="section-heading">
            <div>
              <h3>مراجعة المسودة</h3>
              <p className="muted small">اختر المورد واربط البنود بالأصناف. إذا لم تربط أي بند، تُنشأ مسودة رأسية بالقيم المستخرجة لإكمالها لاحقاً.</p>
            </div>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>الفرع *</span>
              <select className="input" value={effectiveBranch} onChange={(event) => setBranchId(event.target.value)} required>
                <option value="">— اختر —</option>
                {branchOptions(branches.data ?? []).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>المستودع</span>
              <select className="input" value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)}>
                <option value="">— بدون حركة مخزنية —</option>
                {filteredWarehouses.map((row) => <option key={row.id} value={row.id}>{arabicName(row)}</option>)}
              </select>
            </label>
            <label className="field">
              <span>المورد</span>
              <select className="input" value={partyId} onChange={(event) => setPartyId(event.target.value)}>
                <option value="">— مطابقة تلقائية بالاسم —</option>
                {(suppliers.data ?? []).map((row) => <option key={row.id} value={row.id}>{partyLabel(row)}</option>)}
              </select>
            </label>
          </div>

          {job.extracted.lines.length > 0 && (
            <div className="table-wrap">
              <table className="zebra compact">
                <thead><tr><th>الوصف</th><th>الكمية</th><th>السعر</th><th>الثقة</th><th>الصنف</th></tr></thead>
                <tbody>
                  {job.extracted.lines.map((line, index) => (
                    <tr key={`${line.description}-${index}`}>
                      <td>{line.description}</td>
                      <td dir="ltr">{line.quantity ?? '1'}</td>
                      <td dir="ltr">{line.unitPrice ?? line.total ?? '—'}</td>
                      <td><Confidence score={line.confidence} /></td>
                      <td>
                        <select className="input" value={mappedItems[index] ?? ''} onChange={(event) => setMappedItems((current) => ({ ...current, [index]: event.target.value }))}>
                          <option value="">— مسودة رأس فقط —</option>
                          {(items.data ?? []).map((item) => <option key={item.id} value={item.id}>{item.sku} · {item.nameAr ?? item.nameEn ?? item.sku}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="actions">
            <button className="btn primary" type="submit" disabled={busy}>{busy ? 'جارٍ الإنشاء…' : 'إنشاء مسودة فاتورة'}</button>
            {job.draftInvoiceId && <Link className="btn" href={`/purchases/invoices/${job.draftInvoiceId}`}>فتح المسودة الحالية</Link>}
          </div>
        </form>
      )}
    </Screen>
  );
}
