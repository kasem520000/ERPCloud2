'use client';

import Link from 'next/link';
import { use, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { ErrorBox, Loading, Screen } from '../../../../components/screen';
import { apiFetch } from '../../../../lib/api';

/**
 * The print viewer.
 *
 * The server renders the document as one self-contained HTML page (A4 stylesheet, QR,
 * tafqeet and all); this screen only carries it. It is shown inside a sandboxed iframe so
 * the document's own CSS cannot leak into the admin shell, and printing targets the
 * iframe, which is why the paper comes out as the document and not as the surrounding
 * application.
 */
const DOCS: Record<string, { path: string; title: string; back: string; backLabel: string }> = {
  'sales-invoice': { path: 'invoices', title: 'طباعة فاتورة المبيعات', back: '/sales/invoices', backLabel: 'فواتير المبيعات' },
  'purchase-invoice': { path: 'purchase-invoices', title: 'طباعة فاتورة المشتريات', back: '/purchases/invoices', backLabel: 'فواتير المشتريات' },
  voucher: { path: 'vouchers', title: 'طباعة السند', back: '/treasury/vouchers', backLabel: 'السندات' },
  'journal-entry': { path: 'journal-entries', title: 'طباعة سند القيد', back: '/accounting/journal-entries', backLabel: 'القيود' },
  shift: { path: 'shifts', title: 'طباعة إغلاق اليومية', back: '/sales/shifts', backLabel: 'إغلاقات اليومية' },
};

export default function PrintPage({ params }: { params: Promise<{ doc: string; id: string }> }) {
  const { doc, id } = use(params);
  const spec = DOCS[doc];
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string>();
  const [error, setError] = useState<string>();
  /**
   * `?auto=1` — «🖨️ طباعة» تفتح الحوار فور جهوز الورقة، و«👁️ معاينة» تعرضها فقط.
   * والزرّان في النافذة المكتبية (`FrmNewEntry.xaml` L454–455) يفعلان هذا الفرق بعينه،
   * والورقة واحدة في الحالتين.
   */
  const auto = useSearchParams().get('auto') === '1';
  const printed = useRef(false);

  useEffect(() => {
    if (!spec) return;
    let alive = true;
    setHtml(undefined);
    setError(undefined);
    apiFetch<{ html: string }>(`/reports/print/${spec.path}/${id}`)
      .then((payload) => {
        if (alive) setHtml(payload.html);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, [spec, id]);

  useEffect(() => {
    if (!auto || !html || printed.current) return;
    printed.current = true;
    frame.current?.contentWindow?.focus();
    frame.current?.contentWindow?.print();
  }, [auto, html]);

  if (!spec) {
    return (
      <Screen title="طباعة" crumbs={['التقارير']}>
        <ErrorBox message={`نوع المستند «${doc}» غير معروف.`} />
      </Screen>
    );
  }

  return (
    <Screen
      title={spec.title}
      crumbs={['التقارير', 'الطباعة']}
      actions={
        <>
          <button
            className="btn primary"
            type="button"
            disabled={!html}
            onClick={() => {
              const view = frame.current?.contentWindow;
              view?.focus();
              view?.print();
            }}
          >
            طباعة
          </button>
          <button
            className="btn"
            type="button"
            disabled={!html}
            onClick={() => {
              // A plain download keeps a copy of exactly what was printed, which is what
              // an auditor asks for when the printer is not the point.
              const blob = new Blob([html ?? ''], { type: 'text/html;charset=utf-8' });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = `${doc}-${id.slice(0, 8)}.html`;
              anchor.click();
              URL.revokeObjectURL(url);
            }}
          >
            حفظ نسخة
          </button>
          <Link className="btn" href={spec.back}>
            {spec.backLabel}
          </Link>
        </>
      }
    >
      {error && <ErrorBox message={error} />}
      {!html && !error && <Loading />}
      {html && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <iframe ref={frame} title={spec.title} srcDoc={html} sandbox="allow-same-origin allow-modals" style={{ width: '100%', height: '80vh', border: 0, background: 'var(--surface)' }} />
        </div>
      )}
    </Screen>
  );
}
