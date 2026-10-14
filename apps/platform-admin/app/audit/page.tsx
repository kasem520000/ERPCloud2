'use client';

import { Fragment, useState } from 'react';

import { Empty, ErrorBox, Forbidden, Loading, Screen } from '../../components/screen';
import { apiData } from '../../lib/api';
import { useQuery } from '../../lib/use-query';

/**
 * التدقيق — now actually cross-tenant (P-C1).
 *
 * Before this part the page called `GET /audit-log`: a tenant-scoped endpoint that answered
 * with the **platform tenant's own rows** — for an operator, an empty list that looked like
 * "nothing ever happened" (INCOMPLETE_INVENTORY §4.2 measured it). The page now reads
 * `GET /platform/audit`, which returns every customer's rows with the customer's code and
 * name beside them, and filters by customer, action, entity and date.
 *
 * P-C9 added the **diff viewer** the plan asked for: `before`/`after` were on every row since
 * P-C1 but nothing displayed them, so an operator could see *that* settings changed and never
 * *what* changed. The table now expands a row into a field-by-field comparison — added,
 * removed and changed — and falls back to the raw JSON for rows that are not objects.
 */

type AuditRow = {
  id: string;
  /** The row as it was, and as it became — both present on every audit row (P-C1 contract). */
  before: unknown;
  after: unknown;
  tenantId: string | null;
  tenantCode: string | null;
  tenantName: string | null;
  occurredAt?: never;
  action: string;
  entity: string;
  entityId: string | null;
  actorUserId: string | null;
  actorLabel: string | null;
  createdAt: string;
};

type AuditPageResult = { items: AuditRow[]; total: number; limit: number; offset: number };

const PAGE_SIZE = 100;

const AUDIT_ACTION_AR: Record<string, string> = {
  create: 'إنشاء',
  update: 'تعديل',
  delete: 'حذف',
  post: 'ترحيل محاسبي',
  'auth.login': 'تسجيل دخول',
  'auth.logout': 'تسجيل خروج',
  'tenant.status': 'تغيير حالة العميل',
  'tenant.owner_transfer': 'نقل ملكية المنشأة',
  'tenant.flag': 'تغيير راية ميزة',
  'tenant.note': 'إضافة/حذف ملاحظة عميل',
  'tenant.setting': 'تعديل إعداد عميل',
  'platform.setting': 'تعديل إعداد المنصة',
  'platform.break_glass.access': 'دخول تشغيلي على مستوى المنصة',
  'support.ticket.create': 'فتح تذكرة مساعدة/دعم',
  'support.ticket.update': 'تحديث تذكرة دعم',
  'support.ticket.reply': 'رد على تذكرة دعم',
  'support.impersonate.start': 'بدء دخول مؤقّت لحساب عميل',
  'support.impersonate.end': 'إنهاء دخول مؤقّت',
  'operator.session.revoke': 'إبطال جلسة مستخدم',
  'operator.mfa.reset': 'إعادة ضبط التحقق بخطوتين (2FA)',
  'operator.role.grant': 'منح دور منصّي',
  'operator.role.revoke': 'سحب دور منصّي',
  'operator.role.permissions': 'تعديل صلاحيات دور منصّي',
};

const AUDIT_ENTITY_AR: Record<string, string> = {
  tenant: 'منشأة عميل',
  tenant_setting: 'إعداد منشأة',
  tenant_flag: 'راية ميزة',
  tenant_note: 'ملاحظة عميل',
  platform_setting: 'إعداد المنصة',
  platform_admin_plane: 'لوحة تحكم المنصة',
  support_ticket: 'تذكرة دعم فني',
  support_session: 'جلسة دخول مؤقّت',
  sales_invoices: 'فواتير المبيعات',
  purchase_invoices: 'فواتير المشتريات',
  journal_entries: 'قيود اليومية',
  vouchers: 'سندات القبض والصرف',
  items: 'الأصناف والمخزون',
  parties: 'العملاء والموردون',
  users: 'المستخدمون',
  roles: 'الأدوار والصلاحيات',
};

