import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DomainError, errorCodes, permissionGrants } from '@erp/contracts';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { VanSalesCustodyService } from './van-sales-custody.service.js';
import { VanSalesDocumentsService } from './van-sales-documents.service.js';
import { VanSalesLegacyService } from './van-sales-legacy.service.js';
import { VanSalesLoadOrdersService } from './van-sales-load-orders.service.js';
import { VanSalesPricingService } from './van-sales-pricing.service.js';
import { VanSalesProductionService } from './van-sales-production.service.js';
import { VanSalesReportingService } from './van-sales-reporting.service.js';

@ApiTags('van-sales')
@ApiBearerAuth()
@Controller('van-sales')
export class VanSalesController {
  constructor(
    private readonly reporting: VanSalesReportingService,
    private readonly pricing: VanSalesPricingService,
    private readonly production: VanSalesProductionService,
    private readonly loadOrders: VanSalesLoadOrdersService,
    private readonly documents: VanSalesDocumentsService,
    private readonly custody: VanSalesCustodyService,
    private readonly legacy: VanSalesLegacyService,
  ) {}

  @Get('dashboard')
  @RequiresPermission('van_sales.view')
  async dashboard() {
    const { tenantId } = getTenantContext();
    return { data: await this.reporting.dashboard(tenantId) };
  }

  @Get('reports')
  @RequiresPermission('van_sales.view')
  async reports(
    @Query('salesmanId') salesmanId?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    const { tenantId } = getTenantContext();
    return {
      data: await this.reporting.getReports(tenantId, {
        salesmanId: salesmanId?.trim() || undefined,
        fromDate: fromDate?.trim() || undefined,
        toDate: toDate?.trim() || undefined,
      }),
    };
  }

  /**
   * 🚐 مساحة عمل المندوب — everything the rep may see, derived from his own membership
   * (`memberships → employees → salesmen`) and never from an id in the request, so one rep
   * cannot read another's custody by changing a parameter.
   */
  @Get('me')
  @RequiresPermission('van_sales.view')
  async me() {
    const { tenantId, membershipId } = getTenantContext();
    return { data: await this.documents.repWorkspace(tenantId, membershipId ?? null) };
  }

  /**
   * 🧑‍💼 شاشة المندوبين — the official `salesmen` card read with its employee, its login
   * account, its van warehouse and its live custody. Writes stay on the official
   * `POST/PATCH /sales/salesmen` endpoints; this is the distribution view of the same rows.
   */
  @Get('salesmen')
  @RequiresPermission('van_sales.view')
  async salesmen() {
    const { tenantId } = getTenantContext();
    return { data: await this.custody.listSalesmenWithCustody(tenantId) };
  }

