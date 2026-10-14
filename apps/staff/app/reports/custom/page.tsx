'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { deleteCustomReport, listCustomReports, type CustomReport } from '../../../lib/custom-fields';
import { useSession } from '../../../lib/session';

export default function CustomReportsPage() {
  const { can } = useSession();
  const [reports, setReports] = useState<CustomReport[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string>();

  const reload = async (): Promise<void> => {
    setState('loading');
    try { setReports(await listCustomReports()); setState('ready'); setError(undefined); }
    catch (cause) { setState('error'); setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => { void reload(); }, []);
  if (!can('custom_reports.view')) return <Screen title="التقارير المحفوظة" crumbs={['التقارير']}><Forbidden /></Screen>;

  return <Screen title="التقارير المحفوظة" subtitle="شغّل أو عدّل تقاريرك المخصصة من مكان واحد." crumbs={['التقارير', 'التقارير المحفوظة']} actions={<Link className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-bold text-on-accent" href="/reports/builder">تقرير جديد</Link>}>
    {state === 'loading' ? <Loading /> : state === 'error' ? <ErrorBox message={error} onRetry={() => void reload()} /> : reports.length === 0 ? <div className="rounded-xl border border-line bg-surface p-8 text-center text-sm text-muted">لا توجد تقارير محفوظة بعد. ابدأ من منشئ التقارير.</div> : <div className="rounded-xl border border-line bg-surface p-5 shadow-1 overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-right text-muted"><th className="p-2">اسم التقرير</th><th className="p-2">الكيان</th><th className="p-2">الرسم</th><th className="p-2">عام</th><th /></tr></thead><tbody>{reports.map((report) => <tr className="border-b last:border-0" key={report.id}><td className="p-2 font-semibold"><Link className="text-brand-700 hover:underline" href={`/reports/builder?id=${report.id}`}>{report.name}</Link></td><td className="p-2" dir="ltr">{report.baseEntity}</td><td className="p-2">{report.chartType}</td><td className="p-2">{report.isPublic ? 'نعم' : 'لا'}</td><td className="p-2 text-left">{can('custom_reports.manage') ? <button type="button" className="text-danger hover:underline" onClick={async () => { if (window.confirm('حذف التقرير؟')) { await deleteCustomReport(report.id); await reload(); } }}>حذف</button> : null}</td></tr>)}</tbody></table></div>}
  </Screen>;
}
