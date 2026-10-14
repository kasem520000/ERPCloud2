'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../../components/screen';
import { apiList, apiPatch, apiPost } from '../../../../lib/api';
import { useSession } from '../../../../lib/session';
import { useQuery } from '../../../../lib/use-query';

/**
 * 📏 إدارة خصائص القياسات — `Form_WPF/frmMeasurementAttributes.xaml`
 * («📏 إدارة خصائص القياسات»).
 *
 * The window is one grid and six buttons:
 *
 *   • the grid — `📝 اسم الخاصية · 🔢 الترتيب · ⚙️ الحالة` (الرقم hidden), where
 *     ⚙️ الحالة is `CASE WHEN IsActive = 1 THEN 'نشط' ELSE 'معطل' END`, ordered
 *     `ORDER BY DisplayOrder`.
 *   • `➕ إضافة` — an `InputDialog` titled «إضافة خاصية جديدة» asking «أدخل اسم
 *     الخاصية (مثل: الطول، العرض، الكم)»; the new row takes
 *     `ISNULL(MAX(DisplayOrder), 0) + 1`.
 *   • `✏️ تعديل` — the same dialog titled «تعديل» with «تعديل اسم الخاصية:», and a blank
 *     or unchanged answer changes nothing.
 *   • `🔕 تعطيل` — `IsActive = 0` after «هل أنت متأكد من تعطيل هذه الخاصية؟\nسيتم
 *     إخفاؤها من القياسات الجديدة». It is never a delete: the row stays in the list,
 *     marked «معطل», and stops appearing in «📐 قيم القياسات».
 *   • `▲ تحريك للأعلى` و`▼ تحريك للأسفل` — the tenant's الترتيب is what the قياس card
 *     builds its boxes from, so the order is theirs to change. At either end there is no
 *     neighbour and nothing moves.
 *   • `✖ إغلاق` — back to 📏 إدارة قياسات العملاء.
 *
 * The three rows a new tenant starts with (الطول · العرض · الكم) are the repository's
 * own example: the add prompt names them, and `MeasurementAttributes` rows are data —
 * not code — so no others ship with the desktop.
 */
type Attribute = {
  id: string;
  nameAr: string;
  displayOrder: number;
  active: boolean;
  statusText: string;
  version: number;
};

type Prompt = { id?: string; title: string; question: string; value: string; kind: 'add' | 'edit' };

