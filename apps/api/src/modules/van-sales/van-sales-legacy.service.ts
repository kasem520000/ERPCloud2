/**
 * One-off reconciliation of legacy pre-platform rows (factory batches / load orders) into official engine links.
 *
 * M1 decomposition (see ./README.md): extracted verbatim from the former van-sales.service.ts —
 * pure code movement, no behavior change.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { newId } from '@erp/contracts';
import { withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { SalesService, type SalesLineInput } from '../sales/sales.service.js';

import { rows, first, str, dec } from './van-sales-shared.service.js';
import { VanSalesSharedService } from './van-sales-shared.service.js';

@Injectable()
export class VanSalesLegacyService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly sales: SalesService,
    private readonly shared: VanSalesSharedService
  ) {}

  async reconcileLegacyData(
    tenantId: string,
    userId: string,
    options: {
      mode?: 'dry_run' | 'execute';
      resumeFromId?: string;
      batchLimit?: number;
    } = {},
  ) {
    const mode = options.mode === 'execute' ? 'execute' : 'dry_run';
    const batchLimit = Math.max(1, Math.min(200, Number(options.batchLimit ?? 50)));
    const resumeFromId = options.resumeFromId?.trim() || null;

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const batchCounts = first(
        await tx.execute(sql`
          SELECT
            COUNT(*)::int AS total_batches,
            COUNT(*) FILTER (
              WHERE inventory_transaction_id IS NOT NULL
                 OR production_order_id IS NOT NULL
                 OR manufacturing_order_id IS NOT NULL
            )::int AS linked_batches,
            COUNT(*) FILTER (
              WHERE inventory_transaction_id IS NULL
                AND production_order_id IS NULL
                AND manufacturing_order_id IS NULL
            )::int AS unlinked_batches
          FROM factory_production_batches
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
        `),
      );

      const loadCounts = first(
        await tx.execute(sql`
          SELECT
            COUNT(*)::int AS total_loads,
            COUNT(*) FILTER (WHERE stock_transfer_id IS NOT NULL)::int AS linked_loads,
            COUNT(*) FILTER (WHERE stock_transfer_id IS NULL)::int AS unlinked_loads,
            COUNT(*) FILTER (WHERE shortage_qty > 0 AND shortage_policy_status = 'pending_policy_approval')::int AS pending_shortage_policy
          FROM van_load_orders
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
        `),
      );

      const docCounts = first(
        await tx.execute(sql`
          SELECT
            COUNT(*)::int AS total_docs,
            COUNT(*) FILTER (WHERE sales_invoice_id IS NOT NULL)::int AS linked_docs,
            COUNT(*) FILTER (WHERE sales_invoice_id IS NULL)::int AS unlinked_docs,
            COUNT(*) FILTER (WHERE invoice_mode = 'internal_delivery')::int AS internal_delivery_docs
          FROM van_sales_documents
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
        `),
      );

      const priceWithoutHistoryRows = rows(
        await tx.execute(sql`
          SELECT cp.*
          FROM van_sales_customer_prices cp
          WHERE cp.tenant_id = ${tenantId}::uuid
            AND cp.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM van_sales_customer_price_history h
              WHERE h.tenant_id = cp.tenant_id AND h.customer_price_id = cp.id
            )
          ORDER BY cp.id ASC
          LIMIT ${batchLimit}
        `),
      );

      const unlinkedDocsRows = rows(
        await tx.execute(sql`
          SELECT d.*
          FROM van_sales_documents d
          WHERE d.tenant_id = ${tenantId}::uuid
            AND d.deleted_at IS NULL
            AND d.sales_invoice_id IS NULL
            AND (${resumeFromId}::uuid IS NULL OR d.id > ${resumeFromId}::uuid)
          ORDER BY d.id ASC
          LIMIT ${batchLimit}
        `),
      );

      const duplicateDocNumbers = rows(
        await tx.execute(sql`
          SELECT number, COUNT(*)::int AS cnt
          FROM van_sales_documents
          WHERE tenant_id = ${tenantId}::uuid AND deleted_at IS NULL
          GROUP BY number
          HAVING COUNT(*) > 1
        `),
      );

      const resolvedBranchId = await this.shared.resolveDefaultBranchIdInTx(tx, tenantId);
      const conflicts: Array<{ entityType: string; entityId: string; code: string; detail: string }> =
        [];
      const plan: Array<{
        entityType: string;
        entityId: string;
        number: string;
        action: string;
        canBackfillSafely: boolean;
        blockingReason: string | null;
      }> = [];

      for (const dup of duplicateDocNumbers) {
        conflicts.push({
          entityType: 'van_sales_documents',
          entityId: str(dup.number),
          code: 'DUPLICATE_DOCUMENT_NUMBER',
          detail: `رقم الفاتورة (${str(dup.number)}) مكرر ${Number(dup.cnt)} مرات ويحتاج مراجعة يدوية دون إعادة ترقيم تلقائي.`,
        });
      }

      const succeeded: Array<{ entityType: string; entityId: string; linkedId: string }> = [];
      const failed: Array<{ entityType: string; entityId: string; reason: string }> = [];
      let nextResumeCursor: string | null = null;

      for (const cp of priceWithoutHistoryRows) {
        const cpId = str(cp.id);
        plan.push({
          entityType: 'van_sales_customer_prices',
          entityId: cpId,
          number: str(cp.price_tier_label),
          action: 'backfill_price_audit_history',
          canBackfillSafely: true,
          blockingReason: null,
        });
        if (mode === 'execute') {
          const histId = newId();
          await tx.execute(sql`
            INSERT INTO van_sales_customer_price_history (
              id, tenant_id, customer_price_id, party_id, item_id,
              previous_unit_price, new_unit_price,
              max_bonus_pct, max_bonus_kg_per_invoice, max_discount_pct, lock_price,
              effective_from, effective_to, change_reason, changed_by
            ) VALUES (
              ${histId}::uuid, ${tenantId}::uuid, ${cpId}::uuid, ${str(cp.party_id)}::uuid,
              ${cp.item_id ? str(cp.item_id) : null}::uuid,
              NULL, ${dec(cp.unit_price).toFixed(4)}::numeric,
              ${dec(cp.max_bonus_pct).toFixed(2)}::numeric,
              ${dec(cp.max_bonus_kg_per_invoice).toFixed(4)}::numeric,
              ${dec(cp.max_discount_pct).toFixed(2)}::numeric,
              ${cp.lock_price !== false},
              COALESCE(${cp.effective_from ? str(cp.effective_from) : null}::date, CURRENT_DATE),
              ${cp.effective_to ? str(cp.effective_to) : null}::date,
              'تأريخ أولي للبيانات السابقة (Backfill)',
              ${userId}::uuid
            )
          `);
          succeeded.push({
            entityType: 'van_sales_customer_prices',
            entityId: cpId,
            linkedId: histId,
          });
        }
      }

      for (const doc of unlinkedDocsRows) {
        const docId = str(doc.id);
        nextResumeCursor = docId;
        const docNumber = str(doc.number);
        const docMode = str(doc.invoice_mode || doc.doc_mode || 'zatca_tax');
        const branchId = doc.branch_id ? str(doc.branch_id) : resolvedBranchId;
        const hasCustomer = Boolean(doc.party_id || (doc.customer_name && str(doc.customer_name).trim()));

        if (docMode === 'internal_delivery') {
          conflicts.push({
            entityType: 'van_sales_documents',
            entityId: docId,
            code: 'INTERNAL_DELIVERY_TAX_POLICY_PENDING',
            detail: `المستند ${docNumber} من نوع internal_delivery؛ متوقف عن الترحيل الرسمي حتى اعتماد السياسة الضريبية.`,
          });
          plan.push({
            entityType: 'van_sales_documents',
            entityId: docId,
            number: docNumber,
            action: 'skip_pending_tax_policy',
            canBackfillSafely: false,
            blockingReason: 'INTERNAL_DELIVERY_TAX_POLICY_PENDING',
          });
          if (mode === 'execute') {
            failed.push({
              entityType: 'van_sales_documents',
              entityId: docId,
              reason: 'INTERNAL_DELIVERY_TAX_POLICY_PENDING',
            });
          }
          continue;
        }

        if (!branchId || !hasCustomer) {
          const reason = !branchId ? 'MISSING_BRANCH_ID' : 'MISSING_CUSTOMER';
          conflicts.push({
            entityType: 'van_sales_documents',
            entityId: docId,
            code: reason,
            detail: `المستند ${docNumber} يفتقد الفرع أو العميل اللازم لربطه بجدول sales_invoices.`,
          });
          plan.push({
            entityType: 'van_sales_documents',
            entityId: docId,
            number: docNumber,
            action: 'skip_missing_master_ref',
            canBackfillSafely: false,
            blockingReason: reason,
          });
          if (mode === 'execute') {
            failed.push({ entityType: 'van_sales_documents', entityId: docId, reason });
          }
          continue;
        }

        plan.push({
          entityType: 'van_sales_documents',
          entityId: docId,
          number: docNumber,
          action: 'create_linked_draft_sales_invoice',
          canBackfillSafely: true,
          blockingReason: null,
        });

        if (mode === 'execute') {
          const soldQty = dec(doc.sold_qty);
          const bonusQty = dec(doc.bonus_qty);
          const lines: SalesLineInput[] = [];
          if (soldQty.gt(0)) {
            lines.push({
              itemId: doc.item_id ? str(doc.item_id) : undefined,
              description: `فاتورة توزيع مرحلة (${docNumber})`,
              quantity: soldQty.toFixed(4),
              unitPrice: dec(doc.unit_price).toFixed(4),
              discountAmount: dec(doc.discount_amount).toFixed(4),
              taxRate: dec(doc.tax_rate).toFixed(4),
              batchNo: str(doc.production_batch_no),
              metadata: {
                isBonus: false,
                legacyBackfill: true,
                vanDocumentId: docId,
                vanDocumentNumber: docNumber,
              },
            });
          }
          if (bonusQty.gt(0)) {
            lines.push({
              itemId: doc.item_id ? str(doc.item_id) : undefined,
              description: `بونص مجاني (${docNumber})`,
              quantity: bonusQty.toFixed(4),
              unitPrice: '0.0000',
              discountAmount: '0.0000',
              taxRate: '0.0000',
              batchNo: str(doc.production_batch_no),
              metadata: {
                isBonus: true,
                legacyBackfill: true,
                bonusReason: str(doc.bonus_reason) || 'ترويجي',
                vanDocumentId: docId,
                vanDocumentNumber: docNumber,
              },
            });
          }
          const createdInvoiceId = await this.sales.createInTx(tx, tenantId, {
            branchId,
            partyId: doc.party_id ? str(doc.party_id) : undefined,
            salesmanId: doc.salesman_id ? str(doc.salesman_id) : undefined,
            cashCustomerName: !doc.party_id
              ? str(doc.customer_name) || 'عميل توزيع'
              : undefined,
            kind: 'sale',
            lines,
          });
          await tx.execute(sql`
            UPDATE van_sales_documents
            SET branch_id = COALESCE(branch_id, ${branchId}::uuid),
                sales_invoice_id = ${createdInvoiceId}::uuid
            WHERE id = ${docId}::uuid AND tenant_id = ${tenantId}::uuid
          `);
          succeeded.push({
            entityType: 'van_sales_documents',
            entityId: docId,
            linkedId: createdInvoiceId,
          });
        }
      }

      return {
        mode,
        executedAt: new Date().toISOString(),
        counts: {
          totalProductionBatches: Number(batchCounts?.total_batches ?? 0),
          linkedProductionBatches: Number(batchCounts?.linked_batches ?? 0),
          unlinkedProductionBatches: Number(batchCounts?.unlinked_batches ?? 0),
          totalLoadOrders: Number(loadCounts?.total_loads ?? 0),
          linkedLoadOrders: Number(loadCounts?.linked_loads ?? 0),
          unlinkedLoadOrders: Number(loadCounts?.unlinked_loads ?? 0),
          pendingShortagePolicyOrders: Number(loadCounts?.pending_shortage_policy ?? 0),
          totalDocuments: Number(docCounts?.total_docs ?? 0),
          linkedDocuments: Number(docCounts?.linked_docs ?? 0),
          unlinkedDocuments: Number(docCounts?.unlinked_docs ?? 0),
          internalDeliveryDocuments: Number(docCounts?.internal_delivery_docs ?? 0),
          customerPricesWithoutHistory: priceWithoutHistoryRows.length,
        },
        conflicts,
        plan,
        execution: {
          succeededCount: succeeded.length,
          failedCount: failed.length,
          succeeded,
          failed,
          nextResumeCursor,
        },
      };
    });
  }
}
