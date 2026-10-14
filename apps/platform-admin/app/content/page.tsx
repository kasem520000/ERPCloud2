'use client';

import { useState, type ReactNode } from 'react';
import {
  contentBlockKinds,
  contentBlockPayloadSchemas,
  contentKinds,
  contentMenuPositions,
  contentStatuses,
  type ContentBanner,
  type ContentBannerAudience,
  type ContentBannerTone,
  type ContentBlockInput,
  type ContentBlockKind,
  type ContentKind,
  type ContentMenu,
  type ContentMenuItem,
  type ContentMenuPosition,
  type ContentPage,
  type ContentPageDetail,
  type ContentVersion,
  type ListEnvelope,
} from '@erp/contracts';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../components/screen';
import { Tabs } from '../../components/ui';
import { ApiError, apiData, apiFetch } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useQuery } from '../../lib/use-query';

/**
 * المحتوى — نظام إدارة محتوى الموقع التسويقي (P-M5، `docs/roadmap/MARKETING_SITE_PLAN.md` §6).
 *
 * أربعة تبويبات على الأسئلة الأربعة التي يطرحها من يحرّر موقعاً:
 *
 *   1. **الصفحات** — «ما المنشور الآن، وما المسوّدة، وما المجدول؟»: القائمة بترشيح النوع
 *      والحالة والبحث، وإنشاء صفحة، ونشرٌ فوريّ أو جدولةٌ بوقت، وسحبٌ **بسببٍ مكتوب**،
 *      وتاريخٌ يُسترجع منه.
 *   2. **الكتل** — «من ماذا تتكوّن الصفحة؟»: الكتل مرتّبة، وكل كتلةٍ حمولتها بالعربية
 *      وبالإنجليزية، وتُحقَّق بمخطّط النوع نفسه الذي يتحقّق به الـAPI قبل أي إرسال — فلا
 *      تُكتشف حمولةٌ مكسورة بعد الحفظ.
 *   3. **القوائم** — «ما الذي يظهر في الرأس والتذييل؟»: خمسة مواضع (رأس · تذييل · جانبي ·
 *      قانوني · تواصل)، والعناصر مرتّبة كما تُرسل.
 *   4. **اللافتات** — «ما الرسالة المعروضة الآن على الزوّار؟»: نصّان، ونافذة عرض، وجمهور،
 *      ووسم `live` تقوله الخدمة لا الشاشة.
 *
 * وثلاثة قرارات ظاهرة هنا:
 *
 *   * **السحب لا الحذف** — الصفحة تُسحب إلى مسوّدة بسببٍ مكتوب (وهو مُلزَم في العقد)، ويبقى
 *     تاريخها؛ لأن حذف صفحةٍ منشورة يمحو سؤال «ما كان منشوراً يوم كذا؟».
 *   * **الحفظ يُرسل الكتل البديل الكامل** — لا دمج: الدمج يجعل حذف كتلةٍ مستحيلاً من الشاشة.
 *   * **القراءة والكتابة رمزان مختلفان** — `console.content.view` يفتح الشاشة، و
 *     `console.content.manage` وحده يُظهر أزرار النشر والكتابة؛ والـAPI هو الحاكم لا الشاشة.
 */

// ───────────────────────────────────────────────────────────── التسميات

const KIND_LABEL: Record<ContentKind, string> = {
  page: 'صفحة',
  post: 'مقال',
  case_study: 'قصة عميل',
  faq: 'سؤال شائع',
  help: 'مقال مساعدة',
  legal: 'صفحة قانونية',
  // P-M9: سجلّ التغييرات نوعٌ سابع — يُكتب من الشاشة نفسها ويُقرأ في `/changelog`.
  changelog: 'سجلّ التغييرات',
};

const STATUS_LABEL: Record<ContentPage['status'], string> = {
  draft: 'مسوّدة',
  scheduled: 'مجدولة',
  published: 'منشورة',
};

const BLOCK_LABEL: Record<ContentBlockKind, string> = {
  heading: 'عنوان',
  text: 'نصّ',
  list: 'قائمة',
  cards: 'بطاقات',
  table: 'جدول',
  faq: 'أسئلة وأجوبة',
  quote: 'اقتباس',
  image: 'صورة',
  video: 'فيديو',
  code: 'رمز',
  cta: 'دعوة إلى إجراء',
};

const MENU_LABEL: Record<ContentMenuPosition, string> = {
  header: 'الرأس',
  footer: 'التذييل',
  sidebar: 'الشريط الجانبي',
  legal: 'القانوني',
  social: 'التواصل الاجتماعي',
};

const TONE_LABEL: Record<ContentBannerTone, string> = {
  info: 'معلومة',
  ok: 'خبر سارّ',
  warn: 'تنبيه',
  danger: 'عاجل',
};

const AUDIENCE_LABEL: Record<ContentBannerAudience, string> = {
  all: 'الجميع',
  visitors: 'الزوّار فقط',
};

/**
 * حمولةٌ ابتدائية لكل نوع — «أضف كتلة» يجب أن يُنتج كتلةً **صالحة** بلا أن يكتب المحرّر
 * JSON من الصفر؛ والقيم واقعية لأنها تُحفظ فعلاً إن لم تُلمس.
 */
const BLOCK_TEMPLATE: Record<ContentBlockKind, unknown> = {
  heading: { text: 'عنوان القسم', level: 2 },
  text: { text: 'اكتب الفقرة هنا…' },
  list: { items: ['البند الأول', 'البند الثاني'], ordered: false },
  cards: {
    items: [{ icon: '🧾', title: 'الفوترة الإلكترونية', body: 'إصدارٌ فوري متوافق مع زاتكا', href: '/features/einvoicing' }],
  },
  table: { caption: 'المقارنة', columns: ['الباقة', 'المستخدمون'], rows: [['الأساسية', '٣'], ['الاحترافية', '١٠']] },
  faq: { items: [{ question: 'هل النظام متوافق مع زاتكا؟', answer: 'نعم، إصدارٌ فوري وربطٌ مباشر بهيئة الزكاة والضريبة.' }] },
  quote: { text: 'وفّرنا أسبوعاً في الإقفال الشهري.', source: 'مدير مالي', role: 'شركة تجزئة' },
  image: { url: '/brand/og.png', alt: 'لوحة تحكّم النظام' },
  video: { url: 'https://example.com/demo.mp4', title: 'جولة في النظام' },
  code: { language: 'bash', code: 'pnpm install' },
  cta: {
    title: 'ابدأ مجاناً',
    body: 'أربعة عشر يوماً بلا بطاقة بنكية.',
    primaryLabel: 'أنشئ حسابك',
    primaryHref: '/onboarding',
  },
};

