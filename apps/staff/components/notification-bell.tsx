'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { apiData } from '../lib/api';
import { useQuery } from '../lib/use-query';

type Notification = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};

const TYPE_LABEL_AR: Record<string, string> = {
  support_ticket_reply: '🛟 رد الدعم الفني',
  marketplace_addon_approved: '🛒 تفعيل باقة إضافية',
  marketplace_addon_rejected: '🛒 تحديث طلب باقة',
  van_sales_closing_request: '🚚 طلب إغلاق وردية مندوب',
  van_sales_closing_approved: '✅ اعتماد إغلاق الوردية',
  announcement: '📢 إعلان المنصة',
  'comment.mention': '💬 إشارة في تعليق',
};

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function notificationText(item: Notification, locale: 'ar' | 'en'): { title: string; body: string; href: string | null } {
  const payload = item.payload ?? {};
  const href = typeof payload.href === 'string' && payload.href.length > 0 ? payload.href : null;
  if (item.type === 'announcement') {
    return {
      title: locale === 'ar' ? text(payload.titleAr, 'إعلان من المنصة') : text(payload.titleEn, 'Announcement'),
      body: locale === 'ar' ? text(payload.bodyAr, text(payload.body)) : text(payload.bodyEn, text(payload.body)),
      href,
    };
  }
  if (item.type === 'comment.mention') {
    return {
      title: text(payload.title, locale === 'ar' ? 'إشارة في تعليق' : 'Comment mention'),
      body: text(payload.message, text(payload.body)),
      href,
    };
  }
  return {
    title: text(
      payload.title,
      locale === 'ar' ? (TYPE_LABEL_AR[item.type] ?? 'إشعار جديد') : item.type,
    ),
    body: text(payload.body, text(payload.message)),
    href,
  };
}

/**
 * جرس الإشعارات التفاعلي في الشريط العلوي للعميل (`NotificationBell`).
 * يعرض عدد الإشعارات غير المقروءة ويفتح قائمة منسدلة فورية مع إمكانية القراءة أو الانتقال للمستند،
 * ويُغلق تلقائياً عند النقر خارج القائمة أو الضغط على `Escape` أو تغيير المسار.
 */
