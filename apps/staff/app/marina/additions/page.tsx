'use client';

import { useEffect, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { ApiError, apiDelete, apiFetch, apiList, apiPatch, apiPost } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * 📋 إضافات — `Form_WPF/frmAdditions.xaml` («📋 إضافات» — لوحتها «📋 إدارة الإضافات»).
 *
 * Three boxes and three buttons: 🔢 الرقم (read-only عند الديسكتوب) · 📝 الاسم · 💰 القيمة،
 * ثم ➕ جديد · 💾 حفظ · 🗑️ حذف، والشبكة تحتها `🔢 الرقم · 📝 الاسم · 💰 القيمة`.
 *
 * ورفضاها بلسان النافذة: «يجب إدخال اسم الإضافة ⚠️» و«يجب تحديد الإضافة المراد حذفها ⚠️»،
 * وتأكيدها «هل أنت متأكد من حذف هذه الإضافة؟ 🗑️». وقيمةٌ فارغةٌ صفر، كما يكتبها
 * `btnSave_Click` (`if (string.IsNullOrWhiteSpace(txtSalePrice.Text)) … = "0"`).
 *
 * هذه التعاريف هي ما يملأ «🎁 الإضافات» في `frmBookingM` («الحجوزات»): اختيارٌ منها يكتب
 * «السعر»، و«الإجمالي» = الكمية × السعر. و🧾 الاستخدام — كم حجزاً يستعمل الإضافة — عمودٌ
 * مخترَع: «🗑️ حذف» عند الديسكتوب `delete from Additions` يمحو التعريف ويترك
 * `BookingAddition.AditionID` يتيماً؛ وهنا يُتقاعد التعريف ويبقى الصفّ باسمه وسعره.
 */
type Addition = {
  id: string;
  number: number;
  name: string;
  salePrice: string;
  currency: string;
  usageCount: number;
  version: number;
};

type Card = {
  id?: string;
  version?: number;
  number?: number;
  name: string;
  salePrice: string;
};

const emptyCard = (nextNumber = 1): Card => ({ number: nextNumber, name: '', salePrice: '' });

const cardOf = (row: Addition): Card => ({
  id: row.id,
  version: row.version,
  number: row.number,
  name: row.name,
  salePrice: String(Number(row.salePrice)),
});

const fmt = (value: string) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed.toFixed(2).replace(/\.00$/, '') : '0';
};

