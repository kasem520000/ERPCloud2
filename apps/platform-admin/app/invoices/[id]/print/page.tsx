'use client';

import Link from 'next/link';
import { use, useEffect, useRef, useState } from 'react';

import { ErrorBox, Loading, Screen } from '../../../../components/screen';
import { apiFetch } from '../../../../lib/api';

/**
 * معاينة الطباعة — فاتورة الاشتراك كما ستُسلَّم للعميل.
 *
 * الخادم يبني الصفحة كاملةً (ورقة A4 وبنفسها: بلا CSS خارجي ولا صور ولا خطوط)، وهذه الشاشة
 * لا تفعل أكثر من حملها: إطارٌ معزول حتى لا يتسرّب تنسيق المستند إلى هيكل اللوحة، والطباعة
 * تُوجَّه إلى الإطار فتخرج الورقة بلا واجهة التطبيق — نفس نمط سطح الموظفين
 * (`apps/staff/app/print/[doc]/[id]/page.tsx`) لأن الورقة يجب أن تكون ورقة واحدة في المنتج كله.
 */
export default function InvoicePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    setHtml(undefined);
    setError(undefined);
    apiFetch<{ html: string }>(`/platform/invoices/${id}/print`)
      .then((payload) => {
        if (alive) setHtml(payload.html);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <Screen
      title="طباعة الفاتورة"
      crumbs={['المنصة', 'الفواتير', 'الطباعة']}
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
              // A saved copy is what an auditor asks for when the printer is not the point.
              const blob = new Blob([html ?? ''], { type: 'text/html;charset=utf-8' });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = `platform-invoice-${id.slice(0, 8)}.html`;
              anchor.click();
              URL.revokeObjectURL(url);
            }}
          >
            حفظ نسخة
          </button>
          <Link className="btn" href="/invoices">
            الفواتير
          </Link>
        </>
      }
    >
      {error && <ErrorBox message={error} />}
      {!html && !error && <Loading />}
      {html && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <iframe
            ref={frame}
            title="فاتورة المنصة"
            srcDoc={html}
            sandbox="allow-same-origin allow-modals"
            style={{ width: '100%', height: '80vh', border: 0, background: 'var(--surface)' }}
          />
        </div>
      )}
    </Screen>
  );
}
