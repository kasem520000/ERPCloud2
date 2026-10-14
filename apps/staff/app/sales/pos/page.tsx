'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { computeTotals, emptyLine, type LineDraft } from '../../../components/invoice-editor';
import { ApiError, apiData, apiList, apiPost } from '../../../lib/api';
import {
  arabicName,
  cashLocationLabel,
  defaultOf,
  itemLabel,
  listBranches,
  listCashLocations,
  listCategories,
  listItems,
  listParties,
  listTaxGroups,
  listWarehouses,
  money,
  partyLabel,
  type Branch,
  type CashLocation,
  type Category,
  type Item,
  type Party,
  type TaxGroup,
  type Warehouse,
} from '../../../lib/lookups';
import { BankChooser } from '../../../components/bank-chooser';
import { CashCustomerPicker } from '../../../components/cash-customer-picker';
import { ZatcaQrSvg, buildZatcaTlvBase64, printThermalReceipt80mm } from '../../../components/zatca-qr-svg';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

type Ticket = { line: LineDraft; item: Item };

type Method = 'cash' | 'card' | 'bank' | 'credit' | 'split';

/** 💳 صفُّ طريقةٍ في الدفع المتعدّد — «🔀 متعدد» في `frmPOSPay.xaml` L286. */
type Tender = { key: number; method: 'cash' | 'card' | 'bank'; amountText: string; drawerId: string };

/** 🅿️ الفاتورة المعلّقة كما ترجع من الخادم — سلةٌ لا مستند. */
type Hold = {
  id: string;
  slot: number;
  label: string | null;
  total: string;
  linesCount: number;
  cart: {
    /**
     * سطور التعليق تُخزَّن كما هي على الشاشة (`LineDraft`) — فما نُقل إلى السطر من أرقام
     * (R8: «📁 رقم الدفعة» و«🔢 التسلسلي») يعود مع الأوردر المعلَّق، والتعليقات القديمة
     * التي لا تحمل الحقلين تُكمل بـ`emptyLine()` عند الاستعادة.
     */
    lines: Partial<LineDraft>[];
    customerMode?: 'walkin' | 'account';
    customerName?: string;
    customerMobile?: string;
    partyId?: string;
    invoiceDiscount?: string;
  };
};

/** ⚙️ إعدادات الكاشير — `frmCasherSetting.xaml`. */
type PosSettings = {
  'pos.barcodeAuto': boolean;
  'pos.touchScreen': boolean;
  'pos.showGroups': boolean;
  'pos.defaultDeliveryFee': number;
  'pos.defaultInsurance': number;
  'pos.defaultUnitId': string;
  'pos.requireShift': boolean;
};

type Shift = {
  id: string;
  branchId: string;
  status: string;
  openedAt: string;
  expectedCash: string;
  countedCash: string;
  diff: string;
};

type Receipt = {
  invoiceId: string;
  number: string | null;
  subtotal: string;
  taxTotal: string;
  total: string;
  paidTotal: string;
  paymentStatus: string;
  method: Method;
  cashLocationId: string | null;
  shiftId: string | null;
  change: string;
  tendered: string | null;
  /** 🔀 ما قبضته الفاتورة طريقةً طريقة، وكم بقي على ذمة العميل. */
  tenders?: Array<{ method: string; amount: string }> | null;
  onAccount?: string | null;
  cashierId?: string | null;
};

const METHODS: Array<{ id: Method; label: string; hint: string }> = [
  { id: 'cash', label: 'نقداً', hint: 'يُقبض في الصندوق ويظهر في جرد اليومية' },
  { id: 'card', label: 'شبكة', hint: 'يُقفل على حساب البنك ويظهر كتحصيل شبكة' },
  { id: 'bank', label: 'تحويل بنكي', hint: 'يُقفل على حساب البنك' },
  { id: 'credit', label: 'آجل', hint: 'يُرحّل على حساب العميل (ذمم مدينة)' },
  {
    id: 'split',
    label: '🔀 متعدد',
    hint: 'دفع الفاتورة بأكثر من طريقة — «⚖️ مطابقة» تجعل مجموعها الصافي، وما بقي يقف على حساب العميل',
  },
];

const QUICK_CASH = ['20', '50', '100', '200', '500'];

/**
 * Point of sale — one screen, one hand on the keyboard.
 *
 * The whole sale now leaves the browser as a single `POST /pos/checkout`: the API
 * creates the invoice, posts it (journal + stock relief + COGS from the branch
 * posting profile), settles it into the drawer the cashier picked and links it to
 * the open shift — all inside one database transaction. A half-posted sale is
 * therefore impossible, and the closing report can see the till's own takings.
 */
