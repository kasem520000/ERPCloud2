import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '@erp/database';

/**
 * P-C10 — **من أين تُقرأ النسخة، وبأيّ صيغة تُكتب.**
 *
 * الصيغة NDJSON بثلاثة أنواع أسطر: ترويسة، ثم دفعةُ صفوفٍ لجدولٍ واحد، ثم ذيلٌ فيه
 * عدّادات كل جدول. وليست CSV ولا `pg_dump`:
 *
 *   * `pg_dump` غير متاح في هذه البيئة (نسخة `embedded-postgres` تأتي بـ`initdb` و`pg_ctl`
 *     و`postgres` فقط)، وكذلك هو لا يعرف شيئاً عن الجداول التي تحكمها RLS — يُخرج بايتات
 *     الملفات لا الصفوف المرئية.
 *   * وCSV يحتاج ترويسة أعمدة لكل جدول ويفقد `null` عن `''` وعن `"null"`. وهذه نسخة
 *     **للقراءة الآدمية** قبل أن تكون للاستعادة: كل سطر JSON صحيحٌ بذاته، ويُفتح بمحرّر.
 *
 * **والجداول تُقرأ من الكتالوج لا من قائمةٍ مكتوبة في الكود** (`pg_class` + `pg_policies`)،
 * لأن قائمةً يدوية تتقادم بصمت: جدولٌ أُضيف في ترحيلٍ ما لن يظهر في أي نسخة، ولا أحد
 * سيسأل عنه. والقاعدة المشتقّة من السياسات نفسها:
 *
 *   * سياسةٌ تسمح بمستوى المنصّة (`app.is_platform_admin`) ⇒ يُقرأ الجدول مرّةً واحدة في
 *     سياق المنصّة (وهو ما يجعل `audit_log` و`files` يُقرآن كاملين بلا تكرار).
 *   * سياسةٌ مرتبطة بالمستأجر (`app.tenant_id`، مباشرةً أو عبر أبٍ) وبلا سياسة منصّة ⇒
 *     يُقرأ **داخل سياق كل مستأجر**، فلا تفوت صفوفٌ ولا تتكرّر صفوف.
 *   * بلا RLS أصلاً (جداول المنصّة مثل `tenants` و`users`) ⇒ سياق المنصّة.
 */

export const DUMP_FORMAT = 'erp-platform-dump/1';
export const DUMP_HEADER_KIND = 'erp-platform-dump';
export const DUMP_FOOTER_KIND = 'footer';

/** سقفٌ يُفشل النسخة بدل أن يبترها: نسخةٌ ناقصة أخطر من لا نسخة. */
export const MAX_DUMP_ROWS = 200_000;
export const MAX_DUMP_BYTES = 64 * 1024 * 1024;
export const ROWS_PER_CHUNK = 500;

export type DumpTable = {
  table: string;
  /** جداولٌ يُقرأ كلٌّ منها داخل سياق مستأجر — أو مرّة واحدة في سياق المنصّة. */
  context: 'platform' | 'tenant';
  hasTenantColumn: boolean;
};

export type DumpCatalog = {
  /** تُقرأ مرّةً واحدة في سياق المنصّة (مستوى المنصّة أو بلا RLS). */
  platformTables: DumpTable[];
  /** تُقرأ داخل سياق كل مستأجر. */
  tenantTables: DumpTable[];
};

type CatalogRow = {
  table_name: string;
  rls: boolean;
  has_tenant: boolean;
  has_plane: boolean;
  tenant_scoped: boolean;
};

/**
 * قراءة الكتالوج من القاعدة نفسها.
 *
 * `pg_policies.qual` هو النصّ الحقيقي للسياسة، فيُبحث فيه عن `app.is_platform_admin` وعن
 * `app.tenant_id` — لا عن اسم سياسةٍ يمكن أن يتغيّر.
 */
export async function loadDumpCatalog(tx: DrizzleTx): Promise<DumpCatalog> {
  const result = await tx.execute(sql`
    SELECT c.relname AS table_name,
           c.relrowsecurity AS rls,
           EXISTS (
             SELECT 1 FROM information_schema.columns col
             WHERE col.table_schema = 'public' AND col.table_name = c.relname
               AND col.column_name = 'tenant_id'
           ) AS has_tenant,
           EXISTS (
             SELECT 1 FROM pg_policies p
             WHERE p.schemaname = 'public' AND p.tablename = c.relname
               AND p.qual LIKE '%is_platform_admin%'
           ) AS has_plane,
           EXISTS (
             SELECT 1 FROM pg_policies p
             WHERE p.schemaname = 'public' AND p.tablename = c.relname
               AND p.qual LIKE '%app.tenant_id%'
           ) AS tenant_scoped
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `);

  const rows = result.rows as unknown as CatalogRow[];
  const platformTables: DumpTable[] = [];
  const tenantTables: DumpTable[] = [];

  for (const row of rows) {
    const needsTenantContext = !row.has_plane && row.rls && (row.has_tenant || row.tenant_scoped);
    const entry: DumpTable = {
      table: row.table_name,
      context: needsTenantContext ? 'tenant' : 'platform',
      hasTenantColumn: row.has_tenant,
    };
    if (needsTenantContext) tenantTables.push(entry);
    else platformTables.push(entry);
  }

  return { platformTables, tenantTables };
}

