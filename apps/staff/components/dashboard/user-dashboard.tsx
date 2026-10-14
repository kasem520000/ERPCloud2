'use client';

import Link from 'next/link';
import { LayoutDashboard } from 'lucide-react';
import { useEffect, useState } from 'react';

import { dashboardData, listDashboards, type WidgetFigure } from '../../lib/bi-dashboards';
import { useSession } from '../../lib/session';
import { SkeletonCard } from '../ui/skeleton';

import { WidgetCard } from './widget-card';

/** الصفحة الرئيسية تعرض لوحة المستخدم الافتراضية إن كان مسموحاً له برؤيتها. */
export function UserDashboard() {
  const { can } = useSession();
  const [widgets, setWidgets] = useState<WidgetFigure[] | undefined>();
  const [dashboardId, setDashboardId] = useState<string | undefined>();
  const allowed = can('dashboards.view');

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    listDashboards()
      .then((boards) => {
        const board = boards.find((item) => item.isDefault) ?? boards[0];
        if (!board || cancelled) return;
        setDashboardId(board.id);
        return dashboardData(board.id);
      })
      .then((payload) => {
        if (!cancelled && payload) setWidgets(payload.widgets);
      })
      .catch(() => {
        if (!cancelled) setWidgets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  if (!allowed || widgets?.length === 0) return null;
  return (
    <section className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 flex items-center gap-2 text-[15px] font-bold text-ink">
          <LayoutDashboard size={16} className="text-brand-600" />
          لوحتك
        </h2>
        {dashboardId ? (
          <Link href={`/dashboards/${dashboardId}`} className="text-[13px] font-semibold text-brand-700 hover:underline">
            تعديل اللوحة
          </Link>
        ) : null}
      </div>
      {widgets === undefined ? (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <SkeletonCard key={index} />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {widgets.map((widget) => (
            <WidgetCard key={widget.id} widget={widget} />
          ))}
        </div>
      )}
    </section>
  );
}
