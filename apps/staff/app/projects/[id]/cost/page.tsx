'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { ErrorBox, Loading, Screen } from '../../../../components/screen';
import { ApiError } from '../../../../lib/api';
import { loadCost } from '../../../../lib/project-kanban';
import { money } from '../../../../lib/lookups';

type CostLine = { termId: string; code: string; description: string; plannedValue: string; actualValue: string; varianceValue: string };
type CostReport = {
  lines: CostLine[];
  laborValue: string;
  expenseValue: string;
  relatedExpenses: string;
  actualValue: string;
  plannedValue: string;
};

export default function ProjectCostPage() {
  const params = useParams<{ id: string }>();
  const projectId = String(params.id);
  const [report, setReport] = useState<CostReport>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    void loadCost(projectId)
      .then(setReport)
      .catch((reason: unknown) => setError(reason instanceof ApiError ? reason.message : String(reason)));
  }, [projectId]);

  if (error) {
    return (
      <Screen title="تكلفة المشروع" crumbs={['إدارة المشاريع']}>
        <ErrorBox message={error} />
      </Screen>
    );
  }
  if (!report) return <Loading />;
  const max = Math.max(1, ...report.lines.map((line) => Number(line.plannedValue)), ...report.lines.map((line) => Number(line.actualValue)));

  return (
    <Screen title="مخطط مقابل فعلي" subtitle="الفعلي = ساعات المكلّف × معدله + مصاريف المهمة. سندات المقاول المعتمدة تظهر كمصاريف مرتبطة." crumbs={['إدارة المشاريع']} actions={<Link className="btn" href={`/projects/${projectId}/board`}>اللوحة</Link>}>
      <div className="card">
        <p>مخطط البنود: {money(report.plannedValue)}</p>
        <p>أجور: {money(report.laborValue)} · مصاريف المهام: {money(report.expenseValue)} · سندات المقاول: {money(report.relatedExpenses)}</p>
        <p>الفعلي الكلي: {money(report.actualValue)}</p>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>البند</th>
              <th>مخطط</th>
              <th>فعلي</th>
              <th>الفرق</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {report.lines.map((line) => (
              <tr key={line.termId}>
                <td>{line.code} — {line.description}</td>
                <td>{money(line.plannedValue)}</td>
                <td>{money(line.actualValue)}</td>
                <td>{money(line.varianceValue)}</td>
                <td>
                  <span style={{ display: 'inline-block', width: `${(Number(line.plannedValue) / max) * 80}px`, height: 8, background: 'var(--muted)' }} />
                  <span style={{ display: 'inline-block', width: `${(Number(line.actualValue) / max) * 80}px`, height: 8, background: 'var(--ok)', marginInlineStart: 4 }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {report.lines.length === 0 ? <p className="muted">لا بنود في جدول الكميات.</p> : null}
      </div>
    </Screen>
  );
}
