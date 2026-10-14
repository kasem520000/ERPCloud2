'use client';

import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { money } from '../../../lib/lookups';
import { SupplierError, supplierFetch } from '../../../lib/supplier-portal';

type Line = { lineNo: number; description: string; quantity: string; total: string };
type View = {
  companyName: string;
  signerName: string;
  status: string;
  expiresAt: string;
  message: string;
  document: { number: string | null; total: string; currency: string; kind: string; lines: Line[] } | null;
};

export default function EsignPage() {
  const params = useParams<{ token: string }>();
  const token = decodeURIComponent(params.token ?? '');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const moved = useRef(false);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<number | undefined>();
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) return;
    supplierFetch<View>(`/esign/${token}`)
      .then((data) => {
        setView(data);
        setDone(data.status === 'signed');
      })
      .catch((caught: unknown) => {
        if (caught instanceof SupplierError) {
          setStatus(caught.status);
          setError(caught.message);
        } else setError('تعذّر فتح الرابط');
      });
  }, [token]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.lineWidth = 2.2;
      context.lineCap = 'round';
      context.strokeStyle = 'var(--inverse)';
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [view]);

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    canvas.setPointerCapture(event.pointerId);
    drawing.current = true;
    const cursor = point(event);
    context.beginPath();
    context.moveTo(cursor.x, cursor.y);
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    const cursor = point(event);
    context.lineTo(cursor.x, cursor.y);
    context.stroke();
    moved.current = true;
  }

  function stop() {
    drawing.current = false;
  }

  function clearPad() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    moved.current = false;
  }

  async function sign(event: React.FormEvent) {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas || !moved.current) {
      setError('ارسم التوقيع قبل الإرسال');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await supplierFetch(`/esign/${token}/sign`, {
        method: 'POST',
        body: JSON.stringify({ signatureData: canvas.toDataURL('image/png'), otp: otp.trim() }),
      });
      setDone(true);
      setView((current) => (current ? { ...current, status: 'signed' } : current));
    } catch (caught) {
      if (caught instanceof SupplierError) {
        setStatus(caught.status);
        setError(caught.message);
      } else setError('تعذّر حفظ التوقيع');
    } finally {
      setBusy(false);
    }
  }

  const mark = (view?.companyName || 'ت').slice(0, 1);

  return (
    <main className="public-page">
      <div className="public-wrap">
        <header className="row">
          <span className="logo-mark">{mark}</span>
          <div>
            <strong>{view?.companyName || 'طلب توقيع'}</strong>
            <p className="muted small">توقيع مرسوم مع رمز لمرة واحدة. ليس توقيعاً إلكترونياً مؤهلاً.</p>
          </div>
        </header>

        {status === 410 ? (
          <section className="card">
            <h1>انتهت صلاحية الرابط</h1>
            <p>اطلب من المُرسِل رابطاً جديداً. هذا الرابط لم يعد يقبل توقيعاً.</p>
          </section>
        ) : error && !view ? (
          <section className="card">
            <h1>تعذّر فتح المستند</h1>
            <p>{error}</p>
          </section>
        ) : view ? (
          <>
            <article className="sign-sheet">
              <header className="sign-letterhead">
                <span className="row">
                  <span className="logo-mark">{mark}</span>
                  <strong>{view.companyName || 'المنشأة'}</strong>
                </span>
                <span className="muted small">{view.document?.number ?? 'مستند'}</span>
              </header>
              {view.signerName ? <p>إلى: {view.signerName}</p> : null}
              {view.message ? <p>{view.message}</p> : null}
              <table className="sign-table">
                <thead>
                  <tr>
                    <th>البيان</th>
                    <th className="num">الكمية</th>
                    <th className="num">الإجمالي</th>
                  </tr>
                </thead>
                <tbody>
                  {(view.document?.lines ?? []).map((line) => (
                    <tr key={line.lineNo}>
                      <td>{line.description || 'بند'}</td>
                      <td className="num">{line.quantity}</td>
                      <td className="num">{money(line.total, view.document?.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {view.document ? (
                <p>
                  <strong>الإجمالي {money(view.document.total, view.document.currency)}</strong>
                </p>
              ) : (
                <p className="muted">لا توجد بنود ظاهرة لهذا المستند.</p>
              )}
            </article>

            {done || view.status === 'signed' ? (
              <section className="card">
                <h2>تم التوقيع</h2>
                <p>حُفظت نسخة PDF موقّعة، وتغيّرت حالة عرض السعر إن كان مفتوحاً.</p>
                <a className="btn primary" href={`/api/v1/esign/${token}/pdf`}>
                  تنزيل PDF
                </a>
              </section>
            ) : (
              <form className="card" onSubmit={sign}>
                <h2>التوقيع</h2>
                {error ? <p className="alert danger">{error}</p> : null}
                <canvas
                  ref={canvasRef}
                  className="sign-pad"
                  onPointerDown={start}
                  onPointerMove={move}
                  onPointerUp={stop}
                  onPointerLeave={stop}
                />
                <button className="btn sm" type="button" onClick={clearPad}>
                  مسح الرسم
                </button>
                <label className="field">
                  <span>رمز التحقق من البريد</span>
                  <input className="input" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(event) => setOtp(event.target.value)} required />
                </label>
                <button className="btn primary" type="submit" disabled={busy}>
                  {busy ? 'جارٍ الحفظ…' : 'توقيع المستند'}
                </button>
              </form>
            )}
          </>
        ) : (
          <p className="muted">جارٍ فتح المستند…</p>
        )}
      </div>
    </main>
  );
}
