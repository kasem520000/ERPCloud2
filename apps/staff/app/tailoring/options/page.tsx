'use client';

import { Suspense, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../components/screen';
import { apiDelete, apiList, apiPatch, apiPost } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { useQuery } from '../../../lib/use-query';

/**
 * ⚙️ إدارة الخيارات الجاهزة — `Form_WPF/frmOptions.xaml`.
 *
 * Two panels, exactly as the window has them: «📂 التصنيفات (الأنواع)» on the right and
 * «🔧 الخيارات المتاحة» on the left, each with `➕ إضافة · ✏️ تعديل · 🗑️ حذف`, and the
 * options panel carrying `⭐ تعيين افتراضي` as well. The category grid is
 * `التصنيف · الترتيب` (L52–54) and the values grid is the same two columns plus the
 * default flag.
 *
 * `frmOptions.xaml.cs` is the whole rule book, and this screen keeps its sentences:
 *
 *   • DisplayOrder is `ISNULL(MAX(DisplayOrder),0)+1` (L136/L232) — a new row goes last.
 *   • حذف is a soft `IsActive=0` (L198/L298), after
 *     «هل أنت متأكد من حذف هذا التصنيف وجميع خياراته؟» / «هل أنت متأكد من حذف هذا الخيار؟».
 *   • ⭐ تعيين افتراضي clears the category first and then sets the chosen value
 *     (L323 `SET IsDefault=0 WHERE CategoryID=@CatID`, L330 `SET IsDefault=1`).
 *   • the refusals are «الرجاء اختيار تصنيف للتعديل» · «الرجاء اختيار تصنيف للحذف» ·
 *     «الرجاء اختيار خيار للتعديل» · «الرجاء اختيار خيار للحذف» · «الرجاء اختيار خيار».
 *
 * «📂 التصنيفات (الأنواع)» are what `frmOrderDetails` renders as «🔧 الخيارات» on the
 * order card: one value per category (`selectedOptions[catId] = valId`).
 */
type OptionValue = { id: string; nameAr: string; displayOrder: number; isDefault: boolean; active: boolean };
type OptionCategory = { id: string; nameAr: string; displayOrder: number; active: boolean; values: OptionValue[] };

function TailoringOptions() {
  const { can } = useSession();
  const canManage = can('tailoring.manage');

  const [categoryId, setCategoryId] = useState('');
  const [categoryName, setCategoryName] = useState('');
  const [valueName, setValueName] = useState('');
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const categories = useQuery<OptionCategory[]>(() => apiList<OptionCategory>('/tailoring/option-categories?activeOnly=0'), []);

  const rows = categories.data ?? [];
  const selected = rows.find((row) => row.id === categoryId) ?? null;
  const values = selected?.values ?? [];

  const guard = (label: string, ok: boolean) => {
    if (ok) return true;
    setError(label);
    return false;
  };

  async function run(label: string, work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(label);
      setEditingCategory(null);
      setEditingValue(null);
      setCategoryName('');
      setValueName('');
      categories.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const addCategory = () =>
    run('تمت الإضافة بنجاح', () => apiPost('/tailoring/option-categories', { nameAr: categoryName.trim() }));

  const editCategory = () => {
    // «الرجاء اختيار تصنيف للتعديل»
    if (!guard('الرجاء اختيار تصنيف للتعديل', Boolean(editingCategory))) return;
    return run('تم التعديل بنجاح', () =>
      apiPatch(`/tailoring/option-categories/${editingCategory}`, { nameAr: categoryName.trim() }),
    );
  };

  const deleteCategory = () => {
    // «الرجاء اختيار تصنيف للحذف»
    if (!guard('الرجاء اختيار تصنيف للحذف', Boolean(categoryId))) return;
    if (!window.confirm('هل أنت متأكد من حذف هذا التصنيف وجميع خياراته؟')) return;
    return run('تم الحذف بنجاح', async () => {
      await apiDelete(`/tailoring/option-categories/${categoryId}`);
      setCategoryId('');
    });
  };

  const addValue = () => {
    if (!guard('الرجاء اختيار تصنيف أولًا', Boolean(categoryId))) return;
    return run('تمت الإضافة بنجاح', () =>
      apiPost('/tailoring/option-values', { categoryId, nameAr: valueName.trim() }),
    );
  };

  const editValue = () => {
    if (!guard('الرجاء اختيار خيار للتعديل', Boolean(editingValue))) return;
    return run('تم التعديل بنجاح', () =>
      apiPatch(`/tailoring/option-values/${editingValue}`, { nameAr: valueName.trim() }),
    );
  };

  const deleteValue = () => {
    if (!guard('الرجاء اختيار خيار للحذف', Boolean(editingValue))) return;
    if (!window.confirm('هل أنت متأكد من حذف هذا الخيار؟')) return;
    return run('تم الحذف بنجاح', () => apiDelete(`/tailoring/option-values/${editingValue}`));
  };

  const setDefault = (valueId: string) => {
    if (!guard('الرجاء اختيار خيار', Boolean(valueId))) return;
    return run('تم التعيين كافتراضي', () => apiPost(`/tailoring/option-values/${valueId}/default`, {}));
  };

  return (
    <Screen
      title="إدارة الخيارات الجاهزة"
      subtitle="📂 التصنيفات (الأنواع) و🔧 الخيارات المتاحة التي يختار منها الطلب: ياقة، جيب، قماش… وخيار واحد افتراضي لكل تصنيف."
      crumbs={['التفصيل', 'الخيارات']}
    >
      {error && <p className="alert danger">{error}</p>}
      {notice && <p className="alert ok">{notice}</p>}

      {categories.status === 'loading' && <Loading rows={4} />}
      {categories.status === 'forbidden' && <Forbidden />}
      {categories.status === 'error' && <ErrorBox message={categories.error} onRetry={categories.reload} />}
      {categories.status === 'success' && (
        <div className="grid cols-2">
          {/* 📂 التصنيفات (الأنواع) */}
          <section className="card">
            <p className="group-label">📂 التصنيفات (الأنواع)</p>
            {rows.length === 0 ? (
              <Empty title="لا توجد تصنيفات" detail="أضف تصنيفاً واحداً على الأقل قبل إضافة خيارات." />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>التصنيف</th>
                      <th className="num">الترتيب</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.id}
                        className={row.id === categoryId ? 'active' : undefined}
                        onClick={() => {
                          setCategoryId(row.id);
                          setEditingValue(null);
                        }}
                        style={{ cursor: 'pointer' }}
                      >
                        <td>
                          {editingCategory === row.id ? (
                            <input
                              className="input"
                              value={categoryName}
                              onChange={(event) => setCategoryName(event.target.value)}
                            />
                          ) : (
                            <>
                              {row.nameAr}
                              {!row.active && <span className="badge"> موقوف</span>}
                            </>
                          )}
                        </td>
                        <td className="num" dir="ltr">
                          {row.displayOrder}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {canManage && (
              <>
                <div className="row" style={{ marginTop: 10 }}>
                  <input
                    className="input"
                    placeholder="اسم التصنيف"
                    value={categoryName}
                    onChange={(event) => setCategoryName(event.target.value)}
                  />
                </div>
                <div className="toolbar" style={{ marginTop: 8 }}>
                  {editingCategory ? (
                    <button className="btn primary" type="button" onClick={editCategory} disabled={busy}>
                      ✔ حفظ التعديل
                    </button>
                  ) : (
                    <button className="btn primary" type="button" onClick={addCategory} disabled={busy || !categoryName.trim()}>
                      ➕ إضافة
                    </button>
                  )}
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || !categoryId}
                    onClick={() => {
                      setEditingCategory(categoryId);
                      setCategoryName(selected?.nameAr ?? '');
                    }}
                  >
                    ✏️ تعديل
                  </button>
                  <button className="btn danger" type="button" onClick={deleteCategory} disabled={busy || !categoryId}>
                    🗑️ حذف
                  </button>
                </div>
              </>
            )}
          </section>

          {/* 🔧 الخيارات المتاحة */}
          <section className="card">
            <p className="group-label">🔧 الخيارات المتاحة{selected ? ` — ${selected.nameAr}` : ''}</p>
            {!selected ? (
              <Empty title="اختر تصنيفاً" detail="الخيار يتبع تصنيفاً؛ اختر تصنيفاً من القائمة الأولى." />
            ) : values.length === 0 ? (
              <Empty title="لا توجد خيارات في هذا التصنيف" detail="أضف خياراً واحداً على الأقل ليظهر على بطاقة الطلب." />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>الخيار</th>
                      <th className="num">الترتيب</th>
                      <th>الافتراضي</th>
                    </tr>
                  </thead>
                  <tbody>
                    {values.map((value) => (
                      <tr key={value.id} onClick={() => setEditingValue(value.id)} style={{ cursor: 'pointer' }}>
                        <td>
                          {editingValue === value.id ? (
                            <input
                              className="input"
                              value={valueName}
                              onChange={(event) => setValueName(event.target.value)}
                            />
                          ) : (
                            <>
                              {value.nameAr}
                              {!value.active && <span className="badge"> موقوف</span>}
                            </>
                          )}
                        </td>
                        <td className="num" dir="ltr">
                          {value.displayOrder}
                        </td>
                        <td>{value.isDefault ? '⭐ افتراضي' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {canManage && selected && (
              <>
                <div className="row" style={{ marginTop: 10 }}>
                  <input
                    className="input"
                    placeholder="اسم الخيار"
                    value={valueName}
                    onChange={(event) => setValueName(event.target.value)}
                  />
                </div>
                <div className="toolbar" style={{ marginTop: 8 }}>
                  {editingValue ? (
                    <button className="btn primary" type="button" onClick={editValue} disabled={busy}>
                      ✔ حفظ التعديل
                    </button>
                  ) : (
                    <button className="btn primary" type="button" onClick={addValue} disabled={busy || !valueName.trim()}>
                      ➕ إضافة
                    </button>
                  )}
                  <button
                    className="btn"
                    type="button"
                    disabled={busy || !values.length}
                    onClick={() => {
                      const value = values.find((row) => row.id === editingValue) ?? values[0];
                      if (!value) return;
                      setEditingValue(value.id);
                      setValueName(value.nameAr);
                    }}
                  >
                    ✏️ تعديل
                  </button>
                  <button className="btn danger" type="button" onClick={deleteValue} disabled={busy || !editingValue}>
                    🗑️ حذف
                  </button>
                  <button className="btn" type="button" onClick={() => setDefault(editingValue ?? values[0]?.id ?? '')} disabled={busy || !values.length}>
                    ⭐ تعيين افتراضي
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </Screen>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading rows={4} />}>
      <TailoringOptions />
    </Suspense>
  );
}