function TailoringMeasurementAttributes() {
  const { can } = useSession();
  const canManage = can('tailoring.manage');

  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const attributes = useQuery<Attribute[]>(() => apiList<Attribute>('/tailoring/measurement-attributes'), []);
  const rows = attributes.data ?? [];

  const reload = attributes.reload;

  async function submit() {
    if (!prompt) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (prompt.kind === 'add') {
        await apiPost('/tailoring/measurement-attributes', { nameAr: prompt.value });
        setNotice('تمت الإضافة بنجاح');
      } else {
        const current = rows.find((row) => row.id === prompt.id) as Attribute;
        await apiPatch(`/tailoring/measurement-attributes/${prompt.id}`, {
          version: current.version,
          nameAr: prompt.value,
        });
        setNotice('تم التعديل بنجاح');
      }
      setPrompt(null);
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(row: Attribute) {
    // «هل أنت متأكد من تعطيل هذه الخاصية؟\nسيتم إخفاؤها من القياسات الجديدة»
    if (!window.confirm(`هل أنت متأكد من تعطيل هذه الخاصية؟\nسيتم إخفاؤها من القياسات الجديدة\n\n${row.nameAr}`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPost(`/tailoring/measurement-attributes/${row.id}/deactivate`, {});
      setNotice('تم التعطيل بنجاح');
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function move(row: Attribute, direction: 'up' | 'down') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPost(`/tailoring/measurement-attributes/${row.id}/move`, { direction });
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title="📏 إدارة خصائص القياسات"
      subtitle="ما يُقاس: الخاصية وترتيبها وحالتها. والترتيب هو ترتيب الصناديق في بطاقة القياس — و«معطل» تعني أنها تختفي من القياسات الجديدة، لا أنها تُمحى."
      crumbs={['التفصيل', 'القياسات', 'خصائص القياسات']}
      actions={
        <div className="row" style={{ gap: 6 }}>
          <Link className="btn" href="/tailoring/measurements">
            📏 قياسات العملاء
          </Link>
          {canManage && (
            <button
              className="btn primary"
              type="button"
              onClick={() =>
                // «أدخل اسم الخاصية (مثل: الطول، العرض، الكم)» — the desktop's own prompt.
                setPrompt({
                  title: 'إضافة خاصية جديدة',
                  question: 'أدخل اسم الخاصية (مثل: الطول، العرض، الكم)',
                  value: '',
                  kind: 'add',
                })
              }
            >
              ➕ إضافة
            </button>
          )}
        </div>
      }
    >
      {error && <p className="alert danger">{error}</p>}
      {notice && <p className="alert ok">{notice}</p>}

      {attributes.status === 'loading' && <Loading rows={5} />}
      {attributes.status === 'forbidden' && <Forbidden />}
      {attributes.status === 'error' && <ErrorBox message={attributes.error} onRetry={reload} />}
      {attributes.status === 'success' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="group-label" style={{ margin: 0 }}>📏 خصائص القياسات</span>
            <span className="muted">عدد السجلات: {rows.length}</span>
          </div>
          {rows.length === 0 ? (
            <Empty title="لا توجد خصائص" detail="ابدأ بـ «➕ إضافة» — «الطول» مثالاً كما في الديسكتوب." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>📝 اسم الخاصية</th>
                    <th className="num">🔢 الترتيب</th>
                    <th>⚙️ الحالة</th>
                    {canManage && <th>إجراءات</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} style={row.active ? undefined : { opacity: 0.65 }}>
                      <td>{row.nameAr}</td>
                      <td className="num">{row.displayOrder}</td>
                      <td>
                        <span className={`badge${row.active ? '' : ' danger'}`}>{row.statusText}</span>
                      </td>
                      {canManage && (
                        <td>
                          <div className="row" style={{ gap: 4 }}>
                            <button
                              className="btn sm"
                              type="button"
                              onClick={() =>
                                // «تعديل اسم الخاصية:» — `PromptInput` in the desktop.
                                setPrompt({
                                  id: row.id,
                                  title: 'تعديل',
                                  question: 'تعديل اسم الخاصية:',
                                  value: row.nameAr,
                                  kind: 'edit',
                                })
                              }
                            >
                              ✏️ تعديل
                            </button>
                            {row.active && (
                              <button className="btn sm" type="button" onClick={() => deactivate(row)}>
                                🔕 تعطيل
                              </button>
                            )}
                            <button
                              className="btn sm"
                              type="button"
                              title="تحريك للأعلى"
                              disabled={rows[0]?.id === row.id}
                              onClick={() => move(row, 'up')}
                            >
                              ▲
                            </button>
                            <button
                              className="btn sm"
                              type="button"
                              title="تحريك للأسفل"
                              disabled={rows[rows.length - 1]?.id === row.id}
                              onClick={() => move(row, 'down')}
                            >
                              ▼
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

      {prompt && (
        // `InputDialog` — «✔ موافق» و«✖ إلغاء» around one box, as the desktop builds it.
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 440 }}>
            <div className="modal-head">
              <span className="modal-title">{prompt.title}</span>
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 10 }}>
              <p style={{ margin: 0, fontWeight: 700 }}>{prompt.question}</p>
              <input
                className="input"
                value={prompt.value}
                onChange={(event) => setPrompt({ ...prompt, value: event.target.value })}
              />
            </div>
            <div className="modal-foot">
              <button className="btn primary" type="button" onClick={submit} disabled={busy}>
                ✔ موافق
              </button>
              <button className="btn danger" type="button" onClick={() => setPrompt(null)} disabled={busy}>
                ✖ إلغاء
              </button>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading rows={5} />}>
      <TailoringMeasurementAttributes />
    </Suspense>
  );
}
