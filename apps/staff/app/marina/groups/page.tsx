'use client';

import { useEffect, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { ApiError, apiDelete, apiFetch, apiList, apiPatch, apiPost, apiPut } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * 📋 بطاقة فئة — `Form_WPF/frmGroupM.xaml` («📋 بطاقة فئة») و`Form_WPF/frmAddPeriod.xaml`
 * («⏰ إدارة فترات التأجير»).
 *
 * The card: 🖼️ صورة الفئة (📂 اختر / 🗑️ حذف) · 🔢 رقم الفئة · رمز الفئة · اسم الفئة (عربي) ·
 * اسم الفئة (EN) · قيمة الساعة · عرض الساعة (دقيقة) · قيمة النصف ساعة · عرض النصف ساعة
 * (دقيقة) — و«➕ إضافة مدة» يفتح «⏰ إدارة فترات التأجير»: «⏰ المدة · 💵 السعر · 🎁 العرض ·
 * 🗑️». و«📋 قائمة الفئات» تحته: `رقم الفئة · رمز الفئة · اسم الفئة · قيمة الساعة · قيمة
 * النصف ساعة`، وأسفله ⏮ ◀ ▶ ⏭ · 🖨️ · 🗑️ حذف · 💾 حفظ · ➕ جديد.
 *
 * ورفوضها بلسان النافذة: «ادخل الفئة» · «الفئة تم ادخالها مسبقا» · «يجب إستكمال البيانات
 * ⚠️» · «هذه الفئة لها ارتباطات فرعية لايمكن حذفها» · «اختر الفئة ليتم حذفها».
 *
 * 🖼️ صورة الفئة رابطٌ لا ملف: الديسكتوب يخزّن بايتات الصورة في `GroupMarine.image`، ولا
 * مخزن ملفّاتٍ هنا بعد. و«🖨️ طباعة» مؤجَّلة مع ملفّات `Reports/*.repx`.
 */
type RentPeriod = { id: number; name: string; minutes: number };

type GroupPeriod = {
  id: string;
  periodId: number;
  periodName: string;
  minutes: number;
  price: string;
  offerMinutes: number;
  currency: string;
};

type GroupCard = {
  id: string;
  number: number | null;
  code: string;
  name: string;
  nameEn: string;
  hourPrice: string;
  hourOfferMinutes: number;
  halfHourPrice: string;
  halfHourOfferMinutes: number;
  imageUrl: string | null;
  vesselCount: number;
  periods: GroupPeriod[];
  version: number;
};

type Card = {
  id?: string;
  version?: number;
  code: string;
  name: string;
  nameEn: string;
  hourPrice: string;
  hourOfferMinutes: string;
  halfHourPrice: string;
  halfHourOfferMinutes: string;
  imageUrl: string;
};

type PeriodDraft = { periodId: string; price: string; offerMinutes: string };

/** ⏰ المدة · 💵 السعر · 🎁 العرض — صفٌّ من شبكة `frmAddPeriod`. */
const emptyPeriod = (): PeriodDraft => ({ periodId: '2', price: '', offerMinutes: '0' });

const emptyCard = (): Card => ({
  code: '',
  name: '',
  nameEn: '',
  hourPrice: '',
  hourOfferMinutes: '0',
  halfHourPrice: '',
  halfHourOfferMinutes: '0',
  imageUrl: '',
});

const cardOf = (group: GroupCard): Card => ({
  id: group.id,
  version: group.version,
  code: group.code,
  name: group.name,
  nameEn: group.nameEn,
  hourPrice: String(Number(group.hourPrice)),
  hourOfferMinutes: String(group.hourOfferMinutes),
  halfHourPrice: String(Number(group.halfHourPrice)),
  halfHourOfferMinutes: String(group.halfHourOfferMinutes),
  imageUrl: group.imageUrl ?? '',
});

const periodsOf = (group: GroupCard): PeriodDraft[] =>
  group.periods.length
    ? group.periods.map((row) => ({ periodId: String(row.periodId), price: String(Number(row.price)), offerMinutes: String(row.offerMinutes) }))
    : [emptyPeriod()];

const fmt = (value: string) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed.toFixed(2).replace(/\.00$/, '') : '0';
};

