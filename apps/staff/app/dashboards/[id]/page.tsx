'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowRight, Download, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

import { WidgetCard } from '../../../components/dashboard/widget-card';
import { useSession } from '../../../lib/session';
import {
  addWidget,
  dashboardData,
  downloadDashboardPdf,
  getDashboard,
  removeWidget,
  reorderWidgets,
  saveLayout,
  widgetCatalog,
  type CatalogItem,
  type WidgetFigure,
} from '../../../lib/bi-dashboards';

export default function DashboardBuilderPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const { can } = useSession();
  const manage = can('dashboards.manage');
  const [name, setName] = useState('');
  const [widgets, setWidgets] = useState<WidgetFigure[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [dragging, setDragging] = useState<string | undefined>();
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    Promise.all([getDashboard(id), dashboardData(id), widgetCatalog()])
      .then(([board, figures, items]) => {
        if (cancelled) return;
        setName(board.name);
        setCatalog(items);
        const byId = new Map(figures.widgets.map((widget) => [widget.id, widget]));
        setWidgets(board.widgets.map((widget) => byId.get(widget.id) ?? { ...widget, unit: 'text' }));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'تعذر فتح اللوحة');
      });
    return () => {
      cancelled = true;
    };
  }, [id, nonce]);

  async function add(key: string) {
    setError('');
    setStatus('');
    try {
      await addWidget(id, key);
      setNonce((value) => value + 1);
      setStatus('أُضيف المؤشر');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر إضافة المؤشر');
    }
  }

  async function drop(targetId: string) {
    if (!dragging || dragging === targetId) return;
    const next = reorderWidgets(widgets, dragging, targetId);
    setDragging(undefined);
    setWidgets(next);
    setError('');
    try {
      await saveLayout(id, next);
      setStatus('تم حفظ الترتيب');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر حفظ الترتيب');
      setNonce((value) => value + 1);
    }
  }

  async function remove(widgetId: string) {
    setError('');
    try {
      await removeWidget(id, widgetId);
      setNonce((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر حذف المؤشر');
    }
  }

  async function pdf() {
    setError('');
    try {
      await downloadDashboardPdf(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر تصدير PDF');
    }
  }

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/dashboards" className="inline-flex items-center gap-1 text-[13px] font-semibold text-muted hover:text-ink">
            <ArrowRight size={14} />
            اللوحات
          </Link>
          <h1 className="m-0 mt-1 text-[26px] font-bold text-ink">{name || 'اللوحة'}</h1>
          <p className="m-0 mt-1 text-[13px] text-muted">{manage ? 'اسحب مؤشراً وأفلته فوق آخر. يُحفظ الترتيب فوراً.' : 'أرقام هذه اللوحة من بيانات شركتك.'}</p>
        </div>
        <button type="button" className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-4 text-[13.5px] font-semibold text-ink-2" onClick={() => void pdf()}>
          <Download size={16} />
          تصدير PDF
        </button>
      </header>

      {error ? <p className="m-0 rounded-xl border border-danger-line bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">{error}</p> : null}
      {status ? <p className="m-0 text-[13px] text-ok-ink">{status}</p> : null}

      <div className="grid items-start gap-4 lg:grid-cols-[16rem_1fr]">
        <aside className="rounded-2xl border border-line bg-surface p-3 shadow-1">
          <h2 className="m-0 mb-2 text-[13px] font-bold text-ink-2">الكتالوج</h2>
          <ul className="m-0 grid max-h-[32rem] list-none gap-1 overflow-auto p-0">
            {catalog.map((item) => (
              <li key={item.key}>
                {manage ? (
                  <button type="button" className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-start text-[13px] text-ink-2 hover:bg-surface-2" onClick={() => void add(item.key)}>
                    <span>{item.titleAr}</span>
                    <Plus size={14} className="shrink-0 text-brand-600" />
                  </button>
                ) : (
                  <span className="block px-2 py-1.5 text-[13px] text-ink-2">{item.titleAr}</span>
                )}
              </li>
            ))}
          </ul>
        </aside>
        <div className="grid gap-3 xl:hidden">
          {widgets.map((widget) => (
            <WidgetCard
              key={widget.id}
              widget={widget}
              editable={manage}
              onDragStart={manage ? setDragging : undefined}
              onDrop={manage ? (targetId) => void drop(targetId) : undefined}
              onRemove={manage ? (widgetId) => void remove(widgetId) : undefined}
            />
          ))}
        </div>
        <div className="hidden gap-3 xl:grid xl:grid-cols-12" style={{ gridAutoRows: '92px' }}>
          {widgets.map((widget) => (
            <div
              key={widget.id}
              style={{
                gridColumn: `${widget.positionX + 1} / span ${widget.width}`,
                gridRow: `${widget.positionY + 1} / span ${widget.height}`,
              }}
            >
              <WidgetCard
                widget={widget}
                editable={manage}
                onDragStart={manage ? setDragging : undefined}
                onDrop={manage ? (targetId) => void drop(targetId) : undefined}
                onRemove={manage ? (widgetId) => void remove(widgetId) : undefined}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