export default function AuditPage() {
  const [filters, setFilters] = useState({ tenant: '', action: '', entity: '', from: '', to: '' });
  const [applied, setApplied] = useState(filters);
  const [expanded, setExpanded] = useState<string | null>(null);

  const audit = useQuery<AuditPageResult>(() => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (applied.tenant) params.set('filter[tenantId]', applied.tenant);
    if (applied.action) params.set('filter[action]', applied.action);
    if (applied.entity) params.set('filter[entity]', applied.entity);
    if (applied.from) params.set('filter[from]', new Date(applied.from).toISOString());
    if (applied.to) params.set('filter[to]', new Date(applied.to).toISOString());
    return apiData<AuditPageResult>(`/platform/audit?${params.toString()}`);
  }, [applied]);

  const rows = audit.data?.items ?? [];

  return (
    <Screen
      title="سجل التدقيق"
      subtitle="سجل عابر للمستأجرين: كل عملية مؤثّرة في أي منشأة، بمَن فعلها ولمن. للقراءة فقط."
      crumbs={['المنصة', 'التشغيل']}
      actions={
        <button className="btn" type="button" onClick={audit.reload}>
          تحديث
        </button>
      }
    >
      <div className="card tight no-print">
        <div className="form-grid">
          <label className="field">
            <span>معرّف العميل (UUID)</span>
            <input
              className="input"
              dir="ltr"
              value={filters.tenant}
              placeholder="اتركه فارغاً لكل العملاء"
              onChange={(event) => setFilters({ ...filters, tenant: event.target.value })}
            />
          </label>
          <label className="field">
            <span>الإجراء</span>
            <input
              className="input"
              dir="ltr"
              value={filters.action}
              placeholder="create · update · auth.login"
              onChange={(event) => setFilters({ ...filters, action: event.target.value })}
            />
          </label>
          <label className="field">
            <span>الكيان</span>
            <input
              className="input"
              dir="ltr"
              value={filters.entity}
              placeholder="settings · sales_invoices"
              onChange={(event) => setFilters({ ...filters, entity: event.target.value })}
            />
          </label>
          <label className="field">
            <span>من وقت</span>
            <input
              className="input"
              type="datetime-local"
              value={filters.from}
              onChange={(event) => setFilters({ ...filters, from: event.target.value })}
            />
          </label>
          <label className="field">
            <span>إلى وقت</span>
            <input
              className="input"
              type="datetime-local"
              value={filters.to}
              onChange={(event) => setFilters({ ...filters, to: event.target.value })}
            />
          </label>
        </div>
        <div className="row">
          <button className="btn primary" type="button" onClick={() => setApplied(filters)}>
            تطبيق المرشّحات
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              const cleared = { tenant: '', action: '', entity: '', from: '', to: '' };
              setFilters(cleared);
              setApplied(cleared);
            }}
          >
            إزالة المرشّحات
          </button>
        </div>
      </div>

      {audit.status === 'loading' && <Loading />}
      {audit.status === 'forbidden' && <Forbidden />}
      {audit.status === 'error' && <ErrorBox message={audit.error} onRetry={audit.reload} />}
      {audit.status === 'success' &&
        (rows.length === 0 ? (
          <Empty
            title="لا توجد سجلات مطابقة"
            detail="جرّب توسيع الفترة أو إزالة المرشّحات — القراءة تشمل كل المنشآت."
          />
        ) : (
          <>
            <p className="muted small">
              {rows.length} من {audit.data?.total ?? rows.length} سجلاً
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>الوقت</th>
                    <th>العميل</th>
                    <th>الإجراء</th>
                    <th>الكيان</th>
                    <th>المعرّف</th>
                    <th>المستخدم</th>
                    <th>الفرق</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <Fragment key={row.id}>
                      <tr>
                        <td dir="ltr">{new Date(row.createdAt).toLocaleString('ar-SA')}</td>
                        <td>
                          {row.tenantName ? (
                            <>
                              {row.tenantName}
                              <br />
                              <span className="muted small" dir="ltr">
                                {row.tenantCode}
                              </span>
                            </>
                          ) : (
                            <span className="muted">المنصة</span>
                          )}
                        </td>
                        <td>
                          <strong>{AUDIT_ACTION_AR[row.action] ?? row.action}</strong>
                          <div className="muted small" dir="ltr">{row.action}</div>
                        </td>
                        <td>
                          <strong>{AUDIT_ENTITY_AR[row.entity] ?? row.entity}</strong>
                          <div className="muted small" dir="ltr">{row.entity}</div>
                        </td>
                        <td dir="ltr" className="small">
                          {row.entityId ? row.entityId.slice(0, 12) : '—'}
                        </td>
                        <td dir="ltr" className="small">
                          {row.actorLabel ?? (row.actorUserId ? row.actorUserId.slice(0, 8) : '—')}
                        </td>
                        <td>
                          <button
                            className="btn small"
                            type="button"
                            aria-expanded={expanded === row.id}
                            onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                          >
                            {expanded === row.id ? 'إخفاء' : describeChange(row)}
                          </button>
                        </td>
                      </tr>
                      {expanded === row.id && (
                        <tr>
                          <td colSpan={7} style={{ background: 'rgba(0,0,0,0.02)' }}>
                            <DiffPanel row={row} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ))}
    </Screen>
  );
}

