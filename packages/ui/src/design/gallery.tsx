'use client';

import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  CreditCard,
  Info,
  Moon,
  Receipt,
  Search,
  Sun,
  Trash2,
  TrendingUp,
  Users,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  Avatar,
  Badge,
  BarSeries,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ChartLegend,
  Combobox,
  ConfirmDialog,
  CountUp,
  DataTable,
  DateRangePicker,
  Donut,
  Drawer,
  EmptyState,
  FilterBar,
  Input,
  KeyboardHint,
  Kpi,
  LineSeries,
  Marquee,
  Meter,
  Modal,
  MoneyField,
  PageBreak,
  PosKeyHints,
  PrintQr,
  PrintSheet,
  Progress,
  Reveal,
  SearchInput,
  SegmentedTabs,
  Select,
  Skeleton,
  SkeletonCard,
  Sparkline,
  Tabs,
  ThemeToggle,
  ToastProvider,
  Tooltip,
  useToast,
  type Column,
} from '../index';

/**
 * The review page.
 *
 * Design v3 §2.3 requires a place where every component can be seen once, in
 * both themes, without hunting through 40 screens. This is that place, and it
 * lives in the kit rather than in an app so the three surfaces cannot drift
 * into three different galleries.
 *
 * It is mounted at `/design` in staff, platform-admin and marketing, and every
 * app gates it to development (see each app's `app/design/page.tsx`).
 */

type DemoRow = {
  id: string;
  name: string;
  amount: string;
  status: string;
  qty: string;
};

const DEMO_ROWS: DemoRow[] = [
  { id: '1', name: 'فاتورة مبيعات — عميل نقدي', amount: '1250.5000', status: 'posted', qty: '3' },
  { id: '2', name: 'فاتورة مبيعات — مؤسسة الأمل', amount: '8420.0000', status: 'draft', qty: '12' },
  { id: '3', name: 'مردود مبيعات', amount: '310.2500', status: 'voided', qty: '1' },
  { id: '4', name: 'فاتورة مبيعات — متجر النخيل', amount: '560.0000', status: 'posted', qty: '4' },
];

const WEEK = [
  { day: 'السبت', sales: 12400, pos: 8200 },
  { day: 'الأحد', sales: 15300, pos: 9400 },
  { day: 'الاثنين', sales: 11100, pos: 7800 },
  { day: 'الثلاثاء', sales: 17800, pos: 12200 },
  { day: 'الأربعاء', sales: 16400, pos: 10900 },
  { day: 'الخميس', sales: 21000, pos: 15100 },
  { day: 'الجمعة', sales: 18900, pos: 13300 },
];

const CHANNELS = [
  { name: 'فاتورة', value: 68, color: 'var(--color-chart-1)' },
  { name: 'نقطة بيع', value: 32, color: 'var(--color-chart-2)' },
];