// ───────────────────────────────────────────────────────────── أدوات

function dateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('ar-SA') : '—';
}

/** `datetime-local` بلا منطقة زمنية ⇒ تُحوَّل إلى ISO بإزاحة صريحة كما يشترط العقد. */
function toIsoWithOffset(local: string): string {
  const date = new Date(local);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function apiMessage(error: unknown): string {
  if (error instanceof ApiError) return error.detail ? `${error.message} — ${error.detail}` : error.message;
  return error instanceof Error ? error.message : String(error);
}

/** نصٌّ فارغ يعني `null` في الحقول الاختيارية — وإلا رفضه المخطّط (`.min(2)`). */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>
        {label}
        {hint ? <em className="muted small"> — {hint}</em> : null}
      </span>
      {children}
    </label>
  );
}

type TabId = 'pages' | 'blocks' | 'menus' | 'banners';

export default function ContentPageScreen() {
  const [tab, setTab] = useState<TabId>('pages');

  return (
    <Screen
      title="المحتوى"
      subtitle="محتوى الموقع التسويقي: الصفحات وكتلها، وقوائم الرأس والتذييل، واللافتات. المسوّدة لا تظهر للزوّار، والمجدولة تظهر في وقتها، والسحب يعيد الصفحة مسوّدةً بسببٍ مكتوب."
      crumbs={['المنصة', 'التشغيل']}
    >
      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        items={[
          { id: 'pages', label: 'الصفحات' },
          { id: 'blocks', label: 'الكتل' },
          { id: 'menus', label: 'القوائم' },
          { id: 'banners', label: 'اللافتات' },
        ]}
      />
      {tab === 'pages' && <PagesTab />}
      {tab === 'blocks' && <BlocksTab />}
      {tab === 'menus' && <MenusTab />}
      {tab === 'banners' && <BannersTab />}
    </Screen>
  );
}

// ───────────────────────────────────────────────────────────── ١) الصفحات

type EditorDraft = Record<string, string>;

const EDITOR_FIELDS: Array<{ key: string; label: string; hint?: string }> = [
  { key: 'titleAr', label: 'العنوان بالعربية' },
  { key: 'titleEn', label: 'العنوان بالإنجليزية', hint: 'اتركه فارغاً إن لم تُترجم بعد' },
  { key: 'summaryAr', label: 'الملخّص بالعربية' },
  { key: 'summaryEn', label: 'الملخّص بالإنجليزية' },
  { key: 'category', label: 'التصنيف', hint: 'للمقالات والمساعدة' },
  { key: 'authorName', label: 'كاتب المقال' },
  { key: 'seoTitleAr', label: 'عنوان SEO بالعربية', hint: 'حتى ٧٠ حرفاً' },
  { key: 'seoTitleEn', label: 'عنوان SEO بالإنجليزية' },
  { key: 'seoDescAr', label: 'وصف SEO بالعربية', hint: 'حتى ١٨٠ حرفاً' },
  { key: 'seoDescEn', label: 'وصف SEO بالإنجليزية' },
  { key: 'ogImageUrl', label: 'صورة المشاركة', hint: 'مسارٌ أو رابطٌ كامل' },
];

