'use client';

import Link from 'next/link';
import Decimal from 'decimal.js';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Screen } from '../../../components/screen';
import { Notice } from '../../../components/data-view';
import { ApiError } from '../../../lib/api';
import {
  getOrCreateDeviceId,
  listOfflineInvoices,
  readOfflineCatalog,
  saveOfflineInvoice,
  type OfflineCatalog,
  type OfflineCatalogItem,
  type OfflineCheckoutPayload,
  type OfflineQueueRecord,
} from '../../../lib/offline-db';
import {
  refreshOfflineCatalog,
  startOfflineAutoSync,
  syncOfflineInvoices,
  type OfflineSyncResponse,
} from '../../../lib/sync-engine';

const formatMoney = (raw: Decimal.Value) =>
  new Decimal(raw).toDecimalPlaces(2).toNumber().toLocaleString('ar-SA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const decimalValue = (raw: string | number | null | undefined) => {
  if (raw === null || raw === undefined) return new Decimal(0);
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return new Decimal(0);
    try {
      const parsed = new Decimal(trimmed);
      return parsed.isFinite() ? parsed : new Decimal(0);
    } catch {
      return new Decimal(0);
    }
  }
  try {
    const parsed = new Decimal(raw);
    return parsed.isFinite() ? parsed : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
};

type CartLine = { item: OfflineCatalogItem; quantity: string };
type ReceiptPreview = {
  offlineId: string;
  totalText: string;
  createdAt: string;
  lines: CartLine[];
  number?: string | null;
};

type BarcodeDetectorLike = {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue?: string }>>;
};
type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

type OfflineWindow = Window & typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor };

function defaultPrice(catalog: OfflineCatalog | undefined, item: OfflineCatalogItem): string {
  const defaultList = (catalog?.priceLists ?? []).find((list) => list.isDefault) ?? catalog?.priceLists?.[0];
  const selectedPrice = (catalog?.prices ?? []).find(
    (row) => row.itemId === item.id && (!defaultList || row.priceListId === defaultList.id),
  )?.unitPrice as string | number | null | undefined;
  return decimalValue(selectedPrice ?? item.salePrice).toFixed(4);
}

function barcodeForItem(catalog: OfflineCatalog | undefined, item: OfflineCatalogItem): string | undefined {
  const extra = (catalog?.barcodes ?? []).find((row) => row.itemId === item.id);
  return (extra?.barcode as string | undefined) ?? item.barcode ?? undefined;
}

function itemForBarcode(
  catalog: OfflineCatalog | undefined,
  barcode: string,
): OfflineCatalogItem | undefined {
  const trimmed = barcode.trim();
  if (!trimmed) return undefined;
  const extra = (catalog?.barcodes ?? []).find((row) => row.barcode === trimmed);
  return catalog?.items.find(
    (item) => item.id === extra?.itemId || item.barcode === trimmed || item.sku === trimmed,
  );
}

