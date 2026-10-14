import { Inject, Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DomainError, newId } from '@erp/contracts';
import {
  contractorContractLines,
  contractorContracts,
  contractorPayments,
  parties,
  projectOfferLines,
  projectOffers,
  projects,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { tryGetAuthContext } from '../platform/context/tenant-context.js';
import { SequencesService } from '../platform-services/index.js';
import { TreasuryService } from '../treasury/treasury.service.js';

import { ProjectsService } from './projects.service.js';

export type ContractLineInput = { description: string; qty?: string; unitValue: string };
export type ContractInput = {
  projectId: string;
  contractorPartyId: string;
  title: string;
  scope?: string;
  contractValue?: string;
  retentionPct?: string;
  advanceAmount?: string;
  startsOn?: string;
  endsOn?: string;
  notes?: string;
  lines?: ContractLineInput[];
};
export type PaymentKind = 'advance' | 'progress' | 'final' | 'retention_release';
export type ContractorPaymentInput = {
  kind?: PaymentKind;
  paymentDate?: string;
  grossAmount: string;
  advanceRecovery?: string;
  notes?: string;
};
export type PayInput = { cashLocationId: string; method?: 'cash' | 'cheque' | 'bank_transfer' | 'card'; chequeNo?: string; chequeDate?: string; bankName?: string; date?: string };
export type OfferLineInput = { code?: string; description: string; qty?: string; unitValue: string };
export type OfferInput = {
  partyId: string;
  branchId?: string;
  title: string;
  offerDate?: string;
  validUntil?: string;
  retentionPct?: string;
  notes?: string;
  lines: OfferLineInput[];
};

/** Statuses that still commit money against a contract; `cancelled` releases it. */
const LIVE_PAYMENT_STATUSES = ['draft', 'approved', 'paid'];
/** Payment kinds that consume the contract value. An advance is a prepayment, not work. */
const VALUE_CONSUMING_KINDS = ['progress', 'final'];

const dec = (input: string | number | null | undefined) => new Decimal(input ?? 0);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * عقد مقاول، سند دفع لمقاول، عروض المشاريع.
 *
 * The whole reason this is a service and not three CRUD tables is the arithmetic on a
 * contractor payment. Retention and advance recovery are **computed from the contract**,
 * never taken from the request: those two deductions are exactly where a subcontractor is
 * over- or under-paid, and a form that lets the user type them is a form that will
 * eventually pay out the retention twice.
 *
 * The offer is the front of the same story. Accepting one touches nothing; converting it
 * creates the project and copies the offer lines into the BOQ, which is the only way the
 * offered numbers and the project's numbers are guaranteed to agree.
 */
@Injectable()
export class ContractingService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly sequences: SequencesService,
    private readonly projectsService: ProjectsService,
    private readonly treasury: TreasuryService,
  ) {}

  // ------------------------------------------------------------------- contracts

  async listContracts(tenantId: string, filters: { projectId?: string; status?: string } = {}) {
    await this.projectsService.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(contractorContracts)
        .where(and(
          eq(contractorContracts.tenantId, tenantId),
          filters.projectId ? eq(contractorContracts.projectId, filters.projectId) : undefined,
          filters.status ? eq(contractorContracts.status, filters.status) : undefined,
        ))
        .orderBy(desc(contractorContracts.createdAt))
        .limit(200);
      if (!rows.length) return [];
      const ids = rows.map((row) => row.id);
      const lines = await tx.select().from(contractorContractLines).where(and(eq(contractorContractLines.tenantId, tenantId), inArray(contractorContractLines.contractId, ids)));
      const payments = await tx.select().from(contractorPayments).where(and(eq(contractorPayments.tenantId, tenantId), inArray(contractorPayments.contractId, ids)));
      return rows.map((row) => ({
        ...row,
        lines: lines.filter((line) => line.contractId === row.id).sort((a, b) => a.lineNo - b.lineNo),
        ...this.contractTotals(row, payments.filter((payment) => payment.contractId === row.id)),
      }));
    });
  }

  async getContract(tenantId: string, id: string) {
    await this.projectsService.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, (tx) => this.loadContract(tx, tenantId, id));
  }

  async createContract(tenantId: string, input: ContractInput) {
    await this.projectsService.ensureEnabled(tenantId);
    if (!input.projectId || !input.contractorPartyId) throw new DomainError('CONTRACT_PARTIES_REQUIRED', 'A contractor contract needs a project and a contractor', 422);
    if (!input.title?.trim()) throw new DomainError('CONTRACT_TITLE_REQUIRED', 'A contractor contract needs a title', 422);
    const retentionPct = dec(input.retentionPct ?? '0');
    if (retentionPct.lt(0) || retentionPct.gt(100)) throw new DomainError('CONTRACT_RETENTION_INVALID', 'Retention must be between 0 and 100 percent', 422);

    const lines = (input.lines ?? []).map((line, index) => {
      const qty = dec(line.qty ?? '1');
      const unitValue = dec(line.unitValue);
      if (qty.lte(0)) throw new DomainError('CONTRACT_LINE_QTY_INVALID', 'Every contract line needs a quantity greater than zero', 422);
      if (unitValue.lt(0)) throw new DomainError('CONTRACT_LINE_VALUE_INVALID', 'A contract line cannot have a negative unit value', 422);
      return { lineNo: index + 1, description: line.description, qty: qty.toFixed(4), unitValue: unitValue.toFixed(4), lineValue: qty.mul(unitValue).toFixed(4) };
    });
    // Lines win over a typed total: a contract whose header disagrees with its own
    // breakdown is the classic source of an over-certified subcontractor.
    const contractValue = lines.length ? lines.reduce((sum, line) => sum.plus(line.lineValue), new Decimal(0)) : dec(input.contractValue ?? '0');
    if (contractValue.lt(0)) throw new DomainError('CONTRACT_VALUE_INVALID', 'Contract value cannot be negative', 422);
    const advanceAmount = dec(input.advanceAmount ?? '0');
    if (advanceAmount.lt(0)) throw new DomainError('CONTRACT_ADVANCE_INVALID', 'Advance cannot be negative', 422);
    if (contractValue.gt(0) && advanceAmount.gt(contractValue)) throw new DomainError('CONTRACT_ADVANCE_ABOVE_VALUE', 'The advance cannot exceed the contract value', 422);

    const id = newId();
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [project] = await tx.select().from(projects).where(and(eq(projects.tenantId, tenantId), eq(projects.id, input.projectId)));
      if (!project) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found', 404);
      const [contractor] = await tx.select().from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, input.contractorPartyId)));
      if (!contractor) throw new DomainError('PARTY_NOT_FOUND', 'Contractor was not found', 404);

      const allocated = await this.sequences.next({ tenantId, branchId: project.branchId, docType: 'contractor_contract' }, tx, { prefix: 'CC-', padding: 6 });
      await tx.insert(contractorContracts).values({
        id,
        tenantId,
        projectId: input.projectId,
        contractorPartyId: input.contractorPartyId,
        number: allocated.display,
        title: input.title.trim(),
        scope: input.scope,
        status: 'draft',
        contractValue: contractValue.toFixed(4),
        retentionPct: retentionPct.toFixed(4),
        advanceAmount: advanceAmount.toFixed(4),
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        notes: input.notes,
        createdBy: tryGetAuthContext()?.userId,
      });
      if (lines.length) await tx.insert(contractorContractLines).values(lines.map((line) => ({ ...line, contractId: id, tenantId })));
      return this.loadContract(tx, tenantId, id);
    });
  }

  async activateContract(tenantId: string, id: string) {
    return this.transitionContract(tenantId, id, ['draft'], { status: 'active', signedAt: new Date() }, 'Only a draft contract can be activated');
  }

  async closeContract(tenantId: string, id: string) {
    const contract = await this.getContract(tenantId, id);
    if (contract.status !== 'active') throw new DomainError('CONTRACT_INVALID_STATUS', 'Only an active contract can be closed', 409);
    const open = contract.payments.filter((payment) => ['draft', 'approved'].includes(payment.status));
    if (open.length) throw new DomainError('CONTRACT_HAS_OPEN_PAYMENTS', `${open.length} payment(s) are still unpaid; settle or cancel them before closing`, 422);
    return this.transitionContract(tenantId, id, ['active'], { status: 'closed', closedAt: new Date() }, 'Only an active contract can be closed');
  }

  async cancelContract(tenantId: string, id: string) {
    const contract = await this.getContract(tenantId, id);
    if (contract.payments.some((payment) => payment.status === 'paid')) {
      throw new DomainError('CONTRACT_HAS_PAID_PAYMENTS', 'A contract that has already paid money out cannot be cancelled', 422);
    }
    return this.transitionContract(tenantId, id, ['draft', 'active'], { status: 'cancelled' }, 'This contract can no longer be cancelled');
  }

  private async transitionContract(tenantId: string, id: string, from: string[], patch: Record<string, unknown>, message: string) {
    await this.projectsService.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const contract = await this.loadContract(tx, tenantId, id);
      if (!from.includes(contract.status)) throw new DomainError('CONTRACT_INVALID_STATUS', message, 409);
      await tx.update(contractorContracts)
        .set({ ...patch, updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId })
        .where(and(eq(contractorContracts.tenantId, tenantId), eq(contractorContracts.id, id)));
      return this.loadContract(tx, tenantId, id);
    });
  }

  // -------------------------------------------------------------------- payments

  async listPayments(tenantId: string, filters: { contractId?: string; status?: string } = {}) {
    await this.projectsService.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(contractorPayments)
        .where(and(
          eq(contractorPayments.tenantId, tenantId),
          filters.contractId ? eq(contractorPayments.contractId, filters.contractId) : undefined,
          filters.status ? eq(contractorPayments.status, filters.status) : undefined,
        ))
        .orderBy(desc(contractorPayments.createdAt))
        .limit(200));
  }

  async createPayment(tenantId: string, contractId: string, input: ContractorPaymentInput) {
    await this.projectsService.ensureEnabled(tenantId);
    const kind: PaymentKind = input.kind ?? 'progress';
    const gross = dec(input.grossAmount);
    if (!gross.isFinite() || gross.lte(0)) throw new DomainError('CONTRACTOR_PAYMENT_AMOUNT_INVALID', 'The payment amount must be greater than zero', 422);

    const id = newId();
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const contract = await this.loadContract(tx, tenantId, contractId);
      if (contract.status !== 'active') throw new DomainError('CONTRACT_INVALID_STATUS', 'Payments can only be certified against an active contract', 409);
      const totals = this.contractTotals(contract, contract.payments);

      let retention = new Decimal(0);
      let recovery = dec(input.advanceRecovery ?? '0');
      if (recovery.lt(0)) throw new DomainError('CONTRACTOR_ADVANCE_RECOVERY_INVALID', 'Advance recovery cannot be negative', 422);

      if (kind === 'advance') {
        // A prepayment is not work done: it neither carries retention nor consumes value.
        const outstandingAdvance = dec(contract.advanceAmount).minus(totals.advanceIssued);
        if (gross.gt(outstandingAdvance)) throw new DomainError('CONTRACTOR_ADVANCE_EXCEEDED', `The agreed advance leaves only ${outstandingAdvance.toFixed(4)} to pay`, 422);
        recovery = new Decimal(0);
      } else if (kind === 'retention_release') {
        if (gross.gt(dec(totals.retentionHeld))) throw new DomainError('CONTRACTOR_RETENTION_EXCEEDED', `Only ${totals.retentionHeld} of retention is held on this contract`, 422);
        recovery = new Decimal(0);
      } else {
        retention = gross.mul(dec(contract.retentionPct)).div(100);
        const remainingValue = dec(contract.contractValue).minus(totals.certified);
        if (dec(contract.contractValue).gt(0) && gross.gt(remainingValue)) {
          throw new DomainError('CONTRACTOR_PAYMENT_EXCEEDS_CONTRACT', `Only ${remainingValue.toFixed(4)} of the contract value is left to certify`, 422);
        }
        const outstandingRecovery = dec(contract.advanceAmount).minus(dec(contract.advanceRecovered)).minus(totals.recoveryPlanned);
        if (recovery.gt(outstandingRecovery)) {
          throw new DomainError('CONTRACTOR_ADVANCE_RECOVERY_INVALID', `Only ${outstandingRecovery.toFixed(4)} of the advance is left to recover`, 422);
        }
      }

      const net = gross.minus(retention).minus(recovery);
      if (net.lt(0)) throw new DomainError('CONTRACTOR_PAYMENT_NET_NEGATIVE', 'Retention and advance recovery exceed the payment amount', 422);

      const allocated = await this.sequences.next({ tenantId, branchId: contract.projectBranchId, docType: 'contractor_payment' }, tx, { prefix: 'CP-', padding: 6 });
      await tx.insert(contractorPayments).values({
        id,
        tenantId,
        contractId,
        projectId: contract.projectId,
        branchId: contract.projectBranchId,
        number: allocated.display,
        kind,
        status: 'draft',
        paymentDate: input.paymentDate ?? today(),
        grossAmount: gross.toFixed(4),
        retentionAmount: retention.toFixed(4),
        advanceRecovery: recovery.toFixed(4),
        netAmount: net.toFixed(4),
        notes: input.notes,
        createdBy: tryGetAuthContext()?.userId,
      });
      const [row] = await tx.select().from(contractorPayments).where(and(eq(contractorPayments.tenantId, tenantId), eq(contractorPayments.id, id)));
      return row;
    });
  }

  async approvePayment(tenantId: string, paymentId: string) {
    await this.projectsService.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const payment = await this.loadPayment(tx, tenantId, paymentId);
      if (payment.status !== 'draft') throw new DomainError('CONTRACTOR_PAYMENT_INVALID_STATUS', 'Only a draft payment can be approved', 409);
      await tx.update(contractorPayments)
        .set({ status: 'approved', approvedAt: new Date(), approvedBy: tryGetAuthContext()?.userId, updatedAt: new Date() })
        .where(and(eq(contractorPayments.tenantId, tenantId), eq(contractorPayments.id, paymentId)));
      return this.loadPayment(tx, tenantId, paymentId);
    });
  }

  /**
   * Paying issues a **draft** treasury payment voucher for the net amount and links it.
   * Posting it to the ledger stays in treasury, where the accounts and the fiscal period
   * live; duplicating that here would give the money two doors into the journal.
   */
  async payPayment(tenantId: string, paymentId: string, input: PayInput) {
    await this.projectsService.ensureEnabled(tenantId);
    if (!input?.cashLocationId) throw new DomainError('CASH_LOCATION_REQUIRED', 'A cash or bank account is required to pay a contractor', 422);
    const payment = await withTenantTx(this.database.db, tenantId, (tx) => this.loadPayment(tx, tenantId, paymentId));
    if (payment.status !== 'approved') throw new DomainError('CONTRACTOR_PAYMENT_INVALID_STATUS', 'Only an approved payment can be paid', 409);
    const contract = await this.getContract(tenantId, payment.contractId);
    if (!contract.projectBranchId) throw new DomainError('PROJECT_BRANCH_REQUIRED', 'The project needs a branch before money can leave the treasury', 422);

    const voucher = await this.treasury.createVoucher(tenantId, {
      branchId: contract.projectBranchId,
      kind: 'payment',
      subtype: 'supplier',
      date: input.date ?? payment.paymentDate,
      partyId: contract.contractorPartyId,
      cashLocationId: input.cashLocationId,
      method: input.method ?? 'bank_transfer',
      amount: payment.netAmount,
      netAmount: payment.netAmount,
      chequeNo: input.chequeNo,
      chequeDate: input.chequeDate,
      bankName: input.bankName,
      referenceNo: payment.number,
      recipient: contract.title,
    });

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      await tx.update(contractorPayments)
        .set({ status: 'paid', paidAt: new Date(), voucherId: voucher?.id, updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId })
        .where(and(eq(contractorPayments.tenantId, tenantId), eq(contractorPayments.id, paymentId)));
      // Recovery only becomes real when the money actually moves.
      if (dec(payment.advanceRecovery).gt(0)) {
        await tx.update(contractorContracts)
          .set({ advanceRecovered: dec(contract.advanceRecovered).plus(dec(payment.advanceRecovery)).toFixed(4), updatedAt: new Date() })
          .where(and(eq(contractorContracts.tenantId, tenantId), eq(contractorContracts.id, contract.id)));
      }
      return this.loadPayment(tx, tenantId, paymentId);
    });
  }

  async cancelPayment(tenantId: string, paymentId: string) {
    await this.projectsService.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const payment = await this.loadPayment(tx, tenantId, paymentId);
      if (payment.status === 'paid') throw new DomainError('CONTRACTOR_PAYMENT_INVALID_STATUS', 'A paid certificate cannot be cancelled; void its voucher instead', 409);
      if (payment.status === 'cancelled') throw new DomainError('CONTRACTOR_PAYMENT_INVALID_STATUS', 'This payment is already cancelled', 409);
      await tx.update(contractorPayments)
        .set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId })
        .where(and(eq(contractorPayments.tenantId, tenantId), eq(contractorPayments.id, paymentId)));
      return this.loadPayment(tx, tenantId, paymentId);
    });
  }

  // ---------------------------------------------------------------------- offers

  async listOffers(tenantId: string, status?: string) {
    await this.projectsService.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(projectOffers)
        .where(and(eq(projectOffers.tenantId, tenantId), status ? eq(projectOffers.status, status) : undefined))
        .orderBy(desc(projectOffers.createdAt))
        .limit(200);
      if (!rows.length) return [];
      const lines = await tx.select().from(projectOfferLines).where(and(eq(projectOfferLines.tenantId, tenantId), inArray(projectOfferLines.offerId, rows.map((row) => row.id))));
      return rows.map((row) => ({ ...row, lines: lines.filter((line) => line.offerId === row.id).sort((a, b) => a.lineNo - b.lineNo) }));
    });
  }

  async createOffer(tenantId: string, input: OfferInput) {
    await this.projectsService.ensureEnabled(tenantId);
    if (!input.partyId) throw new DomainError('OFFER_PARTY_REQUIRED', 'An offer needs a client', 422);
    if (!input.title?.trim()) throw new DomainError('OFFER_TITLE_REQUIRED', 'An offer needs a title', 422);
    if (!input.lines?.length) throw new DomainError('OFFER_LINES_REQUIRED', 'An offer needs at least one line', 422);
    const retentionPct = dec(input.retentionPct ?? '0');
    if (retentionPct.lt(0) || retentionPct.gt(100)) throw new DomainError('OFFER_RETENTION_INVALID', 'Retention must be between 0 and 100 percent', 422);

    const lines = input.lines.map((line, index) => {
      const qty = dec(line.qty ?? '1');
      const unitValue = dec(line.unitValue);
      if (qty.lte(0)) throw new DomainError('OFFER_LINE_QTY_INVALID', 'Every offer line needs a quantity greater than zero', 422);
      if (unitValue.lt(0)) throw new DomainError('OFFER_LINE_VALUE_INVALID', 'An offer line cannot have a negative unit value', 422);
      return { lineNo: index + 1, code: line.code?.trim() || `B-${String(index + 1).padStart(3, '0')}`, description: line.description, qty: qty.toFixed(4), unitValue: unitValue.toFixed(4), lineValue: qty.mul(unitValue).toFixed(4) };
    });
    const totalValue = lines.reduce((sum, line) => sum.plus(line.lineValue), new Decimal(0));

    const id = newId();
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const allocated = await this.sequences.next({ tenantId, branchId: input.branchId, docType: 'project_offer' }, tx, { prefix: 'OF-', padding: 6 });
      await tx.insert(projectOffers).values({
        id,
        tenantId,
        branchId: input.branchId,
        partyId: input.partyId,
        number: allocated.display,
        title: input.title.trim(),
        status: 'draft',
        offerDate: input.offerDate ?? today(),
        validUntil: input.validUntil,
        totalValue: totalValue.toFixed(4),
        retentionPct: retentionPct.toFixed(4),
        notes: input.notes,
        createdBy: tryGetAuthContext()?.userId,
      });
      await tx.insert(projectOfferLines).values(lines.map((line) => ({ ...line, offerId: id, tenantId })));
      return this.loadOffer(tx, tenantId, id);
    });
  }

  async sendOffer(tenantId: string, id: string) {
    return this.transitionOffer(tenantId, id, ['draft'], { status: 'sent' }, 'Only a draft offer can be sent');
  }

  async acceptOffer(tenantId: string, id: string) {
    return this.transitionOffer(tenantId, id, ['draft', 'sent'], { status: 'accepted', decidedAt: new Date(), rejectionReason: null }, 'Only an open offer can be accepted');
  }

  async rejectOffer(tenantId: string, id: string, reason: string) {
    if (!reason?.trim()) throw new DomainError('OFFER_REASON_REQUIRED', 'A rejection must carry a reason', 422);
    return this.transitionOffer(tenantId, id, ['draft', 'sent'], { status: 'rejected', decidedAt: new Date(), rejectionReason: reason.trim() }, 'Only an open offer can be rejected');
  }

  /** Converting an accepted offer creates the project and copies its lines into the BOQ. */
  async convertOffer(tenantId: string, id: string, input: { code?: string; branchId?: string; startsOn?: string; endsOn?: string } = {}) {
    await this.projectsService.ensureEnabled(tenantId);
    const offer = await withTenantTx(this.database.db, tenantId, (tx) => this.loadOffer(tx, tenantId, id));
    if (offer.status === 'converted') throw new DomainError('OFFER_ALREADY_CONVERTED', 'This offer has already become a project', 409);
    if (offer.status !== 'accepted') throw new DomainError('OFFER_NOT_ACCEPTED', 'Only an accepted offer can be converted into a project', 409);
    if (offer.validUntil && offer.validUntil < today()) throw new DomainError('OFFER_EXPIRED', 'This offer has expired; re-issue it before converting', 422);

    const created = await this.projectsService.create(tenantId, {
      branchId: input.branchId ?? offer.branchId ?? undefined,
      code: input.code?.trim() || offer.number,
      name: offer.title,
      partyId: offer.partyId,
      contractValue: offer.totalValue,
      retentionPct: offer.retentionPct,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
    });
    const projectId = created.data.id;
    for (const line of offer.lines) {
      await this.projectsService.addBoq(tenantId, projectId, { code: line.code, description: line.description, qty: line.qty, unitValue: line.unitValue });
    }
    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.update(projectOffers)
        .set({ status: 'converted', projectId, updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId })
        .where(and(eq(projectOffers.tenantId, tenantId), eq(projectOffers.id, id))));
    return this.projectsService.read(tenantId, projectId);
  }

  private async transitionOffer(tenantId: string, id: string, from: string[], patch: Record<string, unknown>, message: string) {
    await this.projectsService.ensureEnabled(tenantId);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const offer = await this.loadOffer(tx, tenantId, id);
      if (!from.includes(offer.status)) throw new DomainError('OFFER_INVALID_STATUS', message, 409);
      await tx.update(projectOffers)
        .set({ ...patch, updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId })
        .where(and(eq(projectOffers.tenantId, tenantId), eq(projectOffers.id, id)));
      return this.loadOffer(tx, tenantId, id);
    });
  }

  // --------------------------------------------------------------------- helpers

  private async loadContract(tx: DrizzleTx, tenantId: string, id: string) {
    const [contract] = await tx.select().from(contractorContracts).where(and(eq(contractorContracts.tenantId, tenantId), eq(contractorContracts.id, id)));
    if (!contract) throw new DomainError('CONTRACT_NOT_FOUND', 'Contractor contract was not found', 404);
    const [lines, payments, project] = await Promise.all([
      tx.select().from(contractorContractLines).where(and(eq(contractorContractLines.tenantId, tenantId), eq(contractorContractLines.contractId, id))),
      tx.select().from(contractorPayments).where(and(eq(contractorPayments.tenantId, tenantId), eq(contractorPayments.contractId, id))),
      tx.select().from(projects).where(and(eq(projects.tenantId, tenantId), eq(projects.id, contract.projectId))),
    ]);
    return {
      ...contract,
      projectBranchId: project[0]?.branchId ?? null,
      projectName: project[0]?.name ?? null,
      lines: lines.sort((a, b) => a.lineNo - b.lineNo),
      payments: payments.sort((a, b) => a.number.localeCompare(b.number)),
      ...this.contractTotals(contract, payments),
    };
  }

  private async loadPayment(tx: DrizzleTx, tenantId: string, id: string) {
    const [payment] = await tx.select().from(contractorPayments).where(and(eq(contractorPayments.tenantId, tenantId), eq(contractorPayments.id, id)));
    if (!payment) throw new DomainError('CONTRACTOR_PAYMENT_NOT_FOUND', 'Contractor payment was not found', 404);
    return payment;
  }

  private async loadOffer(tx: DrizzleTx, tenantId: string, id: string) {
    const [offer] = await tx.select().from(projectOffers).where(and(eq(projectOffers.tenantId, tenantId), eq(projectOffers.id, id)));
    if (!offer) throw new DomainError('OFFER_NOT_FOUND', 'Offer was not found', 404);
    const lines = await tx.select().from(projectOfferLines).where(and(eq(projectOfferLines.tenantId, tenantId), eq(projectOfferLines.offerId, id)));
    return { ...offer, lines: lines.sort((a, b) => a.lineNo - b.lineNo) };
  }

  /** Money already committed on a contract. Cancelled certificates commit nothing. */
  private contractTotals(
    contract: { contractValue: string; advanceAmount: string; advanceRecovered: string },
    payments: Array<{ status: string; kind: string; grossAmount: string; retentionAmount: string; advanceRecovery: string; netAmount: string }>,
  ) {
    const live = payments.filter((payment) => LIVE_PAYMENT_STATUSES.includes(payment.status));
    const sum = (rows: typeof live, key: 'grossAmount' | 'retentionAmount' | 'advanceRecovery' | 'netAmount') =>
      rows.reduce((carry, row) => carry.plus(dec(row[key])), new Decimal(0));

    const certified = sum(live.filter((payment) => VALUE_CONSUMING_KINDS.includes(payment.kind)), 'grossAmount');
    const advanceIssued = sum(live.filter((payment) => payment.kind === 'advance'), 'grossAmount');
    const retentionWithheld = sum(live, 'retentionAmount');
    const retentionReleased = sum(live.filter((payment) => payment.kind === 'retention_release'), 'grossAmount');
    const recoveryPlanned = sum(live.filter((payment) => payment.status !== 'paid'), 'advanceRecovery');

    return {
      certified: certified.toFixed(4),
      remainingValue: Decimal.max(dec(contract.contractValue).minus(certified), 0).toFixed(4),
      advanceIssued: advanceIssued.toFixed(4),
      advanceOutstanding: Decimal.max(dec(contract.advanceAmount).minus(dec(contract.advanceRecovered)), 0).toFixed(4),
      retentionHeld: Decimal.max(retentionWithheld.minus(retentionReleased), 0).toFixed(4),
      paidNet: sum(live.filter((payment) => payment.status === 'paid'), 'netAmount').toFixed(4),
      recoveryPlanned: recoveryPlanned.toFixed(4),
    };
  }
}
