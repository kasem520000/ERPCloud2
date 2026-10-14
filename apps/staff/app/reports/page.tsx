'use client';

import Link from 'next/link';

import { QueryView } from '../../components/data-view';
import { Screen } from '../../components/screen';
import { REPORT_GROUP_LABELS, REPORT_GROUP_ORDER, fetchReportCatalog, type ReportEntry } from '../../lib/reports';
import { useQuery } from '../../lib/use-query';

export default function ReportsIndexPage() {
  const catalog = useQuery<ReportEntry[]>(() => fetchReportCatalog(), []);

  return (
    <Screen
      title="مركز التقارير"
      subtitle="كل تقارير النظام تعمل على نفس محرّك التقارير: اختر التقرير، حدّد الفترة والمرشحات، ثم صدّر أو اطبع."
      crumbs={['التقارير']}
    >
      <QueryView query={catalog} empty="لا توجد تقارير مسجلة">
        {(entries) => (
          <div className="grid cols-2">
            {REPORT_GROUP_ORDER.filter((group) => entries.some((entry) => entry.group === group)).map((group) => (
              <section key={group} className="card">
                <h3>{REPORT_GROUP_LABELS[group] ?? group}</h3>
                <ul className="kv">
                  {entries
                    .filter((entry) => entry.group === group)
                    .map((entry) => (
                      <li key={entry.key}>
                        <Link href={`/reports/${entry.key}`}>{entry.titleAr}</Link>
                        {entry.hintAr ? <span className="muted small"> — {entry.hintAr}</span> : null}
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </QueryView>
    </Screen>
  );
}