/** «قبل/بعد» مُسطَّحان إلى أزواج مفتاحٍ/قيمة — صفٌّ واحد لكل حقلٍ تغيّر. */
type DiffRow = { field: string; before: unknown; after: unknown; kind: 'added' | 'removed' | 'changed' };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function diffRows(before: unknown, after: unknown): DiffRow[] {
  const left = asRecord(before);
  const right = asRecord(after);
  if (!left && !right) return [];
  const fields = Array.from(new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])).sort();
  const rows: DiffRow[] = [];
  for (const field of fields) {
    const hadBefore = left ? field in left : false;
    const hasAfter = right ? field in right : false;
    const beforeValue = hadBefore ? left?.[field] : undefined;
    const afterValue = hasAfter ? right?.[field] : undefined;
    if (hadBefore && hasAfter && JSON.stringify(beforeValue) === JSON.stringify(afterValue)) continue;
    rows.push({
      field,
      before: beforeValue,
      after: afterValue,
      kind: !hadBefore ? 'added' : !hasAfter ? 'removed' : 'changed',
    });
  }
  return rows;
}

const KIND_LABEL: Record<DiffRow['kind'], string> = {
  added: 'أُضيف',
  removed: 'حُذف',
  changed: 'تغيّر',
};

/** زرّ الصفّ يقول ما سيراه المشغّل إن ضغط: عدد الحقول التي تغيّرت. */
function describeChange(row: AuditRow): string {
  const changes = diffRows(row.before, row.after);
  if (changes.length === 0) return row.before === null && row.after === null ? 'بلا تفاصيل' : 'تفاصيل';
  return `الفرق (${changes.length})`;
}

function showValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * عارض الفرق — لا يفسّر ولا يخفي: يعرض كل حقلٍ تغيّر، ومن أضاف ومن حذف. والصفوف التي
 * ليست كائنات (`before`/`after` نصّان أو مصفوفتان) تُعرض خاماً كما هي في التدقيق.
 */
function DiffPanel({ row }: { row: AuditRow }) {
  const changes = diffRows(row.before, row.after);
  if (changes.length === 0) {
    const raw = [row.before, row.after].filter((value) => value !== null && value !== undefined);
    if (raw.length === 0) {
      return <p className="muted small">لا `before` ولا `after` في هذا السطر — بعض الأفعال لا تغيّر صفاً.</p>;
    }
    return (
      <pre className="code small" dir="ltr">
        {raw.map((value) => showValue(value)).join('\n→\n')}
      </pre>
    );
  }
  return (
    <div className="table-wrap">
      <table className="small">
        <thead>
          <tr>
            <th>الحقل</th>
            <th>قبل</th>
            <th>بعد</th>
            <th>نوع التغيير</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change) => (
            <tr key={change.field}>
              <td dir="ltr">{change.field}</td>
              <td dir="ltr">{showValue(change.before)}</td>
              <td dir="ltr">{showValue(change.after)}</td>
              <td>
                <span
                  className={`badge ${change.kind === 'changed' ? 'pending' : change.kind === 'added' ? 'active' : 'failed'}`}
                >
                  {KIND_LABEL[change.kind]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