export default function OfflinePosPage() {
  const [catalog, setCatalog] = useState<OfflineCatalog>();
  const [cart, setCart] = useState<CartLine[]>([]);
  const [search, setSearch] = useState('');
  const [barcode, setBarcode] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [cashCustomerName, setCashCustomerName] = useState('عميل نقدي');
  const [tendered, setTendered] = useState('');
  const [online, setOnline] = useState(true);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string }>();
  const [queue, setQueue] = useState<OfflineQueueRecord[]>([]);
  const [lastReceipt, setLastReceipt] = useState<ReceiptPreview>();
  const videoRef = useRef<HTMLVideoElement>(null);

  const reloadQueue = async () => setQueue(await listOfflineInvoices());

  useEffect(() => {
    setOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    void (async () => {
      try {
        const cached = await readOfflineCatalog();
        setCatalog(cached);
        await reloadQueue();
        if (navigator.onLine) {
          try {
            setCatalog(await refreshOfflineCatalog());
          } catch {
            if (!cached)
              setNotice({
                kind: 'info',
                text: 'لا يمكن الوصول للخادم. اضغط «تحميل البيانات» عند عودة الاتصال.',
              });
          }
        }
      } catch (error) {
        setNotice({
          kind: 'danger',
          text: error instanceof Error ? error.message : 'تعذر فتح التخزين المحلي.',
        });
      } finally {
        setLoading(false);
      }
    })();
    const stop = startOfflineAutoSync(() => void reloadQueue());
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      stop();
    };
  }, []);

  useEffect(() => {
    if (!scannerOpen) return;
    let active = true;
    let stream: MediaStream | undefined;
    let frame = 0;
    void (async () => {
      const Detector = (window as OfflineWindow).BarcodeDetector;
      if (!Detector) {
        setNotice({
          kind: 'info',
          text: 'هذا المتصفح لا يدعم BarcodeDetector. استخدم حقل الباركود اليدوي أو قارئ USB.',
        });
        setScannerOpen(false);
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setNotice({ kind: 'info', text: 'الكاميرا غير متاحة هنا. استخدم حقل الباركود اليدوي.' });
        setScannerOpen(false);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (!active || !videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        const detector = new Detector();
        const scan = async () => {
          if (!active || !videoRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            const value = found[0]?.rawValue;
            if (value) {
              addByBarcode(value);
              setScannerOpen(false);
              return;
            }
          } catch {
            // A frame may be undecodable while the camera is warming up.
          }
          frame = window.requestAnimationFrame(() => void scan());
        };
        void scan();
      } catch {
        setNotice({
          kind: 'danger',
          text: 'تعذر فتح الكاميرا. تحقق من إذن الكاميرا أو استخدم الإدخال اليدوي.',
        });
        setScannerOpen(false);
      }
    })();
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [scannerOpen]);

  const categories = useMemo(
    () =>
      (catalog?.categories ?? []) as Array<{ id: string; nameAr?: string; nameEn?: string; code?: string }>,
    [catalog],
  );
  const [categoryId, setCategoryId] = useState('');
  const visibleItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (catalog?.items ?? []).filter((item) => {
      const matchesCategory = !categoryId || item.categoryId === categoryId;
      const haystack =
        `${item.nameAr ?? ''} ${item.nameEn ?? ''} ${item.sku ?? ''} ${barcodeForItem(catalog, item) ?? ''}`.toLocaleLowerCase();
      return matchesCategory && (!query || haystack.includes(query));
    });
  }, [catalog, categoryId, search]);

  const subtotal = cart.reduce(
    (sum, line) => sum.plus(new Decimal(defaultPrice(catalog, line.item)).times(line.quantity)),
    new Decimal(0),
  );
  const cash = decimalValue(tendered);
  const changeDue = cash.gt(subtotal) ? cash.minus(subtotal) : new Decimal(0);
  const pending = queue.filter((row) => row.status === 'pending').length;
  const conflicts = queue.filter((row) => row.status === 'conflict').length;
  const branchId = catalog?.defaults?.branchId ?? (catalog?.branches?.[0]?.id as string | undefined) ?? '';
  const warehouseId = catalog?.defaults?.warehouseId ?? (catalog?.warehouses?.[0]?.id as string | undefined);
  const cashLocationId = catalog?.defaults?.cashLocationId ?? undefined;

  function add(item: OfflineCatalogItem) {
    setCart((current) => {
      const existing = current.find((line) => line.item.id === item.id);
      if (existing)
        return current.map((line) =>
          line.item.id === item.id
            ? { ...line, quantity: new Decimal(line.quantity).plus(1).toFixed(4) }
            : line,
        );
      return [...current, { item, quantity: '1' }];
    });
    setNotice(undefined);
  }

  function addByBarcode(value: string) {
    const item = itemForBarcode(catalog, value);
    if (!item) {
      setNotice({ kind: 'danger', text: `لم أجد صنفاً بالباركود ${value}.` });
      return;
    }
    add(item);
    setBarcode('');
  }

  async function downloadCatalog() {
    if (!navigator.onLine) {
      setNotice({ kind: 'info', text: 'لا يوجد اتصال. البيانات الموجودة في الجهاز ما زالت صالحة للعمل.' });
      return;
    }
    setBusy(true);
    try {
      setCatalog(await refreshOfflineCatalog());
      setNotice({ kind: 'ok', text: 'تم تحديث الأصناف والأسعار والعملاء محلياً.' });
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function enqueueInvoice() {
    if (!cart.length) {
      setNotice({ kind: 'danger', text: 'أضف صنفاً واحداً على الأقل.' });
      return;
    }
    if (!branchId) {
      setNotice({ kind: 'danger', text: 'لا يوجد فرع افتراضي في الحزمة المحلية. حدّث البيانات قبل البيع.' });
      return;
    }
    if (cash.lt(subtotal)) {
      setNotice({ kind: 'danger', text: 'المبلغ المستلم أقل من الإجمالي.' });
      return;
    }
    setBusy(true);
    try {
      const deviceId = await getOrCreateDeviceId();
      const payload: OfflineCheckoutPayload = {
        branchId,
        warehouseId,
        partyId: customerId || undefined,
        cashCustomerName: customerId ? undefined : cashCustomerName.trim() || 'عميل نقدي',
        priceIncludesVat: true,
        orderType: 'offline-pos',
        lines: cart.map((line) => ({
          itemId: line.item.id,
          quantity: line.quantity,
          unitPrice: defaultPrice(catalog, line.item),
          taxRate: '0',
        })),
        payment: { method: 'cash', cashLocationId, tendered: cash.toFixed(4) },
      };
      const record = await saveOfflineInvoice(payload, deviceId);
      setLastReceipt({
        offlineId: record.offlineId,
        totalText: subtotal.toFixed(4),
        createdAt: record.createdAt,
        lines: [...cart],
      });
      setCart([]);
      setTendered('');
      setCustomerId('');
      await reloadQueue();
      setNotice({
        kind: 'ok',
        text: `حُفظت الفاتورة ${record.offlineId}. ${online ? 'ستتم المزامنة تلقائياً.' : 'ستُزامن عند عودة الاتصال.'}`,
      });
      if (online) {
        const result = await syncOfflineInvoices();
        await reloadQueue();
        const synced = result.results?.find((row) => row.offlineId === record.offlineId);
        if (synced?.status === 'synced') {
          setLastReceipt((current) => (current ? { ...current, number: synced.number } : current));
          setNotice({ kind: 'ok', text: `تمت المزامنة — الرقم الحقيقي ${synced.number ?? 'تم الترحيل'}.` });
        } else if (synced?.status === 'conflict') {
          setNotice({
            kind: 'danger',
            text: `تعذر ترحيل ${record.offlineId}: ${synced.message ?? synced.errorCode ?? 'تعارض'}.`,
          });
        }
      }
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setBusy(true);
    try {
      const result: OfflineSyncResponse = await syncOfflineInvoices();
      await reloadQueue();
      setNotice({
        kind: result.conflicts ? 'danger' : 'ok',
        text: result.processed
          ? `تمت مزامنة ${result.synced} فاتورة وظهر ${result.conflicts} تعارض.`
          : 'لا توجد فواتير معلقة.',
      });
    } catch (error) {
      setNotice({
        kind: 'info',
        text: error instanceof ApiError ? error.message : 'تعذر الاتصال — بقيت الفواتير في الجهاز.',
      });
    } finally {
      setBusy(false);
    }
  }

  function printReceipt() {
    if (!lastReceipt) {
      setNotice({ kind: 'info', text: 'احفظ فاتورة أولاً ثم اطبع الإيصال.' });
      return;
    }
    window.print();
  }

  return (
    <Screen
      title="POS أوفلاين"
      subtitle="نقد فقط · IndexedDB · يتزامن عند عودة الاتصال"
      crumbs={['المبيعات', 'نقطة البيع']}
      actions={
        <>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-bold ${online ? 'bg-ok-soft text-ok-ink' : 'bg-danger-soft text-danger-ink'}`}
          >
            {online ? '🟢 متصل' : '🔴 أوفلاين'}
          </span>
          <Link className="btn sm" href="/sales/pos">
            POS الرئيسي
          </Link>
          <Link className="btn sm" href="/pos/offline-queue">
            الطابور ({pending + conflicts})
          </Link>
          <button className="btn sm" type="button" disabled={busy || !online} onClick={downloadCatalog}>
            تحديث البيانات
          </button>
          <button className="btn sm primary" type="button" disabled={busy || !online} onClick={syncNow}>
            مزامنة الآن
          </button>
        </>
      }
    >
      {notice ? <Notice notice={notice} /> : null}
      {loading ? <div className="card state">جارٍ فتح التخزين المحلي…</div> : null}
      {!catalog && !loading ? (
        <div className="card state">
          <strong>لا توجد حزمة بيانات على هذا الجهاز</strong>
          <span>اتصل بالشبكة واضغط «تحديث البيانات» قبل مغادرة الفرع.</span>
          <button className="btn primary" type="button" onClick={downloadCatalog} disabled={busy || !online}>
            تحميل حزمة الأوفلاين
          </button>
        </div>
      ) : null}

      {catalog ? (
        <div className="grid cols-2">
          <section className="card">
            <div className="card-head">
              <div>
                <h2>الأصناف المحلية</h2>
                <p className="muted small">
                  آخر تحديث: {catalog.generatedAt ? new Date(catalog.generatedAt).toLocaleString('ar') : '—'}
                </p>
              </div>
              <span className="badge draft">{catalog.items.length} صنف</span>
            </div>
            <div className="toolbar" style={{ marginBottom: 8 }}>
              <input
                className="input"
                placeholder="بحث بالاسم أو SKU…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <input
                className="input"
                dir="ltr"
                placeholder="باركود"
                value={barcode}
                onChange={(event) => setBarcode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') addByBarcode(barcode);
                }}
              />
              <button className="btn" type="button" onClick={() => addByBarcode(barcode)}>
                إضافة
              </button>
              <button className="btn" type="button" onClick={() => setScannerOpen((open) => !open)}>
                {scannerOpen ? 'إغلاق الكاميرا' : '📷 مسح'}
              </button>
            </div>
            {scannerOpen ? (
              <video
                ref={videoRef}
                className="offline-scanner"
                muted
                playsInline
                aria-label="ماسح الباركود"
              />
            ) : null}
            {categories.length > 0 ? (
              <div className="chips" style={{ marginBottom: 10 }}>
                <button
                  className={`chip ${!categoryId ? 'on' : ''}`}
                  type="button"
                  onClick={() => setCategoryId('')}
                >
                  الكل
                </button>
                {categories.map((category) => (
                  <button
                    className={`chip ${categoryId === category.id ? 'on' : ''}`}
                    type="button"
                    key={category.id}
                    onClick={() => setCategoryId(category.id)}
                  >
                    {category.nameAr ?? category.nameEn ?? category.code}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="pos-tiles">
              {visibleItems.slice(0, 100).map((item) => (
                <button className="pos-tile" type="button" key={item.id} onClick={() => add(item)}>
                  <strong>{item.nameAr ?? item.nameEn ?? item.sku}</strong>
                  <span>{formatMoney(defaultPrice(catalog, item))}</span>
                  <small>{barcodeForItem(catalog, item) ?? item.sku}</small>
                </button>
              ))}
            </div>
            {!visibleItems.length ? <p className="muted">لا توجد أصناف مطابقة.</p> : null}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>سلة نقدية أوفلاين</h2>
              <span className="badge posted">{cart.length} أصناف</span>
            </div>
            {!cart.length ? (
              <p className="muted">اضغط على صنف لإضافته إلى الفاتورة المؤقتة.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>الصنف</th>
                      <th>الكمية</th>
                      <th>السعر</th>
                      <th>الإجمالي</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {cart.map((line) => (
                      <tr key={line.item.id}>
                        <td>{line.item.nameAr ?? line.item.sku}</td>
                        <td>
                          <input
                            className="input"
                            dir="ltr"
                            inputMode="decimal"
                            value={line.quantity}
                            onChange={(event) =>
                              setCart((current) =>
                                current.map((row) =>
                                  row.item.id === line.item.id
                                    ? {
                                        ...row,
                                        quantity: Decimal.max(
                                          decimalValue(event.target.value),
                                          new Decimal(1),
                                        ).toFixed(4),
                                      }
                                    : row,
                                ),
                              )
                            }
                          />
                        </td>
                        <td>{formatMoney(defaultPrice(catalog, line.item))}</td>
                        <td>
                          {formatMoney(new Decimal(defaultPrice(catalog, line.item)).times(line.quantity))}
                        </td>
                        <td>
                          <button
                            className="btn sm"
                            type="button"
                            onClick={() =>
                              setCart((current) => current.filter((row) => row.item.id !== line.item.id))
                            }
                          >
                            حذف
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <dl className="kv" style={{ marginTop: 12 }}>
              <dt>الإجمالي</dt>
              <dd className="pos-total">{formatMoney(subtotal)}</dd>
              <dt>التغيير</dt>
              <dd className="pos-change">{formatMoney(changeDue)}</dd>
            </dl>
            <div className="form-grid">
              <label className="field">
                <span>العميل</span>
                <select
                  className="input"
                  value={customerId}
                  onChange={(event) => setCustomerId(event.target.value)}
                >
                  <option value="">عميل نقدي</option>
                  {(catalog.customers ?? []).map((customer) => (
                    <option key={String(customer.id)} value={String(customer.id)}>
                      {String(customer.name ?? customer.code ?? customer.id)}
                    </option>
                  ))}
                </select>
              </label>
              {!customerId ? (
                <label className="field">
                  <span>اسم العميل النقدي</span>
                  <input
                    className="input"
                    value={cashCustomerName}
                    onChange={(event) => setCashCustomerName(event.target.value)}
                  />
                </label>
              ) : null}
              <label className="field">
                <span>المبلغ المستلم</span>
                <input
                  className="input"
                  dir="ltr"
                  inputMode="decimal"
                  value={tendered}
                  onChange={(event) => setTendered(event.target.value)}
                  placeholder={subtotal.toFixed(2)}
                />
              </label>
            </div>
            <div className="toolbar" style={{ marginTop: 12 }}>
              <button
                className="btn primary"
                type="button"
                disabled={busy || !cart.length}
                onClick={enqueueInvoice}
              >
                حفظ فاتورة نقدية أوفلاين
              </button>
              <button className="btn" type="button" disabled={!lastReceipt} onClick={printReceipt}>
                🖨️ إيصال 80mm
              </button>
              <button
                className="btn"
                type="button"
                disabled={!cart.length || busy}
                onClick={() => setCart([])}
              >
                تفريغ
              </button>
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              الأوفلاين لا يقبل الشبكة أو التحويل أو الآجل. رقم الفاتورة يبدأ بـ OFFLINE- ثم يأخذ رقماً
              حقيقياً عند المزامنة.
            </p>
          </section>
        </div>
      ) : null}

      <div className="offline-receipt" aria-hidden="true">
        <h1>ERPCloud</h1>
        <p>إيصال بيع نقدي</p>
        <p>{lastReceipt?.number ?? lastReceipt?.offlineId ?? '—'}</p>
        <p>{lastReceipt ? new Date(lastReceipt.createdAt).toLocaleString('ar') : ''}</p>
        {lastReceipt?.lines.map((line) => (
          <p key={line.item.id}>
            {line.item.nameAr ?? line.item.sku} × {line.quantity} —{' '}
            {formatMoney(new Decimal(defaultPrice(catalog, line.item)).times(line.quantity))}
          </p>
        ))}
        <hr />
        <strong>الإجمالي: {lastReceipt ? formatMoney(lastReceipt.totalText) : '—'}</strong>
      </div>
    </Screen>
  );
}
