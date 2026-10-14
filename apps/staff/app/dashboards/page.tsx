'use client';

import Link from 'next/link';
import { LayoutDashboard, Plus, Star, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { createDashboard, deleteDashboard, listDashboards, setDefaultDashboard, type DashboardSummary } from '../../lib/bi-dashboards';
import { useSession } from '../../lib/session';

export default function DashboardsPage() {
  const { can } = useSession();
  const [boards, setBoards] = useState<DashboardSummary[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const manage = can('dashboards.manage');

  async function reload() {
    setBoards(await listDashboards());
  }

  useEffect(() => {
    reload()
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'تعذر تحميل اللوحات'))
      .finally(() => setLoading(false));
  }, []);

  async function create() {
    setError('');
    try {
      await createDashboard(name.trim() || 'لوحة جديدة');
      setName('');
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر إنشاء اللوحة');
    }
  }

  async function makeDefault(id: string) {
    setError('');
    try {
      await setDefaultDashboard(id);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر تعيين اللوحة');
    }
  }

  async function remove(id: string) {
    setError('');
    try {
      await deleteDashboard(id);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر حذف اللوحة');
    }
  }

  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 flex items-center gap-2 text-[26px] font-bold text-ink">
            <LayoutDashboard size={24} className="text-brand-600" />
            لوحات المؤشرات
          </h1>
          <p className="m-0 mt-1 text-[13px] text-muted">لوحة شخصية لكل مستخدم. المؤشرات من الكتالوج فقط، بلا SQL.</p>
        </div>
      </header>

      {error ? <p className="m-0 rounded-xl border border-danger-line bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">{error}</p> : null}

      {manage ? (
        <form
          className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface p-3 shadow-1"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <input className="h-10 min-w-56 flex-1 rounded-[10px] border border-line-strong px-3 text-[14px]" placeholder="اسم اللوحة" value={name} onChange={(event) => setName(event.target.value)} />
          <button type="submit" className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-brand-600 px-4 text-[13.5px] font-semibold text-on-accent">
            <Plus size={16} />
            لوحة جديدة
          </button>
        </form>
      ) : null}

      {loading ? <p className="text-[13px] text-muted">جاري التحميل…</p> : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {boards.map((board) => (
          <article key={board.id} className="rounded-2xl border border-line bg-surface p-4 shadow-1">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="m-0 text-[16px] font-bold text-ink">{board.name}</h2>
                <p className="m-0 mt-1 text-[12px] text-muted">{board.widgetCount} مؤشرات</p>
              </div>
              {board.isDefault ? <span className="rounded-full bg-ok-soft px-2 py-1 text-[11px] font-semibold text-ok-ink">افتراضية</span> : null}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href={`/dashboards/${board.id}`} className="inline-flex h-9 items-center rounded-[10px] bg-brand-600 px-3 text-[13px] font-semibold text-on-accent">
                فتح
              </Link>
              {manage && !board.isDefault ? (
                <button type="button" className="inline-flex h-9 items-center gap-1 rounded-[10px] border border-line-strong px-3 text-[13px] font-semibold text-ink-2" onClick={() => void makeDefault(board.id)}>
                  <Star size={14} />
                  اجعلها افتراضية
                </button>
              ) : null}
              {manage && boards.length > 1 ? (
                <button type="button" className="inline-flex h-9 items-center gap-1 rounded-[10px] border border-line-strong px-3 text-[13px] text-muted" onClick={() => void remove(board.id)}>
                  <Trash2 size={14} />
                  حذف
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