function PagesTab() {
  const { canConsole } = useSession();
  const canManage = canConsole('console.content.manage');

  const [kind, setKind] = useState<ContentKind | ''>('');
  const [status, setStatus] = useState<ContentPage['status'] | ''>('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'updated' | 'published' | 'title'>('updated');

  const [creating, setCreating] = useState(false);
  const [create, setCreate] = useState({
    slug: '',
    kind: 'page' as ContentKind,
    titleAr: '',
    titleEn: '',
    summaryAr: '',
    defaultLocale: 'ar' as 'ar' | 'en',
  });

  const [editor, setEditor] = useState<{ id: string; draft: EditorDraft; note: string } | null>(null);
  const [schedule, setSchedule] = useState<{ id: string; at: string } | null>(null);
  const [retract, setRetract] = useState<{ id: string; reason: string } | null>(null);
  const [versions, setVersions] = useState<{ id: string; rows: ContentVersion[] } | null>(null);
  const [restoreNote, setRestoreNote] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const categories = useQuery<{ blog: string[]; help: string[] }>(
    () => apiData<{ blog: string[]; help: string[] }>('/platform/content/categories'),
    [],
  );

  const pages = useQuery<ListEnvelope<ContentPage>>(() => {
    const params = new URLSearchParams({ limit: '100', sort });
    if (kind) params.set('filter[kind]', kind);
    if (status) params.set('filter[status]', status);
    if (q.trim().length > 0) params.set('q', q.trim());
    return apiFetch<ListEnvelope<ContentPage>>(`/platform/content/pages?${params.toString()}`);
  }, [kind, status, q, sort]);

  async function run<T>(action: () => Promise<T>, done: (result: T) => string): Promise<void> {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await action();
      setNotice({ kind: 'ok', text: done(result) });
      pages.reload();
      categories.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  const createPage = () =>
    run(
      () =>
        apiData<ContentPage>('/platform/content/pages', {
          method: 'POST',
          body: JSON.stringify({
            slug: create.slug.trim(),
            kind: create.kind,
            titleAr: create.titleAr.trim(),
            ...(orNull(create.titleEn) ? { titleEn: orNull(create.titleEn) } : {}),
            ...(orNull(create.summaryAr) ? { summaryAr: orNull(create.summaryAr) } : {}),
            defaultLocale: create.defaultLocale,
            status: 'draft',
          }),
        }),
      (page) => `أُنشئت «${page.titleAr}» مسوّدةً على المسار ${page.path} — انشرها من صفّها.`,
    );

  const openEditor = async (page: ContentPage) => {
    setBusy(true);
    setNotice(undefined);
    try {
      const detail = await apiData<ContentPageDetail>(`/platform/content/pages/${page.id}`);
      setEditor({
        id: page.id,
        note: '',
        draft: {
          titleAr: detail.titleAr,
          titleEn: detail.titleEn ?? '',
          summaryAr: detail.summaryAr ?? '',
          summaryEn: detail.summaryEn ?? '',
          category: detail.category ?? '',
          authorName: detail.authorName ?? '',
          seoTitleAr: detail.seo.titleAr ?? '',
          seoTitleEn: detail.seo.titleEn ?? '',
          seoDescAr: detail.seo.descriptionAr ?? '',
          seoDescEn: detail.seo.descriptionEn ?? '',
          ogImageUrl: detail.seo.ogImageUrl ?? '',
        },
      });
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const saveEditor = () =>
    editor
      ? run(
          () => {
            const draft = editor.draft;
            return apiData<ContentPage>(`/platform/content/pages/${editor.id}`, {
              method: 'PATCH',
              body: JSON.stringify({
                titleAr: (draft.titleAr ?? '').trim(),
                titleEn: orNull(draft.titleEn ?? ''),
                summaryAr: orNull(draft.summaryAr ?? ''),
                summaryEn: orNull(draft.summaryEn ?? ''),
                category: orNull(draft.category ?? ''),
                authorName: orNull(draft.authorName ?? ''),
                seoTitleAr: orNull(draft.seoTitleAr ?? ''),
                seoTitleEn: orNull(draft.seoTitleEn ?? ''),
                seoDescAr: orNull(draft.seoDescAr ?? ''),
                seoDescEn: orNull(draft.seoDescEn ?? ''),
                ogImageUrl: orNull(draft.ogImageUrl ?? ''),
                ...(editor.note.trim().length >= 2 ? { note: editor.note.trim() } : {}),
              }),
            });
          },
          (page) => `حُفظت «${page.titleAr}» — والحالة القائمة محفوظة نسخةً في تاريخ الصفحة.`,
        ).then(() => setEditor(null))
      : Promise.resolve();

  const publish = (page: ContentPage) =>
    run(
      () =>
        apiData<ContentPage>(`/platform/content/pages/${page.id}/publish`, {
          method: 'POST',
          body: JSON.stringify({ note: 'نشرٌ فوريّ من شاشة المحتوى' }),
        }),
      (updated) => `نُشرت «${updated.titleAr}» — نشرها الزوّار الآن على ${updated.path}.`,
    );

  const schedulePage = () =>
    schedule
      ? run(
          () =>
            apiData<ContentPage>(`/platform/content/pages/${schedule.id}/publish`, {
              method: 'POST',
              body: JSON.stringify({ at: toIsoWithOffset(schedule.at), note: 'جدولةٌ من شاشة المحتوى' }),
            }),
          (updated) => `جُدولت «${updated.titleAr}» إلى ${dateTime(updated.publishAt)} — مهمّة الجدولة تنشرها في وقتها.`,
        ).then(() => setSchedule(null))
      : Promise.resolve();

  const retractPage = () =>
    retract
      ? run(
          () =>
            apiData<ContentPage>(`/platform/content/pages/${retract.id}/retract`, {
              method: 'POST',
              body: JSON.stringify({ reason: retract.reason.trim() }),
            }),
          (updated) => `سُحبت «${updated.titleAr}» إلى مسوّدة — اختفت من الموقع وبقي سببها في التاريخ.`,
        ).then(() => setRetract(null))
      : Promise.resolve();

  const loadVersions = async (page: ContentPage) => {
    setBusy(true);
    setNotice(undefined);
    try {
      const rows = await apiData<ContentVersion[]>(`/platform/content/pages/${page.id}/versions`);
      setVersions({ id: page.id, rows });
      setRestoreNote('');
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const restoreVersion = (version: number) =>
    versions
      ? run(
          () =>
            apiData<ContentPageDetail>(`/platform/content/pages/${versions.id}/versions/${version}/restore`, {
              method: 'POST',
              body: JSON.stringify(restoreNote.trim().length >= 2 ? { note: restoreNote.trim() } : {}),
            }),
          (page) => `استُعيدت النسخة ${version} من «${page.titleAr}» — والحالة التي كانت قائمة حُفظت نسخةً قبلها.`,
        ).then(() => setVersions(null))
      : Promise.resolve();

  const rows = pages.data?.data ?? [];
  // اسم المتغيّر تجنّب لفظ المال عمداً: قاعدة eslint تصطاد المعرّفات المسمّاة بمفرداته حتى
  // في العدّ — وهو محقّ، فعدد الصفحات ليس مبلغاً.
  const pageCount = pages.data?.meta.total ?? 0;

  return (
    <div className="grid">
      {notice && <p className={`alert ${notice.kind}`}>{notice.text}</p>}

      <section className="card grid">
        <div className="toolbar">
          <label className="field" style={{ marginBottom: 0 }}>
            <span>النوع</span>
            <select className="input" value={kind} onChange={(event) => setKind(event.target.value as ContentKind | '')}>
              <option value="">كل الأنواع</option>
              {contentKinds.map((value) => (
                <option key={value} value={value}>
                  {KIND_LABEL[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>الحالة</span>
            <select className="input" value={status} onChange={(event) => setStatus(event.target.value as ContentPage['status'] | '')}>
              <option value="">كل الحالات</option>
              {contentStatuses.map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABEL[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>الترتيب</span>
            <select className="input" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
              <option value="updated">آخر تحديث</option>
              <option value="published">آخر نشر</option>
              <option value="title">العنوان</option>
            </select>
          </label>
          <label className="field" style={{ marginBottom: 0, minWidth: '240px' }}>
            <span>بحث</span>
            <input
              className="input"
              value={q}
              placeholder="عنوان أو مسار"
              onChange={(event) => setQ(event.target.value)}
            />
          </label>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            {canManage && (
              <button type="button" className="btn primary" onClick={() => setCreating((value) => !value)}>
                {creating ? 'إغلاق النموذج' : 'صفحة جديدة'}
              </button>
            )}
            <button type="button" className="btn" onClick={pages.reload} disabled={pages.status === 'loading'}>
              تحديث
            </button>
          </div>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          {pageCount} صفحة. تصنيفات المدوّنة المستعملة: {(categories.data?.blog ?? []).join(' · ') || 'لا شيء بعد'} — وتصنيفات
          المساعدة: {(categories.data?.help ?? []).join(' · ') || 'لا شيء بعد'}.
        </p>
      </section>

      {creating && canManage && (
        <section className="card grid">
          <h3 style={{ margin: 0 }}>صفحة جديدة</h3>
          <div className="form-grid">
            <Field label="المسار (slug)" hint="حروف لاتينية صغيرة وأرقام وشرطات">
              <input
                className="input"
                value={create.slug}
                placeholder="about-us"
                onChange={(event) => setCreate({ ...create, slug: event.target.value })}
              />
            </Field>
            <Field label="النوع" hint="يقرّر المسار العام للصفحة">
              <select
                className="input"
                value={create.kind}
                onChange={(event) => setCreate({ ...create, kind: event.target.value as ContentKind })}
              >
                {contentKinds.map((value) => (
                  <option key={value} value={value}>
                    {KIND_LABEL[value]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="العنوان بالعربية">
              <input
                className="input"
                value={create.titleAr}
                onChange={(event) => setCreate({ ...create, titleAr: event.target.value })}
              />
            </Field>
            <Field label="العنوان بالإنجليزية">
              <input
                className="input"
                value={create.titleEn}
                onChange={(event) => setCreate({ ...create, titleEn: event.target.value })}
              />
            </Field>
            <Field label="اللغة الأصلية" hint="الترجمة تُشتقّ من وجود النصّ الإنجليزي">
              <select
                className="input"
                value={create.defaultLocale}
                onChange={(event) => setCreate({ ...create, defaultLocale: event.target.value as 'ar' | 'en' })}
              >
                <option value="ar">العربية</option>
                <option value="en">English</option>
              </select>
            </Field>
          </div>
          <Field label="الملخّص بالعربية">
            <textarea
              className="input"
              rows={2}
              value={create.summaryAr}
              onChange={(event) => setCreate({ ...create, summaryAr: event.target.value })}
            />
          </Field>
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={busy || create.slug.trim().length < 2 || create.titleAr.trim().length < 2}
              onClick={() => {
                void createPage().then(() => {
                  setCreating(false);
                  setCreate({ slug: '', kind: 'page', titleAr: '', titleEn: '', summaryAr: '', defaultLocale: 'ar' });
                });
              }}
            >
              أنشئ مسوّدة
            </button>
            <span className="muted small">تُنشأ مسوّدةً دائماً — النشر قرارٌ ثانٍ لا أثرٌ جانبيّ للإنشاء.</span>
          </div>
        </section>
      )}

      {pages.status === 'loading' && <Loading rows={5} />}
      {pages.status === 'forbidden' && <Forbidden />}
      {pages.status === 'error' && <ErrorBox message={pages.error} onRetry={pages.reload} />}
      {pages.status === 'success' && rows.length === 0 && (
        <Empty title="لا صفحات بعد" detail="أنشئ أول صفحة، أو غيّر المرشّحات." />
      )}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>العنوان</th>
                <th>النوع</th>
                <th>الحالة</th>
                <th>المسار</th>
                <th>اللغات</th>
                <th>الكتل</th>
                <th>آخر تحديث</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((page) => (
                <tr key={page.id}>
                  <td>
                    <strong>{page.titleAr}</strong>
                    {page.titleEn ? <div className="muted small">{page.titleEn}</div> : null}
                  </td>
                  <td>{KIND_LABEL[page.kind]}</td>
                  <td>
                    <span className={`badge ${page.status}`}>{STATUS_LABEL[page.status]}</span>
                    {page.status === 'scheduled' && page.publishAt ? (
                      <div className="muted small">تنشر {dateTime(page.publishAt)}</div>
                    ) : null}
                  </td>
                  <td className="small">
                    <code>{page.path}</code>
                  </td>
                  <td className="small">{page.translatedLocales.map((locale) => (locale === 'ar' ? 'ع' : 'EN')).join(' · ')}</td>
                  <td>{page.blockCount}</td>
                  <td className="small">{dateTime(page.updatedAt)}</td>
                  <td>
                    <div className="row">
                      <button type="button" className="btn sm" onClick={() => void openEditor(page)} disabled={busy}>
                        تحرير
                      </button>
                      <button type="button" className="btn sm" onClick={() => void loadVersions(page)} disabled={busy}>
                        النسخ
                      </button>
                      {canManage && page.status !== 'published' && (
                        <button type="button" className="btn sm primary" onClick={() => void publish(page)} disabled={busy}>
                          نشر
                        </button>
                      )}
                      {canManage && page.status !== 'published' && (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => setSchedule({ id: page.id, at: '' })}
                          disabled={busy}
                        >
                          جدولة
                        </button>
                      )}
                      {canManage && page.status === 'published' && (
                        <button
                          type="button"
                          className="btn sm danger"
                          onClick={() => setRetract({ id: page.id, reason: '' })}
                          disabled={busy}
                        >
                          سحب
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editor && (
        <section className="card grid">
          <h3 style={{ margin: 0 }}>تحرير الصفحة</h3>
          <div className="form-grid">
            {EDITOR_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <input
                  className="input"
                  value={editor.draft[field.key] ?? ''}
                  onChange={(event) =>
                    setEditor({ ...editor, draft: { ...editor.draft, [field.key]: event.target.value } })
                  }
                />
              </Field>
            ))}
          </div>
          <Field label="ملاحظة النسخة" hint="تُحفظ معها في تاريخ الصفحة">
            <input
              className="input"
              value={editor.note}
              onChange={(event) => setEditor({ ...editor, note: event.target.value })}
            />
          </Field>
          <div className="row">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void saveEditor()}>
              احفظ
            </button>
            <button type="button" className="btn" onClick={() => setEditor(null)}>
              إلغاء
            </button>
            <span className="muted small">
              الحفظ يرفع نسخةً من الحالة القائمة — فيصير في التاريخ نقطةٌ تُسترجع، لا تعديلٌ يمحو ما قبله.
            </span>
          </div>
        </section>
      )}

      {schedule && (
        <section className="card grid">
          <h3 style={{ margin: 0 }}>جدولة النشر</h3>
          <Field label="وقت النشر" hint="بتوقيت المتصفّح، ويُرسل بإزاحته الزمنية">
            <input
              className="input"
              type="datetime-local"
              value={schedule.at}
              onChange={(event) => setSchedule({ ...schedule, at: event.target.value })}
            />
          </Field>
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={busy || schedule.at.length === 0}
              onClick={() => void schedulePage()}
            >
              جدول
            </button>
            <button type="button" className="btn" onClick={() => setSchedule(null)}>
              إلغاء
            </button>
            <span className="muted small">الوقت الماضي مرفوض: النشر الفوري زرّه الآخر.</span>
          </div>
        </section>
      )}

      {retract && (
        <section className="card grid">
          <h3 style={{ margin: 0 }}>سحبٌ من النشر</h3>
          <Field label="سبب السحب" hint="ثلاثة أحرف على الأقل — يُحفظ في التاريخ">
            <input
              className="input"
              value={retract.reason}
              onChange={(event) => setRetract({ ...retract, reason: event.target.value })}
            />
          </Field>
          <div className="row">
            <button
              type="button"
              className="btn danger"
              disabled={busy || retract.reason.trim().length < 3}
              onClick={() => void retractPage()}
            >
              اسحب إلى مسوّدة
            </button>
            <button type="button" className="btn" onClick={() => setRetract(null)}>
              إلغاء
            </button>
          </div>
        </section>
      )}

      {versions && (
        <section className="card grid">
          <h3 style={{ margin: 0 }}>تاريخ الصفحة — {versions.rows.length} نسخة</h3>
          {versions.rows.length === 0 ? (
            <Empty title="لا نسخ بعد" detail="تُحفظ نسخةٌ عند كل تعديل أو نشر أو استعادة." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>النسخة</th>
                    <th>العنوان</th>
                    <th>الحالة</th>
                    <th>الكتل</th>
                    <th>ملاحظة</th>
                    <th>التاريخ</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {versions.rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.version}</td>
                      <td>{row.titleAr}</td>
                      <td>
                        <span className={`badge ${row.pageStatus}`}>{STATUS_LABEL[row.pageStatus]}</span>
                      </td>
                      <td>{row.blockCount}</td>
                      <td className="small">{row.note ?? '—'}</td>
                      <td className="small">{dateTime(row.createdAt)}</td>
                      <td>
                        {canManage && (
                          <button
                            type="button"
                            className="btn sm"
                            disabled={busy}
                            onClick={() => void restoreVersion(row.version)}
                          >
                            استعادة
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row">
            <Field label="ملاحظة الاستعادة">
              <input className="input" value={restoreNote} onChange={(event) => setRestoreNote(event.target.value)} />
            </Field>
            <button type="button" className="btn" onClick={() => setVersions(null)} style={{ alignSelf: 'flex-end' }}>
              إغلاق
            </button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            الاستعادة نفسها لا تُمحى: تُحفظ الحالة القائمة نسخةً قبلها.
          </p>
        </section>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── ٢) الكتل

type BlockDraft = { kind: ContentBlockKind; ar: string; en: string };

/** رقّم الكتل من الصفر بالترتيب المعروض — الترتيب هو ما يراه الزائر. */
function toBlocksInput(drafts: BlockDraft[], content: (draft: BlockDraft, locale: 'ar' | 'en') => string): ContentBlockInput[] {
  const blocks: ContentBlockInput[] = [];
  drafts.forEach((draft, index) => {
    const payloads: Record<string, unknown> = {};
    for (const locale of ['ar', 'en'] as const) {
      const text = content(draft, locale).trim();
      if (text.length === 0) continue;
      payloads[locale] = JSON.parse(text) as unknown;
    }
    blocks.push({
      position: index,
      kind: draft.kind,
      content: { ar: payloads.ar, ...(payloads.en !== undefined ? { en: payloads.en } : {}) },
    });
  });
  return blocks;
}

function validatePayload(kind: ContentBlockKind, text: string, locale: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    return `${locale}: JSON غير صالح — ${error instanceof Error ? error.message : String(error)}`;
  }
  const schema = contentBlockPayloadSchemas[kind];
  const result = schema.safeParse(parsed);
  if (result.success) return undefined;
  const issue = result.error.issues[0];
  return `${locale}: ${issue?.path.join('.') || '—'} — ${issue?.message ?? 'حمولة غير صحيحة'}`;
}

function BlocksTab() {
  const { canConsole } = useSession();
  const canManage = canConsole('console.content.manage');

  const [pageId, setPageId] = useState('');
  const [page, setPage] = useState<ContentPageDetail | null>(null);
  const [drafts, setDrafts] = useState<BlockDraft[]>([]);
  const [newKind, setNewKind] = useState<ContentBlockKind>('text');
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const pages = useQuery<ListEnvelope<ContentPage>>(
    () => apiFetch<ListEnvelope<ContentPage>>('/platform/content/pages?limit=100&sort=updated'),
    [],
  );

  async function load(id: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      const detail = await apiData<ContentPageDetail>(`/platform/content/pages/${id}`);
      setPage(detail);
      setDrafts(
        detail.blocks.map((block) => ({
          kind: block.kind,
          ar: JSON.stringify(block.content.ar, null, 2),
          en: block.content.en === null || block.content.en === undefined ? '' : JSON.stringify(block.content.en, null, 2),
        })),
      );
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  const errors = drafts.map((draft) =>
    [validatePayload(draft.kind, draft.ar, 'العربية'), validatePayload(draft.kind, draft.en, 'الإنجليزية')].filter(
      (value): value is string => value !== undefined,
    ),
  );
  const hasErrors = errors.some((list) => list.length > 0);

  async function save() {
    if (!page) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const updated = await apiData<ContentPageDetail>(`/platform/content/pages/${page.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          blocks: toBlocksInput(drafts, (draft, locale) => (locale === 'ar' ? draft.ar : draft.en)),
          ...(note.trim().length >= 2 ? { note: note.trim() } : {}),
        }),
      });
      setPage(updated);
      setDrafts(
        updated.blocks.map((block) => ({
          kind: block.kind,
          ar: JSON.stringify(block.content.ar, null, 2),
          en: block.content.en === null || block.content.en === undefined ? '' : JSON.stringify(block.content.en, null, 2),
        })),
      );
      setNotice({
        kind: 'ok',
        text: `حُفظت ${updated.blocks.length} كتلة على «${updated.titleAr}». الكتل المرسلة هي البديل الكامل — ما حُذف من هنا حُذف من الصفحة.`,
      });
      pages.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= drafts.length) return;
    const next = [...drafts];
    const [row] = next.splice(index, 1);
    if (!row) return;
    next.splice(target, 0, row);
    setDrafts(next);
  }

  function change(index: number, patch: Partial<BlockDraft>) {
    setDrafts(drafts.map((draft, position) => (position === index ? { ...draft, ...patch } : draft)));
  }

  const selected = (pages.data?.data ?? []).find((row) => row.id === pageId);

  return (
    <div className="grid">
      {notice && <p className={`alert ${notice.kind}`}>{notice.text}</p>}

      <section className="card grid">
        <div className="toolbar">
          <Field label="الصفحة">
            <select
              className="input"
              value={pageId}
              onChange={(event) => {
                setPageId(event.target.value);
                setPage(null);
                setDrafts([]);
                if (event.target.value) void load(event.target.value);
              }}
            >
              <option value="">اختر صفحة…</option>
              {(pages.data?.data ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {KIND_LABEL[row.kind]} · {row.titleAr} ({row.blockCount} كتلة)
                </option>
              ))}
            </select>
          </Field>
          {selected ? (
            <p className="muted small" style={{ alignSelf: 'flex-end', margin: 0 }}>
              المسار العام <code>{selected.path}</code> · الحالة{' '}
              <span className={`badge ${selected.status}`}>{STATUS_LABEL[selected.status]}</span>
            </p>
          ) : null}
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          الأحد عشر نوعاً هي ما يفهمه الموقع: {contentBlockKinds.map((kind) => BLOCK_LABEL[kind]).join(' · ')}. ولا HTML
          حرّاً — لأن التصميم يُبنى من هذه الكتل لا من وسومٍ يكتبها المحرّر.
        </p>
      </section>

      {pages.status === 'forbidden' && <Forbidden />}
      {pages.status === 'error' && <ErrorBox message={pages.error} onRetry={pages.reload} />}
      {busy && drafts.length === 0 && <Loading rows={3} />}

      {page && (
        <>
          {drafts.length === 0 && <Empty title="لا كتل في هذه الصفحة" detail="أضف أول كتلة من الأسفل." />}

          {drafts.map((draft, index) => (
            <section className="card grid" key={`${index}-${draft.kind}`}>
              <div className="section-title">
                <h3 style={{ margin: 0 }}>
                  {index + 1}. {BLOCK_LABEL[draft.kind]}
                  {errors[index]?.length ? <span className="badge failed"> تحتاج مراجعة</span> : null}
                </h3>
                <div className="row">
                  <select
                    className="input"
                    value={draft.kind}
                    onChange={(event) => change(index, { kind: event.target.value as ContentBlockKind })}
                  >
                    {contentBlockKinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {BLOCK_LABEL[kind]}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn sm" onClick={() => move(index, -1)} disabled={index === 0}>
                    ▲
                  </button>
                  <button type="button" className="btn sm" onClick={() => move(index, 1)} disabled={index === drafts.length - 1}>
                    ▼
                  </button>
                  <button
                    type="button"
                    className="btn sm danger"
                    onClick={() => setDrafts(drafts.filter((_, position) => position !== index))}
                  >
                    حذف
                  </button>
                </div>
              </div>
              <div className="grid cols-2">
                <Field label="الحمولة بالعربية">
                  <textarea
                    className="input code"
                    rows={8}
                    value={draft.ar}
                    onChange={(event) => change(index, { ar: event.target.value })}
                  />
                </Field>
                <Field label="الحمولة بالإنجليزية" hint="فارغة = بلا ترجمة">
                  <textarea
                    className="input code"
                    rows={8}
                    value={draft.en}
                    onChange={(event) => change(index, { en: event.target.value })}
                  />
                </Field>
              </div>
              {errors[index]?.length ? (
                <p className="alert danger" style={{ margin: 0 }}>
                  {errors[index]?.join(' · ')}
                </p>
              ) : (
                <p className="muted small" style={{ margin: 0 }}>
                  الحمولة تُطابق مخطّط النوع «{BLOCK_LABEL[draft.kind]}» — والـAPI سيقبلها كما هي.
                </p>
              )}
            </section>
          ))}

          <section className="card grid">
            <div className="section-title">
              <h3 style={{ margin: 0 }}>إضافة كتلة</h3>
              <div className="row">
                <select
                  className="input"
                  value={newKind}
                  onChange={(event) => setNewKind(event.target.value as ContentBlockKind)}
                >
                  {contentBlockKinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {BLOCK_LABEL[kind]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setDrafts([
                      ...drafts,
                      {
                        kind: newKind,
                        ar: JSON.stringify(BLOCK_TEMPLATE[newKind], null, 2),
                        en: '',
                      },
                    ])
                  }
                >
                  أضف
                </button>
              </div>
            </div>
            <Field label="ملاحظة النسخة">
              <input className="input" value={note} onChange={(event) => setNote(event.target.value)} />
            </Field>
            <div className="row">
              <button
                type="button"
                className="btn primary"
                disabled={!canManage || busy || hasErrors}
                onClick={() => void save()}
              >
                احفظ الكتل
              </button>
              <button type="button" className="btn" onClick={() => void load(page.id)} disabled={busy}>
                أعِد التحميل
              </button>
              {!canManage && <span className="muted small">القراءة متاحة، والحفظ يحتاج `console.content.manage`.</span>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── ٣) القوائم

function MenusTab() {
  const { canConsole } = useSession();
  const canManage = canConsole('console.content.manage');

  const [edits, setEdits] = useState<Partial<Record<ContentMenuPosition, ContentMenuItem[]>>>({});
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const menus = useQuery<ContentMenu[]>(() => apiData<ContentMenu[]>('/platform/content/menus'), []);
  const byPosition = new Map((menus.data ?? []).map((menu) => [menu.position, menu]));

  function itemsOf(position: ContentMenuPosition): ContentMenuItem[] {
    return edits[position] ?? byPosition.get(position)?.items ?? [];
  }

  function setItems(position: ContentMenuPosition, items: ContentMenuItem[]) {
    setEdits({ ...edits, [position]: items });
  }

  async function save(position: ContentMenuPosition) {
    setBusy(true);
    setNotice(undefined);
    try {
      await apiData<ContentMenu>(`/platform/content/menus/${position}`, {
        method: 'PUT',
        body: JSON.stringify({ items: itemsOf(position) }),
      });
      setEdits({ ...edits, [position]: undefined });
      setNotice({ kind: 'ok', text: `حُفظت قائمة «${MENU_LABEL[position]}» — الترتيب المعروض هو الترتيب في الموقع.` });
      menus.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  if (menus.status === 'loading') return <Loading rows={5} />;
  if (menus.status === 'forbidden') return <Forbidden />;
  if (menus.status === 'error') return <ErrorBox message={menus.error} onRetry={menus.reload} />;

  return (
    <div className="grid">
      {notice && <p className={`alert ${notice.kind}`}>{notice.text}</p>}
      {contentMenuPositions.map((position) => {
        const items = itemsOf(position);
        const dirty = edits[position] !== undefined;
        return (
          <section className="card grid" key={position}>
            <div className="section-title">
              <h3 style={{ margin: 0 }}>
                {MENU_LABEL[position]} <span className="muted small">({items.length} عنصراً)</span>
                {dirty ? <span className="badge draft"> تغييرات غير محفوظة</span> : null}
              </h3>
              <div className="row">
                {canManage && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() =>
                      setItems(position, [
                        ...items,
                        { key: `item-${items.length + 1}`, href: '/', labelAr: 'عنصر جديد', labelEn: null },
                      ])
                    }
                  >
                    أضف عنصراً
                  </button>
                )}
                {canManage && dirty && (
                  <button type="button" className="btn sm primary" disabled={busy} onClick={() => void save(position)}>
                    احفظ
                  </button>
                )}
                {canManage && dirty && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => setEdits({ ...edits, [position]: undefined })}
                  >
                    تراجع
                  </button>
                )}
              </div>
            </div>

            {items.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                لا عناصر — القائمة تُبنى من الموقع الافتراضي حين تكون فارغة.
              </p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>المفتاح</th>
                      <th>الرابط</th>
                      <th>التسمية بالعربية</th>
                      <th>بالإنجليزية</th>
                      <th>وسم</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row, index) => (
                      <tr key={`${position}-${index}`}>
                        <td>
                          <input
                            className="input"
                            value={row.key}
                            onChange={(event) => {
                              const next = [...items];
                              next[index] = { ...row, key: event.target.value };
                              setItems(position, next);
                            }}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            value={row.href}
                            onChange={(event) => {
                              const next = [...items];
                              next[index] = { ...row, href: event.target.value };
                              setItems(position, next);
                            }}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            value={row.labelAr}
                            onChange={(event) => {
                              const next = [...items];
                              next[index] = { ...row, labelAr: event.target.value };
                              setItems(position, next);
                            }}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            value={row.labelEn ?? ''}
                            onChange={(event) => {
                              const next = [...items];
                              next[index] = { ...row, labelEn: orNull(event.target.value) };
                              setItems(position, next);
                            }}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            value={row.badgeAr ?? ''}
                            placeholder="جديد"
                            onChange={(event) => {
                              const next = [...items];
                              next[index] = { ...row, badgeAr: orNull(event.target.value) };
                              setItems(position, next);
                            }}
                          />
                        </td>
                        <td>
                          <div className="row">
                            <button
                              type="button"
                              className="btn sm"
                              disabled={index === 0}
                              onClick={() => {
                                const next = [...items];
                                const [moved] = next.splice(index, 1);
                                if (moved) next.splice(index - 1, 0, moved);
                                setItems(position, next);
                              }}
                            >
                              ▲
                            </button>
                            <button
                              type="button"
                              className="btn sm"
                              disabled={index === items.length - 1}
                              onClick={() => {
                                const next = [...items];
                                const [moved] = next.splice(index, 1);
                                if (moved) next.splice(index + 1, 0, moved);
                                setItems(position, next);
                              }}
                            >
                              ▼
                            </button>
                            <button
                              type="button"
                              className="btn sm danger"
                              onClick={() => setItems(position, items.filter((_, at) => at !== index))}
                            >
                              حذف
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small" style={{ margin: 0 }}>
              آخر تحديث: {dateTime(byPosition.get(position)?.updatedAt)} — الرابط يبدأ بـ`/` أو `https://` أو `mailto:`
              أو `tel:`.
            </p>
          </section>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── ٤) اللافتات

function BannersTab() {
  const { canConsole } = useSession();
  const canManage = canConsole('console.content.manage');

  const [draft, setDraft] = useState({
    textAr: '',
    textEn: '',
    href: '',
    linkLabelAr: '',
    tone: 'info' as ContentBannerTone,
    audience: 'all' as ContentBannerAudience,
    startsAt: '',
    endsAt: '',
  });
  const [editing, setEditing] = useState<{ id: string; textAr: string; textEn: string; href: string } | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger'; text: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const banners = useQuery<ContentBanner[]>(() => apiData<ContentBanner[]>('/platform/content/banners'), []);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
      setNotice({ kind: 'ok', text: done });
      banners.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: apiMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  const createBanner = () =>
    run(
      () =>
        apiData<ContentBanner>('/platform/content/banners', {
          method: 'POST',
          body: JSON.stringify({
            textAr: draft.textAr.trim(),
            ...(orNull(draft.textEn) ? { textEn: orNull(draft.textEn) } : {}),
            ...(orNull(draft.href) ? { href: orNull(draft.href) } : {}),
            ...(orNull(draft.linkLabelAr) ? { linkLabelAr: orNull(draft.linkLabelAr) } : {}),
            tone: draft.tone,
            audience: draft.audience,
            ...(draft.startsAt ? { startsAt: toIsoWithOffset(draft.startsAt) } : {}),
            ...(draft.endsAt ? { endsAt: toIsoWithOffset(draft.endsAt) } : {}),
            active: true,
          }),
        }),
      'أُنشئت اللافتة — إن كانت داخل نافذتها فهي معروضة الآن على الموقع.',
    ).then(() =>
      setDraft({
        textAr: '',
        textEn: '',
        href: '',
        linkLabelAr: '',
        tone: 'info',
        audience: 'all',
        startsAt: '',
        endsAt: '',
      }),
    );

  if (banners.status === 'loading') return <Loading rows={4} />;
  if (banners.status === 'forbidden') return <Forbidden />;
  if (banners.status === 'error') return <ErrorBox message={banners.error} onRetry={banners.reload} />;

  const rows = banners.data ?? [];

  return (
    <div className="grid">
      {notice && <p className={`alert ${notice.kind}`}>{notice.text}</p>}

      <section className="card grid">
        <h3 style={{ margin: 0 }}>قواعد اللافتة</h3>
        <p className="muted small" style={{ margin: 0 }}>
          اللافتة تظهر على الموقع إذا كانت **نشطة** و**داخل نافذتها** و**جمهورها يطابق** الزائر. ووسم «معروضة» يأتي
          من الخدمة لا من هذه الشاشة — فالشاشة لا تدّعي عرضاً لم يقع.
        </p>
      </section>

      {canManage && (
        <section className="card grid">
          <h3 style={{ margin: 0 }}>لافتة جديدة</h3>
          <div className="form-grid">
            <Field label="النصّ بالعربية">
              <input
                className="input"
                value={draft.textAr}
                onChange={(event) => setDraft({ ...draft, textAr: event.target.value })}
              />
            </Field>
            <Field label="النصّ بالإنجليزية">
              <input
                className="input"
                value={draft.textEn}
                onChange={(event) => setDraft({ ...draft, textEn: event.target.value })}
              />
            </Field>
            <Field label="الرابط">
              <input
                className="input"
                value={draft.href}
                placeholder="/pricing"
                onChange={(event) => setDraft({ ...draft, href: event.target.value })}
              />
            </Field>
            <Field label="نصّ الرابط">
              <input
                className="input"
                value={draft.linkLabelAr}
                placeholder="اعرف المزيد"
                onChange={(event) => setDraft({ ...draft, linkLabelAr: event.target.value })}
              />
            </Field>
            <Field label="اللون">
              <select
                className="input"
                value={draft.tone}
                onChange={(event) => setDraft({ ...draft, tone: event.target.value as ContentBannerTone })}
              >
                {(Object.keys(TONE_LABEL) as ContentBannerTone[]).map((tone) => (
                  <option key={tone} value={tone}>
                    {TONE_LABEL[tone]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="الجمهور">
              <select
                className="input"
                value={draft.audience}
                onChange={(event) => setDraft({ ...draft, audience: event.target.value as ContentBannerAudience })}
              >
                {(Object.keys(AUDIENCE_LABEL) as ContentBannerAudience[]).map((audience) => (
                  <option key={audience} value={audience}>
                    {AUDIENCE_LABEL[audience]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="تبدأ" hint="اتركه فارغاً = الآن">
              <input
                className="input"
                type="datetime-local"
                value={draft.startsAt}
                onChange={(event) => setDraft({ ...draft, startsAt: event.target.value })}
              />
            </Field>
            <Field label="تنتهي" hint="اتركه فارغاً = بلا نهاية">
              <input
                className="input"
                type="datetime-local"
                value={draft.endsAt}
                onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })}
              />
            </Field>
          </div>
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={busy || draft.textAr.trim().length < 3}
              onClick={() => void createBanner()}
            >
              أنشئ لافتة
            </button>
          </div>
        </section>
      )}

      {rows.length === 0 ? (
        <Empty title="لا لافتات" detail="لا شيء معروض أعلى الموقع الآن." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>النصّ</th>
                <th>اللون</th>
                <th>الجمهور</th>
                <th>النافذة</th>
                <th>الحالة</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.textAr}</strong>
                    {row.textEn ? <div className="muted small">{row.textEn}</div> : null}
                    {row.href ? (
                      <div className="small">
                        <code>{row.href}</code> — {row.linkLabelAr ?? row.linkLabelEn ?? 'بلا نصّ رابط'}
                      </div>
                    ) : null}
                  </td>
                  <td>{TONE_LABEL[row.tone]}</td>
                  <td>{AUDIENCE_LABEL[row.audience]}</td>
                  <td className="small">
                    {dateTime(row.startsAt)} ← {row.endsAt ? dateTime(row.endsAt) : 'بلا نهاية'}
                  </td>
                  <td>
                    <span className={`badge ${row.live ? 'ok' : row.active ? 'draft' : 'archived'}`}>
                      {row.live ? 'معروضة الآن' : row.active ? 'نشطة، خارج نافذتها' : 'موقوفة'}
                    </span>
                  </td>
                  <td>
                    <div className="row">
                      {canManage && (
                        <button
                          type="button"
                          className="btn sm"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () =>
                                apiData<ContentBanner>(`/platform/content/banners/${row.id}`, {
                                  method: 'PATCH',
                                  body: JSON.stringify({ active: !row.active }),
                                }),
                              row.active ? 'أُوقفت اللافتة — اختفت من الموقع فوراً.' : 'فُعّلت اللافتة.',
                            )
                          }
                        >
                          {row.active ? 'أوقف' : 'فعّل'}
                        </button>
                      )}
                      {canManage && (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() =>
                            setEditing({ id: row.id, textAr: row.textAr, textEn: row.textEn ?? '', href: row.href ?? '' })
                          }
                        >
                          تحرير
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <section className="card grid">
          <h3 style={{ margin: 0 }}>تحرير اللافتة</h3>
          <div className="form-grid">
            <Field label="النصّ بالعربية">
              <input
                className="input"
                value={editing.textAr}
                onChange={(event) => setEditing({ ...editing, textAr: event.target.value })}
              />
            </Field>
            <Field label="النصّ بالإنجليزية">
              <input
                className="input"
                value={editing.textEn}
                onChange={(event) => setEditing({ ...editing, textEn: event.target.value })}
              />
            </Field>
            <Field label="الرابط">
              <input
                className="input"
                value={editing.href}
                onChange={(event) => setEditing({ ...editing, href: event.target.value })}
              />
            </Field>
          </div>
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={busy || editing.textAr.trim().length < 3}
              onClick={() =>
                void run(
                  () =>
                    apiData<ContentBanner>(`/platform/content/banners/${editing.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({
                        textAr: editing.textAr.trim(),
                        textEn: orNull(editing.textEn),
                        href: orNull(editing.href),
                      }),
                    }),
                  'حُفظت اللافتة — والمحرّك يعرض نصّها الجديد في الطلب التالي.',
                ).then(() => setEditing(null))
              }
            >
              احفظ
            </button>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              إلغاء
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
