'use client';

import { useEffect, useState } from 'react';

import { DataTable, Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError } from '../../../lib/api';
import { forecast, type CrmDeal, type CrmForecast } from '../../../lib/crm';

export default function CrmForecastPage() {
  const [summary, setSummary] = useState<CrmForecast>();
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string }>();

  useEffect(() => {
    void forecast()
      .then(setSummary)
      .catch((error: unknown) => setNotice({ kind: 'danger', text: error instanceof ApiError ? error.message : String(error) }));
  }, []);

  return (
    <Screen
      title="تنبؤ المبيعات"
      subtitle="مجموع قيمة الصفقات المفتوحة مضروباً في احتمالها. الرابحة والخاسرة لا تدخلان."
      crumbs={['المبيعات', 'التنبؤ']}
    >
      <Notice notice={notice} />
      <div className="card">
        <h3>{summary?.weighted ?? '0.0000'}</h3>
        <p className="muted">{summary?.openCount ?? summary?.count ?? 0} صفقة مفتوحة</p>
      </div>
      <div className="card">
        <DataTable
          columns={[
            { key: 'title', header: 'الصفقة', cell: (row: CrmDeal) => row.title },
            { key: 'value', header: 'القيمة', cell: (row: CrmDeal) => row.value },
            { key: 'probability', header: 'الاحتمال', cell: (row: CrmDeal) => `${row.probability}%` },
          ]}
          rows={summary?.deals ?? []}
          rowKey={(row) => row.id}
        />
      </div>
    </Screen>
  );
}
