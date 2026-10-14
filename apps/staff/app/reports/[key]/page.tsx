'use client';

import Link from 'next/link';
import { use, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Banknote,
  Download,
  FileSpreadsheet,
  FileText,
  Hash,
  ListChecks,
  Printer,
  Search,
  Timer,
} from 'lucide-react';

import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { BarCardChart, LineCardChart } from '../../../components/ui/chart';
import { Reveal } from '../../../components/ui/count-up';
import { EmptyState } from '../../../components/ui/empty-state';
import { Labeled } from '../../../components/ui/input';
import { KpiCard } from '../../../components/ui/kpi-card';
import { SkeletonCard } from '../../../components/ui/skeleton';
import { Table, type SortState } from '../../../components/ui/table';
import {
  arabicName,
  itemLabel,
  listAccounts,
  listBranches,
  listCashLocations,
  listCategories,
  listCostCenters,
  listItems,
  listParties,
  listSalesmen,
  listVesselGroups,
  listWarehouses,
  partyLabel,
  type Account,
  type Branch,
  type CashLocation,
  type Category,
  type CostCenter,
  type Item,
  type Party,
  type Salesman,
  type VesselGroup,
  type Warehouse,
} from '../../../lib/lookups';
import {
  REPORT_GROUP_LABELS,
  exportReport,
  fetchReportCatalog,
  fetchReportLayouts,
  formatCell,
  initialFilters,
  isNumericColumn,
  openPrintable,
  runReport,
  saveExport,
  type ExportFormat,
  type ReportEntry,
  type ReportLayout,
  type ReportParam,
  type ReportResult,
} from '../../../lib/reports';
import { useQuery } from '../../../lib/use-query';

