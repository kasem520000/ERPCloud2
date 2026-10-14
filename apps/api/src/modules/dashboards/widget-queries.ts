import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '@erp/database';

import { catalogByKey, compareKpi, type WidgetPayload } from './bi-dashboard.js';

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows ?? []);
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function asText(value: unknown): string {
  const raw = text(value);
  return raw.length > 0 ? raw : '0';
}

async function one(tx: DrizzleTx, query: Parameters<DrizzleTx['execute']>[0]): Promise<string> {
  const rows = rowsOf<{ value: unknown }>(await tx.execute(query));
  return asText(rows[0]?.value);
}

async function table(tx: DrizzleTx, query: Parameters<DrizzleTx['execute']>[0], columns: string[]): Promise<WidgetPayload> {
  const rows = rowsOf<Record<string, unknown>>(await tx.execute(query));
  return {
    columns,
    rows: rows.map((row) => columns.map((_, index) => text(row[`c${index}`]))),
  };
}

function kpi(current: string, previous?: string): WidgetPayload {
  if (previous === undefined) return { value: current };
  return { value: current, previous, ...compareKpi(current, previous) };
}

/**
 * أرقام المستأجر من جداول التقارير المعروفة. المفتاح كتالوج، والجملة هنا ثابتة في الخادم.
 * لا يُلحق أي نص كتبه المستخدم بهذه الاستعلامات.
 */
