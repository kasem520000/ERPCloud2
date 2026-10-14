'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../../../components/screen';
import { Notice } from '../../../../components/data-view';
import { apiData, apiFetch } from '../../../../lib/api';
import { navTargets, positionLabel, type JournalNeighbours } from '../../../../lib/journal-nav';
import { useQuery } from '../../../../lib/use-query';

/**
 * 🧾 القيد — نافذة القيد المكتبية في نسختها السحابيّة للقراءة.
 *
 * `Form_WPF/FrmNewEntry.xaml` نافذةٌ واحدة تفعل كل شيء: «➕ جديد» و«💾 حفظ» و«🗑️ حذف»
 * (L450 `btnDelete` → `FrmNewEntry.xaml.cs:645 DeleteEntry()`:
 * `update Entry set IS_Deleted=1 where GlobalId=…` + سطر سجل «تم حذف سند قيد…») و
 * «🖨️ طباعة» و«👁️ معاينة» ومعها **⏮ ◀ ▶ ⏭** (L428-431) لتصفّح القيود، وعمود
 * «🗑️ حذف» على كل سطر (L378-397 `BtnDeleteRow_Click` L532) لحذف السطر قبل الحفظ.
 *
 * والسحابة تفصل الفعل عن التصفّح لأن قيداً مرحّلاً لا يُعدَّل ولا يُحذف — الحذف
 * ممنوع في القاعدة (`0004_accounting.sql` `prevent_posted_journal_mutation` يُصلح
 * بـ`0047` ليُطبّق `void` لكن الحذف يبقى ممنوعاً)، وعكسه هو الطريق
 * (`POST /journal-entries/:id/reverse`). فبقي من النافذة **ما هو قراءة**: رأسُ القيد
 * وسطوره ومجموعاه والمتنقّل والطباعة، وزرّ الحذف معطّل مع شرح — فالتسميات كلها من
 * النافذة، والفعل الوحيد الذي يزيده العكس مُعلَنٌ في مكانه.
 *
 * والنطاق يأتي في الرابط (`?from&to&status&branchId`) من سجل القيود الذي فُتح منه القيد،
 * فيبقى التنقّل داخل الفترة المعروضة لا يخرج منها.
 */

type Entry = {
  id: string;
  number: string | null;
  date: string;
  entryTime: string | null;
  kind: string;
  status: string;
  description: string | null;
  sourceType: string | null;
  sourceId: string | null;
  reversalOf: string | null;
  postedAt: string | null;
  isVat: boolean;
  legacyId: string | null;
  /** الحقلان موجودان في `...entry` من الخدمة — نحتاجهما لعكس القيد. */
  branchId: string;
  fiscalPeriodId: string;
  lines: Array<{
    lineNo: number;
    accountId: string;
    accountCode: string | null;
    accountNameAr: string | null;
    debit: string;
    credit: string;
    description: string | null;
    costCenterId: string | null;
    partyId: string | null;
  }>;
};