export default function ReportRunnerPage({ params }: { params: Promise<{ key: string }> }) {
  const reportKey = use(params).key;
  const catalog = useQuery<ReportEntry[]>(() => fetchReportCatalog(), []);
  const entry = (catalog.data ?? []).find((row) => row.key === reportKey);

  const [filters, setFilters] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'warn'; text: string } | null>(null);
  const layouts = useQuery<ReportLayout[]>(() => fetchReportLayouts(reportKey), [reportKey]);

  useEffect(() => {
    if (!entry) return;
    const initial = initialFilters(entry.params);
    setFilters(initial);
    setApplied(initial);
    setReady(true);
  }, [entry]);

  const appliedKey = JSON.stringify(applied);
  const report = useQuery<ReportResult | null>(
    async () => (ready && entry ? runReport(reportKey, applied) : null),
    [reportKey, appliedKey, ready, Boolean(entry)],
  );

  const kinds = new Set((entry?.params ?? []).map((param) => param.kind));
  const branches = useQuery<Branch[]>(async () => (kinds.has('branch') ? listBranches() : []), [reportKey, kinds.has('branch')]);
  const warehouses = useQuery<Warehouse[]>(async () => (kinds.has('warehouse') ? listWarehouses() : []), [reportKey, kinds.has('warehouse')]);
  const parties = useQuery<Party[]>(async () => (kinds.has('party') ? listParties() : []), [reportKey, kinds.has('party')]);
  const items = useQuery<Item[]>(async () => (kinds.has('item') ? listItems() : []), [reportKey, kinds.has('item')]);
  const categories = useQuery<Category[]>(async () => (kinds.has('category') ? listCategories() : []), [reportKey, kinds.has('category')]);
  const costCenters = useQuery<CostCenter[]>(async () => (kinds.has('costCenter') ? listCostCenters() : []), [reportKey, kinds.has('costCenter')]);
  const salesmen = useQuery<Salesman[]>(async () => (kinds.has('salesman') ? listSalesmen() : []), [reportKey, kinds.has('salesman')]);
  const accounts = useQuery<Account[]>(async () => (kinds.has('account') ? listAccounts() : []), [reportKey, kinds.has('account')]);
  const cashLocations = useQuery<CashLocation[]>(async () => (kinds.has('cashLocation') ? listCashLocations() : []), [reportKey, kinds.has('cashLocation')]);
  const vesselGroups = useQuery<VesselGroup[]>(async () => (kinds.has('vesselGroup') ? listVesselGroups() : []), [reportKey, kinds.has('vesselGroup')]);

  const optionsFor = useMemo(
    () => ({
      branch: (branches.data ?? []).map((row) => ({ value: row.id, label: arabicName(row) })),
      warehouse: (warehouses.data ?? []).map((row) => ({ value: row.id, label: arabicName(row) })),
      party: (parties.data ?? []).map((row) => ({ value: row.id, label: partyLabel(row) })),
      item: (items.data ?? []).map((row) => ({ value: row.id, label: itemLabel(row) })),
      category: (categories.data ?? []).map((row) => ({ value: row.id, label: arabicName(row) })),
      costCenter: (costCenters.data ?? []).map((row) => ({ value: row.id, label: `${row.code} — ${arabicName(row)}` })),
      salesman: (salesmen.data ?? []).map((row) => ({ value: row.id, label: row.name })),
      account: (accounts.data ?? []).map((row) => ({ value: row.id, label: `${row.code} — ${arabicName(row)}` })),
      cashLocation: (cashLocations.data ?? []).map((row) => ({ value: row.id, label: row.name })),
      vesselGroup: (vesselGroups.data ?? []).map((row) => ({ value: row.id, label: row.name })),
    }),
    [branches.data, warehouses.data, parties.data, items.data, categories.data, costCenters.data, salesmen.data, accounts.data, cashLocations.data, vesselGroups.data],
  );

  if (catalog.status === 'success' && !entry) {
    return (
      <EmptyState
        tone="red"
        icon={<FileText size={30} strokeWidth={1.5} />}
        title="تقرير غير معروف"
        description={`لا يوجد تقرير بالمفتاح «${reportKey}». راجع مركز التقارير.`}
        action={
          <Link href="/reports">
            <Button variant="primary" icon={<ArrowRight size={15} />}>مركز التقارير</Button>
          </Link>
        }
      />
    );
  }

  const result = report.data ?? null;

  async function download(format: ExportFormat) {
    setBusy(format);
    setNotice(null);
    try {
      const produced = await exportReport(reportKey, applied, format);
      if (format === 'pdf') {
        if (!openPrintable(produced.content)) {
          setNotice({ kind: 'warn', text: 'تعذّر فتح نافذة الطباعة — اسمح بالنوافذ المنبثقة لهذا الموقع ثم أعد المحاولة.' });
        }
      } else {
        saveExport(produced);
        setNotice({ kind: 'ok', text: `تم تصدير ${produced.rows} سجلاً إلى الملف ${produced.filename}` });
      }
    } catch (error) {
      setNotice({ kind: 'danger', text: error instanceof Error ? error.message : 'تعذّر التصدير' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-4">
      {/* header */}
      <Reveal>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Link href="/reports" className="grid place-items-center size-9 rounded-xl bg-surface border border-line shadow-1 text-muted hover:text-brand-600 hover:border-brand-200 transition-colors">
              <ArrowRight size={17} />
            </Link>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="m-0 text-[22px] font-bold text-ink tracking-tight leading-tight truncate">{entry?.titleAr ?? 'تقرير'}</h1>
                <Badge tone="blue" dot>
                  {REPORT_GROUP_LABELS[entry?.group ?? ''] ?? 'تقارير'}
                </Badge>
              </div>
              {entry?.hintAr ? <p className="m-0 text-[12.5px] text-muted truncate">{entry.hintAr}</p> : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/settings/printing">
              <Button variant="ghost" icon={<Printer size={15} />}>
                إعدادات الطباعة
              </Button>
            </Link>
            <Button variant="secondary" icon={<FileSpreadsheet size={15} />} disabled={!result || busy !== null} loading={busy === 'xlsx'} onClick={() => void download('xlsx')}>
              Excel
            </Button>
            <Button variant="secondary" icon={<Download size={15} />} disabled={!result || busy !== null} loading={busy === 'csv'} onClick={() => void download('csv')}>
              CSV
            </Button>
            <Button variant="primary" icon={<Printer size={15} />} disabled={!result || busy !== null} loading={busy === 'pdf'} onClick={() => void download('pdf')}>
              طباعة / PDF
            </Button>
          </div>
        </div>
      </Reveal>

      {/* filters */}
      {entry ? (
        <Reveal delay={0.05}>
          <form
            className="rounded-xl border border-line bg-surface p-4 shadow-1"
            onSubmit={(event) => {
              event.preventDefault();
              setNotice(null);
              setApplied({ ...filters });
            }}
          >
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 items-end">
              {(layouts.data ?? []).length > 0 ? (
                <Labeled label="التصميم">
                  <select
                    value={filters.layout ?? ''}
                    onChange={(event) => setFilters((current) => ({ ...current, layout: event.target.value }))}
                    className="w-full h-10 px-3 rounded-[10px] border border-line-strong bg-surface text-[13.5px] text-ink focus:outline-none focus:border-brand-600 focus:shadow-[var(--ring-brand)] transition-all duration-150"
                  >
                    <option value="">الافتراضي</option>
                    {(layouts.data ?? []).map((layout) => (
                      <option key={layout.id} value={layout.id}>
                        {layout.name}
                      </option>
                    ))}
                    <option value="none">كل الأعمدة</option>
                  </select>
                </Labeled>
              ) : null}
              {entry.params.map((param) => (
                <FilterField
                  key={param.name}
                  param={param}
                  value={filters[param.name] ?? ''}
                  options={
                    param.kind === 'select'
                      ? (param.options ?? []).map((option) => ({ value: option.value, label: option.labelAr }))
                      : optionsFor[param.kind as keyof typeof optionsFor] ?? []
                  }
                  onChange={(value) => setFilters((current) => ({ ...current, [param.name]: value }))}
                />
              ))}
              <div className="col-span-2 sm:col-span-3 lg:col-span-4 xl:col-span-5 flex justify-end">
                <Button type="submit" variant="primary" size="lg" icon={<Search size={16} />}>
                  عرض التقرير
                </Button>
              </div>
            </div>
          </form>
        </Reveal>
      ) : null}

      {notice ? (
        <div
          className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-[13px] font-semibold ${
            notice.kind === 'ok'
              ? 'border-ok-line bg-ok-soft text-ok-ink'
              : notice.kind === 'danger'
                ? 'border-danger-line bg-danger-soft text-danger-ink'
                : 'border-warn-line bg-warn-soft text-warn-ink'
          }`}
        >
          {notice.text}
        </div>
      ) : null}

      {/* body */}
      {report.status === 'loading' ? (
        <div className="grid gap-4">
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <SkeletonCard lines={2} />
            <SkeletonCard lines={2} />
            <SkeletonCard lines={2} />
            <SkeletonCard lines={2} />
          </div>
          <SkeletonCard lines={7} />
        </div>
      ) : report.status === 'error' ? (
        <EmptyState
          tone="red"
          icon={<FileText size={30} strokeWidth={1.5} />}
          title="تعذّر تشغيل التقرير"
          description={report.error ?? 'خطأ غير معروف'}
          action={<Button variant="primary" onClick={report.reload}>إعادة المحاولة</Button>}
        />
      ) : !result ? null : result.rows.length === 0 ? (
        <EmptyState
          icon={<ListChecks size={30} strokeWidth={1.5} />}
          title="لا توجد بيانات ضمن هذه الفترة"
          description="جرّب توسيع الفترة أو إزالة المرشحات — التقارير تعرض المستندات المرحّلة فقط."
        />
      ) : (
        <>
          {/* summary cards */}
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <KpiCard
              title="عدد السطور"
              value={result.rowCount.toLocaleString('ar-EG')}
              icon={<Hash size={20} />}
              tone="blue"
              hint={`وقت الاستخراج: ${result.generatedAt.slice(0, 16).replace('T', ' ')}`}
            />
            {result.grandTotal.slice(0, 3).map((card, index) => (
              <KpiCard
                key={card.key}
                title={card.labelAr}
                value={formatCell(card.amount, 'money')}
                icon={<Banknote size={20} />}
                tone={index % 2 === 0 ? 'green' : 'amber'}
                delay={0.06 * (index + 1)}
              />
            ))}
            {result.grandTotal.length === 0
              ? Object.entries(result.totals).slice(0, 3).map(([key, value], index) => (
                  <KpiCard
                    key={key}
                    title={result.columns.find((column) => column.key === key)?.labelAr ?? key}
                    value={formatCell(value, result.columns.find((column) => column.key === key)?.type ?? 'money')}
                    icon={<Timer size={20} />}
                    tone={index % 2 === 0 ? 'amber' : 'green'}
                    delay={0.06 * (index + 1)}
                  />
                ))
              : null}
          </div>

          {/* chart */}
          {entry?.chart && result.columns.length > 0 ? (
            <Reveal delay={0.1}>
              <ReportChart entry={entry} result={result} />
            </Reveal>
          ) : null}

          {/* table */}
          <Reveal delay={0.15}>
            <div className="rounded-xl border border-line bg-surface shadow-1 overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 pb-1">
                <h3 className="m-0 text-[15px] font-bold text-ink">نتائج التقرير</h3>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(result.totals).map(([key, value]) => {
                    const column = result.columns.find((col) => col.key === key);
                    return (
                      <Badge key={key} tone="neutral" dot>
                        {column?.labelAr ?? key}: {formatCell(value, column?.type ?? 'money')}
                      </Badge>
                    );
                  })}
                </div>
              </div>
              <div className="px-1 pb-1">
                <SortableReportTable result={result} />
              </div>
            </div>
          </Reveal>
        </>
      )}
    </div>
  );
}

/** 📈 مخطط بياني تفاعلي — يعتمد أول عمود رقمي من `net`/`total`/`quantity`/`sales`/`invoices`/`count`. */
function ReportChart({ entry, result }: { entry: ReportEntry; result: ReportResult }) {
  const numericCols = result.columns.filter((c) => c.type === 'money' || c.type === 'qty' || c.type === 'int');
  const preferred = ['net', 'total', 'quantity', 'sales', 'invoices', 'count'].find((k) => numericCols.some((c) => c.key === k)) ?? numericCols[0]?.key ?? '';
  const labelCol =
    result.columns.find((c) => c.type !== 'money' && c.type !== 'qty' && c.type !== 'int' && !c.hidden)?.key ?? result.columns[0]?.key ?? '';
  const valueCol = entry.columns.find((c) => c.key === preferred)?.labelAr ?? preferred;

  const data = useMemo(
    () =>
      result.rows.slice(0, 30).map((row, i) => ({
        name: (labelCol ? (row[labelCol] ?? `سطر ${i + 1}`) : `سطر ${i + 1}`).toString().slice(0, 18),
        value: Number(row[preferred] ?? '0') || 0,
      })),
    [result, labelCol, preferred],
  );

  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-1">
      <div className="flex items-center justify-between mb-2">
        <h3 className="m-0 text-[15px] font-bold text-ink">
          📈 {valueCol} — {entry.titleAr}
        </h3>
        <Badge tone="blue" dot>
          {entry.chart === 'bar' ? 'أعمدة' : 'خط'}
        </Badge>
      </div>
      {data.length > 0 ? (
        entry.chart === 'line' ? (
          <LineCardChart data={data} xKey="name" dataKey="value" name={valueCol} height={300} formatter={(v) => formatCell(String(v), 'money')} />
        ) : (
          <BarCardChart data={data} xKey="name" dataKey="value" name={valueCol} height={300} formatter={(v) => formatCell(String(v), 'money')} />
        )
      ) : (
        <EmptyState icon={<ListChecks size={24} strokeWidth={1.5} />} title="لا توجد قيم للرسم" />
      )}
    </div>
  );
}

/** جدول قابل للفرز مع صف الإجماليات المثبّت أسفل الجدول. */
function SortableReportTable({ result }: { result: ReportResult }) {
  const [sort, setSort] = useState<SortState>(null);

  const rows = useMemo(() => {
    if (!sort) return result.rows;
    const col = result.columns.find((c) => c.key === sort.key);
    const numeric = col ? isNumericColumn(col) : false;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...result.rows].sort((a, b) => {
      const av = a[sort.key] ?? '';
      const bv = b[sort.key] ?? '';
      if (numeric) return (Number(av) - Number(bv)) * factor;
      return av.localeCompare(bv, 'ar') * factor;
    });
  }, [result, sort]);

  const footer = useMemo(
    () =>
      result.columns.map((column) => {
        const value = result.totals[column.key];
        return value !== undefined ? (
          <span className="font-bold text-ink">{formatCell(value, column.type)}</span>
        ) : (
          <span className="text-muted">·</span>
        );
      }),
    [result],
  );

  return (
    <Table
      rows={rows}
      rowKey={(_row, index) => `${result.key}-${index}`}
      sortable
      sort={sort}
      onSortChange={setSort}
      dense
      footer={footer}
      columns={result.columns.map((column) => ({
        key: column.key,
        header: column.labelAr,
        numeric: isNumericColumn(column),
        sortable: true,
        cell: (row: Record<string, string>) => (
          <span style={isNumericColumn(column) ? { fontVariantNumeric: 'tabular-nums' } : undefined}>{formatCell(row[column.key] ?? '', column.type)}</span>
        ),
      }))}
    />
  );
}

function FilterField({ param, value, options, onChange }: { param: ReportParam; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  if (param.kind === 'date') {
    return (
      <Labeled label={param.labelAr}>
        <input
          type="date"
          dir="ltr"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full h-10 px-3 rounded-[10px] border border-line-strong bg-surface text-[13.5px] text-ink focus:outline-none focus:border-brand-600 focus:shadow-[var(--ring-brand)] transition-all duration-150"
        />
      </Labeled>
    );
  }
  if (param.kind === 'serial' || param.kind === 'entryNo' || param.kind === 'docNo' || param.kind === 'year') {
    return (
      <Labeled label={param.labelAr}>
        <input
          type="text"
          dir="ltr"
          value={value}
          placeholder={param.kind === 'serial' ? 'SN-0001' : param.kind === 'year' ? '2026' : 'JE-000001'}
          onChange={(event) => onChange(event.target.value)}
          className="w-full h-10 px-3 rounded-[10px] border border-line-strong bg-surface text-[13.5px] text-ink focus:outline-none focus:border-brand-600 focus:shadow-[var(--ring-brand)] transition-all duration-150"
        />
      </Labeled>
    );
  }
  if (param.kind === 'time') {
    return (
      <Labeled label={param.labelAr}>
        <input
          type="time"
          step="1"
          dir="ltr"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full h-10 px-3 rounded-[10px] border border-line-strong bg-surface text-[13.5px] text-ink focus:outline-none focus:border-brand-600 focus:shadow-[var(--ring-brand)] transition-all duration-150"
        />
      </Labeled>
    );
  }
  return (
    <Labeled label={param.labelAr}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full h-10 px-3 rounded-[10px] border border-line-strong bg-surface text-[13.5px] text-ink focus:outline-none focus:border-brand-600 focus:shadow-[var(--ring-brand)] transition-all duration-150"
      >
        <option value="">الكل</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Labeled>
  );
}