export async function queryWidget(tx: DrizzleTx, tenantId: string, key: string): Promise<WidgetPayload> {
  const item = catalogByKey(key);
  if (!item) throw new Error('UNKNOWN_WIDGET');
  switch (key) {
    case 'sales-today':
      return kpi(
        await one(tx, sql`select coalesce(sum(total), 0)::text as value from sales_invoices where tenant_id = ${tenantId}::uuid and kind = 'sale' and status = 'posted' and posted_at >= date_trunc('day', now())`),
        await one(tx, sql`select coalesce(sum(total), 0)::text as value from sales_invoices where tenant_id = ${tenantId}::uuid and kind = 'sale' and status = 'posted' and posted_at >= date_trunc('day', now()) - interval '1 day' and posted_at < date_trunc('day', now())`),
      );
    case 'sales-month':
      return kpi(
        await one(tx, sql`select coalesce(sum(total), 0)::text as value from sales_invoices where tenant_id = ${tenantId}::uuid and kind = 'sale' and status = 'posted' and posted_at >= date_trunc('month', now())`),
        await one(tx, sql`select coalesce(sum(total), 0)::text as value from sales_invoices where tenant_id = ${tenantId}::uuid and kind = 'sale' and status = 'posted' and posted_at >= date_trunc('month', now()) - interval '1 month' and posted_at < date_trunc('month', now())`),
      );
    case 'purchases-today':
      return kpi(
        await one(tx, sql`select coalesce(sum(total), 0)::text as value from purchase_invoices where tenant_id = ${tenantId}::uuid and kind = 'purchase' and status = 'posted' and posted_at >= date_trunc('day', now())`),
        await one(tx, sql`select coalesce(sum(total), 0)::text as value from purchase_invoices where tenant_id = ${tenantId}::uuid and kind = 'purchase' and status = 'posted' and posted_at >= date_trunc('day', now()) - interval '1 day' and posted_at < date_trunc('day', now())`),
      );
    case 'receipts-today':
      return kpi(
        await one(tx, sql`select coalesce(sum(amount), 0)::text as value from vouchers where tenant_id = ${tenantId}::uuid and kind = 'receipt' and status = 'posted' and date = current_date`),
        await one(tx, sql`select coalesce(sum(amount), 0)::text as value from vouchers where tenant_id = ${tenantId}::uuid and kind = 'receipt' and status = 'posted' and date = current_date - 1`),
      );
    case 'payments-today':
      return kpi(
        await one(tx, sql`select coalesce(sum(amount), 0)::text as value from vouchers where tenant_id = ${tenantId}::uuid and kind = 'payment' and status = 'posted' and date = current_date`),
        await one(tx, sql`select coalesce(sum(amount), 0)::text as value from vouchers where tenant_id = ${tenantId}::uuid and kind = 'payment' and status = 'posted' and date = current_date - 1`),
      );
    case 'receivable':
      return kpi(await one(tx, sql`select coalesce(sum(total - paid_total), 0)::text as value from sales_invoices where tenant_id = ${tenantId}::uuid and kind = 'sale' and status = 'posted' and payment_status <> 'paid'`));
    case 'cash-position':
      return kpi(await one(tx, sql`select coalesce(sum(balance), 0)::text as value from cash_location_balances where tenant_id = ${tenantId}::uuid`));
    case 'expense-month':
      return kpi(
        await one(tx, sql`select coalesce(sum(amount), 0)::text as value from vouchers where tenant_id = ${tenantId}::uuid and kind = 'payment' and status = 'posted' and date >= date_trunc('month', current_date)::date`),
        await one(tx, sql`select coalesce(sum(amount), 0)::text as value from vouchers where tenant_id = ${tenantId}::uuid and kind = 'payment' and status = 'posted' and date >= (date_trunc('month', current_date) - interval '1 month')::date and date < date_trunc('month', current_date)::date`),
      );
    case 'inventory-value':
      return kpi(await one(tx, sql`select coalesce(sum(value), 0)::text as value from stock_balances where tenant_id = ${tenantId}::uuid`));
    case 'new-customers':
      return kpi(
        await one(tx, sql`select count(*)::text as value from parties where tenant_id = ${tenantId}::uuid and deleted_at is null and kind in ('customer', 'both') and created_at >= date_trunc('month', now())`),
        await one(tx, sql`select count(*)::text as value from parties where tenant_id = ${tenantId}::uuid and deleted_at is null and kind in ('customer', 'both') and created_at >= date_trunc('month', now()) - interval '1 month' and created_at < date_trunc('month', now())`),
      );
    case 'attendance-today':
      return kpi(await one(tx, sql`select count(distinct employee_id)::text as value from employee_attendance where tenant_id = ${tenantId}::uuid and at >= date_trunc('day', now())`));
    case 'open-quotations':
      return kpi(await one(tx, sql`select count(*)::text as value from sales_invoices where tenant_id = ${tenantId}::uuid and kind = 'quotation' and status not in ('converted', 'void', 'cancelled')`));
    case 'posted-journals':
      return kpi(
        await one(tx, sql`select count(*)::text as value from journal_entries where tenant_id = ${tenantId}::uuid and status = 'posted' and date >= date_trunc('month', current_date)::date`),
        await one(tx, sql`select count(*)::text as value from journal_entries where tenant_id = ${tenantId}::uuid and status = 'posted' and date >= (date_trunc('month', current_date) - interval '1 month')::date and date < date_trunc('month', current_date)::date`),
      );
    case 'sales-week': {
      const rows = rowsOf<{ label: unknown; value: unknown }>(await tx.execute(sql`
        select to_char(bucket::date, 'MM-DD') as label, coalesce(sum(s.total), 0)::text as value
        from generate_series(date_trunc('day', now()) - interval '6 days', date_trunc('day', now()), interval '1 day') as bucket
        left join sales_invoices s
          on s.tenant_id = ${tenantId}::uuid
         and s.kind = 'sale'
         and s.status = 'posted'
         and s.posted_at >= bucket
         and s.posted_at < bucket + interval '1 day'
        group by bucket
        order by bucket
      `));
      return { series: rows.map((row) => ({ label: text(row.label), value: asText(row.value) })) };
    }
    case 'sales-by-branch': {
      const rows = rowsOf<{ label: unknown; value: unknown }>(await tx.execute(sql`
        select b.name_ar as label, coalesce(sum(s.total), 0)::text as value
        from branches b
        left join sales_invoices s
          on s.branch_id = b.id
         and s.tenant_id = b.tenant_id
         and s.kind = 'sale'
         and s.status = 'posted'
         and s.posted_at >= date_trunc('month', now())
        where b.tenant_id = ${tenantId}::uuid
          and b.deleted_at is null
        group by b.name_ar
        order by coalesce(sum(s.total), 0) desc
        limit 8
      `));
      return { series: rows.map((row) => ({ label: text(row.label), value: asText(row.value) })) };
    }
    case 'overdue-invoices':
      return table(
        tx,
        sql`select coalesce(number, '—') as c0, to_char(posted_at, 'YYYY-MM-DD') as c1, (total - paid_total)::text as c2
            from sales_invoices
            where tenant_id = ${tenantId}::uuid and kind = 'sale' and status = 'posted'
              and payment_status <> 'paid' and posted_at < now() - interval '30 days'
            order by posted_at
            limit 8`,
        ['الفاتورة', 'التاريخ', 'المتبقي'],
      );
    case 'unpaid-invoices':
      return table(
        tx,
        sql`select coalesce(number, '—') as c0, payment_status as c1, (total - paid_total)::text as c2
            from sales_invoices
            where tenant_id = ${tenantId}::uuid and kind = 'sale' and status = 'posted' and payment_status <> 'paid'
            order by posted_at desc
            limit 8`,
        ['الفاتورة', 'الحالة', 'المتبقي'],
      );
    case 'low-stock':
      return table(
        tx,
        sql`select i.name_ar as c0, b.quantity::text as c1, i.min_qty::text as c2
            from stock_balances b
            join items i on i.id = b.item_id and i.tenant_id = b.tenant_id
            where b.tenant_id = ${tenantId}::uuid and i.deleted_at is null and i.min_qty > 0 and b.quantity <= i.min_qty
            order by i.name_ar
            limit 8`,
        ['الصنف', 'الكمية', 'الحد الأدنى'],
      );
    case 'top-items':
      return table(
        tx,
        sql`select coalesce(i.name_ar, l.description, 'صنف') as c0, sum(l.quantity)::text as c1, sum(l.total)::text as c2
            from sales_invoice_lines l
            join sales_invoices s on s.id = l.invoice_id and s.tenant_id = l.tenant_id
            left join items i on i.id = l.item_id
            where l.tenant_id = ${tenantId}::uuid and s.kind = 'sale' and s.status = 'posted'
              and s.posted_at >= date_trunc('month', now())
            group by 1
            order by sum(l.total) desc
            limit 8`,
        ['الصنف', 'الكمية', 'المبلغ'],
      );
    case 'near-expiry':
      return table(
        tx,
        sql`select i.name_ar as c0, l.lot_no as c1, l.expiry_date::text as c2
            from item_lots l
            join items i on i.id = l.item_id and i.tenant_id = l.tenant_id
            where l.tenant_id = ${tenantId}::uuid and l.deleted_at is null and i.deleted_at is null
              and l.expiry_date is not null and l.expiry_date <= current_date + 30
            order by l.expiry_date
            limit 8`,
        ['الصنف', 'الدفعة', 'الانتهاء'],
      );
    default:
      throw new Error('UNKNOWN_WIDGET');
  }
}