export function NotificationBell({ label }: { label: string }) {
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState<number>(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const page = await apiData<{ data?: Notification[]; meta?: { unread?: number } }>(
        '/notifications?limit=12',
      );
      const list = Array.isArray(page) ? (page as Notification[]) : (page?.data ?? []);
      setItems(list);
      const metaUnread = (page as { meta?: { unread?: number } })?.meta?.unread;
      setUnread(typeof metaUnread === 'number' ? metaUnread : list.filter((n) => !n.readAt).length);
    } catch {
      // صامت عن قصد في الشريط العلوي
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 25_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    function handleOutside(event: MouseEvent | TouchEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    if (open) {
      document.addEventListener('mousedown', handleOutside);
      document.addEventListener('touchstart', handleOutside);
      document.addEventListener('keydown', handleKey);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('touchstart', handleOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  async function markOneRead(id: string) {
    setBusyId(id);
    try {
      await apiData(`/notifications/${id}/read`, { method: 'POST' });
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function markAllRead() {
    setBusyId('all');
    try {
      for (const n of items.filter((item) => !item.readAt)) {
        await apiData(`/notifications/${n.id}/read`, { method: 'POST' });
      }
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="btn bell"
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void refresh();
        }}
      >
        🔔
        {unread > 0 && <span className="bell-count">{unread}</span>}
      </button>

      {open && (
        <div
          className="card"
          style={{
            position: 'absolute',
            insetInlineEnd: 0,
            top: 'calc(100% + 6px)',
            minWidth: 340,
            maxWidth: 400,
            maxHeight: '72vh',
            overflowY: 'auto',
            zIndex: 70,
            display: 'grid',
            gap: 10,
            padding: 12,
            boxShadow: 'var(--shadow-4)',
          }}
        >
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>🔔 الإشعارات والتنبيهات ({unread} غير مقروء)</strong>
            <div className="row" style={{ gap: 6 }}>
              {unread > 0 && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={busyId === 'all'}
                  onClick={() => void markAllRead()}
                >
                  قراءة الكل
                </button>
              )}
              <Link className="btn sm" href="/notifications" onClick={() => setOpen(false)}>
                الكل
              </Link>
            </div>
          </div>

          {items.length === 0 ? (
            <p className="muted small" style={{ margin: '8px 0', textAlign: 'center' }}>
              لا توجد إشعارات جديدة حالياً.
            </p>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {items.map((item) => {
                const info = notificationText(item, 'ar');
                return (
                  <div
                    key={item.id}
                    style={{
                      padding: 10,
                      borderRadius: 10,
                      border: '1px solid var(--line)',
                      background: item.readAt ? 'var(--surface)' : 'var(--brand-soft)',
                      display: 'grid',
                      gap: 4,
                    }}
                  >
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                      <strong style={{ fontSize: 13 }}>{info.title}</strong>
                      {!item.readAt && (
                        <button
                          type="button"
                          className="btn sm"
                          disabled={busyId === item.id}
                          onClick={() => void markOneRead(item.id)}
                        >
                          ✓ مقروء
                        </button>
                      )}
                    </div>
                    {info.body && (
                      <p className="muted small" style={{ margin: 0, lineHeight: 1.5 }}>
                        {info.body}
                      </p>
                    )}
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                      <span className="muted" style={{ fontSize: 11 }} dir="ltr">
                        {new Date(item.createdAt).toLocaleString('ar-SA')}
                      </span>
                      {info.href && (
                        <Link
                          href={info.href}
                          className="small"
                          style={{ fontWeight: 700, color: 'var(--brand)' }}
                          onClick={() => {
                            if (!item.readAt) void markOneRead(item.id);
                            setOpen(false);
                          }}
                        >
                          فتح والانتقال ←
                        </Link>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * مركز الإشعارات الكامل (`/notifications`).
 */
export function NotificationInbox({ locale }: { locale: 'ar' | 'en' }) {
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const inbox = useQuery<{ data: Notification[]; meta: { unread: number; total: number } }>(
    () =>
      apiData<{ data: Notification[]; meta: { unread: number; total: number } }>(
        `/notifications?limit=50${onlyUnread ? '&filter[read]=false' : ''}`,
      ),
    [onlyUnread],
  );

  async function markRead(id: string) {
    setBusyId(id);
    setNotice(undefined);
    try {
      await apiData(`/notifications/${id}/read`, { method: 'POST' });
      inbox.reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }

  async function markAllRead() {
    setBusyId('all');
    setNotice(undefined);
    try {
      const items = Array.isArray(inbox.data) ? inbox.data : (inbox.data?.data ?? []);
      const unread = items.filter((item) => !item.readAt);
      for (const item of unread) {
        await apiData(`/notifications/${item.id}/read`, { method: 'POST' });
      }
      setNotice(unread.length === 0 ? 'لا غيرَ مقروء.' : `وُسم ${unread.length} إشعاراً مقروءاً.`);
      inbox.reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }

  const rows = Array.isArray(inbox.data) ? inbox.data : (inbox.data?.data ?? []);
  const unreadCount = inbox.data?.meta?.unread ?? rows.filter((item) => !item.readAt).length;

  return (
    <div className="grid">
      <div className="toolbar">
        <span className="chip">
          {locale === 'ar' ? 'غير مقروء' : 'Unread'}: {unreadCount}
        </span>
        <label className="row" style={{ gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={onlyUnread}
            onChange={(event) => setOnlyUnread(event.target.checked)}
          />
          <span>{locale === 'ar' ? 'غير المقروء فقط' : 'Unread only'}</span>
        </label>
        <button className="btn" type="button" disabled={busyId === 'all'} onClick={() => void markAllRead()}>
          {locale === 'ar' ? 'قراءة الكل' : 'Mark all read'}
        </button>
        <button className="btn" type="button" onClick={inbox.reload}>
          {locale === 'ar' ? 'تحديث' : 'Refresh'}
        </button>
      </div>

      {notice && <p className="notice">{notice}</p>}
      {inbox.status === 'loading' && <p className="muted">…</p>}
      {inbox.status === 'error' && <p className="error">{inbox.error}</p>}
      {inbox.status === 'success' && rows.length === 0 && (
        <p className="muted">{locale === 'ar' ? 'لا جديد.' : 'Nothing new.'}</p>
      )}

      <ul className="inbox">
        {rows.map((item) => {
          const info = notificationText(item, locale);
          return (
            <li key={item.id} className={item.readAt ? 'read' : 'unread'}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <strong>{info.title}</strong>
                  <p className="muted" style={{ margin: '4px 0 0' }}>
                    {info.body}
                  </p>
                  {info.href ? (
                    <Link href={info.href} style={{ fontWeight: 700 }}>
                      فتح المستند ←
                    </Link>
                  ) : null}
                  <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
                    {new Date(item.createdAt).toLocaleString(locale === 'ar' ? 'ar-SA' : 'en-GB')} ·{' '}
                    {TYPE_LABEL_AR[item.type] ?? item.type}
                  </p>
                </div>
                {!item.readAt && (
                  <button
                    className="btn"
                    type="button"
                    disabled={busyId === item.id}
                    onClick={() => void markRead(item.id)}
                  >
                    {locale === 'ar' ? 'تحديد كمقروء' : 'Mark read'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
