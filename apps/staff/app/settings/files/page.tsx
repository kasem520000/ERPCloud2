'use client';

import { useRef, useState } from 'react';

import { DataTable, Notice, QueryView } from '../../../components/data-view';
import { Screen } from '../../../components/screen';
import { StatTile, StatTiles } from '../../../components/ui';
import { ApiError, apiDelete, apiData, apiFetch, apiPost } from '../../../lib/api';
import { useQuery } from '../../../lib/use-query';
import { useSession } from '../../../lib/session';

/**
 * 📄 مدير الملفات — R7 (`docs/roadmap/INCOMPLETE_INVENTORY.md` §7-1: «مدير ملفات في staff
 * (الخلفية جاهزة)»).
 *
 * الخلفية كانت قائمةً وحدها: `POST /files/presign` → رفعٌ مباشر إلى التخزين الكائني →
 * `POST /files/{id}/finalize` → `GET /files/{id}/download`. ولم يكن في المستودع سطحٌ
 * يقرأ المخزن نفسه؛ فملفٌّ يُرفع من شاشةٍ لا يُعرف مصيره بعدها: لا قائمة، ولا بحث، ولا
 * حذف. هذه الشاشة هي ذلك السطح.
 *
 * **مقابلها في الديسكتوب** `frmshowdocument.xaml` — نافذة «الوثائق» («📄 الوثائق المرفقة»،
 * :66) التي تُفتح من كل مستندٍ وبطاقة (`frmInvSale.xaml.cs:3068` · `frmInvPurch.xaml.cs:2609`
 * · `frmCustomers.xaml.cs:1714`) وتعرض مرفقات **ذلك** المستند وحده، وصفوفها «م» و«📄 اسم
 * الملف» وخانةُ «موقع الملف» مخفيّة، وعمود «🗑️ حذف» يقول «هل أنت متأكد من الحذف؟» ثم «تم
 * الحذف بنجاح» (:135 · :93 · :110). والتسميات المنقولة بحروفها موضوعةٌ في مواضعها هنا.
 *
 * **والفارق مقصود ومُعلَن**: الديسكتوب يخزّن الملفات على قرص الجهاز داخل مجلد المستند،
 * والسحابة تخزّن الكائنات في مساحة المنشأة كلها بمفاتيح `tenants/{tenantId}/…`. فلا معنى
 * لشاشةٍ «مرفقات مستند» بلا مستند؛ فالشاشة تعرض المخزن كله، ومعها مرشّح **مرتبط بـ** يردّ
 * إليك قراءة المستند الواحد التي تعطيها النافذة المكتبية.
 *
 * **ودورة الرفع تُقال كما هي**: البايتات لا تمرّ بالـAPI أبداً — الخادم يسلّم رابطاً موقّعاً
 * (‏`FILES_ALLOWED_MIME_TYPES` و`FILES_MAX_UPLOAD_BYTES` هما الحاكمان) والملفّ يُدفع من
 * المتصفّح إلى التخزين مباشرةً، ثم يُثبَّت الصفّ بـ`finalize`. ولذلك إن لم يكن التخزين
 * مُهيّأً أو لم يكن الخادم واصلَه شيء، فالإخفاق يقع في المتصفّح لا في الـAPI — والشاشة
 * تفصل بين الحالتين وتسمّي كلًّا منهما باسمها.
 */

type FileStatus = 'pending' | 'ready' | 'deleted';

type FileRow = {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  bucket: string;
  objectKey: string;
  checksum: string | null;
  status: FileStatus;
  entity: string | null;
  entityId: string | null;
  uploadedBy: string | null;
  createdAt: string;
};

type FilePage = { data: FileRow[]; meta: { total: number; limit: number; offset: number } };

type Presign = {
  fileId: string;
  uploadUrl: string;
  objectKey: string;
  requiredHeaders: Record<string, string>;
  expiresAt: string;
};

/** `frmshowdocument.xaml:66` — عنوان النافذة المكتبية، وهو عنوان البطاقة هنا. */
const CARD_TITLE = '📄 الوثائق المرفقة';

/**
 * «م» (`frmshowdocument.xaml:99`) · «📄 اسم الملف» (:115) · «🗑️ حذف» (:135) — بحروفها.
 * والباقي أوصافٌ لازمة لهذا المخزن (الحالة والحجم والمستند المرتبط) وليست في النافذة
 * المكتبية؛ مذكورةٌ في «ما اخترعناه» بوثيقة المرحلة.
 */