/**
 * سطر قراءة جدولٍ واحد.
 *
 * والمحدّد يُبنى بـ`sql.identifier` والفلتر بقيمةٍ مربوطة — لا نصّاً مجموعاً في الاستعلام.
 * والقيد على المستأجر يُضاف مرّتين: مرّة من RLS (وهي المُلزِمة) ومرّة هنا صراحةً، لأن
 * نسخةً تعتمد على سياسةٍ واحدة تعتمد على إعدادٍ قد يختلف بين بيئة وأخرى.
 */
export function readTableSql(table: string, tenantId: string | null, hasTenantColumn: boolean) {
  const target = sql.identifier(table);
  if (tenantId && hasTenantColumn) {
    return sql`SELECT to_jsonb(t) AS row FROM ${target} t WHERE tenant_id = ${tenantId}::uuid`;
  }
  if (tenantId && table === 'users') {
    // `users` ليس صفّاً لأي مستأجر: يُضمّ إلى نسخته بعلاقة العضوية وحدها.
    return sql`SELECT to_jsonb(t) AS row FROM ${target} t
               WHERE id IN (SELECT user_id FROM memberships WHERE tenant_id = ${tenantId}::uuid)`;
  }
  return sql`SELECT to_jsonb(t) AS row FROM ${target} t`;
}

export function encodeHeader(input: {
  scope: 'platform' | 'tenant';
  tenantId: string | null;
  createdAt: string;
  tables: number;
}): string {
  return `${JSON.stringify({
    kind: DUMP_HEADER_KIND,
    version: 1,
    format: DUMP_FORMAT,
    scope: input.scope,
    tenantId: input.tenantId,
    createdAt: input.createdAt,
    tables: input.tables,
  })}\n`;
}

export function encodeChunk(table: string, tenantId: string | null, rows: unknown[]): string {
  return `${JSON.stringify({ table, tenantId, rows })}\n`;
}

export function encodeFooter(input: {
  tables: Record<string, number>;
  totalRows: number;
  tenants: string[];
  skippedTables: string[];
  complete: true;
}): string {
  return `${JSON.stringify({ kind: DUMP_FOOTER_KIND, ...input })}\n`;
}

export type ParsedDump = {
  format: string | null;
  scope: string | null;
  tenantId: string | null;
  createdAt: string | null;
  tables: Array<{ table: string; rows: number }>;
  tenants: string[];
  totalRows: number;
  lines: number;
  complete: boolean;
  /** الجداول المذكورة في الترويسة/الذيل ولا صفوف لها — تُعرض صراحةً. */
  truncated: boolean;
  detail: string | null;
};

/**
 * قراءة الملف كما كُتب، وإعادة حساب عدّاداته — لا الثقة بما وعدت به الترويسة.
 *
 * و«البتر» يُكتشف بثلاث علامات: غياب سطر الذيل، أو اختلاف عدّاد الذيل عن الصفوف
 * المقروءة فعلاً، أو `complete` غير صحيحة. وهذا هو الفرق بين ملفٍّ ونسخة.
 */
export function parseDump(text: string): ParsedDump {
  const lines = text.split('\n').filter((line) => line.length > 0);
  const counts = new Map<string, number>();
  const tenants = new Set<string>();
  let header: Record<string, unknown> | null = null;
  let footer: Record<string, unknown> | null = null;
  let totalRows = 0;

  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return {
        format: null,
        scope: null,
        tenantId: null,
        createdAt: null,
        tables: [],
        tenants: [],
        totalRows: 0,
        lines: lines.length,
        complete: false,
        truncated: true,
        detail: `line ${lines.indexOf(line) + 1} is not valid JSON`,
      };
    }

    if (parsed.kind === DUMP_HEADER_KIND) {
      header = parsed;
      continue;
    }
    if (parsed.kind === DUMP_FOOTER_KIND) {
      footer = parsed;
      continue;
    }
    const table = typeof parsed.table === 'string' ? parsed.table : null;
    const rows = Array.isArray(parsed.rows) ? parsed.rows.length : 0;
    if (!table) {
      return {
        format: null,
        scope: null,
        tenantId: null,
        createdAt: null,
        tables: [],
        tenants: [],
        totalRows: 0,
        lines: lines.length,
        complete: false,
        truncated: true,
        detail: 'a row chunk carries no table name',
      };
    }
    counts.set(table, (counts.get(table) ?? 0) + rows);
    totalRows += rows;
    if (typeof parsed.tenantId === 'string') tenants.add(parsed.tenantId);
  }

  const footerTables = (footer?.tables ?? {}) as Record<string, number>;
  const tableList = [...counts.entries()]
    .map(([table, rows]) => ({ table, rows }))
    .sort((a, b) => a.table.localeCompare(b.table));
  const mismatched = Object.entries(footerTables).filter(
    ([table, rows]) => (counts.get(table) ?? 0) !== rows,
  );
  const footerTotal = typeof footer?.totalRows === 'number' ? footer.totalRows : null;
  const complete = footer?.complete === true && mismatched.length === 0 && footerTotal === totalRows;

  return {
    format: typeof header?.format === 'string' ? header.format : null,
    scope: typeof header?.scope === 'string' ? header.scope : null,
    tenantId: typeof header?.tenantId === 'string' ? header.tenantId : null,
    createdAt: typeof header?.createdAt === 'string' ? header.createdAt : null,
    tables: tableList,
    tenants: [...tenants].sort(),
    totalRows,
    lines: lines.length,
    complete,
    truncated: !complete,
    detail: complete
      ? null
      : footer === null
        ? 'the footer line is missing — the file was cut short'
        : `the footer disagrees with the body: ${mismatched
            .map(([table, rows]) => `${table} says ${rows}`)
            .join(', ')}`,
  };
}
