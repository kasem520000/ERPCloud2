import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import { boqTerms, progressBillLines, progressBills, projects, projectRequirements, projectStages, projectStageTemplates, tenantSettings, withTenantTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { isUniqueViolation } from '../organization/shared/org-support.js';
import { SequencesService } from '../platform-services/index.js';
import { SalesService } from '../sales/sales.service.js';

import { computeProgressBill } from './progress-bill-calculator.js';

export type ProjectInput = { branchId?: string; code: string; name: string; partyId: string; contractorPartyId?: string; startsOn?: string; endsOn?: string; contractValue?: string; retentionPct?: string; costCenterId?: string; templateId?: string };
export type BoqInput = { code: string; description: string; qty?: string; unitValue: string; estimatedCost?: string; executionPeriod?: string };
export type BillInput = { billDate: string; lines: Array<{ termId: string; billPct?: string; billValue?: string }> };

@Injectable()
export class ProjectsService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle, private readonly sequences: SequencesService, private readonly sales: SalesService) {}
  async ensureEnabled(tenantId: string) { const [flag] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(tenantSettings).where(and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.key, 'pack.projects'))).limit(1)); if (flag && flag.value !== true && flag.value !== 'true') throw new DomainError('NOT_FOUND', 'Projects pack is disabled for this tenant', 404); }
  async list(tenantId: string) { await this.ensureEnabled(tenantId); return { data: await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(projects).where(and(eq(projects.tenantId, tenantId), isNull(projects.deletedAt))).orderBy(desc(projects.createdAt))) }; }
  /**
   * R11 — الحارس الذي كان غائباً: `projects.code` · `name` · `party_id` كلها NOT NULL،
   * وكان غيابها يبلغ القاعدة فيردّ الخادم **500**. والرسالة عربيّة كما في النوافذ،
   * والرمز معلنٌ في contracts.
   */
  async create(tenantId: string, input: ProjectInput) {
    await this.ensureEnabled(tenantId);
    if (!input?.code?.trim() || !input?.name?.trim() || !input?.partyId?.trim()) {
      throw new DomainError('PROJECT_FIELDS_REQUIRED', 'الرجاء إدخال رقم المشروع واسمه والعميل', 422);
    }
    const id = newId(); await withTenantTx(this.database.db, tenantId, async (tx) => { await tx.insert(projects).values({ id, tenantId, branchId: input.branchId, code: input.code, name: input.name, partyId: input.partyId, contractorPartyId: input.contractorPartyId, startsOn: input.startsOn, endsOn: input.endsOn, contractValue: input.contractValue ?? '0', retentionPct: input.retentionPct ?? '0', costCenterId: input.costCenterId, status: 'active' }); if (input.templateId) { const [template] = await tx.select().from(projectStageTemplates).where(and(eq(projectStageTemplates.tenantId, tenantId), eq(projectStageTemplates.id, input.templateId))); const stages = Array.isArray(template?.stages) ? template.stages as Array<{ name?: string }> : []; if (stages.length) await tx.insert(projectStages).values(stages.map((stage, index) => ({ id: newId(), tenantId, projectId: id, name: stage.name ?? `Stage ${index + 1}`, stageOrder: index + 1 }))); } }); return this.read(tenantId, id); }
  async listBills(tenantId: string, projectId: string) { await this.ensureEnabled(tenantId); return { data: await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(progressBills).where(and(eq(progressBills.tenantId, tenantId), eq(progressBills.projectId, projectId))).orderBy(desc(progressBills.billDate))) }; }
  async read(tenantId: string, id: string) { await this.ensureEnabled(tenantId); const [project] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(projects).where(and(eq(projects.tenantId, tenantId), eq(projects.id, id))).limit(1)); if (!project) throw new DomainError('NOT_FOUND', 'Project not found', 404); const [stages, boq, requirements] = await Promise.all([withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(projectStages).where(and(eq(projectStages.tenantId, tenantId), eq(projectStages.projectId, id)))), withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(boqTerms).where(and(eq(boqTerms.tenantId, tenantId), eq(boqTerms.projectId, id), isNull(boqTerms.deletedAt)))), withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(projectRequirements).where(and(eq(projectRequirements.tenantId, tenantId), eq(projectRequirements.projectId, id), isNull(projectRequirements.deletedAt))))]); return { data: { ...project, stages, boq, requirements } }; }
  async createTemplate(tenantId: string, input: { name: string; stages: Array<{ name: string }> }) {
    await this.ensureEnabled(tenantId);
    const name = input?.name?.trim();
    const stages = (input?.stages ?? []).filter((stage) => stage?.name?.trim());
    if (!name || stages.length === 0) throw new DomainError('PROJECT_STAGE_TEMPLATE_REQUIRED', 'الرجاء إدخال اسم المجموعة ومرحلةٍ واحدة على الأقل', 422);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(projectStageTemplates).values({ id: newId(), tenantId, name, stages: stages.map((stage, index) => ({ name: stage.name.trim(), order: index + 1 })) }).returning());
    return row;
  }

  /**
   * R11 — «🗂️ المجموعة» في `frmProjectStagesPM.xaml` قائمةُ مجموعاتٍ تُختار منها؛ ولم يكن
   * لها مسارُ قراءة. وأسوأ من غيابه أن `GET /projects/stage-templates` كان **يبلغ
   * `@Get(':id')`** فيردّ `400 INVALID_ID` — مسارٌ يبدو موجوداً وهو يقرأ معرّفاً.
   */
  async listTemplates(tenantId: string) {
    await this.ensureEnabled(tenantId);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(projectStageTemplates)
        .where(and(eq(projectStageTemplates.tenantId, tenantId), isNull(projectStageTemplates.deletedAt)))
        .orderBy(desc(projectStageTemplates.createdAt)),
    );
    return { data: rows };
  }

  async addStage(tenantId: string, projectId: string, input: { name: string; stageOrder?: number }) {
    await this.ensureEnabled(tenantId);
    const name = input?.name?.trim();
    if (!name) throw new DomainError('PROJECT_STAGE_NAME_REQUIRED', 'الرجاء إدخال اسم المرحلة', 422);
    const row = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const existing = await tx.select({ stageOrder: projectStages.stageOrder }).from(projectStages).where(and(eq(projectStages.tenantId, tenantId), eq(projectStages.projectId, projectId)));
      /** «➕ إضافة حالة» في النافذة تُلحق في الذيل: `newOrder = count + 1` (`:236`). */
      const next = input.stageOrder ?? existing.reduce((max, stage) => Math.max(max, stage.stageOrder), 0) + 1;
      const [inserted] = await tx.insert(projectStages).values({ id: newId(), tenantId, projectId, name, stageOrder: next }).returning();
      return inserted;
    });
    return row;
  }

  /**
   * R11 — «💾 حفظ» في `frmStagePM.xaml`: تغييرُ الاسم وإعادةُ الترتيب (`⬆️ لأعلى` / `⬇️ لأسفل`
   * في `frmProjectStagesPM`). وفهرس `project_stages_order_key` فريدٌ على
   * (المشروع، الترتيب) فلا يصحّ تبديلُ صفّين بتحديثين متتابعين — يُرحَّل الجميع مؤقّتاً
   * ثم يُكتب الترتيب النهائي في المعاملة نفسها.
   */
  async updateStage(tenantId: string, stageId: string, patch: { name?: string; stageOrder?: number }) {
    await this.ensureEnabled(tenantId);
    const name = patch?.name?.trim();
    if (patch?.name !== undefined && !name) throw new DomainError('PROJECT_STAGE_NAME_REQUIRED', 'الرجاء إدخال اسم المرحلة', 422);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [stage] = await tx.select().from(projectStages).where(and(eq(projectStages.tenantId, tenantId), eq(projectStages.id, stageId)));
      if (!stage) throw new DomainError('PROJECT_STAGE_NOT_FOUND', 'Stage not found', 404);
      if (name !== undefined && name !== stage.name) {
        await tx.update(projectStages).set({ name, updatedAt: new Date() }).where(and(eq(projectStages.tenantId, tenantId), eq(projectStages.id, stageId)));
      }
      if (patch.stageOrder !== undefined) {
        const ordered = await tx.select({ id: projectStages.id, stageOrder: projectStages.stageOrder }).from(projectStages).where(and(eq(projectStages.tenantId, tenantId), eq(projectStages.projectId, stage.projectId))).orderBy(asc(projectStages.stageOrder), asc(projectStages.id));
        const ids = ordered.map((row) => row.id).filter((id) => id !== stageId);
        const target = Math.min(Math.max(Math.trunc(patch.stageOrder), 1), ids.length + 1);
        ids.splice(target - 1, 0, stageId);
        await this.rewriteStageOrder(tx, tenantId, stage.projectId, ids);
      }
      const [updated] = await tx.select().from(projectStages).where(and(eq(projectStages.tenantId, tenantId), eq(projectStages.id, stageId)));
      return updated;
    });
  }

  /** «⬆️ لأعلى» و«⬇️ لأسفل» — تبديلٌ مع الجار لا إعادةُ ترقيمٍ كامل. */
  async moveStage(tenantId: string, stageId: string, direction: 'up' | 'down') {
    await this.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [stage] = await tx.select().from(projectStages).where(and(eq(projectStages.tenantId, tenantId), eq(projectStages.id, stageId)));
      if (!stage) throw new DomainError('PROJECT_STAGE_NOT_FOUND', 'Stage not found', 404);
      const ordered = await tx.select({ id: projectStages.id }).from(projectStages).where(and(eq(projectStages.tenantId, tenantId), eq(projectStages.projectId, stage.projectId))).orderBy(asc(projectStages.stageOrder), asc(projectStages.id));
      const ids = ordered.map((row) => row.id);
      const index = ids.indexOf(stageId);
      const target = direction === 'up' ? index - 1 : index + 1;
      /** الطرفان لا يتحرّكان: الزرّ في الشاشة يُعطَّل، والمسار لا يخطئ بهدوء. */
      if (index < 0 || target < 0 || target >= ids.length) return { data: { moved: false, stages: [] } };
      [ids[index], ids[target]] = [ids[target] as string, ids[index] as string];
      await this.rewriteStageOrder(tx, tenantId, stage.projectId, ids);
      return { data: { moved: true, stages: ids } };
    });
  }

  async removeStage(tenantId: string, stageId: string) {
    await this.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [stage] = await tx.select().from(projectStages).where(and(eq(projectStages.tenantId, tenantId), eq(projectStages.id, stageId)));
      if (!stage) throw new DomainError('PROJECT_STAGE_NOT_FOUND', 'Stage not found', 404);
      await tx.delete(projectStages).where(and(eq(projectStages.tenantId, tenantId), eq(projectStages.id, stageId)));
      const remaining = await tx.select({ id: projectStages.id }).from(projectStages).where(and(eq(projectStages.tenantId, tenantId), eq(projectStages.projectId, stage.projectId))).orderBy(asc(projectStages.stageOrder), asc(projectStages.id));
      await this.rewriteStageOrder(tx, tenantId, stage.projectId, remaining.map((row) => row.id));
      return { data: { deleted: true } };
    });
  }

  /** يُرحّل ترتيب المشروع كله مؤقّتاً ثم يكتب 1..n — فلا يصطدم الفهرس الفريد بالتبديل. */
  private async rewriteStageOrder(tx: DrizzleTx, tenantId: string, projectId: string, orderedIds: string[]) {
    await tx.update(projectStages).set({ stageOrder: sql`${projectStages.stageOrder} + 1000000` }).where(and(eq(projectStages.tenantId, tenantId), eq(projectStages.projectId, projectId)));
    let order = 1;
    for (const id of orderedIds) {
      await tx.update(projectStages).set({ stageOrder: order, updatedAt: new Date() }).where(and(eq(projectStages.tenantId, tenantId), eq(projectStages.id, id)));
      order += 1;
    }
  }
  async accreditStage(tenantId: string, stageId: string, userId: string, note?: string) { await this.ensureEnabled(tenantId); const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.update(projectStages).set({ status: 'accredited', accreditedBy: userId, accreditedAt: new Date(), accreditationNote: note, updatedAt: new Date() }).where(and(eq(projectStages.tenantId, tenantId), eq(projectStages.id, stageId))).returning()); return row; }
  async addBoq(tenantId: string, projectId: string, input: BoqInput) {
    await this.ensureEnabled(tenantId);
    /**
     * «من فضلك أدخل رقم البند» · «من فضلك أدخل اسم البند» (`frmTermsPM.xaml.cs` L244–L250)
     * — وبلا الحارس كان الغياب يبلغ القاعدة فيردّ الخادم 500.
     */
    if (!input?.code?.trim()) throw new DomainError('BOQ_TERMS_REQUIRED', 'من فضلك أدخل رقم البند', 422);
    if (!input?.description?.trim()) throw new DomainError('BOQ_TERMS_REQUIRED', 'من فضلك أدخل اسم البند', 422);
    if (input?.unitValue === undefined || input?.unitValue === null || String(input.unitValue).trim() === '') {
      throw new DomainError('BOQ_TERMS_REQUIRED', 'من فضلك أدخل سعر البيع', 422);
    }
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(boqTerms).values({ id: newId(), tenantId, projectId, code: input.code, description: input.description, qty: input.qty ?? '1', unitValue: input.unitValue, estimatedCost: input.estimatedCost ?? '0', executionPeriod: input.executionPeriod }).returning()); return row; }
  /**
   * «✏️ تعديل» في `frmTermsPM.xaml` — البند يُصحَّح بعد كتابته، والحارس نفسه: الرقم والاسم
   * مطلوبان، والرمز المكرّر يمنعه فهرس `(المستأجر، المشروع، الرقم)` فيردّ 409 لا 500.
   */
  async updateBoq(tenantId: string, termId: string, input: Partial<BoqInput>) {
    await this.ensureEnabled(tenantId);
    const values: Partial<typeof boqTerms.$inferInsert> = { updatedAt: new Date() };
    if (input.code !== undefined) {
      if (!input.code.trim()) throw new DomainError('BOQ_TERMS_REQUIRED', 'من فضلك أدخل رقم البند', 422);
      values.code = input.code.trim();
    }
    if (input.description !== undefined) {
      if (!input.description.trim()) throw new DomainError('BOQ_TERMS_REQUIRED', 'من فضلك أدخل اسم البند', 422);
      values.description = input.description.trim();
    }
    if (input.qty !== undefined) values.qty = input.qty;
    if (input.unitValue !== undefined) {
      if (String(input.unitValue).trim() === '') throw new DomainError('BOQ_TERMS_REQUIRED', 'من فضلك أدخل سعر البيع', 422);
      values.unitValue = input.unitValue;
    }
    if (input.estimatedCost !== undefined) values.estimatedCost = input.estimatedCost;
    if (input.executionPeriod !== undefined) values.executionPeriod = input.executionPeriod;
    try {
      const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
        tx
          .update(boqTerms)
          .set(values)
          .where(and(eq(boqTerms.tenantId, tenantId), eq(boqTerms.id, termId), isNull(boqTerms.deletedAt)))
          .returning(),
      );
      if (!row) throw new DomainError('BOQ_TERM_NOT_FOUND', 'بند جدول الكميات غير موجود', 404);
      return { data: row };
      // `BOQ_TERM_NOT_FOUND` يعود من داخل `try` أيضاً — فلا يبتلعه الصيد.
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (isUniqueViolation(error, 'boq_terms_code_key')) throw new DomainError('BOQ_TERM_CODE_TAKEN', 'كود البند مدخل مسبقاً', 409);
      throw error;
    }
  }

  /**
   * «🗑️ حذف» — حذفٌ ناعم (الجدول يحمل `deleted_at`)، ويُرفض إن كان البند قد فُوتر: سطور
   * المستخلص المرحَّلة تشير إليه بـ`onDelete: restrict`، وتغييرُ بنودٍ دُفعت لا يجوز.
   */
  async removeBoq(tenantId: string, termId: string) {
    await this.ensureEnabled(tenantId);
    const [row] = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [term] = await tx
        .select()
        .from(boqTerms)
        .where(and(eq(boqTerms.tenantId, tenantId), eq(boqTerms.id, termId), isNull(boqTerms.deletedAt)));
      if (!term) throw new DomainError('BOQ_TERM_NOT_FOUND', 'بند جدول الكميات غير موجود', 404);
      if (Number(term.previouslyBilled) > 0) throw new DomainError('BOQ_TERM_BILLED', 'لا يمكن حذف بند سبق فوترته في مستخلص', 409);
      return tx
        .update(boqTerms)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(boqTerms.tenantId, tenantId), eq(boqTerms.id, termId)))
        .returning({ id: boqTerms.id });
    });
    return { data: { id: row?.id, deleted: true } };
  }
  async createBill(tenantId: string, projectId: string, input: BillInput) { await this.ensureEnabled(tenantId); const project = (await this.read(tenantId, projectId)).data; const billId = newId(); const termIds = new Set(input.lines.map((line) => line.termId)); const terms = (project.boq as Array<typeof boqTerms.$inferSelect>).filter((term) => termIds.has(term.id)); const mapped = input.lines.map((line) => { const term = terms.find((item) => item.id === line.termId); if (!term) throw new DomainError('BOQ_TERM_NOT_FOUND', 'BOQ term not found', 404); return { termId: term.id, qty: term.qty, unitValue: term.unitValue, previouslyBilled: term.previouslyBilled, billPct: line.billPct, billValue: line.billValue }; }); const computed = computeProgressBill(mapped, project.retentionPct); await withTenantTx(this.database.db, tenantId, async (tx) => { const branchId = project.branchId; if (!branchId) throw new DomainError('PROJECT_BRANCH_REQUIRED', 'Project branch is required to number progress bills', 422); const allocated = await this.sequences.next({ tenantId, branchId, docType: 'progress_bill' }, tx, { prefix: 'PB-', padding: 6 }); await tx.insert(progressBills).values({ id: billId, tenantId, projectId, number: allocated.display, billDate: input.billDate, workValue: computed.workValue, previousValue: computed.previousValue, retentionValue: computed.retentionValue, netDue: computed.netDue, summary: { remainingAfter: computed.remainingAfter } }); await tx.insert(progressBillLines).values(computed.lines.map((line, index) => ({ billId, tenantId, lineNo: index + 1, termId: line.termId, billPct: line.billPct, billValue: line.billValue, previousValue: line.previousValue, remainingValue: line.remainingValue }))); }); return this.getBill(tenantId, billId); }
  async getBill(tenantId: string, billId: string) { const [bill] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(progressBills).where(and(eq(progressBills.tenantId, tenantId), eq(progressBills.id, billId)))); if (!bill) throw new DomainError('PROGRESS_BILL_NOT_FOUND', 'Progress bill not found', 404); const lines = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(progressBillLines).where(and(eq(progressBillLines.tenantId, tenantId), eq(progressBillLines.billId, billId)))); return { data: { ...bill, lines } }; }
  async postBill(tenantId: string, billId: string, input: { branchId?: string; fiscalPeriodId?: string; revenueAccountId?: string; receivableAccountId?: string; retentionReceivableAccountId?: string }) { await this.ensureEnabled(tenantId); const bill = (await this.getBill(tenantId, billId)).data; if (bill.status !== 'draft') throw new DomainError('PROGRESS_BILL_INVALID_STATE', 'Only draft progress bills can be posted', 409); const project = (await this.read(tenantId, bill.projectId)).data; const branchId = input.branchId ?? project.branchId; if (!branchId) throw new DomainError('PROJECT_BRANCH_REQUIRED', 'Project branch is required to post bill', 422); const invoice = await this.sales.create(tenantId, { branchId, partyId: project.partyId, kind: 'sale', lines: [{ description: `Progress bill ${bill.number ?? bill.id}`, quantity: '1', unitPrice: bill.netDue, taxRate: '0' }] }); await this.sales.post(tenantId, invoice.id, input.fiscalPeriodId && input.revenueAccountId && input.receivableAccountId ? { fiscalPeriodId: input.fiscalPeriodId, journalLines: [{ accountId: input.receivableAccountId, debit: bill.netDue, partyId: project.partyId }, { accountId: input.retentionReceivableAccountId ?? input.receivableAccountId, debit: bill.retentionValue, partyId: project.partyId }, { accountId: input.revenueAccountId, credit: bill.workValue }] } : {}); await withTenantTx(this.database.db, tenantId, async (tx) => { await tx.update(progressBills).set({ status: 'posted', invoiceId: invoice.id, postedAt: new Date(), updatedAt: new Date() }).where(and(eq(progressBills.tenantId, tenantId), eq(progressBills.id, billId))); for (const line of bill.lines) await tx.update(boqTerms).set({ previouslyBilled: sql`${boqTerms.previouslyBilled} + ${line.billValue}`, updatedAt: new Date() }).where(and(eq(boqTerms.tenantId, tenantId), eq(boqTerms.id, line.termId))); }); return this.getBill(tenantId, billId); }
  async releaseRetention(tenantId: string, billId: string, input: { branchId?: string }) { await this.ensureEnabled(tenantId); const bill = (await this.getBill(tenantId, billId)).data; if (bill.status !== 'posted') throw new DomainError('PROGRESS_BILL_INVALID_STATE', 'Only posted bills can release retention', 409); const project = (await this.read(tenantId, bill.projectId)).data; const branchId = input.branchId ?? project.branchId; if (!branchId) throw new DomainError('PROJECT_BRANCH_REQUIRED', 'Project branch is required', 422); const invoice = await this.sales.create(tenantId, { branchId, partyId: project.partyId, kind: 'sale', lines: [{ description: `Retention release ${bill.number ?? bill.id}`, quantity: '1', unitPrice: bill.retentionValue, taxRate: '0' }] }); await withTenantTx(this.database.db, tenantId, (tx) => tx.update(progressBills).set({ status: 'released', releasedAt: new Date(), updatedAt: new Date(), summary: sql`${progressBills.summary} || ${JSON.stringify({ retentionReleaseInvoiceId: invoice.id })}::jsonb` }).where(and(eq(progressBills.tenantId, tenantId), eq(progressBills.id, billId)))); return { data: { retentionReleaseInvoiceId: invoice.id } }; }
  async addRequirement(tenantId: string, input: { projectId?: string; partyId?: string; title: string; status?: string; payload?: Record<string, unknown> }) { await this.ensureEnabled(tenantId); const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(projectRequirements).values({ id: newId(), tenantId, projectId: input.projectId, partyId: input.partyId, title: input.title, status: input.status ?? 'open', payload: input.payload ?? {} }).returning()); return row; }
}