export default function MarinaGroupCardsPage() {
  const { can } = useSession();
  const canManage = can('marina.manage');

  const [card, setCard] = useState<Card | null>(null);
  const [editingPeriods, setEditingPeriods] = useState<{ id: string; code: string; rows: PeriodDraft[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const groups = useQuery<GroupCard[]>(() => apiList<GroupCard>('/marina/groups'), []);
  const periods = useQuery<RentPeriod[]>(() => apiList<RentPeriod>('/marina/rent-periods'), []);

  useEffect(() => {
    if (!error && !notice) return;
    const timer = setTimeout(() => {
      setError('');
      setNotice('');
    }, 6000);
    return () => clearTimeout(timer);
  }, [error, notice]);

  const rows = groups.data ?? [];
  const durations = periods.data ?? [];
  const setField = (patch: Partial<Card>) => setCard((current) => (current ? { ...current, ...patch } : current));

  async function save() {
    if (!card) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        code: card.code.trim(),
        name: card.name.trim(),
        nameEn: card.nameEn.trim(),
        hourPrice: card.hourPrice || '0',
        hourOfferMinutes: Number(card.hourOfferMinutes || 0),
        halfHourPrice: card.halfHourPrice || '0',
        halfHourOfferMinutes: Number(card.halfHourOfferMinutes || 0),
        imageUrl: card.imageUrl.trim() || null,
      };
      if (card.id) {
        await apiPatch(`/marina/groups/${card.id}`, { ...payload, ...(card.version ? { version: card.version } : {}) });
        setNotice('تم حفظ التعديلات بنجاح...');
      } else {
        await apiPost('/marina/groups', payload);
        setNotice('تم حفظ الفئة');
      }
      setCard(null);
      groups.reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(group: GroupCard) {
    if (!window.confirm(`هل انت متأكد من حذف الفئة\n\n${group.code} — ${group.name}`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiDelete(`/marina/groups/${group.id}`);
      setNotice('تم الحذف');
      if (card?.id === group.id) setCard(null);
      groups.reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function savePeriods() {
    if (!editingPeriods) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPut(`/marina/groups/${editingPeriods.id}/periods`, {
        periods: editingPeriods.rows.map((row) => ({
          periodId: Number(row.periodId),
          price: row.price || '0',
          offerMinutes: Number(row.offerMinutes || 0),
        })),
      });
      setNotice('✅ تم الحفظ بنجاح');
      setEditingPeriods(null);
      groups.reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  /** ⏮ ◀ ▶ ⏭ — `Navigate` عند الديسكتوب يقف مكانه إن لم يجد صفاً. */
  async function walk(direction: 'first' | 'previous' | 'next' | 'last') {
    setBusy(true);
    setError('');
    try {
      const query = new URLSearchParams({ dir: direction, ...(card?.id ? { currentId: card.id } : {}) });
      const found = await apiFetch<GroupCard | null>(`/marina/groups/navigate?${query.toString()}`);
      const body = (found as { data?: GroupCard | null } | null) ?? null;
      const next = (body && 'data' in body ? body.data : (found as GroupCard | null)) ?? null;
      if (next) setCard(cardOf(next));
      else setNotice('لا توجد فئة في هذا الاتجاه');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="📋 بطاقة فئة"
      subtitle="فئة المركب وتسعيرها: قيمة الساعة وقيمة النصف ساعة وعرضاهما بالدقائق، ثم «➕ إضافة مدة» لِما زاد من الفترات — و«📋 قائمة الفئات» تحتها."
      crumbs={['إدارة المراسي', 'التعاريف']}
      actions={
        <div className="row" style={{ gap: 6 }}>
          <a className="btn" href="/marina/vessels">
            ⚓ المراكب
          </a>
          {canManage && (
            <button className="btn primary" type="button" onClick={() => { setError(''); setNotice(''); setCard(emptyCard()); }}>
              ➕ جديد
            </button>
          )}
        </div>
      }
    >
      {error && <p className="alert danger">{error}</p>}
      {notice && <p className="alert ok">{notice}</p>}

      {groups.status === 'loading' && <Loading rows={6} />}
      {groups.status === 'forbidden' && <Forbidden />}
      {groups.status === 'error' && <ErrorBox message={groups.error} onRetry={groups.reload} />}

      {groups.status === 'success' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="group-label" style={{ margin: 0 }}>📋 قائمة الفئات</span>
            <span className="muted">عدد السجلات: {rows.length}</span>
          </div>
          {rows.length === 0 ? (
            <Empty title="لا توجد فئات" detail="ابدأ بـ «➕ جديد»: رمز الفئة واسمها، ثم قيمة الساعة وقيمة النصف ساعة." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>🔢 رقم الفئة</th>
                    <th>رمز الفئة</th>
                    <th>اسم الفئة</th>
                    <th>اسم الفئة (EN)</th>
                    <th className="num">قيمة الساعة</th>
                    <th className="num">قيمة النصف ساعة</th>
                    <th className="num">⏰ الفترات</th>
                    <th className="num">⛵ المراكب</th>
                    {canManage && <th>إجراءات</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} onDoubleClick={() => canManage && setCard(cardOf(row))}>
                      <td dir="ltr">{row.number ?? '—'}</td>
                      <td dir="ltr">{row.code || '—'}</td>
                      <td>{row.name}</td>
                      <td dir="ltr">{row.nameEn || '—'}</td>
                      <td className="num" dir="ltr">{fmt(row.hourPrice)}</td>
                      <td className="num" dir="ltr">{fmt(row.halfHourPrice)}</td>
                      <td className="num" dir="ltr">{row.periods.length}</td>
                      <td className="num" dir="ltr">{row.vesselCount}</td>
                      {canManage && (
                        <td>
                          <div className="row" style={{ gap: 4 }}>
                            <button className="btn sm" type="button" onClick={() => setCard(cardOf(row))}>
                              ✏️ تعديل
                            </button>
                            <button
                              className="btn sm"
                              type="button"
                              onClick={() => setEditingPeriods({ id: row.id, code: row.code, rows: periodsOf(row) })}
                            >
                              ⏰ الفترات
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

      {/* «📋 بطاقة فئة» — الحقول كما في `frmGroupM`، و⏮ ◀ ▶ ⏭ أسفلها. */}
      {card && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 760 }}>
            <div className="modal-head">
              <span className="modal-title">{card.id ? '✏️ تعديل الفئة' : '📋 بطاقة فئة'}</span>
              <button className="btn sm" type="button" onClick={() => setCard(null)}>
                ✖ خروج
              </button>
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 12, maxHeight: '70vh', overflow: 'auto' }}>
              <div className="form-grid">
                <label className="field">
                  <span>🔢 رقم الفئة</span>
                  <input className="input" value={card.id ? String(rows.find((row) => row.id === card.id)?.number ?? '') : 'يُصدر عند الحفظ'} disabled />
                </label>
                <label className="field">
                  <span>رمز الفئة *</span>
                  <input className="input" dir="ltr" value={card.code} onChange={(event) => setField({ code: event.target.value })} />
                </label>
                <label className="field">
                  <span>اسم الفئة (عربي)</span>
                  <input className="input" value={card.name} onChange={(event) => setField({ name: event.target.value })} />
                </label>
                <label className="field">
                  <span>اسم الفئة (EN)</span>
                  <input className="input" dir="ltr" value={card.nameEn} onChange={(event) => setField({ nameEn: event.target.value })} />
                </label>
                <label className="field">
                  <span>قيمة الساعة</span>
                  <input className="input" dir="ltr" inputMode="decimal" value={card.hourPrice} onChange={(event) => setField({ hourPrice: event.target.value })} />
                </label>
                <label className="field">
                  <span>عرض الساعة (دقيقة)</span>
                  <input className="input" dir="ltr" inputMode="numeric" value={card.hourOfferMinutes} onChange={(event) => setField({ hourOfferMinutes: event.target.value })} />
                </label>
                <label className="field">
                  <span>قيمة النصف ساعة</span>
                  <input className="input" dir="ltr" inputMode="decimal" value={card.halfHourPrice} onChange={(event) => setField({ halfHourPrice: event.target.value })} />
                </label>
                <label className="field">
                  <span>عرض النصف ساعة (دقيقة)</span>
                  <input className="input" dir="ltr" inputMode="numeric" value={card.halfHourOfferMinutes} onChange={(event) => setField({ halfHourOfferMinutes: event.target.value })} />
                </label>
                <label className="field" style={{ gridColumn: '1 / -1' }}>
                  <span>🖼️ صورة الفئة — رابط الصورة</span>
                  <input className="input" dir="ltr" placeholder="https://…" value={card.imageUrl} onChange={(event) => setField({ imageUrl: event.target.value })} />
                </label>
              </div>

              {card.imageUrl && /^(https?:\/\/|data:image\/)/i.test(card.imageUrl) && (
                <img src={card.imageUrl} alt="🖼️ صورة الفئة" style={{ maxHeight: 120, alignSelf: 'flex-start', borderRadius: 8 }} />
              )}

              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button className="btn primary" type="button" disabled={busy || !card.code.trim()} onClick={save}>
                  💾 حفظ
                </button>
                {card.id && (
                  <button
                    className="btn"
                    type="button"
                    onClick={() =>
                      setEditingPeriods({
                        id: card.id!,
                        code: card.code,
                        rows: periodsOf(rows.find((row) => row.id === card.id) ?? { ...emptyCard(), id: card.id, periods: [] } as unknown as GroupCard),
                      })
                    }
                  >
                    ➕ إضافة مدة
                  </button>
                )}
                {card.imageUrl && (
                  <button className="btn" type="button" onClick={() => setField({ imageUrl: '' })}>
                    🗑️ حذف الصورة
                  </button>
                )}
                <span style={{ flex: 1 }} />
                <button className="btn sm" type="button" disabled={busy} onClick={() => walk('first')} title="الأول">⏮</button>
                <button className="btn sm" type="button" disabled={busy} onClick={() => walk('previous')} title="السابق">◀</button>
                <button className="btn sm" type="button" disabled={busy} onClick={() => walk('next')} title="التالي">▶</button>
                <button className="btn sm" type="button" disabled={busy} onClick={() => walk('last')} title="الأخير">⏭</button>
              </div>
              {!card.id && <p className="muted">⏰ فترتا «ساعة» و«نصف ساعة» تُكتبان من هذين الصندوقين عند الحفظ، كما يكتبها `frmGroupM`.</p>}
            </div>
          </div>
        </div>
      )}

      {/* «⏰ إدارة فترات التأجير» — `frmAddPeriod`. */}
      {editingPeriods && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 660 }}>
            <div className="modal-head">
              <span className="modal-title">⏰ إدارة فترات التأجير — {editingPeriods.code}</span>
              <button className="btn sm" type="button" onClick={() => setEditingPeriods(null)}>
                ✖ إغلاق
              </button>
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 12, maxHeight: '70vh', overflow: 'auto' }}>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>⏰ المدة</th>
                      <th className="num">💵 السعر</th>
                      <th className="num">🎁 العرض</th>
                      <th>🗑️</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editingPeriods.rows.map((row, index) => (
                      <tr key={index}>
                        <td>
                          <select
                            className="input"
                            value={row.periodId}
                            onChange={(event) =>
                              setEditingPeriods((current) =>
                                current
                                  ? { ...current, rows: current.rows.map((line, at) => (at === index ? { ...line, periodId: event.target.value } : line)) }
                                  : current,
                              )
                            }
                          >
                            {durations.length === 0 && <option value={row.periodId}>{row.periodId}</option>}
                            {durations.map((duration) => (
                              <option key={duration.id} value={String(duration.id)}>
                                {duration.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            className="input"
                            dir="ltr"
                            inputMode="decimal"
                            value={row.price}
                            onChange={(event) =>
                              setEditingPeriods((current) =>
                                current
                                  ? { ...current, rows: current.rows.map((line, at) => (at === index ? { ...line, price: event.target.value } : line)) }
                                  : current,
                              )
                            }
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            dir="ltr"
                            inputMode="numeric"
                            value={row.offerMinutes}
                            onChange={(event) =>
                              setEditingPeriods((current) =>
                                current
                                  ? { ...current, rows: current.rows.map((line, at) => (at === index ? { ...line, offerMinutes: event.target.value } : line)) }
                                  : current,
                              )
                            }
                          />
                        </td>
                        <td>
                          <button
                            className="btn sm danger"
                            type="button"
                            onClick={() =>
                              setEditingPeriods((current) => (current ? { ...current, rows: current.rows.filter((_, at) => at !== index) } : current))
                            }
                          >
                            🗑️ حذف
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="row" style={{ gap: 6 }}>
                <button
                  className="btn"
                  type="button"
                  onClick={() => setEditingPeriods((current) => (current ? { ...current, rows: [...current.rows, emptyPeriod()] } : current))}
                >
                  ➕
                </button>
                <span style={{ flex: 1 }} />
                <button className="btn primary" type="button" disabled={busy || editingPeriods.rows.length === 0} onClick={savePeriods}>
                  💾 حفظ
                </button>
              </div>
              <p className="muted">🎁 العرض بالدقائق، كما في `RentPeriodSub.offer`.</p>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}