function money(value: string | null | undefined) {
  return Number(value || 0).toLocaleString('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const STATUS_LABELS: Record<string, string> = { posted: 'مرحّل', draft: 'مسودة', void: 'ملغي' };

export default function JournalEntryPage() {
  const params = useParams<{ id: string }>();
  const entryId = String(params.id);
  const search = useSearchParams();
  const scope = {
    from: search.get('from') ?? undefined,
    to: search.get('to') ?? undefined,
    status: search.get('status') ?? undefined,
    branchId: search.get('branchId') ?? undefined,
  };
  const scopeKey = `${scope.from ?? ''}|${scope.to ?? ''}|${scope.status ?? ''}|${scope.branchId ?? ''}`;

  const entry = useQuery<Entry>(() => apiData<Entry>(`/journal-entries/${entryId}`), [entryId]);
  const neighbours = useQuery<JournalNeighbours>(() => {
    const query = new URLSearchParams();
    if (scope.from) query.set('from', scope.from);
    if (scope.to) query.set('to', scope.to);
    if (scope.status) query.set('status', scope.status);
    if (scope.branchId) query.set('branchId', scope.branchId);
    const suffix = query.toString();
    return apiData<JournalNeighbours>(`/journal-entries/${entryId}/neighbours${suffix ? `?${suffix}` : ''}`);
  }, [entryId, scopeKey]);

  const registerHref = `/accounting/journal-entries${scope.from || scope.to || scope.status ? `?${new URLSearchParams(Object.entries({ from: scope.from, to: scope.to, status: scope.status }).filter(([, value]) => Boolean(value)) as Array<[string, string]>).toString()}` : ''}`;

  const [reverseReason, setReverseReason] = useState('');
  const [reversing, setReversing] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);
  const [reversedId, setReversedId] = useState<string | null>(null);

  if (entry.status === 'loading') return <Loading />;
  if (entry.status === 'forbidden') return <Forbidden />;
  if (entry.status !== 'success' || !entry.data) {
    return (
      <Screen title="🧾 القيد" crumbs={['المحاسبة', 'القيود اليومية']}>
        <ErrorBox message={entry.error ?? 'تعذّر تحميل القيد'} onRetry={entry.reload} />
      </Screen>
    );
  }

  const doc = entry.data;
  const totalDebit = doc.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
  const totalCredit = doc.lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
  const difference = totalDebit - totalCredit;
  const buttons = navTargets(neighbours.data, scope);

  async function handleReverse() {
    if (!reverseReason.trim()) {
      setReverseError('اكتب سبب العكس — هو بيان القيد العكسي');
      return;
    }
    setReversing(true);
    setReverseError(null);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await apiFetch<{ data: { id: string } }>(`/journal-entries/${doc.id}/reverse`, {
        method: 'POST',
        body: JSON.stringify({
          branchId: doc.branchId,
          fiscalPeriodId: doc.fiscalPeriodId,
          date: today,
          reason: reverseReason.trim(),
        }),
      });
      setReversedId(res.data.id);
    } catch (error) {
      setReverseError(error instanceof Error ? error.message : 'تعذّر عكس القيد');
    } finally {
      setReversing(false);
    }
  }

  return (
    <Screen
      title="🧾 القيد"
      subtitle={doc.description ?? '—'}
      crumbs={['المحاسبة', 'القيود اليومية', 'القيد']}
      actions={
        <>
          {/*
            «🖨️ طباعة» و«👁️ معاينة» — `FrmNewEntry.xaml` L454–455. والشاشتان واحدةٌ عندنا:
            ورقة المستند تُفتح داخل إطار، و`?auto=1` يطبعها فور جهوزها (فرقُ الزرّين في
            المكتب: المعاينة تُعرض، والطباعة تُخرج الورق).
          */}
          <Link className="btn primary" href={`/print/journal-entry/${doc.id}?auto=1`}>
            🖨️ طباعة
          </Link>
          <Link className="btn" href={`/print/journal-entry/${doc.id}`}>
            👁️ معاينة
          </Link>
          {/*
            🗑️ حذف — `FrmNewEntry.xaml` L450 `btnDelete` + L378-397 عمود حذف السطر
            (`BtnDeleteRow_Click` L532). في الديسكتوب: `update Entry set IS_Deleted=1
            where GlobalId=N'…'` (L654) + سجل «تم حذف سند قيد برقم …». في السحابة
            القيد المرحّل لا يُحذف — الحذف ممنوع في القاعدة (`prevent_posted_journal_mutation`
            يُصلح بـ0047 ليُطبّق void لكن الحذف يبقى ممنوعاً)، وعكسه هو الطريق.
            فالزرّ معطّل مع شرح، وحذف السطر غير موجود أصلاً لأن الشاشة قراءة.
          */}
          <button
            className="btn"
            type="button"
            disabled
            title="القيد المرحّل لا يُحذف في السحابة — في الديسكتوب: update Entry set IS_Deleted=1 (FrmNewEntry.xaml.cs:654). هنا العكس هو الطريق: POST /journal-entries/:id/reverse"
            aria-label="حذف"
          >
            🗑️ حذف
          </button>
          {/* «✖» خروج — L427؛ والخروج هنا عودةٌ إلى السجل بالنطاق نفسه. */}
          <Link className="btn" href={registerHref}>
            ✖ خروج
          </Link>
        </>
      }
    >
      <div className="card tight">
        {/*
          ⏮ ◀ ▶ ⏭ — `FrmNewEntry.xaml` L428–431 بترتيبها ونصوصها. وزرٌّ بلا جارٍ يُعطَّل
          ولا يُخفى (فالنافذة المكتبية تُبقي الأزرار الأربعة دائماً).
        */}
        <div className="row" style={{ alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {buttons.map((button) =>
            button.href ? (
              <Link key={button.key} className="btn" href={button.href} title={button.title} aria-label={button.label}>
                <span aria-hidden>{button.glyph}</span> {button.label}
              </Link>
            ) : (
              <button key={button.key} className="btn" type="button" disabled title={button.title} aria-label={button.label}>
                <span aria-hidden>{button.glyph}</span> {button.label}
              </button>
            ),
          )}
          <span className="muted small" style={{ marginInlineStart: 'auto' }}>
            {positionLabel(neighbours.data)}
          </span>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>بيانات القيد</h2>
          <dl className="kv">
            {/* «رقم القيد» — FrmNewEntry.xaml L254. */}
            <dt>رقم القيد</dt>
            <dd dir="ltr">{doc.number ?? '—'}</dd>
            {/* «📅 التاريخ» — L257. */}
            <dt>📅 التاريخ</dt>
            <dd dir="ltr">{doc.date}</dd>
            {/* «⏰ الوقت» — L260 (`txtTime`)، والقيد القديم قد يخلو منه. */}
            <dt>⏰ الوقت</dt>
            <dd dir="ltr">{doc.entryTime ? String(doc.entryTime).slice(0, 5) : '—'}</dd>
            {/* «📝 الملاحظة» — L269 (شرح القيد). */}
            <dt>📝 الملاحظة</dt>
            <dd>{doc.description ?? '—'}</dd>
            <dt>📋 الحالة</dt>
            <dd>{STATUS_LABELS[doc.status] ?? doc.status}</dd>
            <dt>المصدر</dt>
            <dd>{doc.sourceType ? `${doc.sourceType}` : 'يدوي'}</dd>
            {doc.reversalOf && (
              <>
                <dt>قيدٌ عكسيّ لـ</dt>
                <dd>
                  <Link className="muted" href={`/accounting/journal-entries/${doc.reversalOf}`}>
                    {doc.reversalOf.slice(0, 8)}…
                  </Link>
                </dd>
              </>
            )}
            {doc.postedAt && (
              <>
                <dt>الترحيل</dt>
                <dd dir="ltr">{String(doc.postedAt).slice(0, 19).replace('T', ' ')}</dd>
              </>
            )}
            {/* «🔑 الرقم العام» — L263؛ ويظهر حين يوجد مرجعٌ قديم فقط. */}
            {doc.legacyId && (
              <>
                <dt>🔑 الرقم العام</dt>
                <dd dir="ltr">{doc.legacyId}</dd>
              </>
            )}
          </dl>
        </div>

        <div className="card">
          {/* «مجموع المدين:» و«مجموع الدائن:» — L446–449، و«الفرق=» — L293. */}
          <h2>الملخّص</h2>
          <dl className="kv">
            <dt>مجموع المدين:</dt>
            <dd>{money(String(totalDebit))}</dd>
            <dt>مجموع الدائن:</dt>
            <dd>{money(String(totalCredit))}</dd>
            <dt>الفرق=</dt>
            <dd>{money(String(difference))}</dd>
          </dl>
        </div>
      </div>

      <div className="card">
        {/* «📋 تفاصيل القيد» — L291، بأعمدة الشبكة L320–366. */}
        <h2>📋 تفاصيل القيد</h2>
        {doc.lines.length === 0 ? (
          <Empty title="لا سطور لهذا القيد" detail="القيد المُعلَن عناصرُه." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>رمز الحساب</th>
                  <th>اسم الحساب</th>
                  <th className="num">مدين</th>
                  <th className="num">دائن</th>
                  <th>الشرح</th>
                </tr>
              </thead>
              <tbody>
                {doc.lines.map((line) => (
                  <tr key={line.lineNo}>
                    <td>{line.lineNo}</td>
                    <td dir="ltr">{line.accountCode ?? '—'}</td>
                    <td>{line.accountNameAr ?? '—'}</td>
                    <td className="num">{money(line.debit)}</td>
                    <td className="num">{money(line.credit)}</td>
                    <td>{line.description ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/*
          عمود «🗑️ حذف» على كل سطر — `FrmNewEntry.xaml` L378-397 `BtnDeleteRow_Click`
          (L532) + `DeleteCurrentRow` L552 + `GridControl1_KeyDown` L482 (Delete key).
          في الديسكتوب يحذف السطر قبل الحفظ (`EntryAccList.Remove` + `ReIndexRows`).
          في السحابة القيد المرحّل لا يُعدَّل أصلاً، والشاشة قراءة — فالعمود غير موجود،
          ويُعلَن هنا حيث يُتوقّعه من يقرأ الشبكة.
        */}
        <p className="muted small" style={{ marginTop: 8 }}>
          حذف السطر (🗑️) في `FrmNewEntry.xaml:378-397` كان قبل الحفظ فقط — القيد المرحّل لا يُعدَّل، فالشبكة هنا قراءة.
        </p>
      </div>

      {/*
        القيد المرحّل لا يُعدَّل في السحابة (وهو المؤجَّل المُعلَن من نافذة الديسكتوب)،
        وعكسُه هو الطريق — ويُعلَن هنا حيث يُتوقّعه المُدخِل، لا في وثيقة.
        وزرّ الحذف 🗑️ معطّل في الأعلى مع tooltip يسمّي السطر الديسكتوبي.
      */}
      {doc.status === 'posted' && (
        <>
          <Notice notice={{ kind: 'info', text: 'القيد المرحّل لا يُعدَّل ولا يُحذف — في الديسكتوب: update Entry set IS_Deleted=1 (FrmNewEntry.xaml.cs:654). في السحابة عكسُه هو الطريق (POST /journal-entries/:id/reverse). زرّ 🗑️ حذف معطّل لهذا السبب.' }} />

          <div className="card">
            <h2>↩️ عكس القيد</h2>
            <p className="muted small">
              العكس ينشئ قيداً مرآةً (مدين ↔ دائن) بنفس الأبعاد (مركز التكلفة · الفرع · المندوب) — ترحيل 0047.
              {doc.kind === 'reversal' ? ' هذا القيد نفسه عكسي.' : ''}
            </p>
            {reversedId ? (
              <div className="row" style={{ marginTop: 8 }}>
                <span>تم العكس — القيد العكسي:</span>
                <Link className="btn primary sm" href={`/accounting/journal-entries/${reversedId}`}>
                  {reversedId.slice(0, 8)}…
                </Link>
              </div>
            ) : (
              <>
                <div className="row" style={{ marginTop: 8 }}>
                  <label className="field" style={{ flex: 1, margin: 0 }}>
                    <span>سبب العكس (بيان القيد العكسي)</span>
                    <input
                      className="input"
                      value={reverseReason}
                      onChange={(event) => setReverseReason(event.target.value)}
                      placeholder="مثال: تصحيح قيد …"
                    />
                  </label>
                  <button className="btn primary" type="button" onClick={handleReverse} disabled={reversing || doc.kind === 'reversal'}>
                    {reversing ? 'جاري العكس…' : '↩️ عكس القيد'}
                  </button>
                </div>
                {reverseError && (
                  <p className="muted small" style={{ color: 'var(--danger, #c00)', marginTop: 6 }}>
                    {reverseError}
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </Screen>
  );
}