export default function PosPage() {
  const { can, me } = useSession();
  const branches = useQuery<Branch[]>(() => listBranches(), []);
  const warehouses = useQuery<Warehouse[]>(() => listWarehouses(), []);
  const items = useQuery<Item[]>(() => listItems(), []);
  const categories = useQuery<Category[]>(() => listCategories(), []);
  const taxGroups = useQuery<TaxGroup[]>(() => listTaxGroups(), []);
  const cashLocations = useQuery<CashLocation[]>(() => listCashLocations(), []);
  const customers = useQuery<Party[]>(() => listParties('customer'), []);

  const branchRow = defaultOf(branches.data ?? []);
  const branchId = branchRow?.id ?? '';
  const warehouseRows = (warehouses.data ?? []).filter(
    (row) => !branchId || row.branchId === branchId || !row.branchId,
  );
  const [warehouseId, setWarehouseId] = useState('');
  const effectiveWarehouse = warehouseId || defaultOf(warehouseRows)?.id || '';

  const shift = useQuery<Shift | null>(
    () =>
      branchId
        ? apiData<Shift>(`/shift-closes/current?branch_id=${branchId}`).catch(() => null)
        : Promise.resolve(null),
    [branchId],
  );
  const recent = useQuery<
    Array<{
      id: string;
      number: string | null;
      total: string;
      orderType?: string | null;
      status: string;
      paymentStatus?: string;
    }>
  >(() => apiList('/sales/invoices'), []);

  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [ticket, setTicket] = useState<Ticket[]>([]);
  const [customerMode, setCustomerMode] = useState<'walkin' | 'account'>('walkin');
  const [customerName, setCustomerName] = useState('');
  const [customerMobile, setCustomerMobile] = useState('');
  const [partyId, setPartyId] = useState('');
  /**
   * 🏦 اختر البنك / 👤 عميل نقدي — `frmPayBank` و`frmCashCustomer` are windows opened
   * *from* the sale, and each returns one answer to it: which bank the transfer went to,
   * and which walk-in the invoice is written for.
   */
  const [pickingBank, setPickingBank] = useState(false);
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [method, setMethod] = useState<Method>('cash');
  const [cashLocationId, setCashLocationId] = useState('');
  const [tendered, setTendered] = useState('');
  const [invoiceDiscount, setInvoiceDiscount] = useState('');
  const [priceIncludesVat, setPriceIncludesVat] = useState(true);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | undefined>();
  const [receiptLines, setReceiptLines] = useState<
    Array<{ name: string; quantity: string; unitPrice: string; total: string }>
  >([]);
  const [autoPrintThermal, setAutoPrintThermal] = useState(true);
  /**
   * ⚙️ إعدادات الكاشير — تُقرأ من `GET /pos/settings` بصلاحية `pos.view` (لا صلاحية
   * إعدادات المستأجر) لأنّ الكاشير يحتاجها ليعمل، والكتابة تبقى في شاشة الإعدادات.
   */
  const settings = useQuery<PosSettings>(() => apiData<PosSettings>('/pos/settings'), []);
  const casher = {
    barcodeAuto: settings.data?.['pos.barcodeAuto'] ?? true,
    touchScreen: settings.data?.['pos.touchScreen'] ?? false,
    showGroups: settings.data?.['pos.showGroups'] ?? true,
    requireShift: settings.data?.['pos.requireShift'] ?? false,
  };
  /** 🔀 الدفع المتعدّد: صفوف الطرق، ومفتاحها لعنصر React لا لتسلسلٍ يُعاد ترتيبه. */
  const [tenders, setTenders] = useState<Tender[]>([]);
  const tenderSeq = useMemo(() => ({ next: 1 }), []);
  const newTender = (method: 'cash' | 'card' | 'bank', amountText = ''): Tender => ({
    key: tenderSeq.next++,
    method,
    amountText,
    drawerId: '',
  });

  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string } | undefined>();
  /**
   * ✋ تعديل السعر — `frmPOS.xaml` L387: زرّ التعديل `IsEnabled = User.EditPrice`، ومن
   * ضغطه بلا الحقّ سمع «لا يمكن تعديل السعر» (`frmPOS.xaml.cs` L1377، والحارس `User.EditPrice`
   * من `Class/User.cs` L24 · OperNo 13). والسحابة تُعطّل الحقل وتُظهر السبب، والمحرّك يرفض
   * على أي حال بـ`POS_PRICE_OVERRIDE_FORBIDDEN` — فالإخفاء ليس هو الفرض.
   */
  const canOverridePrice = can('pos.priceoverride');

  const defaultRate = (taxGroups.data ?? [])[0]?.rate;
  const drawerKind = method === 'cash' ? 'safe' : 'bank';
  const drawers = (cashLocations.data ?? []).filter(
    (row) => (row.kind ?? 'safe') === drawerKind && (!branchId || !row.branchId || row.branchId === branchId),
  );
  const effectiveDrawer = cashLocationId || defaultOf(drawers)?.id || '';
  /** صناديق/بنوك صفِّ طريقه: النقد من الخزنة، والشبكة والتحويل من البنك. */
  const drawersFor = (tenderMethod: 'cash' | 'card' | 'bank') => {
    const kind = tenderMethod === 'cash' ? 'safe' : 'bank';
    return (cashLocations.data ?? []).filter(
      (row) => (row.kind ?? 'safe') === kind && (!branchId || !row.branchId || row.branchId === branchId),
    );
  };

  const lines = ticket.map((entry) => entry.line);
  const totals = computeTotals(lines, { priceIncludesVat, invoiceDiscount });
  /**
   * حدّ الخصم على العضوية (R1، بديل `OperMaxDiscount`). الشاشة تُظهره فقط؛ الفرض في
   * `assertDiscountWithinLimit` على الخادم، فإخفاء الحقل ليس تجاوزاً.
   */
  const discountLimitText = ((): string => {
    const pct = me?.membership.maxDiscountPct ?? null;
    // الاسم `capAmount` لا `amount`: قاعدة الفحص (`eslint.config.mjs`) تمنع تعريف
    // معرّفٍ باسمٍ نقديّ بلا نوع Decimal — والحدّ نصٌّ لا رقم.
    const capAmount = me?.membership.maxDiscountAmount ?? null;
    if (pct === null && capAmount === null) return '';
    const parts: string[] = [];
    if (pct !== null) parts.push(`أعلى نسبة للخصم ${pct}%`);
    if (capAmount !== null) parts.push(`أعلى قيمة للخصم ${capAmount}`);
    return `حدّك: ${parts.join(' · ')}`;
  })();
  const tenderedValue = Number(tendered || 0);
  const saleValue = Number(totals.total);
  /** 🔀 مجموع الطرق وفرقها عن الصافي — «⚖️ F6 مطابقة». */
  const tenderTotal = tenders.reduce((sum, row) => sum + Number(row.amountText || 0), 0);
  const tenderDiff = tenderTotal - saleValue;
  const change = tenderedValue > 0 ? tenderedValue - saleValue : 0;

  const visible = useMemo(() => {
    const needle = search.trim();
    return (items.data ?? []).filter((row) => {
      if ((row.kind ?? 'stock') !== 'stock') return false;
      if (categoryId && (row.categoryId ?? row.category_id) !== categoryId) return false;
      if (!needle) return true;
      return itemLabel(row).includes(needle) || (row.barcode ?? '').includes(needle);
    });
  }, [items.data, search, categoryId]);

  function add(item: Item) {
    const taxPercent = defaultRate ? String(Number(defaultRate) * 100) : '15';
    setTicket((current) => {
      const existing = current.find((entry) => entry.item.id === item.id);
      if (existing) {
        return current.map((entry) =>
          entry.item.id === item.id
            ? { ...entry, line: { ...entry.line, quantityText: String(Number(entry.line.quantityText) + 1) } }
            : entry,
        );
      }
      return [
        ...current,
        {
          item,
          // بانية السطر الموحّدة (R8): حرفٌ واحد يمنع انحراف تذكرة الكاشير عن شبكة الفاتورة.
          line: {
            ...emptyLine(taxPercent),
            itemId: item.id,
            unitPriceText: String(item.salePrice ?? item.sale_price ?? '0'),
          },
        },
      ];
    });
  }

  function patch(itemId: string, changes: Partial<LineDraft>) {
    setTicket((current) =>
      current.map((entry) =>
        entry.item.id === itemId ? { ...entry, line: { ...entry.line, ...changes } } : entry,
      ),
    );
  }

  async function openShift() {
    setBusy(true);
    setNotice(undefined);
    try {
      await apiPost('/shift-closes/open', { branchId });
      setNotice({ kind: 'ok', text: 'تم فتح الوردية — أصبحت مبيعاتك النقدية تُنسب إليها.' });
      shift.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function checkout() {
    setBusy(true);
    setNotice(undefined);
    try {
      if (ticket.length === 0) throw new ApiError(422, 'VALIDATION_FAILED', 'السلة فارغة.');
      if (!branchId) throw new ApiError(422, 'VALIDATION_FAILED', 'لا يوجد فرع مُعرّف لهذا المستخدم.');
      if (!effectiveWarehouse)
        throw new ApiError(422, 'VALIDATION_FAILED', 'اختر المستودع الذي تُصرف منه الأصناف.');
      if (method !== 'credit' && method !== 'split' && !effectiveDrawer)
        throw new ApiError(
          422,
          'VALIDATION_FAILED',
          `اختر ${method === 'cash' ? 'الصندوق' : 'البنك'} الذي يستلم المبلغ.`,
        );
      /**
       * ⚖️ F6 مطابقة قبل الإرسال — والفرض الحقيقيّ في المحرّك (`POS_TENDER_MISMATCH`)،
       * وهنا جوابٌ فوريّ لا نداءُ شبكةٍ ينتظر رفضاً.
       */
      if (method === 'split') {
        if (tenders.length < 2)
          throw new ApiError(422, 'VALIDATION_FAILED', 'الدفع المتعدّد يحتاج طريقتين على الأقل.');
        for (const row of tenders) {
          if (!(Number(row.amountText) > 0))
            throw new ApiError(422, 'VALIDATION_FAILED', 'كل طريقة تحتاج مبلغاً أكبر من صفر.');
          if (!row.drawerId)
            throw new ApiError(
              422,
              'VALIDATION_FAILED',
              `اختر ${row.method === 'cash' ? 'الصندوق' : 'البنك'} لطريقة الدفع.`,
            );
        }
        if (tenderDiff > 0)
          throw new ApiError(
            422,
            'POS_TENDER_MISMATCH',
            `مجموع الطرق أكبر من الصافي بـ${money(tenderDiff)} — صحّح «⚖️ المطابقة».`,
          );
        if (tenderDiff < 0 && customerMode !== 'account')
          throw new ApiError(
            422,
            'POS_TENDER_MISMATCH',
            `الباقي ${money(-tenderDiff)} يحتاج حساب عميل يقف عليه.`,
          );
      }
      if (method === 'credit' && customerMode !== 'account')
        throw new ApiError(422, 'VALIDATION_FAILED', 'البيع الآجل يحتاج حساب عميل.');

      const response = await apiPost<Receipt & { data?: Receipt }>('/pos/checkout', {
        branchId,
        warehouseId: effectiveWarehouse,
        priceIncludesVat,
        invoiceDiscount: invoiceDiscount || undefined,
        orderType: 'pos',
        shiftId: shift.data?.id,
        partyId: customerMode === 'account' ? partyId || undefined : undefined,
        cashCustomerName: customerMode === 'walkin' ? customerName.trim() || 'عميل عام' : undefined,
        cashCustomerMobile: customerMode === 'walkin' ? customerMobile.trim() || undefined : undefined,
        lines: ticket.map((entry) => ({
          itemId: entry.item.id,
          quantity: entry.line.quantityText,
          unitPrice: entry.line.unitPriceText,
          taxRate: entry.line.taxRateText,
          discountRate: entry.line.discountRateText || undefined,
        })),
        payment:
          method === 'split'
            ? { method: tenders[0]?.method ?? 'cash' }
            : {
                method,
                cashLocationId: method === 'credit' ? undefined : effectiveDrawer,
                tendered: method === 'cash' && tendered ? tendered : undefined,
              },
        /** 🔀 الطرق كما كُتبت — والرمز `split` يبقى في الشاشة لا في الطلب. */
        payments:
          method === 'split'
            ? tenders.map((row) => ({
                method: row.method,
                amount: row.amountText,
                cashLocationId: row.drawerId,
              }))
            : undefined,
      });

      const receiptData = (response.data ?? response) as Receipt;
      const soldLines = ticket.map((entry) => {
        const lineTotals = computeTotals([entry.line], { priceIncludesVat });
        return {
          name: itemLabel(entry.item),
          quantity: entry.line.quantityText || '1',
          unitPrice: entry.line.unitPriceText || '0',
          total: lineTotals.total,
        };
      });
      setReceiptLines(soldLines);
      setReceipt(receiptData);
      setNotice({
        kind: 'ok',
        text: `تم البيع — الفاتورة ${receiptData.number ?? ''} بمبلغ ${money(receiptData.total)}.`,
      });
      if (autoPrintThermal) {
        const qrPayload = buildZatcaTlvBase64({
          sellerName: branchRow ? arabicName(branchRow) : 'ERP Cloud KSA',
          vatNo: '300000000000003',
          timestampIso: new Date().toISOString(),
          total: receiptData.total,
          tax: receiptData.taxTotal,
        });
        printThermalReceipt80mm({
          companyName: branchRow ? arabicName(branchRow) : 'منشأة سحابية',
          taxNo: '300000000000003',
          branchName: branchRow ? arabicName(branchRow) : undefined,
          invoiceNumber: receiptData.number ?? receiptData.invoiceId.slice(0, 8),
          invoiceTypeLabel: 'فاتورة ضريبية مبسطة — إيصال كاشير',
          issuedAt: new Date().toLocaleString('ar-SA'),
          customerName:
            customerMode === 'walkin'
              ? customerName.trim() || 'عميل عام'
              : (customers.data ?? []).find((c) => c.id === partyId)?.name || 'عميل عام',
          paymentMethodLabel: METHODS.find((row) => row.id === receiptData.method)?.label ?? receiptData.method,
          lines: soldLines,
          subtotal: receiptData.subtotal,
          taxTotal: receiptData.taxTotal,
          total: receiptData.total,
          paidAmount: receiptData.tendered ?? receiptData.paidTotal,
          changeAmount: receiptData.change,
          qrPayload,
        });
      }
      setTicket([]);
      setTendered('');
      setInvoiceDiscount('');
      setTenders([]);
      recent.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const holds = useQuery<Hold[]>(
    () => (branchId ? apiList<Hold>(`/pos/holds?branchId=${branchId}`) : Promise.resolve([])),
    [branchId],
  );

  /**
   * ⏸️ تعليق الأوردر — `frmPOS.xaml.cs` L1871–L1962.
   *
   * الديسكتوب يكتب رقم الفاتورة في `HoldList[9]` (L179) ويلوّن الزرّ أخضر (L1907)، ويقول
   * عند امتلاء الخانات «لقد وصلت للحد الاقصي من عمليات الايقاف المؤقت» (L1935) — والرمز
   * نفسه صار في المحرّك، فلا تعتمد الشاشة على عدّها الخاصّ. والسحابة تعلّق **السلة** لا
   * المستند: رقم الفاتورة يُمنح عند الترحيل، فتعليقُ سلةٍ لا يحجز رقماً ولا يلوّث السجلّ.
   */
  async function holdTicket() {
    if (ticket.length === 0) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await apiPost('/pos/holds', {
        branchId,
        label: customerName.trim() || undefined,
        total: totals.total,
        linesCount: ticket.length,
        cart: {
          lines: ticket.map((entry) => entry.line),
          customerMode,
          customerName,
          customerMobile,
          partyId,
          invoiceDiscount,
        },
      });
      setNotice({ kind: 'ok', text: 'تم تعليق الأوردر — عُد إليه من خانته.' });
      setTicket([]);
      setTendered('');
      holds.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  /**
   * استرجاع خانة. والديسكتوب يرفض الاسترجاع على جدولٍ غير فارغ: «يوجد أصناف في الجدول»
   * (L1955) — فالسلة الحالية لا تُدهَس، والحكم هنا لأنّه حالةُ شاشةٍ لا قاعدةُ بيانات.
   */
  function recallHold(hold: Hold) {
    if (ticket.length > 0) {
      setNotice({ kind: 'danger', text: 'يوجد أصناف في الجدول' });
      return;
    }
    const byId = new Map((items.data ?? []).map((row) => [row.id, row]));
    const restored: Ticket[] = [];
    for (const line of hold.cart?.lines ?? []) {
      const item = line.itemId ? byId.get(line.itemId) : undefined;
      if (item) restored.push({ item, line: { ...emptyLine(), ...line, itemId: item.id } });
    }
    setTicket(restored);
    setCustomerMode(hold.cart?.customerMode ?? 'walkin');
    setCustomerName(hold.cart?.customerName ?? '');
    setCustomerMobile(hold.cart?.customerMobile ?? '');
    setPartyId(hold.cart?.partyId ?? '');
    setInvoiceDiscount(hold.cart?.invoiceDiscount ?? '');
    setNotice({ kind: 'ok', text: `تم استرجاع الخانة ${hold.slot + 1}.` });
    void apiPost(`/pos/holds/${hold.id}/recall`, {}).then(() => holds.reload());
  }

  /** وترمى الخانة بلا استرجاع — كما يُفرَّغ الصندوق آخر النهار. */
  async function releaseHold(hold: Hold) {
    try {
      await apiPost(`/pos/holds/${hold.id}/release`, {});
      holds.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) });
    }
  }

  // F7 — اختصار التعليق كما في الديسكتوب («⏸️ تعليق  F7»), ويُتجاهل داخل حقول الكتابة.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'F7') return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      event.preventDefault();
      void holdTicket();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!can('pos.operate')) {
    return (
      <Screen title="نقطة البيع" crumbs={['المبيعات']}>
        <div className="card state">
          <strong>لا تملك صلاحية تشغيل نقطة البيع</strong>
          <span>تحتاج صلاحية pos.operate.</span>
        </div>
      </Screen>
    );
  }

  return (
    <Screen
      title="نقطة البيع"
      subtitle={`${branchRow ? arabicName(branchRow) : 'بدون فرع'} — ${warehouseRows.find((row) => row.id === effectiveWarehouse) ? arabicName(warehouseRows.find((row) => row.id === effectiveWarehouse)!) : 'بدون مستودع'} · ${priceIncludesVat ? 'الأسعار شاملة الضريبة' : 'الأسعار قبل الضريبة'}`}
      crumbs={['المبيعات', 'العمليات']}
      actions={
        <>
          <span className={`badge ${shift.data ? 'posted' : 'draft'}`}>
            {shift.data
              ? `وردية مفتوحة منذ ${new Date(shift.data.openedAt).toLocaleTimeString('ar')}`
              : 'لا توجد وردية مفتوحة'}
          </span>
          {!shift.data && branchId && (
            <button className="btn sm" type="button" disabled={busy} onClick={openShift}>
              فتح وردية
            </button>
          )}
          <Link className="btn sm" href="/sales/shifts">
            إغلاق اليومية
          </Link>
        </>
      }
    >
      <div className="grid cols-2">
        <div className="card">
          <h2>الأصناف</h2>
          <div className="toolbar" style={{ marginBottom: 8 }}>
            <input
              className="input"
              placeholder="بحث بالاسم أو الباركود…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              style={{ maxWidth: 260 }}
              /**
               * «الباركود أوتوماتيك» (`frmCasherSetting.xaml` L239): قارئ الباركود يكتب
               * الرمز ثم Enter، فالزرّ لا يُلمس. والشرط أن يكون المطابق واحداً — رمزٌ
               * يطابق عشرة أصناف سؤالٌ لا جواب، فيبقى للكاشير يختار.
               */
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || !casher.barcodeAuto) return;
                const typed = search.trim();
                if (!typed) return;
                const exact = visible.filter((row) => (row.barcode ?? '') === typed);
                const matches = exact.length ? exact : visible;
                if (matches.length !== 1) return;
                event.preventDefault();
                add(matches[0]!);
                setSearch('');
              }}
            />
            <label className="row" style={{ alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={priceIncludesVat}
                onChange={(event) => setPriceIncludesVat(event.target.checked)}
              />
              الأسعار شاملة الضريبة
            </label>
          </div>
          {/* «عرض المجموعات والأصناف» (`frmCasherSetting.xaml` L265). */}
          <div className="chips" style={{ marginBottom: 10, display: casher.showGroups ? undefined : 'none' }}>
            <button
              className={`chip ${categoryId === '' ? 'on' : ''}`}
              type="button"
              onClick={() => setCategoryId('')}
            >
              الكل
            </button>
            {(categories.data ?? []).map((row) => (
              <button
                key={row.id}
                className={`chip ${categoryId === row.id ? 'on' : ''}`}
                type="button"
                onClick={() => setCategoryId(row.id)}
              >
                {arabicName(row)}
              </button>
            ))}
          </div>
          <div className="pos-tiles">
            {visible.slice(0, 60).map((item) => (
              <button
                className="pos-tile"
                type="button"
                key={item.id}
                onClick={() => add(item)}
                /* 🖐️ «تاتش سكرين» (`frmCasherSetting.xaml` L252): بلاطاتٌ أكبر لإصبعٍ
                   لا لمؤشّر — الإعداد يغيّر المقاس لا المحتوى. */
                style={casher.touchScreen ? { minHeight: 104, fontSize: 15 } : undefined}
              >
                <strong>{arabicName(item)}</strong>
                <span>{money(item.salePrice ?? item.sale_price)}</span>
              </button>
            ))}
          </div>
          {visible.length === 0 && (
            <p className="muted">لا توجد أصناف مطابقة. أضف المواد من «المستودعات ← دليل المواد».</p>
          )}
        </div>

        <div className="card">
          <h2>الفاتورة الحالية</h2>
          {ticket.length === 0 ? (
            <p className="muted">اضغط على صنف لإضافته.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الصنف</th>
                    <th>الكمية</th>
                    <th>السعر</th>
                    <th>خصم %</th>
                    <th>الإجمالي</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {ticket.map((entry) => {
                    const line = computeTotals([entry.line], { priceIncludesVat }).lines[0];
                    return (
                      <tr key={entry.item.id}>
                        <td>{arabicName(entry.item)}</td>
                        <td>
                          <input
                            className="input"
                            dir="ltr"
                            inputMode="decimal"
                            value={entry.line.quantityText}
                            onChange={(event) => patch(entry.item.id, { quantityText: event.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            dir="ltr"
                            inputMode="decimal"
                            value={entry.line.unitPriceText}
                            readOnly={!canOverridePrice}
                            title={canOverridePrice ? undefined : 'لا يمكن تعديل السعر'}
                            onChange={(event) => patch(entry.item.id, { unitPriceText: event.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            dir="ltr"
                            inputMode="decimal"
                            value={entry.line.discountRateText}
                            onChange={(event) =>
                              patch(entry.item.id, { discountRateText: event.target.value })
                            }
                          />
                        </td>
                        <td>{money(line?.total ?? '0')}</td>
                        <td>
                          <button
                            className="btn sm"
                            type="button"
                            onClick={() =>
                              setTicket((current) => current.filter((row) => row.item.id !== entry.item.id))
                            }
                          >
                            حذف
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>قبل الضريبة</dt>
            <dd>{money(totals.subtotal)}</dd>
            <dt>الضريبة</dt>
            <dd>{money(totals.tax)}</dd>
            <dt>المطلوب</dt>
            <dd className="pos-total">{money(totals.total)}</dd>
          </dl>

          <div className="form-grid">
            <label className="field">
              <span>المستودع</span>
              <select
                className="input"
                value={effectiveWarehouse}
                onChange={(event) => setWarehouseId(event.target.value)}
              >
                {warehouseRows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {arabicName(row)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>خصم على الفاتورة</span>
              <input
                className="input"
                dir="ltr"
                inputMode="decimal"
                value={invoiceDiscount}
                onChange={(event) => setInvoiceDiscount(event.target.value)}
              />
              {/* R1 — الحدّ يُعرض هنا ويُفحص في الخادم: الشاشة تُعلن السقف، والخدمة تفرضه. */}
              {discountLimitText && <span className="muted">{discountLimitText}</span>}
            </label>
            <label className="field">
              <span>العميل</span>
              <select
                className="input"
                value={customerMode}
                onChange={(event) => setCustomerMode(event.target.value as 'walkin' | 'account')}
              >
                <option value="walkin">عميل عام (فاتورة ضريبية مبسطة)</option>
                <option value="account">حساب عميل مسجل</option>
              </select>
            </label>
            {customerMode === 'walkin' ? (
              <>
                <label className="field">
                  <span>🏷️ الاسم:</span>
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <input
                      className="input"
                      placeholder="عميل عام"
                      value={customerName}
                      onChange={(event) => setCustomerName(event.target.value)}
                    />
                    <button type="button" className="btn" onClick={() => setPickingCustomer(true)}>
                      👤 بحث
                    </button>
                  </div>
                </label>
                <label className="field">
                  <span>📱 رقم الجوال:</span>
                  <input
                    className="input"
                    dir="ltr"
                    inputMode="tel"
                    value={customerMobile}
                    onChange={(event) => setCustomerMobile(event.target.value)}
                  />
                </label>
              </>
            ) : (
              <label className="field">
                <span>حساب العميل</span>
                <select
                  className="input"
                  value={partyId}
                  onChange={(event) => setPartyId(event.target.value)}
                >
                  <option value="">— اختر —</option>
                  {(customers.data ?? []).map((row) => (
                    <option key={row.id} value={row.id}>
                      {partyLabel(row)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <h2 style={{ marginTop: 6 }}>الدفع</h2>
          <div className="chips">
            {METHODS.map((row) => (
              <button
                key={row.id}
                className={`chip ${method === row.id ? 'on' : ''}`}
                type="button"
                onClick={() => setMethod(row.id)}
                title={row.hint}
              >
                {row.label}
              </button>
            ))}
          </div>
          <p className="muted small">{METHODS.find((row) => row.id === method)?.hint}</p>

          {/**
           * 🔀 دفع الفاتورة بأكثر من طريقة — `frmPOSPay.xaml` L286 (زرّ «🔀 متعدد») وL548
           * («⚖️ F6 مطابقة»). صفٌّ لكل طريقة: بماذا، وكم، ومن أيّ صندوقٍ أو بنك. والمطابقة
           * سطرٌ ظاهر لا حسابٌ في الرأس: الكاشير يرى الفرق قبل أن يضغط «✔ دفع».
           */}
          {method === 'split' && (
            <div className="card tight" style={{ marginTop: 8 }}>
              <div className="card-head">🔀 طرق الدفع</div>
              {tenders.map((row) => (
                <div key={row.key} className="row" style={{ alignItems: 'flex-end', gap: 6, marginBottom: 6 }}>
                  <label className="field" style={{ flex: '0 0 110px' }}>
                    <span>الطريقة</span>
                    <select
                      className="input"
                      value={row.method}
                      onChange={(event) =>
                        setTenders((current) =>
                          current.map((entry) =>
                            entry.key === row.key
                              ? { ...entry, method: event.target.value as Tender['method'], drawerId: '' }
                              : entry,
                          ),
                        )
                      }
                    >
                      <option value="cash">💵 كاش</option>
                      <option value="card">🖧 شبكة</option>
                      <option value="bank">💳 تحويل</option>
                    </select>
                  </label>
                  <label className="field" style={{ flex: '0 0 110px' }}>
                    <span>المبلغ</span>
                    <input
                      className="input"
                      dir="ltr"
                      inputMode="decimal"
                      value={row.amountText}
                      onChange={(event) =>
                        setTenders((current) =>
                          current.map((entry) =>
                            entry.key === row.key ? { ...entry, amountText: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="field" style={{ flex: 1 }}>
                    <span>{row.method === 'cash' ? 'الصندوق' : 'البنك'}</span>
                    <select
                      className="input"
                      value={row.drawerId}
                      onChange={(event) =>
                        setTenders((current) =>
                          current.map((entry) =>
                            entry.key === row.key ? { ...entry, drawerId: event.target.value } : entry,
                          ),
                        )
                      }
                    >
                      <option value="">— اختر —</option>
                      {drawersFor(row.method).map((drawer) => (
                        <option key={drawer.id} value={drawer.id}>
                          {cashLocationLabel(drawer)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="btn sm"
                    type="button"
                    onClick={() => setTenders((current) => current.filter((entry) => entry.key !== row.key))}
                  >
                    ✖
                  </button>
                </div>
              ))}
              <div className="toolbar">
                <button
                  className="btn sm"
                  type="button"
                  onClick={() => setTenders((current) => [...current, newTender('cash')])}
                >
                  + 💵 كاش
                </button>
                <button
                  className="btn sm"
                  type="button"
                  onClick={() => setTenders((current) => [...current, newTender('card')])}
                >
                  + 🖧 شبكة
                </button>
                <button
                  className="btn sm"
                  type="button"
                  onClick={() => setTenders((current) => [...current, newTender('bank')])}
                >
                  + 💳 تحويل
                </button>
              </div>
              <dl className="kv" style={{ marginTop: 8 }}>
                <dt>⚖️ مطابقة</dt>
                <dd className={tenderDiff === 0 ? 'pos-change' : 'pos-change-due'}>
                  {tenderDiff === 0
                    ? `مطابق — ${money(tenderTotal)}`
                    : tenderDiff > 0
                      ? `زيادة ${money(tenderDiff)}`
                      : `ناقص ${money(-tenderDiff)}`}
                </dd>
                {tenderDiff < 0 && <dt>والباقي على حساب العميل</dt>}
                {tenderDiff < 0 && <dd>{money(-tenderDiff)}</dd>}
              </dl>
            </div>
          )}

          {method === 'bank' ? (
            /**
             * 🏦 تحويل بنكي — `frmPayBank.xaml`: a tile per bank, `✔ موافق` / `✖ خروج`,
             * and no sale without a named bank. `EntryOper.cs` L493/L620 then debits
             * *that* bank's account instead of the generic شبكة account, so the choice
             * cannot be a dropdown default the cashier never looked at.
             */
            <div className="card tight" style={{ marginTop: 8 }}>
              <div className="card-head">🏦 البنوك المتاحة</div>
              <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <span>{effectiveDrawer ? cashLocationLabel(drawers.find((row) => row.id === effectiveDrawer) ?? ({} as CashLocation)) : 'لم يُختر بنك'}</span>
                <button type="button" className="btn primary" onClick={() => setPickingBank(true)}>
                  🏦 اختر البنك
                </button>
              </div>
            </div>
          ) : null}

          {method !== 'credit' && method !== 'bank' && method !== 'split' && (
            <label className="field" style={{ marginTop: 8 }}>
              <span>{method === 'cash' ? 'الصندوق' : 'حساب التحصيل'}</span>
              <select
                className="input"
                value={effectiveDrawer}
                onChange={(event) => setCashLocationId(event.target.value)}
              >
                <option value="">— اختر —</option>
                {drawers.map((row) => (
                  <option key={row.id} value={row.id}>
                    {cashLocationLabel(row)}
                  </option>
                ))}
              </select>
            </label>
          )}

          {method === 'cash' && (
            <>
              <label className="field">
                <span>المبلغ المستلم</span>
                <input
                  className="input"
                  dir="ltr"
                  inputMode="decimal"
                  value={tendered}
                  onChange={(event) => setTendered(event.target.value)}
                />
              </label>
              <div className="chips">
                {QUICK_CASH.map((value) => (
                  <button className="chip" type="button" key={value} onClick={() => setTendered(value)}>
                    {value}
                  </button>
                ))}
                <button className="chip" type="button" onClick={() => setTendered(totals.total)}>
                  المبلغ بالضبط
                </button>
              </div>
              <dl className="kv" style={{ marginTop: 8 }}>
                <dt>الباقي</dt>
                <dd className={change < 0 ? 'pos-change-due' : 'pos-change'}>{money(change)}</dd>
              </dl>
            </>
          )}

          <Notice notice={notice} />
          <button
            className="btn primary block"
            type="button"
            disabled={busy || ticket.length === 0}
            onClick={checkout}
          >
            {busy ? 'جارٍ إتمام البيع…' : `إتمام البيع — ${money(totals.total)}`}
          </button>
          {!shift.data && (
            <p className="muted small">لا توجد وردية مفتوحة: لن تُنسب هذه المبيعة إلى جرد اليومية.</p>
          )}
        </div>
      </div>

      {/**
       * ⏸️ أزرار التعليق — الصفّ الثالث في `frmPOS.xaml` (L1120–L1180): تسعة أزرار
       * عنوانها «1»…«9» و`HoldList[9]` (L179)، وزرّ «⏸️ تعليق  F7» تحتها. والمشغول أخضر
       * (`Colors.Green`) والفارغ معطّل — نفس ما تراه العين هنا. والديسكتوب يُخفي 6–9
       * (`Visibility="Collapsed"`) حتى تُشترى الخانات… والسحابة تُظهرها كلها وتترك
       * الحدّ للمحرّك: خانةٌ فارغة ليست عيباً، والمخفيُّ لا يُخبَر به الكاشير.
       */}
      <div className="card">
        <div className="card-head">⏸️ الفواتير المعلّقة — ٩ خانات</div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {(holds.data ?? []).map((hold) => (
            <button
              className="chip on"
              type="button"
              key={hold.id}
              style={{ background: 'var(--success, #2f9e44)', color: 'var(--on-accent)' }}
              title={`${hold.label ?? 'معلّقة'} · ${money(hold.total)} · ${hold.linesCount} صنف`}
              onClick={() => recallHold(hold)}
              onContextMenu={(event) => {
                event.preventDefault();
                void releaseHold(hold);
              }}
            >
              {hold.slot + 1}
            </button>
          ))}
          {Array.from({ length: 9 })
            .map((_, slot) => slot)
            .filter((slot) => !(holds.data ?? []).some((hold) => hold.slot === slot))
            .map((slot) => (
              <button className="chip" type="button" key={`free-${slot}`} disabled title="خانة فارغة">
                {slot + 1}
              </button>
            ))}
          <button
            className="btn sm primary"
            type="button"
            disabled={busy || ticket.length === 0}
            onClick={holdTicket}
            title="F7"
          >
            ⏸️ تعليق  F7
          </button>
        </div>
        <p className="muted small">
          الضغط على خانةٍ مشغولة يسترجع سلها، والضغط الطويل (زرّ الفأرة الأيمن) يُفرغها. و«يوجد أصناف في الجدول»
          تمنع دهس سلةٍ لم تُتمّ.
        </p>
      </div>

      {receipt && (
        <div className="card receipt">
          <div className="toolbar no-print" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <h2>🧾 آخر إيصال كاشير (80mm)</h2>
            <div className="toolbar" style={{ gap: 8, flexWrap: 'wrap' }}>
              <label className="row" style={{ fontSize: 12, gap: 6 }}>
                <input
                  type="checkbox"
                  checked={autoPrintThermal}
                  onChange={(e) => setAutoPrintThermal(e.target.checked)}
                />
                <span>طباعة حرارية فورية بعد البيع</span>
              </label>
              <button
                className="btn primary sm"
                type="button"
                onClick={() => {
                  const qrPayload = buildZatcaTlvBase64({
                    sellerName: branchRow ? arabicName(branchRow) : 'ERP Cloud KSA',
                    vatNo: '300000000000003',
                    timestampIso: new Date().toISOString(),
                    total: receipt.total,
                    tax: receipt.taxTotal,
                  });
                  printThermalReceipt80mm({
                    companyName: branchRow ? arabicName(branchRow) : 'منشأة سحابية',
                    taxNo: '300000000000003',
                    branchName: branchRow ? arabicName(branchRow) : undefined,
                    invoiceNumber: receipt.number ?? receipt.invoiceId.slice(0, 8),
                    invoiceTypeLabel: 'فاتورة ضريبية مبسطة — إيصال كاشير',
                    issuedAt: new Date().toLocaleString('ar-SA'),
                    customerName: customerName.trim() || 'عميل عام',
                    paymentMethodLabel: METHODS.find((row) => row.id === receipt.method)?.label ?? receipt.method,
                    lines:
                      receiptLines.length > 0
                        ? receiptLines
                        : [{ name: 'مبيعات نقطة بيع', quantity: '1', unitPrice: receipt.subtotal, total: receipt.total }],
                    subtotal: receipt.subtotal,
                    taxTotal: receipt.taxTotal,
                    total: receipt.total,
                    paidAmount: receipt.tendered ?? receipt.paidTotal,
                    changeAmount: receipt.change,
                    qrPayload,
                  });
                }}
              >
                🖨️ طباعة إيصال كاشير حراري (80mm)
              </button>
              <Link className="btn sm" href={`/sales/invoices/${receipt.invoiceId}`}>
                تفاصيل الفاتورة
              </Link>
            </div>
          </div>
          <div className="row" style={{ gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <dl className="kv" style={{ flex: 1, minWidth: 220 }}>
              <dt>الرقم</dt>
              <dd>{receipt.number ?? '—'}</dd>
              <dt>الإجمالي</dt>
              <dd>{money(receipt.total)}</dd>
              <dt>الضريبة</dt>
              <dd>{money(receipt.taxTotal)}</dd>
              <dt>طريقة الدفع</dt>
              <dd>{METHODS.find((row) => row.id === receipt.method)?.label ?? receipt.method}</dd>
              {/* 🔀 متعدد: الإيصال يفصّل ما قُبض طريقةً طريقة، والباقي على الحساب إن بقي. */}
              {receipt.tenders?.map((row) => (
                <>
                  <dt key={`${row.method}-dt`}>
                    {row.method === 'cash' ? '💵 كاش' : row.method === 'card' ? '🖧 شبكة' : '💳 تحويل'}
                  </dt>
                  <dd key={`${row.method}-dd`}>{money(row.amount)}</dd>
                </>
              ))}
              {receipt.onAccount && Number(receipt.onAccount) > 0 && (
                <>
                  <dt>على حساب العميل</dt>
                  <dd className="pos-change-due">{money(receipt.onAccount)}</dd>
                </>
              )}
              {receipt.cashierId && (
                <>
                  <dt>الكاشير</dt>
                  <dd dir="ltr">{receipt.cashierId.slice(0, 8)}</dd>
                </>
              )}
              {receipt.method === 'cash' && (
                <>
                  <dt>المستلم</dt>
                  <dd>{receipt.tendered ? money(receipt.tendered) : '—'}</dd>
                  <dt>الباقي</dt>
                  <dd>{money(receipt.change)}</dd>
                </>
              )}
              <dt>الحالة</dt>
              <dd>{receipt.paymentStatus === 'paid' ? 'مدفوعة' : 'آجلة'}</dd>
              {receipt.shiftId && (
                <>
                  <dt>الوردية</dt>
                  <dd>
                    <Link href="/sales/shifts">مربوطة بوردية مفتوحة</Link>
                  </dd>
                </>
              )}
            </dl>
            <ZatcaQrSvg
              payload={buildZatcaTlvBase64({
                sellerName: branchRow ? arabicName(branchRow) : 'ERP Cloud KSA',
                vatNo: '300000000000003',
                timestampIso: new Date().toISOString(),
                total: receipt.total,
                tax: receipt.taxTotal,
              })}
              size={132}
              label="باركود الفاتورة الضريبية المبسطة (QR)"
            />
          </div>
        </div>
      )}

      <div className="card">
        <h2>آخر مبيعات نقطة البيع</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الرقم</th>
                <th>الإجمالي</th>
                <th>الحالة</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(recent.data ?? [])
                .filter((row) => row.orderType === 'pos')
                .slice(0, 8)
                .map((row) => (
                  <tr key={row.id}>
                    <td>{row.number ?? '—'}</td>
                    <td>{money(row.total)}</td>
                    <td>
                      <span className={`badge ${row.status === 'posted' ? 'posted' : row.status}`}>
                        {row.status}
                      </span>
                    </td>
                    <td>
                      <Link className="btn sm" href={`/sales/invoices/${row.id}`}>
                        فتح
                      </Link>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/**
       * 🏦 `frmPayBank` — the bank is chosen at the moment of payment, or the sale is
       * not made: `SelectedBankId == 0` is the desktop's "يرجى اختر بنك أولًا".
       */}
      {pickingBank ? (
        <BankChooser
          banks={drawers}
          selectedId={effectiveDrawer}
          loading={cashLocations.status === 'loading'}
          onPick={(bank) => {
            setCashLocationId(bank.id);
            setPickingBank(false);
          }}
          onCancel={() => setPickingBank(false)}
        />
      ) : null}

      {/** 👤 `frmCashCustomer` — a walk-in is a name and a mobile, not a ledger account. */}
      {pickingCustomer ? (
        <CashCustomerPicker
          value={{ name: customerName, mobile: customerMobile }}
          onPick={(customer) => {
            setCustomerName(customer.name);
            setCustomerMobile(customer.mobile);
            setPickingCustomer(false);
          }}
          onClose={() => setPickingCustomer(false)}
        />
      ) : null}
    </Screen>
  );
}