export default function MarinaAdditionsPage() {
  const { can } = useSession();
  const canManage = can('marina.manage');

  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const additions = useQuery<Addition[]>(() => apiList<Addition>('/marina/additions'), []);
  const next = useQuery<{ number: number }>(() => apiFetch<{ number: number }>('/marina/additions/next').then((body) => ((body as { data?: { number: number } }).data ?? body) as { number: number }), []);

  useEffect(() => {
    if (!error && !notice) return;
    const timer = setTimeout(() => {
      setError('');
      setNotice('');
    }, 6000);
    return () => clearTimeout(timer);
  }, [error, notice]);

  const rows = additions.data ?? [];
  const setField = (patch: Partial<Card>) => setCard((current) => (current ? { ...current, ...patch } : current));

  async function save() {
    if (!card) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = { name: card.name.trim(), salePrice: card.salePrice.trim() || '0' };
      if (card.id) {
        await apiPatch(`/marina/additions/${card.id}`, { ...payload, ...(card.version ? { version: card.version } : {}) });
        setNotice('✅ تم حفظ التعديلات بنجاح');
      } else {
        await apiPost('/marina/additions', payload);
        setNotice('✅ تم الحفظ بنجاح');
      }
      setCard(null);
      additions.reload();
      next.reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: Addition) {
    if (!window.confirm(`هل أنت متأكد من حذف هذه الإضافة؟ 🗑️\n\n${row.number} — ${row.name}`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiDelete(`/marina/additions/${row.id}`);
      setNotice('✅ تم الحذف بنجاح');
      if (card?.id === row.id) setCard(null);
      additions.reload();
      next.reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="📋 إضافات"
      subtitle="إدارة الإضافات: الرقم والاسم والقيمة — وهي ما يملأ «🎁 الإضافات» في «الحجوزات»، فاختيارٌ منها يكتب «السعر» و«الإجمالي» = الكمية × السعر."
      crumbs={['إدارة المراسي', 'التعاريف']}
      actions={
        <div className="row" style={{ gap: 6 }}>
          <a className="btn" href="/marina/bookings">
            ⛵ الحجوزات
          </a>
          {canManage && (
            <button
              className="btn primary"
              type="button"
              onClick={() => {
                setError('');
                setNotice('');
                setCard(emptyCard(next.data?.number ?? rows.length + 1));
              }}
            >
              ➕ جديد
            </button>
          )}
        </div>
      }
    >
      {error && <p className="alert danger">{error}</p>}
      {notice && <p className="alert ok">{notice}</p>}

      {additions.status === 'loading' && <Loading rows={5} />}
      {additions.status === 'forbidden' && <Forbidden />}
      {additions.status === 'error' && <ErrorBox message={additions.error} onRetry={additions.reload} />}

      {additions.status === 'success' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="group-label" style={{ margin: 0 }}>📋 إدارة الإضافات</span>
            <span className="muted">عدد السجلات: {rows.length}</span>
          </div>
          {rows.length === 0 ? (
            <Empty title="لا توجد إضافات" detail="ابدأ بـ «➕ جديد»: اسم الإضافة وقيمتها، فتظهر في «🎁 الإضافات» داخل الحجز." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>🔢 الرقم</th>
                    <th>📝 الاسم</th>
                    <th className="num">💰 القيمة</th>
                    <th className="num">🧾 الاستخدام</th>
                    {canManage && <th>إجراءات</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} onDoubleClick={() => canManage && setCard(cardOf(row))}>
                      <td dir="ltr">{row.number}</td>
                      <td>{row.name}</td>
                      <td className="num" dir="ltr">{fmt(row.salePrice)}</td>
                      <td className="num" dir="ltr">{row.usageCount}</td>
                      {canManage && (
                        <td>
                          <div className="row" style={{ gap: 4 }}>
                            <button className="btn sm" type="button" onClick={() => setCard(cardOf(row))}>
                              ✏️ تعديل
                            </button>
                            <button className="btn sm danger" type="button" onClick={() => remove(row)}>
                              🗑️ حذف
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* «📋 إدارة الإضافات» — الصناديق الثلاثة كما في `frmAdditions`. */}
      {card && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 560 }}>
            <div className="modal-head">
              <span className="modal-title">{card.id ? '✏️ تعديل الإضافة' : '📋 إدارة الإضافات'}</span>
              <button className="btn sm" type="button" onClick={() => setCard(null)}>
                ✖ إغلاق
              </button>
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 12, maxHeight: '70vh', overflow: 'auto' }}>
              <div className="form-grid">
                <label className="field">
                  <span>🔢 الرقم</span>
                  <input className="input" dir="ltr" value={card.id ? String(card.number ?? '') : String(card.number ?? next.data?.number ?? '')} disabled />
                </label>
                <label className="field">
                  <span>📝 الاسم *</span>
                  <input className="input" value={card.name} onChange={(event) => setField({ name: event.target.value })} />
                </label>
                <label className="field">
                  <span>💰 القيمة</span>
                  <input className="input" dir="ltr" inputMode="decimal" value={card.salePrice} onChange={(event) => setField({ salePrice: event.target.value })} />
                </label>
              </div>

              <div className="row" style={{ gap: 6 }}>
                <button className="btn primary" type="button" disabled={busy || !card.name.trim()} onClick={save}>
                  💾 حفظ
                </button>
                <button className="btn" type="button" disabled={busy} onClick={() => setCard(emptyCard(next.data?.number ?? rows.length + 1))}>
                  ➕ جديد
                </button>
                <span style={{ flex: 1 }} />
                {card.id && (
                  <button
                    className="btn sm danger"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      const row = rows.find((item) => item.id === card.id);
                      if (row) void remove(row);
                    }}
                  >
                    🗑️ حذف
                  </button>
                )}
              </div>
              <p className="muted">💰 القيمة الفارغة تُحفظ صفراً، كما يفعل «💾 حفظ» عند الديسكتوب.</p>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}