const STATUS_LABEL: Record<FileStatus, string> = {
  pending: 'بانتظار الرفع',
  ready: 'جاهز',
  deleted: 'محذوف',
};

/** أصناف الوسم في `globals.css` (`.badge.ready` · `.badge.pending` · `.badge.failed`). */
const STATUS_BADGE: Record<FileStatus, string> = {
  pending: 'pending',
  ready: 'ready',
  deleted: 'failed',
};

/**
 * المستندات التي تقبل مرفقات في هذا المستودع اليوم. المصدر ليس هذه القائمة بل سجلّ
 * `FileAttachmentRegistry` في الـAPI: كل مستندٍ يُسجّل مُتحقِّقاً يفحص أن الصفّ موجود في
 * المنشأة، وغير المسجَّل يُرفض بـ422. والقائمة هنا **عرضٌ** لتلك المسجَّلة — `company_profile`
 * هي الأولى والوحيدة حتى الآن، ومَن أضاف مُتحقِّقاً يضيف اسمه هنا ليظهر المرشّح.
 */
const ENTITY_LABEL: Record<string, string> = {
  company_profile: 'شعار المنشأة',
};

const PAGE_SIZE = 25;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ك.ب`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} م.ب`;
}

function dateTime(value: string): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** «خطأ في الحذف: » (`frmshowdocument.xaml.cs:114`) — النصّ كما هو، والسبب يُلحق به. */
const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export default function FilesPage() {
  const session = useSession();
  const [status, setStatus] = useState('');
  const [entity, setEntity] = useState('');
  const [term, setTerm] = useState('');
  const [offset, setOffset] = useState(0);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'danger' | 'info' | 'warn'; text: string }>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const canUpload = session.can('tenant.file.upload');
  const canManage = session.can('tenant.file.manage');

  /**
   * `apiFetch` لا `apiData`: الغلاف `{ data, meta }` هو ما يحمل `meta.total`، و`apiData`
   * تُسقطه. والعدّاد الكلي في بطاقة الإحصاء يأتي من `meta` نفسه — لا من عدّ الصفحة.
   */
  const files = useQuery<FilePage>(() => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (status) params.set('filter[status]', status);
    if (entity) params.set('filter[entity]', entity);
    if (term.trim()) params.set('q', term.trim());
    return apiFetch<FilePage>(`/files?${params.toString()}`);
  }, [status, entity, term, offset]);

  /** الأعداد الثلاثة من `meta.total` لكل حالة، بطلبٍ واحد الصفّ لكل منها. */
  const counts = useQuery<Record<string, number>>(async () => {
    const [all, ready, pending] = await Promise.all([
      apiFetch<FilePage>('/files?limit=1'),
      apiFetch<FilePage>('/files?limit=1&filter[status]=ready'),
      apiFetch<FilePage>('/files?limit=1&filter[status]=pending'),
    ]);
    return {
      all: all.meta.total,
      ready: ready.meta.total,
      pending: pending.meta.total,
    };
  }, []);

  /** عدد الصفوف المطابقة للفلاتر في القاعدة (من `meta.total`) — يُقرأ للعرض وللتنقّل. */
  const matchCount = files.data?.meta.total ?? 0;

  /** ⬇️ تنزيل — رابطٌ موقّع قصير العمر يُفتح في تبويبٍ جديد (`GET /files/{id}/download`). */
  async function download(row: FileRow) {
    setNotice(undefined);
    setBusyId(row.id);
    try {
      const link = await apiData<{ url: string; expiresAt: string }>(`/files/${row.id}/download`);
      const absolute = `${window.location.origin}${link.url}`;
      const opened = window.open(absolute, '_blank', 'noopener');
      setNotice({
        kind: opened ? 'ok' : 'warn',
        text: opened
          ? `فُتح رابطُ «${row.name}» الموقّع — ينتهي في ${dateTime(link.expiresAt)}.`
          : `المتصفّح منع فتح نافذة التنزيل. الرابط: ${absolute}`,
      });
    } catch (error) {
      setNotice({ kind: 'danger', text: failure(error) });
    } finally {
      setBusyId(null);
    }
  }

  /** 🗑️ حذف — بنصّ التأكيد المكتبيّ نفسه (`frmshowdocument.xaml.cs:93`). */
  async function remove(row: FileRow) {
    if (!window.confirm('هل أنت متأكد من الحذف؟')) return;
    setBusyId(row.id);
    setNotice(undefined);
    try {
      const result = await apiDelete<{ objectRemoved: boolean }>(`/files/${row.id}`);
      setNotice({
        kind: result?.objectRemoved === false ? 'warn' : 'ok',
        // «تم الحذف بنجاح» (:110) — ومعها الحقيقة كاملةً: هل ذهبت البايتات أم بقي الصفّ
        // وحده. الشاشة لا تقول «حُذف الملف» إذا كان المخزنُ لم يستجب.
        text:
          result?.objectRemoved === false
            ? `تم الحذف بنجاح من السجلّ، لكن التخزين لم يؤكّد إسقاط الكائن — تبقى البايتات حتى ينظّفها جامع الأيتام.`
            : 'تم الحذف بنجاح',
      });
      files.reload();
      counts.reload();
    } catch (error) {
      setNotice({ kind: 'danger', text: `خطأ في الحذف: ${failure(error)}` });
    } finally {
      setBusyId(null);
    }
  }

  /**
   * 📎 الرفع — ثلاث خطوات كما يفرضها العقد: presign ⇒ PUT إلى التخزين ⇒ finalize.
   * والخطوة الوسطى هي التي لا يراها الـAPI؛ فإن أخفقت فالصفّ يبقى `pending` ويظهر في
   * الشاشة بذلك، ويُنظّفه جامع الأيتام بعد `FILES_ORPHAN_GC_HOURS`.
   */
  async function upload(file: File) {
    setUploading(true);
    setNotice(undefined);
    try {
      const presigned = await apiPost<Presign>('/files/presign', {
        name: file.name,
        mime: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      });

      // لا رمز ولا ترويسة هويّة هنا: الرابط الموقّع نفسه هو التصريح عند التخزين، وإرسال
      // رمز الجلسة إلى مضيفٍ آخر تسريبٌ لا حماية.
      const put = await fetch(presigned.uploadUrl, {
        method: 'PUT',
        headers: { ...presigned.requiredHeaders },
        body: file,
      });
      if (!put.ok) {
        throw new Error(
          `التخزين رفض الرفع (${put.status}). الصفّ «${file.name}» بقي «بانتظار الرفع» وسيُنظَّف تلقائياً.`,
        );
      }

      await apiPost(`/files/${presigned.fileId}/finalize`, {});
      setNotice({ kind: 'ok', text: `رُفع «${file.name}» وأُثبِت في المخزن.` });
      files.reload();
      counts.reload();
    } catch (error) {
      // 503 `STORAGE_NOT_CONFIGURED` ليست عطلاً: بنيةٌ ناقصة في الخادم، وتُقال باسمها.
      if (error instanceof ApiError && error.code === 'STORAGE_NOT_CONFIGURED') {
        setNotice({ kind: 'info', text: `الرفع غير متاح على هذا الخادم: ${error.message}` });
      } else if (error instanceof ApiError && error.code === 'VALIDATION_FAILED') {
        setNotice({ kind: 'danger', text: `رفض الخادم الملف: ${error.detail ?? error.message}` });
      } else {
        setNotice({ kind: 'danger', text: failure(error) });
      }
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }

  if (!canUpload) {
    return (
      <Screen title="مدير الملفات" crumbs={['الإعدادات', 'إعدادات إدارية']}>
        <p className="alert warn">
          لا تملك صلاحية الملفات (`tenant.file.upload`) — اطلبها من «صلاحيات المستخدمين».
        </p>
      </Screen>
    );
  }

  return (
    <Screen
      title="مدير الملفات"
      subtitle="مخزن المنشأة: كل ما رُفع، بحالته ومستنده المرتبط، مع تنزيلٍ برابط موقّع ورفعٍ مباشر إلى التخزين. البايتات لا تمرّ بالـAPI."
      crumbs={['الإعدادات', 'إعدادات إدارية']}
      actions={
        <button
          type="button"
          className="btn"
          onClick={() => {
            files.reload();
            counts.reload();
          }}
        >
          🔄 تحديث
        </button>
      }
    >
      <StatTiles>
        <StatTile label="الكل" value={counts.data?.all ?? '—'} hint="صفوف المخزن غير المحذوفة" />
        <StatTile
          label={STATUS_LABEL.ready}
          value={counts.data?.ready ?? '—'}
          tone="ok"
          hint="مرفوعة ومُثبَّتة"
        />
        <StatTile
          label={STATUS_LABEL.pending}
          value={counts.data?.pending ?? '—'}
          tone="warn"
          hint="رابطٌ صدر ولم يُثبَّت بعد"
        />
      </StatTiles>

      <section className="card">
        <h2>{CARD_TITLE}</h2>
        <div className="filters no-print">
          <label className="field">
            <span>بحث في الاسم</span>
            <input
              className="input"
              value={term}
              onChange={(event) => {
                setTerm(event.target.value);
                setOffset(0);
              }}
              placeholder="فاتورة · عقد · شعار"
            />
          </label>
          <label className="field">
            <span>الحالة</span>
            <select
              className="input"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">الكل</option>
              <option value="ready">{STATUS_LABEL.ready}</option>
              <option value="pending">{STATUS_LABEL.pending}</option>
              <option value="deleted">{STATUS_LABEL.deleted}</option>
            </select>
          </label>
          <label className="field">
            <span>مرتبط بـ</span>
            <select
              className="input"
              value={entity}
              onChange={(event) => {
                setEntity(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">الكل</option>
              {Object.entries(ENTITY_LABEL).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <QueryView
          query={files}
          isEmpty={(data) => data.data.length === 0}
          empty="لا يوجد وثائق."
          emptyDetail="ارفع ملفاً من البطاقة أدناه — أو جرّب توسيع البحث أو الحالة."
        >
          {(data) => (
            <>
              <DataTable
                columns={[
                  { key: 'no', header: 'م', align: 'num', cell: (_row, index) => String(offset + index + 1) },
                  { key: 'name', header: '📄 اسم الملف', cell: (row) => row.name },
                  { key: 'mime', header: 'النوع', cell: (row) => row.mime, align: 'ltr' },
                  { key: 'size', header: 'الحجم', align: 'num', cell: (row) => size(row.sizeBytes) },
                  {
                    key: 'status',
                    header: 'الحالة',
                    cell: (row) => (
                      <span className={`badge ${STATUS_BADGE[row.status]}`}>{STATUS_LABEL[row.status]}</span>
                    ),
                  },
                  {
                    key: 'entity',
                    header: 'مرتبط بـ',
                    cell: (row) =>
                      row.entity ? (
                        <span title={row.entityId ?? ''}>{ENTITY_LABEL[row.entity] ?? row.entity}</span>
                      ) : (
                        '—'
                      ),
                  },
                  { key: 'createdAt', header: 'التاريخ', cell: (row) => dateTime(row.createdAt) },
                  {
                    key: 'actions',
                    header: '',
                    cell: (row) => (
                      <>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={row.status !== 'ready' || busyId === row.id}
                          title={
                            row.status === 'ready' ? 'رابطٌ موقّع قصير العمر' : 'لا يُنزَّل قبل تثبيت الرفع'
                          }
                          onClick={() => download(row)}
                        >
                          ⬇️ تنزيل
                        </button>{' '}
                        <button
                          type="button"
                          className="btn sm danger"
                          disabled={!canManage || busyId === row.id}
                          title={
                            canManage ? 'حذف ناعم للصفّ وإسقاط الكائن' : 'تحتاج صلاحية tenant.file.manage'
                          }
                          onClick={() => remove(row)}
                        >
                          🗑️ حذف
                        </button>
                      </>
                    ),
                  },
                ]}
                rows={data.data}
                rowKey={(row) => row.id}
                footer={[`المعروض ${data.data.length} من ${matchCount}`, '', '', '', '', '', '', '']}
              />
              <div className="toolbar no-print">
                <button
                  type="button"
                  className="btn sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  السابق
                </button>
                <span className="muted small">
                  الصفوف {offset + 1}–{offset + data.data.length} من {matchCount}
                </span>
                <button
                  type="button"
                  className="btn sm"
                  disabled={offset + PAGE_SIZE >= matchCount}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  التالي
                </button>
              </div>
            </>
          )}
        </QueryView>

        {!canManage && (
          <p className="muted small">
            الحذف يحتاج صلاحية <span dir="ltr">tenant.file.manage</span> — وهي غير ممنوحة لدورك.
          </p>
        )}
      </section>

      <section className="card">
        <h3>📎 اختيار المرفقات</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          الملفّ يُدفع من هذا المتصفّح إلى التخزين الكائني مباشرةً برابطٍ موقّع، ثم يُثبَّت الصفّ — فلا تمرّ
          البايتات بالـAPI. والنوع والحجم يحكمهما الخادم؛ رفضُهما يظهر نصّه هنا كما هو.
        </p>
        <div className="toolbar">
          <input
            ref={input}
            type="file"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <span className="muted small">
            {uploading ? 'جارٍ الرفع والتثبيت…' : 'اختر ملفاً واحداً — والحذف من عمود «🗑️ حذف».'}
          </span>
        </div>
        <Notice notice={notice} />
      </section>
    </Screen>
  );
}
