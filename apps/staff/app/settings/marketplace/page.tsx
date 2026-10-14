'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Notice } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { ApiError, apiDelete, apiData, apiPost } from '../../../lib/api';

type AppRow = {
  code: string;
  nameAr: string;
  nameEn?: string;
  descriptionAr: string;
  icon: string;
  version: string;
  monthlyPrice: string;
  isCore: boolean;
  isActive: boolean;
  enabled: boolean;
  screens: string[];
  category?: 'core' | 'integration' | 'sector';
  requiresApproval?: boolean;
  requestStatus?: 'none' | 'pending' | 'approved' | 'rejected';
  requestNote?: string | null;
  decisionNote?: string | null;
};

type Catalog = { apps: AppRow[] };

export default function MarketplacePage() {
  const [apps, setApps] = useState<AppRow[]>([]);
  const [filter, setFilter] = useState<'all' | 'sector' | 'integration' | 'core'>('all');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info'; text: string }>();
  const [busy, setBusy] = useState('');

  async function reload() {
    const catalog = await apiData<Catalog>('/marketplace/apps');
    setApps(catalog.apps ?? []);
  }

  useEffect(() => {
    reload().catch((error: unknown) => setNotice({ kind: 'danger', text: messageOf(error) }));
  }, []);

  async function requestApp(app: AppRow) {
    setBusy(app.code);
    setNotice(undefined);
    try {
      await apiPost(`/marketplace/apps/${app.code}/request`, {
        note: notes[app.code]?.trim() || undefined,
      });
      setNotice({
        kind: 'ok',
        text: `أُرسل طلب تفعيل باقة «${app.nameAr}» إلى إدارة المنصة. فور الموافقة ستظهر الشاشة في القائمة الجانبية ويصلك إشعار.`,
      });
      await reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: messageOf(error) });
    } finally {
      setBusy('');
    }
  }

  async function toggle(app: AppRow) {
    setBusy(app.code);
    setNotice(undefined);
    try {
      if (app.enabled) {
        await apiDelete(`/marketplace/apps/${app.code}`);
        setNotice({ kind: 'ok', text: `أُوقفت باقة «${app.nameAr}». تم إخفاء شاشاتها وإعداداتها مع الاحتفاظ بجميع بياناتك.` });
      } else if (app.requiresApproval) {
        await requestApp(app);
        return;
      } else {
        await apiPost(`/marketplace/apps/${app.code}/install`, {});
        setNotice({ kind: 'ok', text: `فُعّلت إضافة «${app.nameAr}» وأصبحت متاحة في القائمة الجانبية.` });
      }
      window.dispatchEvent(new Event('erp:apps-changed'));
      await reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: messageOf(error) });
    } finally {
      setBusy('');
    }
  }

  const visibleApps = apps.filter((app) => {
    if (filter === 'all') return true;
    const cat = app.category ?? (app.isCore ? 'core' : 'integration');
    return cat === filter;
  });

  return (
    <Screen
      title="🛒 سوق الإضافات والباقات القطاعية"
      subtitle="اطلب تفعيل الباقات القطاعية المتخصصة (التصنيع، التفصيل، النظارات، المراسي، المشاريع، تطبيق الموظف، وتوزيع المناديب والمخابز). الباقات غير المفعّلة تختفي شاشاتها وإعداداتها لتبسيط النظام."
      crumbs={['سوق الإضافات']}
    >
      {notice ? <Notice notice={notice} /> : null}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button
          type="button"
          className={filter === 'all' ? 'btn primary sm' : 'btn sm'}
          onClick={() => setFilter('all')}
        >
          الكل ({apps.length})
        </button>
        <button
          type="button"
          className={filter === 'sector' ? 'btn primary sm' : 'btn sm'}
          onClick={() => setFilter('sector')}
        >
          🏢 الباقات والأنظمة القطاعية ({apps.filter((a) => a.category === 'sector').length})
        </button>
        <button
          type="button"
          className={filter === 'integration' ? 'btn primary sm' : 'btn sm'}
          onClick={() => setFilter('integration')}
        >
          🔗 تكاملات المتاجر والدفع ({apps.filter((a) => (a.category ?? (a.isCore ? 'core' : 'integration')) === 'integration').length})
        </button>
        <button
          type="button"
          className={filter === 'core' ? 'btn primary sm' : 'btn sm'}
          onClick={() => setFilter('core')}
        >
          ⚙️ خدمات مدمجة ({apps.filter((a) => a.isCore).length})
        </button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
        {visibleApps.map((app) => {
          const isPending = !app.enabled && app.requestStatus === 'pending';
          return (
            <article key={app.code} className="card" style={{ display: 'grid', gap: 10 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <strong style={{ fontSize: 16 }}>
                  {app.icon} {app.nameAr}
                </strong>
                <span
                  className={`badge ${
                    app.isCore || app.enabled
                      ? 'ok'
                      : isPending
                        ? 'warn'
                        : app.requestStatus === 'rejected'
                          ? 'danger'
                          : 'neutral'
                  }`}
                >
                  {app.isCore
                    ? 'مدمجة بالنظام'
                    : app.enabled
                      ? 'مفعّلة'
                      : isPending
                        ? 'قيد موافقة المنصة'
                        : app.requestStatus === 'rejected'
                          ? 'مرفوضة'
                          : 'غير مفعّلة'}
                </span>
              </div>

              <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
                {app.descriptionAr}
              </p>

              <p className="muted" style={{ margin: 0, fontSize: 12 }} dir="ltr">
                v{app.version} · {Number(app.monthlyPrice) === 0 ? 'مجاناً ضمن الباقة' : `${Number(app.monthlyPrice).toFixed(2)} SAR / شهر`}
                {!app.isActive ? ' · متوقفة من المنصة' : ''}
              </p>

              {app.decisionNote ? (
                <p className="alert info" style={{ margin: 0, fontSize: 12 }}>
                  ملاحظة إدارة المنصة: {app.decisionNote}
                </p>
              ) : null}

              {!app.isCore && !app.enabled && app.requiresApproval ? (
                <input
                  className="input"
                  placeholder="ملاحظة لمدير المنصة عند طلب التفعيل (اختياري)…"
                  value={notes[app.code] ?? app.requestNote ?? ''}
                  onChange={(event) => setNotes((curr) => ({ ...curr, [app.code]: event.target.value }))}
                />
              ) : null}

              <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 'auto' }}>
                {app.isCore ? (
                  <span className="muted small">مفعّلة تلقائياً ضمن النظام الأساسي</span>
                ) : app.enabled ? (
                  <>
                    {app.screens[0] ? (
                      <Link className="btn primary sm" href={app.screens[0]}>
                        فتح الباقة ⬅
                      </Link>
                    ) : null}
                    <button
                      className="btn sm"
                      type="button"
                      disabled={busy === app.code}
                      onClick={() => void toggle(app)}
                    >
                      إيقاف وإخفاء
                    </button>
                  </>
                ) : (
                  <button
                    className={isPending ? 'btn sm' : 'btn primary sm'}
                    type="button"
                    disabled={busy === app.code || !app.isActive}
                    onClick={() => void toggle(app)}
                  >
                    {busy === app.code
                      ? 'جارٍ الإرسال…'
                      : isPending
                        ? '🔄 تحديث طلب التفعيل (بانتظار موافقة المنصة)'
                        : app.requiresApproval
                          ? '📩 طلب تفعيل الباقة'
                          : '⚡ تفعيل الإضافة'}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </Screen>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.detail || error.message;
  return error instanceof Error ? error.message : 'تعذر إكمال الطلب';
}