const COMBOBOX_OPTIONS = [
  { value: 'cash', label: 'عميل نقدي', hint: '💵' },
  { value: 'amal', label: 'مؤسسة الأمل للتجارة', hint: '3001' },
  { value: 'nakhil', label: 'متجر النخيل', hint: '3002' },
];

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-3">
      <div>
        <h2 className="m-0 text-[18px] font-bold text-ink">{title}</h2>
        {note ? <p className="m-0 mt-1 text-[13px] text-muted">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

export function DesignGallery() {
  const { push } = useToast();
  const [tab, setTab] = useState('one');
  const [modal, setModal] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [money, setMoney] = useState('1250.50');
  const [range, setRange] = useState({ from: '2026-10-01', to: '2026-10-31' });
  const [customer, setCustomer] = useState('cash');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [state, setState] = useState<'ready' | 'loading' | 'error' | 'forbidden'>('ready');

  const columns = useMemo<Array<Column<DemoRow>>>(
    () => [
      { key: 'name', header: 'الصنف', cell: (row) => row.name, grow: true },
      { key: 'qty', header: 'الكمية', numeric: true, cell: (row) => row.qty, width: 80 },
      { key: 'amount', header: 'الصافي', numeric: true, ltr: true, cell: (row) => row.amount, width: 120 },
      {
        key: 'status',
        header: 'الحالة',
        width: 110,
        cell: (row) => (
          <Badge status={row.status} dot>
            {row.status === 'posted' ? 'مرحّل' : row.status === 'draft' ? 'مسودة' : 'ملغاة'}
          </Badge>
        ),
      },
    ],
    [],
  );

  const rows = useMemo(() => {
    if (!sort) return DEMO_ROWS;
    const sorted = [...DEMO_ROWS].sort((a, b) => {
      const left = a[sort.key as keyof DemoRow] ?? '';
      const right = b[sort.key as keyof DemoRow] ?? '';
      return String(left).localeCompare(String(right)) * (sort.dir === 'asc' ? 1 : -1);
    });
    return sorted;
  }, [sort]);

  return (
    <div className="grid gap-10" dir="rtl">
      <header className="grid gap-3">
        <h1 className="m-0 text-[26px] font-bold text-ink">نظام التصميم — الإصدار الثالث</h1>
        <p className="m-0 max-w-2xl text-[13.5px] leading-relaxed text-muted">
          كل مكوّن مرة واحدة، في الوضعين. بدّل الوضع من الشريط أعلاه (أو من المفتاح في أي شاشة)
          ويجب أن تبقى كل بطاقة أدناه مقروءة — لا لون ثابت، ولا سطح باهت، ولا حدود تختفي.
        </p>
        <Row>
          <ThemeToggle />
          <span className="text-[12px] text-muted">
            المفتاح أعلاه هو المكوّن نفسه المستخدم في التطبيقات الثلاثة.
          </span>
        </Row>
      </header>

      <Section title="الأزرار" note="خمس variants × ثلاثة مقاسات، مع حالة تعطيل تبقى ظاهرة.">
        <Row>
          <Button variant="primary" icon={<CheckCircle2 size={15} />}>
            حفظ
          </Button>
          <Button variant="secondary">إلغاء</Button>
          <Button variant="ghost">تفاصيل</Button>
          <Button variant="danger" icon={<Trash2 size={15} />}>
            حذف
          </Button>
          <Button variant="success">ترحيل</Button>
          <Button variant="primary" loading>
            جارٍ الحفظ
          </Button>
          <Button disabled>معطّل — ظاهر لا مخفي</Button>
          <Button size="sm">صغير</Button>
          <Button size="lg">كبير</Button>
        </Row>
      </Section>

      <Section title="البطاقات">
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader title="🧾 فاتورة مبيعات" subtitle="frmInvSale.xaml:347" action={<Badge status="posted">مرحّل</Badge>} />
            <CardBody>سطح أبيض في الفاتح، slate-900 في الداكن — نفس الصنف.</CardBody>
            <CardFooter>
              <span>تذييل البطاقة</span>
            </CardFooter>
          </Card>
          <Card variant="raised" hover>
            <CardHeader title="بطاقة مرفوعة" subtitle="shadow-3" />
            <CardBody>تستخدم للطبقات العائمة: النوافذ، القوائم، اللوحات المنبثقة.</CardBody>
          </Card>
          <Card>
            <CardHeader title="شعارات الجهات الخارجية" subtitle="§2.2.8" />
            <CardBody>
              <span className="logo-plate">
                <span className="text-[12px] font-bold text-slate-700">ZATCA</span>
              </span>{' '}
              <span className="text-[12px] text-muted">داخل لوح أبيض محايد دائمًا.</span>
            </CardBody>
          </Card>
        </div>
      </Section>

      <Section title="المؤشرات" note="اتجاه مقارنة + sparkline، واللون يتبع المعنى لا الرقم.">
        <div className="grid gap-4 md:grid-cols-4">
          <Kpi
            title="مبيعات اليوم"
            value={<span dir="ltr">112,930.00</span>}
            icon={<TrendingUp size={18} />}
            tone="brand"
            delta={12.4}
            deltaLabel="مقابل الأمس"
            spark={[8, 12, 10, 16, 14, 20, 18]}
          />
          <Kpi
            title="الذمم المدينة"
            value={<span dir="ltr">48,200.00</span>}
            icon={<Receipt size={18} />}
            tone="warn"
            delta={-3.1}
            deltaLabel="مقابل الأمس"
            goodDirection="down"
            spark={[20, 18, 19, 15, 14, 13, 12]}
          />
          <Kpi
            title="النقدية"
            value={<span dir="ltr">9,410.00</span>}
            icon={<CreditCard size={18} />}
            tone="ok"
            delta={0}
            deltaLabel="بلا تغيير"
            spark={[9, 9, 9, 9, 9, 9, 9]}
          />
          <Kpi
            title="العملاء"
            value={<CountUp value={1284} />}
            icon={<Users size={18} />}
            tone="neutral"
            hint="عدد العملاء النشطين"
          />
        </div>
        <Row>
          <Sparkline points={[4, 8, 6, 12, 9, 15, 13]} color="var(--ok)" />
          <span className="text-[12px] text-muted">Sparkline بلون من المتغيرات.</span>
        </Row>
      </Section>

      <Section title="الشارات وخريطة الحالات" note="نفس الخريطة في التطبيقات الثلاثة.">
        <Row>
          <Badge status="posted" dot>
            مرحّل
          </Badge>
          <Badge status="draft" dot>
            مسودة
          </Badge>
          <Badge status="voided" dot>
            ملغاة
          </Badge>
          <Badge status="مطابق" dot>
            مطابق
          </Badge>
          <Badge status="زيادة" dot>
            زيادة
          </Badge>
          <Badge status="ناقص" dot>
            ناقص
          </Badge>
          <Badge tone="brand" dot>
            معلومات
          </Badge>
          <Badge tone="neutral">محايد</Badge>
        </Row>
      </Section>

      <Section
        title="الجدول"
        note="ترويسة لاصقة، فرز، اختيار أعمدة محفوظ في localStorage، وأربع حالات صريحة."
      >
        <Row>
          <SegmentedTabs
            label="حالة الجدول"
            value={state}
            onChange={(next) => setState(next as typeof state)}
            items={[
              { key: 'ready', label: 'جاهز' },
              { key: 'loading', label: 'تحميل' },
              { key: 'error', label: 'خطأ' },
              { key: 'forbidden', label: 'محظور' },
            ]}
          />
        </Row>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          storageKey="design-gallery"
          selectable
          selectedKeys={selected}
          onSelectionChange={setSelected}
          sortable
          sort={sort}
          onSortChange={setSort}
          dense
          state={
            state === 'ready'
              ? { kind: 'ready' }
              : state === 'loading'
                ? { kind: 'loading' }
                : state === 'error'
                  ? { kind: 'error', message: 'GET /sales-invoices → 500' }
                  : { kind: 'forbidden', message: 'sales.invoice.view' }
          }
          footer={['', '3', '9,930.75', '']}
          empty="لا توجد فواتير في هذه الفترة"
        />
      </Section>

      <Section title="الفلاتر والحقول">
        <FilterBar onClear={() => undefined} summary="12 من 340">
          <SearchInput label="بحث" placeholder="ابحث عن صنف أو عميل…" wrapperClassName="w-56" />
          <Select
            label="الحالة"
            wrapperClassName="w-40"
            placeholder="الكل"
            options={[
              { value: 'posted', label: 'مرحّل' },
              { value: 'draft', label: 'مسودة' },
            ]}
          />
          <Combobox
            label="العميل"
            wrapperClassName="w-64"
            options={COMBOBOX_OPTIONS}
            value={customer}
            onChange={setCustomer}
          />
          <MoneyField
            label="السعر"
            value={money}
            onChange={setMoney}
            note="حدّك: 15% / 500.00"
            wrapperClassName="w-44"
          />
          <DateRangePicker
            label="الفترة"
            from={range.from}
            to={range.to}
            onChange={setRange}
            wrapperClassName="w-72"
          />
        </FilterBar>
        <Row>
          <Input label="حقل نصي" placeholder="نص…" hint="تلميح تحت الحقل" wrapperClassName="w-56" />
          <Input label="بخطأ" error="قيمة غير صحيحة" defaultValue="abc" wrapperClassName="w-56" />
          <Input label="معطّل" disabled defaultValue="لا يمكن تعديل السعر" wrapperClassName="w-56" />
        </Row>
      </Section>

      <Section title="المخططات" note="كل لون من المتغيرات أو من لوحة السلاسل الثابتة.">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="مبيعات الأسبوع" subtitle="فاتورة مقابل نقطة بيع" />
            <BarSeries
              data={WEEK}
              xKey="day"
              series={[
                { key: 'sales', label: 'فاتورة' },
                { key: 'pos', label: 'نقطة بيع' },
              ]}
              height={220}
            />
            <ChartLegend
              items={[
                { name: 'فاتورة', color: 'var(--color-chart-1)' },
                { name: 'نقطة بيع', color: 'var(--color-chart-2)' },
              ]}
            />
          </Card>
          <Card>
            <CardHeader title="قنوات البيع" subtitle="حصة كل قناة" />
            <Donut data={CHANNELS} centerValue="112,930" centerLabel="الإجمالي" height={220} />
            <ChartLegend
              items={CHANNELS.map((entry) => ({ name: entry.name, color: entry.color }))}
            />
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader title="الاتجاه" subtitle="خط زمني" />
            <LineSeries
              data={WEEK}
              xKey="day"
              series={[{ key: 'sales', label: 'فاتورة' }]}
              height={200}
            />
          </Card>
        </div>
      </Section>

      <Section title="الحصص والتقدّم">
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader title="الحصص" subtitle="§5 — Progress / Meter" />
            <div className="grid gap-4">
              <Meter label="الفواتير هذا الشهر" used="8,240" limit="10,000" percent={82.4} />
              <Meter label="المستخدمون" used="10" limit="10" percent={100} />
              <Meter label="التخزين (جيجابايت)" used="61" limit="50" percent={122} unit="GB" />
              <Progress value={45} label="تقدّم عام" />
              <Progress label="غير محدّد" />
            </div>
          </Card>
          <Card>
            <CardHeader title="الصور الرمزية والتلميحات" />
            <div className="grid gap-4">
              <Row>
                <Avatar name="أحمد الشمري" size="lg" hint="مالك" />
                <Avatar name="Sara Lee" size="md" hint="محاسب" />
                <Avatar name="س" size="sm" />
              </Row>
              <Row>
                <Tooltip label="طباعة الفاتورة (F9)">
                  <Button size="sm" icon={<Receipt size={14} />}>
                    طباعة
                  </Button>
                </Tooltip>
                <Tooltip label="إشعارات غير مقروءة" side="bottom">
                  <Button size="sm" icon={<Bell size={14} />}>
                    3
                  </Button>
                </Tooltip>
              </Row>
              <Row>
                <KeyboardHint keys={['F7']} label="تعليق" />
                <KeyboardHint keys={['F9']} label="حفظ + طباعة" />
                <KeyboardHint keys={['Esc']} label="إلغاء" />
              </Row>
              <PosKeyHints
                hints={[
                  { keys: ['F7'], label: 'تعليق' },
                  { keys: ['F9'], label: 'دفع' },
                ]}
              />
            </div>
          </Card>
        </div>
      </Section>

      <Section title="التنبيهات والحالات">
        <Row>
          <Button size="sm" onClick={() => push({ tone: 'success', title: 'تم حفظ الفاتورة' })}>
            نجاح
          </Button>
          <Button size="sm" onClick={() => push({ tone: 'info', title: 'تم إرسال الطلب' })}>
            معلومة
          </Button>
          <Button
            size="sm"
            onClick={() => push({ tone: 'warning', title: 'الكمية تحت الحد الأدنى' })}
          >
            تحذير
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              push({ tone: 'danger', title: 'تعذّر الترحيل', description: 'POS_TENDER_MISMATCH' })
            }
          >
            خطر
          </Button>
        </Row>
        <div className="grid gap-4 md:grid-cols-3">
          <EmptyState
            icon={<Search size={26} />}
            title="لا نتائج"
            description="غيّر الفلاتر أو امسحها للعودة إلى القائمة الكاملة."
            action={<Button size="sm">مسح الفلاتر</Button>}
          />
          <EmptyState
            icon={<XCircle size={26} />}
            tone="danger"
            title="GET /sales-invoices → 503"
            description="الخدمة غير متاحة. الرسالة كما وردت، لا صمت."
          />
          <EmptyState
            icon={<AlertTriangle size={26} />}
            tone="warn"
            title="لا تملك صلاحية العرض"
            description="الصلاحية تُمنح من «⚙️ تعديل الصلاحيات»."
          />
        </div>
        <Row>
          <SkeletonCard />
          <div className="grid gap-2">
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="h-3.5 w-24" />
          </div>
        </Row>
      </Section>

      <Section title="النوافذ واللوحات" note="تركيز محصور، Escape للإغلاق، وصفحة لا تُمرّر خلفها.">
        <Row>
          <Button variant="primary" onClick={() => setModal(true)}>
            فتح نافذة
          </Button>
          <Button onClick={() => setDrawer(true)}>فتح لوحة يمينية</Button>
          <Button variant="danger" onClick={() => setConfirm(true)}>
            إجراء تدميري
          </Button>
        </Row>
      </Section>

      <Section title="الطباعة" note="أبيض دائمًا، حتى لو طبعت من الوضع الليلي.">
        <PrintSheet
          format="a4"
          header={
            <div className="flex items-center justify-between">
              <strong>🧾 فاتورة مبيعات</strong>
              <span className="num" dir="ltr">
                INV-2026-0001
              </span>
            </div>
          }
          footer="شكرًا لتعاملكم معنا — هذه الفاتورة صادرة من نظام ERPCloud السحابي."
        >
          <table className="w-full text-left text-[12px]">
            <thead>
              <tr>
                <th className="border-b border-slate-300 py-1">الصنف</th>
                <th className="border-b border-slate-300 py-1">الكمية</th>
                <th className="border-b border-slate-300 py-1">الصافي</th>
              </tr>
            </thead>
            <tbody>
              {DEMO_ROWS.map((row) => (
                <tr key={row.id}>
                  <td className="py-1">{row.name}</td>
                  <td className="num py-1" dir="ltr">
                    {row.qty}
                  </td>
                  <td className="num py-1" dir="ltr">
                    {row.amount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 flex items-center justify-between">
            <PrintQr value="AQZATCA-TLV-PAYLOAD" label="QR المرحلة الثانية" />
            <strong className="num" dir="ltr">
              9,930.75 ر.س
            </strong>
          </div>
          <PageBreak />
        </PrintSheet>
      </Section>

      <Section title="حركة التسويق" note="Reveal / CountUp / Marquee — للموقع فقط.">
        <Reveal>
          <Card>
            <CardBody>يظهر هذا العنصر عند وصوله إلى الشاشة، بمدة ≤ 300ms.</CardBody>
          </Card>
        </Reveal>
        <Marquee speed={26}>
          {['قطاع التجزئة', 'المطاعم', 'البصريات', 'التفصيل', 'المقاولات', 'الخدمات'].map((item) => (
            <span key={item} className="text-[13px] font-bold text-ink-2">
              {item}
            </span>
          ))}
        </Marquee>
      </Section>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="نافذة نظام"
        description="وصف قصير يشرح ما سيحدث."
        footer={
          <>
            <Button onClick={() => setModal(false)}>إلغاء</Button>
            <Button variant="primary" onClick={() => setModal(false)}>
              تأكيد
            </Button>
          </>
        }
      >
        <p className="m-0">
          جسم النافذة. التركيز ينتقل إليها عند الفتح، ويدور بين عناصرها بـ Tab، ويعود إلى الزر الذي
          فتحها عند الإغلاق.
        </p>
      </Modal>

      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        title="لوحة تفاصيل"
        description="تنزلق من حافة البداية المنطقية — يمين في العربية ويسار في الإنجليزية."
        footer={<Button onClick={() => setDrawer(false)}>إغلاق</Button>}
      >
        <div className="grid gap-3">
          <Input label="الاسم" defaultValue="مؤسسة الأمل للتجارة" />
          <MoneyField label="الرصيد" value="4820.00" onChange={() => undefined} />
          <Tabs
            label="أقسام"
            value={tab}
            onChange={setTab}
            items={[
              { key: 'one', label: 'عام' },
              { key: 'two', label: 'الفواتير', badge: 12 },
              { key: 'three', label: 'السجل' },
            ]}
          />
          <p className="m-0 text-[13px] text-muted">
            محتوى اللوحة. لون السطح والحدود من المتغيرات، فلا شيء يختلف بين الوضعين.
          </p>
        </div>
      </Drawer>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          push({ tone: 'success', title: 'تم تنفيذ الإجراء' });
        }}
        title="حذف المستأجر؟"
        description="إجراء لا يمكن الرجوع عنه. يُسجَّل السبب في سجل التدقيق."
        confirmWord="حذف"
      />

      <div className="flex items-center gap-3 text-[12px] text-muted">
        <Sun size={14} aria-hidden />
        <span>فاتح</span>
        <Moon size={14} aria-hidden />
        <span>داكن</span>
        <Info size={14} aria-hidden />
        <span>هذه الصفحة مقيّدة ببيئة التطوير.</span>
      </div>
    </div>
  );
}

/** Convenience wrapper: the gallery already needs a toast provider for its demos. */
export function DesignGalleryWithToasts() {
  return (
    <ToastProvider>
      <DesignGallery />
    </ToastProvider>
  );
}