  /**
   * 🔗 ربط المندوب بحساب دخول — creates/reuses the official user + membership, puts it on
   * the rep role, links the employee card and scopes the login to his own van warehouse.
   */
  @Post('salesmen/:id/account')
  @RequiresPermission('sales.salesman.manage')
  async linkSalesmanAccount(
    @Param('id') id: string,
    @Body()
    body: {
      email?: string;
      fullName?: string;
      branchScope?: string[] | null;
      restrictToVanWarehouse?: boolean;
    },
  ) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.custody.linkSalesmanAccount(tenantId, userId, id, body ?? {}) };
  }

  @Post('production-batches')
  @RequiresPermission('van_sales.production.manage')
  async createProductionBatch(
    @Body()
    body: {
      batchNo?: string;
      itemId?: string | null;
      warehouseId?: string | null;
      branchId?: string | null;
      productionDate?: string;
      bomId?: string | null;
      components?: Array<{ itemId: string; qty: string; unitId?: string }>;
      itemName?: string;
      producedQty?: string;
      scrapQty?: string;
      /** 🗑️ سبب الفاقد — إلزامي مع أي كمية فاقد (لا يُرحَّل فاقد بلا سبب). */
      scrapReason?: string;
      /** 💵 تكلفة الوحدة — تُقبل موجبةً فقط، والأولوية لأمر التصنيع الرسمي ثم البطاقة. */
      unitCost?: string;
      supervisorName?: string;
      notes?: string;
      idempotencyKey?: string;
    },
  ) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.production.createProductionBatch(tenantId, userId, body ?? {}) };
  }

  @Post('customer-prices')
  @RequiresPermission('van_sales.pricing.manage')
  async upsertCustomerPrice(
    @Body()
    body: {
      partyId?: string;
      itemId?: string | null;
      priceTierLabel?: string;
      unitPrice?: string;
      maxBonusPct?: string;
      maxBonusKgPerInvoice?: string;
      preferredInvoiceMode?: 'zatca_tax' | 'internal_delivery';
      creditLimit?: string;
      paymentTermsDays?: number;
      lockPrice?: boolean;
      maxDiscountPct?: string;
      effectiveFrom?: string;
      effectiveTo?: string | null;
      changeReason?: string;
      notes?: string;
    },
  ) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.pricing.upsertCustomerPrice(tenantId, body ?? {}, userId) };
  }

  @Post('load-orders')
  @RequiresPermission('van_sales.load.manage')
  async createLoadOrder(
    @Body()
    body: {
      salesmanId?: string;
      branchId?: string | null;
      warehouseId?: string | null;
      vanWarehouseId?: string | null;
      itemId?: string | null;
      vehiclePlate?: string;
      productionBatchNo?: string;
      loadedQty?: string;
      maxBonusQty?: string;
      maxBonusPct?: string;
      notes?: string;
      idempotencyKey?: string;
    },
  ) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.loadOrders.createLoadOrder(tenantId, userId, body ?? {}) };
  }

  /**
   * ✅ تأكيد استلام التوريد — the rep's own confirmation. Only the rep who owns the custody
   * (or a back-office user holding `van_sales.load.manage`) may confirm; the goods enter his
   * official van balance here, not when the warehouse sends them.
   */
  @Post('load-orders/:id/confirm-receipt')
  @RequiresPermission('van_sales.view')
  async confirmReceipt(
    @Param('id') id: string,
    @Body() body: { receivedQty?: string; notes?: string },
  ) {
    const { tenantId, userId, membershipId } = getTenantContext();
    return {
      data: await this.loadOrders.confirmReceipt(
        tenantId,
        userId,
        membershipId ?? null,
        id,
        body ?? {},
      ),
    };
  }

  /** ↩️ مرتجع العميل — official `sale_return` invoice referencing the original document. */
  @Post('documents/:id/returns')
  @RequiresPermission('van_sales.invoice.create')
  async createReturn(
    @Param('id') id: string,
    @Body()
    body: {
      returnedQty?: string;
      reason?: string;
      notes?: string;
      idempotencyKey?: string;
    },
  ) {
    const { tenantId, userId } = getTenantContext();
    return {
      data: await this.documents.createReturnDocument(tenantId, userId, {
        ...(body ?? {}),
        documentId: id,
      }),
    };
  }

  /**
   * 🖨️ نسختا الطباعة — one official sale document rendered twice: a customer copy and a rep
   * copy carrying a signature box. The print timestamp is stamped here, independently of the
   * sale date.
   */
  @Get('documents/:id/print-view')
  @RequiresPermission('van_sales.view')
  async printView(@Param('id') id: string, @Query('copies') copies?: string) {
    const { tenantId } = getTenantContext();
    return {
      data: await this.documents.documentPrintView(tenantId, id, {
        copies: copies ? Number(copies) : 2,
      }),
    };
  }

  @Post('documents')
  @RequiresPermission('van_sales.invoice.create')
  async createDocument(
    @Body()
    body: {
      loadOrderId?: string;
      partyId?: string | null;
      customerName?: string;
      itemId?: string | null;
      invoiceMode?: 'zatca_tax' | 'internal_delivery';
      paymentMethod?: 'cash' | 'card' | 'credit';
      cashLocationId?: string | null;
      soldQty?: string;
      bonusQty?: string;
      bonusReason?: string;
      unitPrice?: string;
      discountAmount?: string;
      discountReason?: string;
      allowPriceDiscountOverride?: boolean;
      customerBonusConfirmed?: boolean;
      customerConfirmationCode?: string;
      allowBonusOverride?: boolean;
      notes?: string;
      idempotencyKey?: string;
    },
  ) {
    const { tenantId, userId, permissions } = getTenantContext();
    if (body?.allowPriceDiscountOverride || body?.allowBonusOverride) {
      const canOverride =
        permissionGrants(permissions, 'van_sales.override.approve') ||
        permissionGrants(permissions, 'sales.discount.override');
      if (!canOverride) {
        throw new DomainError(
          errorCodes.FORBIDDEN,
          'permission van_sales.override.approve required',
          403,
          { field: 'permission', message: 'van_sales.override.approve' },
        );
      }
    }
    return { data: await this.documents.createDocument(tenantId, userId, body ?? {}) };
  }

  @Post('load-orders/:id/submit-closing')
  @RequiresPermission('van_sales.closing.submit')
  async submitClosing(
    @Param('id') id: string,
    @Body()
    body: {
      returnedQty?: string;
      damagedQty?: string;
      damageReason?: string;
      collectedCash?: string;
      /** 🧮 المتبقي الفعلي بالجرد في السيارة عند إغلاق الوردية. */
      actualRemainingQty?: string;
      closingNotes?: string;
    },
  ) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.custody.submitClosing(tenantId, userId, id, body ?? {}) };
  }

  @Post('load-orders/:id/approve-closing')
  @RequiresPermission('van_sales.closing.approve')
  async approveClosing(
    @Param('id') id: string,
    @Body()
    body: {
      returnedQty?: string;
      damagedQty?: string;
      collectedCash?: string;
      damageInspected?: boolean;
      salaryDeductionApproved?: boolean;
      selfApprovalOverride?: boolean;
      notes?: string;
      /** 🧮 تصحيح المحاسب للجرد الفعلي (اختياري). */
      actualRemainingQty?: string;
      /** `return_to_main` · `carry_over` — إلزامي عند وجود متبقٍ فعلي بالجرد. */
      remainingAction?: string;
      /** 🖋️ تفويض صريح بترحيل مستند الجرد الرسمي؛ بدونه يبقى مسودة وتبقى العهدة معلّقة. */
      settleStockAdjustment?: boolean;
      /** ⚖️ إقرار صريح بفائض الجرد عن العهدة — بدونه يُرفض الرقم حمايةً من خطأ الإدخال. */
      surplusAcknowledged?: boolean;
    },
  ) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.custody.approveClosing(tenantId, userId, id, body ?? {}) };
  }

  /**
   * ♻️ استكمال تسوية مخزون وردية معلّقة — the safe resume path: the quantities were approved but
   * the official count settlement did not complete (no authorisation, missing accounts, a failed
   * call). Repeating it never moves a kilogram twice.
   */
  @Post('load-orders/:id/settle-stock')
  @RequiresPermission('van_sales.closing.approve')
  async settleLoadOrderStock(
    @Param('id') id: string,
    @Body() body: { settleStockAdjustment?: boolean; remainingAction?: string },
  ) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.custody.settleLoadOrderStock(tenantId, userId, id, body ?? {}) };
  }

  /**
   * ❌ رفض المندوب لاستلام التوريد — the quantity is officially still in transit, so the refusal
   * closes the official transfer with `mode: 'return'` and the goods go back to the source.
   */
  @Post('load-orders/:id/reject-receipt')
  @RequiresPermission('van_sales.view')
  async rejectReceipt(@Param('id') id: string, @Body() body: { reason?: string }) {
    const { tenantId, userId, membershipId } = getTenantContext();
    return {
      data: await this.loadOrders.rejectReceipt(tenantId, userId, membershipId ?? null, id, body ?? {}),
    };
  }

  /**
   * 🚦 قرار فرق الاستلام — `return` (إرجاع إلى المصدر) أو `shortage` (عجز تحويل). قرار مالي صريح
   * ينفّذه محرّك المخزون الرسمي بقيوده وحساباته من ملف ترحيل المستأجر.
   */
  @Post('load-orders/:id/close-transit-difference')
  @RequiresPermission('van_sales.load.manage')
  async closeTransitDifference(
    @Param('id') id: string,
    @Body() body: { mode?: string; reason?: string },
  ) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.loadOrders.closeTransitDifference(tenantId, userId, id, body ?? {}) };
  }

  /** 🗑️ إلغاء أمر تحميل قبل الاستلام — عبر الإلغاء الرسمي للمناقلة (يعيد الكميات ويعكس القيد). */
  @Post('load-orders/:id/cancel')
  @RequiresPermission('van_sales.load.manage')
  async cancelLoadOrder(@Param('id') id: string, @Body() body: { reason?: string }) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.loadOrders.cancelLoadOrder(tenantId, userId, id, body ?? {}) };
  }

  @Post('load-orders/:id/settle')
  @RequiresPermission('van_sales.closing.approve')
  async settleLoadOrder(
    @Param('id') id: string,
    @Body()
    body: {
      returnedQty?: string;
      damagedQty?: string;
      collectedCash?: string;
      damageInspected?: boolean;
      salaryDeductionApproved?: boolean;
      notes?: string;
    },
  ) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.custody.settleLoadOrder(tenantId, id, body ?? {}, userId) };
  }

  @Post('collections')
  @RequiresPermission('van_sales.collection.create')
  async collectCustomerDebt(
    @Body()
    body: {
      documentId?: string;
      collectedAmount?: string;
      cashLocationId?: string;
      offsetAccountId?: string;
      notes?: string;
      idempotencyKey?: string;
    },
  ) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.custody.collectCustomerDebt(tenantId, userId, body ?? {}) };
  }

  @Post('legacy-reconciliation')
  @RequiresPermission('van_sales.override.approve')
  async reconcileLegacyData(
    @Body()
    body: {
      mode?: 'dry_run' | 'execute';
      resumeFromId?: string;
      batchLimit?: number;
    },
  ) {
    const { tenantId, userId } = getTenantContext();
    return {
      data: await this.legacy.reconcileLegacyData(tenantId, userId, {
        mode: body?.mode === 'execute' ? 'execute' : 'dry_run',
        resumeFromId: body?.resumeFromId,
        batchLimit: body?.batchLimit,
      }),
    };
  }
}

