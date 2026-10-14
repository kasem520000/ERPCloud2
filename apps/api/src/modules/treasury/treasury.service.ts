/* eslint-disable no-restricted-syntax */
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { DomainError, isUuid, newId } from '@erp/contracts';
import {
  accounts,
  cashLocationBalances,
  cashLocations,
  cashTransfers,
  employees,
  expenseTypes,
  journalEntries,
  journalEntryLines,
  memberships,
  parties,
  paymentAllocations,
  shiftCloseLines,
  shiftCloses,
  cashCountLines,
  invoicePayments,
  salesInvoices,
  users,
  vouchers,
  withTenantTx,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import { tryGetAuthContext } from '../../request-context/request-context.js';
import { AccountingService, type JournalLineInput } from '../accounting/accounting.service.js';
import { WebhookPublisher } from '../developer/webhook-publisher.service.js';
import { PostingProfilesService } from '../organization/posting-profiles/posting-profiles.service.js';
import { SequencesService } from '../platform-services/index.js';
import { FileAttachmentRegistry } from '../platform-services/files/file-attachments.js';

export type VoucherInput = {
  branchId: string;
  kind: 'receipt' | 'payment';
  subtype: 'customer' | 'supplier' | 'expense' | 'account' | 'salary' | 'vat' | 'other';
  date: string;
  partyId?: string;
  counterAccountId?: string;
  cashLocationId: string;
  method: 'cash' | 'cheque' | 'bank_transfer' | 'card';
  amount: string;
  vatAmount?: string;
  netAmount?: string;
  currency?: string;
  chequeNo?: string;
  chequeDate?: string;
  bankName?: string;
  costCenterId?: string;
  referenceNo?: string;
  referenceDate?: string;
  recipient?: string;
  /**
   * 📝 البيان — the desktop's `Receipts.Notes`, which `BindReceiptToEntry` copies onto
   * the journal entry (`entry.Note = Receipt.Notes`). Without it a posted receipt reads
   * `receipt voucher RV-000004` in the ledger, which tells an auditor nothing.
   */
  description?: string;
  /** ⏰ الوقت — `HH:mm`. The desktop stores date *and* time, and حركة الصندوق filters by both. */
  voucherTime?: string;
  /** 👔 المندوب — `Receipts.SalesManID`, which the desktop carries onto the journal line. */
  salesmanId?: string;
  /** 💲 قيمة السند كما في عملتها الأجنبية; `amount` stays in the base currency. */
  foreignAmount?: string;
  fiscalPeriodId?: string;
  idempotencyKey?: string;
};
export type VoucherPostInput = {
  fiscalPeriodId?: string;
  journalLines?: JournalLineInput[];
  allocations?: Array<{ partyId: string; invoiceKind: string; invoiceId: string; amount: string }>;
};
export type TransferInput = {
  branchId: string;
  fromCashLocationId: string;
  toCashLocationId: string;
  amount: string;
  currency?: string;
};
export type ShiftCount = { currencyCode?: string; denomination: string; count: number };
export type MovementQuery = {
  /** `من تاريخ` — `YYYY-MM-DD`. */
  from?: string;
  /** `إلى تاريخ` — `YYYY-MM-DD`. */
  to?: string;
  /** `من وقت (HH:mm)` — the desktop defaults to `00:00`. */
  fromTime?: string;
  /** `إلى وقت (HH:mm)` — the desktop defaults to `23:59`. */
  toTime?: string;
  /** ☑ `كل الفترة` — no date window, no `رصيد سابق` line. */
  all?: boolean;
};
export type MovementRow = {
  seq: number;
  processType: string;
  number: string;
  date: string;
  income: string;
  outcome: string;
  balance: string;
  note: string;
  /** The `رصيد سابق` line — a presentation row the desktop prepends, never a real entry. */
  isOpening?: boolean;
};

const money = (value: string) => new Decimal(value);

const shiftDay = (day: string, days: number) => {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};
/**
 * `العملية` in the desktop is `Common.ResrirectionType(Entry.type)`. Our entry carries
 * `sourceType` instead, and a voucher's own kind decides whether it was money in or out —
 * a name an accountant can read, not a code.
 */
const processTypeAr = (sourceType: string | null, voucherKind: string | null) => {
  if (sourceType === 'voucher')
    return voucherKind === 'payment' ? 'سند صرف' : voucherKind === 'receipt' ? 'سند قبض' : 'سند';
  switch (sourceType) {
    case 'voucher_cheque':
      return 'شيك';
    case 'sales_invoice':
      return 'فاتورة مبيعات';
    case 'sales_return':
      return 'مرتجع مبيعات';
    case 'purchase_invoice':
      return 'فاتورة مشتريات';
    case 'purchase_return':
      return 'مرتجع مشتريات';
    case 'stock_voucher':
      return 'إذن مخزني';
    case 'stock_transfer':
    case 'stock_transfer_receipt':
      return 'مناقلة مخزنية';
    case 'stock_adjustment':
      return 'تسوية مخزنية';
    case 'reversal':
      return 'قيد عكسي';
    default:
      return 'قيد يومية';
  }
};

/**
 * ⏰ الوقت — `Receipts.ReceiptDate` carries a time as well as a date, and حركة الصندوق is
 * filtered من وقت / إلى وقت. A clerk types `9:05`, not `09:05:00`, so both are accepted and
 * the stored value is always `HH:mm:ss`.
 */
function normaliseTime(value?: string | null): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value).trim());
  const pad = (part: string) => part.padStart(2, '0');
  if (!match)
    throw new DomainError('VOUCHER_TIME_INVALID', 'Voucher time must look like 09:05', 422, {
      field: 'voucherTime',
    });
  const [hour, minute, second] = [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')];
  if (hour > 23 || minute > 59 || second > 59)
    throw new DomainError('VOUCHER_TIME_INVALID', 'Voucher time must look like 09:05', 422, {
      field: 'voucherTime',
    });
  return `${pad(String(hour))}:${pad(String(minute))}:${pad(String(second))}`;
}

@Injectable()
export class TreasuryService implements OnModuleInit {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly accounting: AccountingService,
    private readonly sequences: SequencesService,
    private readonly profiles: PostingProfilesService,
    // P-C11 — `shift.closed`: من ينتظر تقرير الوردية يعرف بغلاقها بلا أن يسأل.
    private readonly webhooks: WebhookPublisher,
    private readonly attachments: FileAttachmentRegistry,
  ) {}

  onModuleInit(): void {
    // 📎 إرفاق المستندات — `ReceiptOper.insertDocument` في الديسكتوب يحفظ صورة السند
    // كـ `Documents`؛ السحابة تستخدم `files` مع `entity=voucher`.
    this.attachments.register('voucher', async (tx, tenantId, entityId) => {
      const [row] = await tx
        .select({ id: vouchers.id })
        .from(vouchers)
        .where(and(eq(vouchers.tenantId, tenantId), eq(vouchers.id, entityId)))
        .limit(1);
      return row !== undefined;
    });
  }

  /**
   * `frmSandQ`'s 🔍 panel: 📅 من تاريخ / 📅 إلى تاريخ, 📋 كل الفترة, and a search by
   * 🔢 الرقم or رقم المرجع (`ReceiptOper.LoadReceipts`, `Class/ReceiptOper.cs:496`).
   */
  vouchers(tenantId: string, filters: { from?: string; to?: string; q?: string } = {}) {
    const q = filters.q?.trim();
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: vouchers.id,
          tenantId: vouchers.tenantId,
          branchId: vouchers.branchId,
          kind: vouchers.kind,
          subtype: vouchers.subtype,
          number: vouchers.number,
          date: vouchers.date,
          partyId: vouchers.partyId,
          counterAccountId: vouchers.counterAccountId,
          cashLocationId: vouchers.cashLocationId,
          method: vouchers.method,
          amount: vouchers.amount,
          vatAmount: vouchers.vatAmount,
          netAmount: vouchers.netAmount,
          currency: vouchers.currency,
          fxRate: vouchers.fxRate,
          chequeNo: vouchers.chequeNo,
          chequeDate: vouchers.chequeDate,
          bankName: vouchers.bankName,
          chequeState: vouchers.chequeState,
          costCenterId: vouchers.costCenterId,
          referenceNo: vouchers.referenceNo,
          referenceDate: vouchers.referenceDate,
          recipient: vouchers.recipient,
          description: vouchers.description,
          voucherTime: vouchers.voucherTime,
          salesmanId: vouchers.salesmanId,
          foreignAmount: vouchers.foreignAmount,
          status: vouchers.status,
          journalEntryId: vouchers.journalEntryId,
          fiscalPeriodId: vouchers.fiscalPeriodId,
          postedAt: vouchers.postedAt,
          voidedAt: vouchers.voidedAt,
          idempotencyKey: vouchers.idempotencyKey,
          createdAt: vouchers.createdAt,
          createdBy: vouchers.createdBy,
          /** محرر السند — `frmSandQ` / `frmSandD` تُظهر «محرر السند:» بجانب البيان. */
          createdByName: users.fullName,
          updatedAt: vouchers.updatedAt,
          updatedBy: vouchers.updatedBy,
          version: vouchers.version,
        })
        .from(vouchers)
        .leftJoin(users, eq(users.id, vouchers.createdBy))
        .where(
          and(
            eq(vouchers.tenantId, tenantId),
            filters.from ? gte(vouchers.date, filters.from) : undefined,
            filters.to ? lte(vouchers.date, filters.to) : undefined,
            q
              ? or(
                  ilike(vouchers.number, `%${q}%`),
                  ilike(vouchers.referenceNo, `%${q}%`),
                  ilike(vouchers.chequeNo, `%${q}%`),
                  ilike(vouchers.description, `%${q}%`),
                  ilike(vouchers.recipient, `%${q}%`),
                )
              : undefined,
          ),
        )
        .orderBy(desc(vouchers.date), desc(vouchers.createdAt))
        .limit(500);
      return rows;
    });
  }
  async getVoucher(tenantId: string, id: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: vouchers.id,
          tenantId: vouchers.tenantId,
          branchId: vouchers.branchId,
          kind: vouchers.kind,
          subtype: vouchers.subtype,
          number: vouchers.number,
          date: vouchers.date,
          partyId: vouchers.partyId,
          counterAccountId: vouchers.counterAccountId,
          cashLocationId: vouchers.cashLocationId,
          method: vouchers.method,
          amount: vouchers.amount,
          vatAmount: vouchers.vatAmount,
          netAmount: vouchers.netAmount,
          currency: vouchers.currency,
          fxRate: vouchers.fxRate,
          chequeNo: vouchers.chequeNo,
          chequeDate: vouchers.chequeDate,
          bankName: vouchers.bankName,
          chequeState: vouchers.chequeState,
          costCenterId: vouchers.costCenterId,
          referenceNo: vouchers.referenceNo,
          referenceDate: vouchers.referenceDate,
          recipient: vouchers.recipient,
          description: vouchers.description,
          voucherTime: vouchers.voucherTime,
          salesmanId: vouchers.salesmanId,
          foreignAmount: vouchers.foreignAmount,
          status: vouchers.status,
          journalEntryId: vouchers.journalEntryId,
          fiscalPeriodId: vouchers.fiscalPeriodId,
          postedAt: vouchers.postedAt,
          voidedAt: vouchers.voidedAt,
          idempotencyKey: vouchers.idempotencyKey,
          createdAt: vouchers.createdAt,
          createdBy: vouchers.createdBy,
          createdByName: users.fullName,
          updatedAt: vouchers.updatedAt,
          updatedBy: vouchers.updatedBy,
          version: vouchers.version,
        })
        .from(vouchers)
        .leftJoin(users, eq(users.id, vouchers.createdBy))
        .where(and(eq(vouchers.tenantId, tenantId), eq(vouchers.id, id)))
        .limit(1);
      return rows;
    });
    if (!row) throw new DomainError('VOUCHER_NOT_FOUND', 'Voucher was not found', 404);
    return row;
  }

  async createVoucher(tenantId: string, input: VoucherInput) {
    return withTenantTx(this.database.db, tenantId, (tx) => this.createVoucherInTx(tx, tenantId, input));
  }

  /**
   * AUD-10 — نسخةٌ تنفيذية داخل معاملةٍ قائمة. مسيّر الرواتب يحتاجها لينشئ سند الصرف،
   * ويرحّله، ويحدّث حالة المسيّر في **معاملة واحدة**: لا سندٌ يتيم إن فشل تحديث المسيّر،
   * ولا مسيّر «مدفوع» بلا سند إن فشل الإدراج.
   */
  async createVoucherInTx(tx: DrizzleTx, tenantId: string, input: VoucherInput) {
    const amount = money(input.amount);
    if (!amount.isFinite() || amount.lte(0))
      throw new DomainError('VOUCHER_AMOUNT_INVALID', 'Voucher amount must be positive', 422);
    if (input.method === 'cheque' && !input.chequeNo)
      throw new DomainError('CHEQUE_NO_REQUIRED', 'Cheque vouchers require a cheque number', 422);
    const voucherTime = normaliseTime(input.voucherTime);
    let fxRate: string | null = null;
    if (input.foreignAmount !== undefined && input.foreignAmount !== '') {
      const foreign = new Decimal(input.foreignAmount);
      if (!foreign.isFinite() || foreign.lte(0))
        throw new DomainError('VOUCHER_FOREIGN_AMOUNT_INVALID', 'Foreign amount must be positive', 422, {
          field: 'foreignAmount',
        });
      // 💱 سعر الصرف = المبلغ بالأساس ÷ المبلغ بالعملة الأجنبية — كما في `Receipts.ExchangePrice`
      // عند الديسكتوب (يُحسب من `val1 × exchange_price` في `frmInvBySalesMen` L254).
      fxRate = amount.div(foreign).toFixed(6);
    }
    if (input.salesmanId) await this.assertSalesmanInTx(tx, tenantId, input.salesmanId);
    const id = newId();
    const actorId = tryGetAuthContext()?.userId ?? null;
    const [row] = await tx
      .insert(vouchers)
      .values({
        id,
        tenantId,
        branchId: input.branchId,
        kind: input.kind,
        subtype: input.subtype,
        date: input.date,
        partyId: input.partyId,
        counterAccountId: input.counterAccountId,
        cashLocationId: input.cashLocationId,
        method: input.method,
        amount: input.amount,
        vatAmount: input.vatAmount ?? '0',
        netAmount: input.netAmount ?? input.amount,
        currency: input.currency ?? 'SAR',
        fxRate,
        chequeNo: input.chequeNo,
        chequeDate: input.chequeDate,
        bankName: input.bankName,
        chequeState: input.method === 'cheque' ? 'pending' : null,
        costCenterId: input.costCenterId,
        referenceNo: input.referenceNo,
        referenceDate: input.referenceDate,
        recipient: input.recipient,
        description: input.description?.trim() || null,
        voucherTime,
        salesmanId: input.salesmanId ?? null,
        foreignAmount: input.foreignAmount ?? null,
        fiscalPeriodId: input.fiscalPeriodId,
        idempotencyKey: input.idempotencyKey,
        createdBy: actorId,
        updatedBy: actorId,
      })
      .returning();
    return row;
  }

  /**
   * `frmSandQ.xaml.cs:903` updates the whole receipt, not just its money: date, reference,
   * treasury, salesman, payment type, the cheque block and the cost centre. A draft is a
   * draft — the one thing that cannot change is what the document *is* (`kind`/`subtype`),
   * because the numbering series and the journal shape are chosen from it.
   */
  async updateDraftVoucher(tenantId: string, id: string, input: Partial<VoucherInput>) {
    const row = await this.getVoucher(tenantId, id);
    if (row.status !== 'draft')
      throw new DomainError('VOUCHER_IMMUTABLE', 'Only draft vouchers can be changed', 409);
    if (input.salesmanId) await this.assertSalesman(tenantId, input.salesmanId);
    if (input.foreignAmount !== undefined && input.foreignAmount !== '') {
      const foreign = new Decimal(input.foreignAmount);
      if (!foreign.isFinite() || foreign.lte(0))
        throw new DomainError('VOUCHER_FOREIGN_AMOUNT_INVALID', 'Foreign amount must be positive', 422, {
          field: 'foreignAmount',
        });
    }
    const patch: Record<string, unknown> = { updatedAt: new Date(), updatedBy: tryGetAuthContext()?.userId ?? null };
    const assignments = {
      plain: <T>(value: T) => value,
      money: (value: string) => value,
      trimmed: (value: string) => value.trim() || null,
      time: (value: string) => normaliseTime(value),
    } as const;
    const copy = <K extends keyof typeof assignments>(key: string, field: K, value: unknown) => {
      if (value !== undefined) patch[key] = assignments[field](value as never);
    };
    copy('branchId', 'plain', input.branchId);
    copy('date', 'plain', input.date);
    copy('voucherTime', 'time', input.voucherTime);
    copy('partyId', 'plain', input.partyId);
    copy('counterAccountId', 'plain', input.counterAccountId);
    copy('cashLocationId', 'plain', input.cashLocationId);
    copy('method', 'plain', input.method);
    copy('amount', 'money', input.amount);
    copy('vatAmount', 'money', input.vatAmount);
    copy('netAmount', 'money', input.netAmount);
    copy('currency', 'plain', input.currency);
    copy('foreignAmount', 'money', input.foreignAmount);
    copy('chequeNo', 'plain', input.chequeNo);
    copy('chequeDate', 'plain', input.chequeDate);
    copy('bankName', 'plain', input.bankName);
    copy('costCenterId', 'plain', input.costCenterId);
    copy('referenceNo', 'plain', input.referenceNo);
    copy('referenceDate', 'plain', input.referenceDate);
    copy('recipient', 'plain', input.recipient);
    copy('description', 'trimmed', input.description);
    copy('salesmanId', 'plain', input.salesmanId);
    copy('fiscalPeriodId', 'plain', input.fiscalPeriodId);

    // 💱 إعادة حساب سعر الصرف عند تغيير amount أو foreignAmount
    const effectiveAmount = input.amount !== undefined ? input.amount : row.amount;
    const effectiveForeign = input.foreignAmount !== undefined ? input.foreignAmount : (row.foreignAmount as string | null);
    if (effectiveForeign && effectiveForeign !== '' && Number(effectiveForeign) > 0) {
      try {
        const amt = new Decimal(effectiveAmount);
        const frn = new Decimal(effectiveForeign);
        if (amt.isFinite() && frn.isFinite() && frn.gt(0)) {
          patch['fxRate'] = amt.div(frn).toFixed(6);
        }
      } catch {
        // ignore calc errors — validation already done
      }
    } else if (input.foreignAmount === '' || input.foreignAmount === null) {
      patch['fxRate'] = null;
      patch['foreignAmount'] = null;
    }

    await withTenantTx(this.database.db, tenantId, (tx) =>
      tx.update(vouchers).set(patch).where(and(eq(vouchers.tenantId, tenantId), eq(vouchers.id, id))),
    );
    return this.getVoucher(tenantId, id);
  }

  /** 👔 المندوب has to be one of *this* tenant's employees, or the commission is fiction. */
  private async assertSalesman(tenantId: string, salesmanId: string): Promise<void> {
    await withTenantTx(this.database.db, tenantId, (tx) => this.assertSalesmanInTx(tx, tenantId, salesmanId));
  }

  private async assertSalesmanInTx(tx: DrizzleTx, tenantId: string, salesmanId: string): Promise<void> {
    const [row] = await tx
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.tenantId, tenantId), eq(employees.id, salesmanId), isNull(employees.deletedAt)))
      .limit(1);
    if (!row)
      throw new DomainError('SALESMAN_NOT_FOUND', 'That employee does not belong to this tenant', 422, {
        field: 'salesmanId',
      });
  }

  /**
   * The two accounts a voucher moves money between.
   *
   * `BindReceiptToEntry` (`Class/ReceiptOper.cs:21`) always built them: debit the treasury
   * account (`Receipt.DebitAcc`) and credit the client's account (`Receipt.CreditAcc`), with
   * the cost centre on the client line. The cloud left it to the caller, and the callers who
   * forgot — HRM's `payRun`, for one — paid a salary out of the safe with **no entry at all**:
   * the cash left and the ledger never heard of it. From here the entry is built unless the
   * caller deliberately overrides it.
   */
  private async voucherAccounts(
    tx: DrizzleTx,
    tenantId: string,
    voucher: typeof vouchers.$inferSelect,
  ): Promise<{ cashAccountId: string; counterAccountId: string }> {
    const docType = voucher.kind === 'receipt' ? 'receipt_voucher' : 'payment_voucher';
    const [location] = await tx
      .select()
      .from(cashLocations)
      .where(and(eq(cashLocations.tenantId, tenantId), eq(cashLocations.id, voucher.cashLocationId)))
      .limit(1);
    if (!location)
      throw new DomainError('CASH_LOCATION_NOT_FOUND', 'That cash location does not belong to this tenant', 422, {
        field: 'cashLocationId',
      });
    const cashAccountId =
      location.accountId ??
      (await this.profileAccount(tx, tenantId, voucher.branchId, docType, location.kind === 'bank' ? 'bankAccountId' : 'cashAccountId', { required: false }));
    if (!cashAccountId)
      throw new DomainError(
        'CASH_ACCOUNT_REQUIRED',
        'This cash location has no linked account, and the branch posting profile names no cash account',
        422,
        { field: 'cashLocationId' },
      );

    let counterAccountId = voucher.counterAccountId ?? undefined;
    if (!counterAccountId && voucher.partyId) {
      const [party] = await tx
        .select()
        .from(parties)
        .where(and(eq(parties.tenantId, tenantId), eq(parties.id, voucher.partyId)))
        .limit(1);
      counterAccountId =
        voucher.kind === 'receipt'
          ? (party?.receivableAccountId ?? undefined)
          : (party?.payableAccountId ?? undefined);
    }
    if (!counterAccountId)
      counterAccountId = await this.profileAccount(
        tx,
        tenantId,
        voucher.branchId,
        docType,
        voucher.kind === 'receipt' ? 'receivableAccountId' : 'payableAccountId',
        { required: false },
      );
    if (!counterAccountId)
      throw new DomainError(
        'COUNTER_ACCOUNT_REQUIRED',
        'A voucher needs somewhere for the money to come from: set the party, the counter account, or the branch posting profile',
        422,
        { field: 'counterAccountId' },
      );
    return { cashAccountId, counterAccountId };
  }

  private async resolveProfile(
    tx: DrizzleTx,
    tenantId: string,
    branchId: string,
    docType: string,
  ): Promise<{ mapping: unknown } | undefined> {
    try {
      return await this.profiles.resolvePostProfileInTx(tx, tenantId, branchId, docType);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'ACCOUNT_PROFILE_MISSING') return undefined;
      throw error;
    }
  }

  /**
   * 🏦 حساب موقع نقد — `cash_locations.account_id`, بلا تخمين: خزنةٌ بلا حساب لا مدينَ
   * لها ولا دائن، فيُقال ذلك (`422 CASH_ACCOUNT_REQUIRED`) بدل أن يخرج القيد بسطرٍ ناقص.
   */
  private async locationAccount(tx: DrizzleTx, tenantId: string, cashLocationId: string) {
    const [row] = await tx
      .select({ accountId: cashLocations.accountId, label: cashLocations.name })
      .from(cashLocations)
      .where(
        and(
          eq(cashLocations.tenantId, tenantId),
          eq(cashLocations.id, cashLocationId),
          isNull(cashLocations.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new DomainError('CASH_LOCATION_NOT_FOUND', 'Cash location was not found', 404);
    if (!row.accountId)
      throw new DomainError(
        'CASH_ACCOUNT_REQUIRED',
        `«${row.label}» بلا حساب في الدليل — اربطه من «تعريف الخزن والبنوك» قبل تحريك المال`,
        422,
        { field: 'accountId' },
      );
    return row.accountId;
  }

  /**
   * 🧾 نقد تحت التحويل — the account that holds money between `📤 اعتماد الإرسال` and
   * `📥 تأكيد الاستلام`: the source safe is short and the destination is not yet long, and
   * that gap is a balance somebody has to carry. The desktop never needs one because it
   * moves money with a سند صرف and a سند قبض, each naming the other side
   * (`Form_WPF/frmPaymentVoucher.xaml.cs:559`); the cloud's transfer is one document in
   * two states. Resolved as the posting-profile key `cash_transfer.cashInTransitAccountId`
   * → the chart's own `1211003` (the cloud extension seeded next to `1270003` «بضاعة تحت
   * التحويل») → 422, never a guess.
   */
  private async transitAccount(tx: DrizzleTx, tenantId: string, branchId: string) {
    const configured = await this.profileAccount(
      tx,
      tenantId,
      branchId,
      'cash_transfer',
      'cashInTransitAccountId',
      { required: false },
    );
    if (configured) return configured;
    const [seeded] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.code, '1211003')))
      .limit(1);
    if (!seeded)
      throw new DomainError(
        'CASH_TRANSFER_TRANSIT_ACCOUNT_MISSING',
        'نقد تحت التحويل: لا حساب في الدليل ولا ملفُّ ترحيلٍ يسمّيه (1211003)',
        422,
        { field: 'cashInTransitAccountId' },
      );
    return seeded.id;
  }

  /**
   * 🧾 عهدة الإغلاق — the account the counted drawer is parked on at close.
   *
   * `ClosShiftAndroid.xaml.cs:1593` and `Class/EntryOper.cs:774` both hardcode `1211002`
   * «عهدة الإغلاق», and that is the order here too: the branch posting profile names it
   * if the tenant has one (`shift_close.custodyAccountId`), otherwise the chart's own
   * `1211002` is the answer — the desktop's constant, and the code the cloud's chart
   * ships with every tenant (`desktop-coa.ts:479`). A tenant without either gets a 422
   * that names what is missing, not a guess.
   */
  private async custodyAccount(tx: DrizzleTx, tenantId: string, branchId: string) {
    const configured = await this.profileAccount(tx, tenantId, branchId, 'shift_close', 'custodyAccountId', {
      required: false,
    });
    if (configured) return configured;
    const [seeded] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.code, '1211002')))
      .limit(1);
    if (!seeded)
      throw new DomainError(
        'SHIFT_CUSTODY_ACCOUNT_MISSING',
        'عهدة الإغلاق: لا حساب في الدليل ولا ملفُّ ترحيلٍ يسمّيه (1211002)',
        422,
        { field: 'custodyAccountId' },
      );
    return seeded.id;
  }

  private async profileAccount(
    tx: DrizzleTx,
    tenantId: string,
    branchId: string,
    docType: string,
    key: string,
    options: { required: boolean } = { required: true },
  ): Promise<string | undefined> {
    /**
     * A tenant that has never opened Settings › Posting profiles has no profile row at all,
     * and `ACCOUNT_PROFILE_MISSING` is the answer. That is a hard stop for an account the
     * engine *must* have, but not for one it is only *hoping* to find: the cash location's
     * own account, or the party's own account, is the better answer when it exists.
     */
    const profile = await this.resolveProfile(tx, tenantId, branchId, docType);
    const accountId = profile
      ? (profile.mapping as unknown as Record<string, string | null | undefined>)[key]
      : undefined;
    if (!accountId && options.required)
      throw new DomainError(
        'TREASURY_PROFILE_KEY_MISSING',
        `Posting profile has no ${key} — map it in Settings › Posting profiles`,
        422,
        { field: key },
      );
    return accountId ?? undefined;
  }

  /**
   * The entry a voucher writes, if the caller did not supply one. A pending cheque does not
   * touch the treasury: it sits in أوراق القبض (`chequesInHandAccountId`) until it clears,
   * which is why `bumpBalance` skips it and why the two have to agree.
   */
  private async defaultJournalLines(
    tx: DrizzleTx,
    tenantId: string,
    voucher: typeof vouchers.$inferSelect,
  ): Promise<JournalLineInput[]> {
    const { cashAccountId, counterAccountId } = await this.voucherAccounts(tx, tenantId, voucher);
    const treasuryAccountId =
      voucher.method === 'cheque'
        ? ((await this.profileAccount(tx, tenantId, voucher.branchId, voucher.kind === 'receipt' ? 'receipt_voucher' : 'payment_voucher', 'chequesInHandAccountId', { required: false })) ??
          cashAccountId)
        : cashAccountId;
    const amount = voucher.netAmount && Number(voucher.netAmount) > 0 ? voucher.netAmount : voucher.amount;
    const statement = voucher.description ?? (voucher.kind === 'receipt' ? 'سند قبض' : 'سند صرف');
    const counterLine: JournalLineInput = {
      accountId: counterAccountId,
      costCenterId: voucher.costCenterId ?? undefined,
      partyId: voucher.partyId ?? undefined,
      description: statement,
      ...(voucher.kind === 'receipt' ? { credit: amount } : { debit: amount }),
    };
    const treasuryLine: JournalLineInput = {
      accountId: treasuryAccountId,
      description: statement,
      ...(voucher.kind === 'receipt' ? { debit: amount } : { credit: amount }),
    };
    return [treasuryLine, counterLine];
  }

  async postVoucher(tenantId: string, id: string, input: VoucherPostInput = {}) {
    return withTenantTx(this.database.db, tenantId, (tx) => this.postVoucherInTx(tx, tenantId, id, input)).then(() =>
      this.getVoucher(tenantId, id),
    );
  }

  /**
   * AUD-10 — ترحيل سند داخل معاملةٍ قائمة: ينشئ مسيّر الرواتب السند ويرحّله ويحدّث حالة
   * المسيّر في معاملة واحدة. ودلالة إعادة المحاولة مقصودة:
   *
   *   • سندٌ **مرحّل** يُعاد كما هو — لا ترحيل ثانٍ ولا قيد ثانٍ؛
   *   • سندٌ غير موجود ⇒ 404، وسندٌ في حالة غير `draft` ⇒ 409؛
   *   • القفل الفعلي هو `status = 'draft'` في القراءة داخل المعاملة، فطلبان متزامنان
   *     لا يمرّان معاً: الثاني يرى الحالة بعد الأول.
   */
  async postVoucherInTx(tx: DrizzleTx, tenantId: string, id: string, input: VoucherPostInput = {}) {
    const [existing] = await tx
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.tenantId, tenantId), eq(vouchers.id, id)));
    if (!existing) throw new DomainError('VOUCHER_NOT_FOUND', 'Voucher was not found', 404);
    if (existing.status === 'posted') return existing;
    if (existing.status !== 'draft')
      throw new DomainError('VOUCHER_INVALID_STATUS', 'Only draft vouchers can be posted', 409);
    if (input.journalLines?.length && !input.fiscalPeriodId && !existing.fiscalPeriodId)
      throw new DomainError(
        'VOUCHER_FISCAL_PERIOD_REQUIRED',
        'A fiscal period is required for voucher journals',
        422,
      );
    if (!input.journalLines?.length && !input.fiscalPeriodId && !existing.fiscalPeriodId) {
      // Nothing to post into until we know the period — checked before any write so the
      // failure is a 422 on the request, not a half-written transaction.
      await this.accounting.openPeriodForDateInTx(tx, tenantId, existing.date);
    }
    const [locked] = await tx
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.tenantId, tenantId), eq(vouchers.id, id), eq(vouchers.status, 'draft')));
    if (!locked) throw new DomainError('VOUCHER_INVALID_STATUS', 'Only draft vouchers can be posted', 409);
    const allocated = await this.sequences.next(
      { tenantId, branchId: locked.branchId, docType: `${locked.kind}_voucher` },
      tx,
      { prefix: locked.kind === 'receipt' ? 'RV-' : 'PV-', padding: 6 },
    );
    let journalEntryId: string | null = null;
    const lines = input.journalLines?.length
      ? input.journalLines
      : await this.defaultJournalLines(tx, tenantId, locked);
    if (lines.length) {
      const journal = await this.accounting.postJournalInTx(tx, tenantId, {
        branchId: locked.branchId,
        fiscalPeriodId:
          input.fiscalPeriodId ??
          locked.fiscalPeriodId ??
          (await this.accounting.openPeriodForDateInTx(tx, tenantId, locked.date)),
        date: locked.date,
        description:
          locked.description?.trim() ||
          `${locked.kind === 'receipt' ? 'سند قبض' : 'سند صرف'} ${allocated.display}`,
        lines,
        sourceType: 'voucher',
        sourceId: id,
      });
      journalEntryId = journal?.id ?? null;
    }
    if (locked.method !== 'cheque')
      await this.bumpBalance(
        tx,
        tenantId,
        locked.cashLocationId,
        locked.currency,
        locked.kind === 'receipt' ? locked.amount : `-${locked.amount}`,
      );
    for (const allocation of input.allocations ?? []) {
      if (money(allocation.amount).lte(0) || money(allocation.amount).gt(money(locked.amount)))
        throw new DomainError(
          'ALLOCATION_AMOUNT_INVALID',
          'Allocation amount is outside voucher bounds',
          422,
        );
      await tx
        .insert(paymentAllocations)
        .values({
          id: newId(),
          tenantId,
          partyId: allocation.partyId,
          voucherId: id,
          invoiceKind: allocation.invoiceKind,
          invoiceId: allocation.invoiceId,
          amount: allocation.amount,
        });
    }
    await tx
      .update(vouchers)
      .set({
        status: 'posted',
        number: allocated.display,
        journalEntryId,
        postedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(vouchers.tenantId, tenantId), eq(vouchers.id, id)));
    // Same shape the caller would read back — no second read needed inside the transaction.
    return { ...existing, status: 'posted' as const, number: allocated.display, journalEntryId };
  }

  async voidVoucher(tenantId: string, id: string, reason: string) {
    if (!reason.trim()) throw new DomainError('VOUCHER_VOID_REASON_REQUIRED', 'Void reason is required', 422);
    const row = await this.getVoucher(tenantId, id);
    if (row.status !== 'posted')
      throw new DomainError('VOUCHER_INVALID_STATUS', 'Only posted vouchers can be voided', 409);
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      if (row.method !== 'cheque')
        await this.bumpBalance(
          tx,
          tenantId,
          row.cashLocationId,
          row.currency,
          row.kind === 'receipt' ? `-${row.amount}` : row.amount,
        );
      await tx
        .update(vouchers)
        .set({ status: 'voided', voidedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(vouchers.tenantId, tenantId), eq(vouchers.id, id)));
    });
    return this.getVoucher(tenantId, id);
  }

  async transitionCheque(tenantId: string, id: string, action: 'clear' | 'bounce' | 'collect') {
    const target = action === 'clear' ? 'cleared' : action === 'bounce' ? 'bounced' : 'collected';
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      /** `typeof vouchers.$inferSelect` — the full row, so the entry can read its البيان. */
      const [row] = await tx
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.tenantId, tenantId), eq(vouchers.id, id)));
      if (!row || row.method !== 'cheque' || row.status !== 'posted')
        throw new DomainError('CHEQUE_INVALID_STATE', 'Cheque voucher is not posted', 422);
      if (row.chequeState !== 'pending')
        throw new DomainError('CHEQUE_INVALID_STATE', 'Cheque transition is terminal', 422);
      /**
       * A pending cheque is a promise, not money: أوراق القبض holds it until the bank
       * honours it. Clearing is what turns the promise into cash — Dr البنك / Cr أوراق
       * القبض — and bouncing is what takes it back: the customer owes the money again.
       * The cloud used to move the balance here with no entry at all, so a cleared cheque
       * was invisible to the ledger the bank statement has to agree with.
       */
      if (target === 'cleared' || target === 'collected') {
        await this.bumpBalance(
          tx,
          tenantId,
          row.cashLocationId,
          row.currency,
          row.kind === 'receipt' ? row.amount : `-${row.amount}`,
        );
        const { cashAccountId } = await this.voucherAccounts(tx, tenantId, row);
        const docType = row.kind === 'receipt' ? 'receipt_voucher' : 'payment_voucher';
        const chequesAccountId =
          (await this.profileAccount(tx, tenantId, row.branchId, docType, 'chequesInHandAccountId', {
            required: false,
          })) ?? cashAccountId;
        const amount = row.netAmount && Number(row.netAmount) > 0 ? row.netAmount : row.amount;
        const statement = row.description?.trim() || `${row.kind === 'receipt' ? 'سند قبض' : 'سند صرف'} ${row.number ?? ''}`.trim();
        await this.accounting.postJournalInTx(tx, tenantId, {
          branchId: row.branchId,
          fiscalPeriodId:
            row.fiscalPeriodId ?? (await this.accounting.openPeriodForDateInTx(tx, tenantId, row.date)),
          date: row.date,
          description: `${target === 'collected' ? 'تحصيل' : 'تحصيل'} شيك ${row.chequeNo ?? ''}`.trim(),
          lines:
            row.kind === 'receipt'
              ? [
                  { accountId: cashAccountId, debit: amount, description: statement },
                  { accountId: chequesAccountId, credit: amount, description: statement },
                ]
              : [
                  { accountId: chequesAccountId, debit: amount, description: statement },
                  { accountId: cashAccountId, credit: amount, description: statement },
                ],
          sourceType: 'voucher_cheque',
          sourceId: id,
          idempotencyKey: `voucher-cheque:${id}:${target}`,
        });
      }
      if (target === 'bounced') {
        const { cashAccountId, counterAccountId } = await this.voucherAccounts(tx, tenantId, row);
        const docType = row.kind === 'receipt' ? 'receipt_voucher' : 'payment_voucher';
        const chequesAccountId =
          (await this.profileAccount(tx, tenantId, row.branchId, docType, 'chequesInHandAccountId', {
            required: false,
          })) ?? cashAccountId;
        const amount = row.netAmount && Number(row.netAmount) > 0 ? row.netAmount : row.amount;
        const statement = row.description?.trim() || 'شيك مرتجع';
        // مرتجع: the cheque never became money, so the debt it was meant to settle returns.
        await this.accounting.postJournalInTx(tx, tenantId, {
          branchId: row.branchId,
          fiscalPeriodId:
            row.fiscalPeriodId ?? (await this.accounting.openPeriodForDateInTx(tx, tenantId, row.date)),
          date: row.date,
          description: `ارتجاع شيك ${row.chequeNo ?? ''}`.trim(),
          lines:
            row.kind === 'receipt'
              ? [
                  { accountId: counterAccountId, debit: amount, description: statement },
                  { accountId: chequesAccountId, credit: amount, description: statement },
                ]
              : [
                  { accountId: chequesAccountId, debit: amount, description: statement },
                  { accountId: counterAccountId, credit: amount, description: statement },
                ],
          sourceType: 'voucher_cheque',
          sourceId: id,
          idempotencyKey: `voucher-cheque:${id}:bounced`,
        });
      }
      await tx
        .update(vouchers)
        .set({ chequeState: target, updatedAt: new Date() })
        .where(
          and(eq(vouchers.tenantId, tenantId), eq(vouchers.id, id), eq(vouchers.chequeState, 'pending')),
        );
      return { id, chequeState: target };
    });
  }

  async createTransfer(tenantId: string, input: TransferInput) {
    if (input.fromCashLocationId === input.toCashLocationId)
      throw new DomainError('CASH_TRANSFER_INVALID', 'Transfer requires distinct locations', 422);
    const amount = money(input.amount);
    if (!amount.isFinite() || amount.lte(0))
      throw new DomainError('CASH_TRANSFER_AMOUNT_INVALID', 'Transfer amount must be positive', 422);
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(cashTransfers)
        .values({
          id: newId(),
          tenantId,
          branchId: input.branchId,
          fromCashLocationId: input.fromCashLocationId,
          toCashLocationId: input.toCashLocationId,
          amount: input.amount,
          currency: input.currency ?? 'SAR',
        })
        .returning(),
    );
    return row;
  }
  /**
   * 🔍 البحث — `frmSafesTransfer.xaml` «📊 نتائج البحث»: `🔢 رقم التحويل` ·
   * `📅 من تاريخ` · `📅 إلى تاريخ` · `📋 كل الفترة` · `🔍 بحث`. The grid binds
   * `SafeFromName`/`SafeToName`, so the two sides are resolved here rather than in the
   * browser — a screen that resolves a name is a screen that can show the wrong one.
   */
  transfers(
    tenantId: string,
    filters: { status?: string; number?: string; from?: string; to?: string } = {},
  ) {
    const fromSide = alias(cashLocations, 'from_side');
    const toSide = alias(cashLocations, 'to_side');
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select({
          id: cashTransfers.id,
          branchId: cashTransfers.branchId,
          fromCashLocationId: cashTransfers.fromCashLocationId,
          toCashLocationId: cashTransfers.toCashLocationId,
          /** 🏦 من خزنة */
          fromName: fromSide.name,
          /** 🏦 إلى خزنة */
          toName: toSide.name,
          number: cashTransfers.number,
          amount: cashTransfers.amount,
          currency: cashTransfers.currency,
          status: cashTransfers.status,
          /**
           * 💸 في الطريق — `in_transit` تعني أنّ الإرسال وقع والاستلام لم يقع، وهذا ما
           * تقوله الأرصدة (`📊 عدد المناقلات` / `🚧 في الطريق` في الشاشة). وأعمدة القيد
           * تُعلَن في الشبكة كما تُعلَن في السجل، فيرى المحاسب أيّ الحالتين قُيِّدت.
           */
          sentJournalEntryId: cashTransfers.sentJournalEntryId,
          receivedJournalEntryId: cashTransfers.receivedJournalEntryId,
          sentAt: cashTransfers.sentAt,
          receivedAt: cashTransfers.receivedAt,
          createdAt: cashTransfers.createdAt,
        })
        .from(cashTransfers)
        .leftJoin(fromSide, eq(fromSide.id, cashTransfers.fromCashLocationId))
        .leftJoin(toSide, eq(toSide.id, cashTransfers.toCashLocationId))
        .where(
          and(
            eq(cashTransfers.tenantId, tenantId),
            filters.status ? eq(cashTransfers.status, filters.status) : undefined,
            filters.number ? ilike(cashTransfers.number, `%${filters.number}%`) : undefined,
            filters.from ? gte(cashTransfers.createdAt, new Date(`${filters.from}T00:00:00.000Z`)) : undefined,
            filters.to ? lte(cashTransfers.createdAt, new Date(`${filters.to}T23:59:59.999Z`)) : undefined,
          ),
        )
        .orderBy(desc(cashTransfers.createdAt))
        .limit(200),
    );
  }

  /**
   * 🗑️ حذف / إلغاء — `frmSafesTransfer` keeps `IS_Deleted` on the row rather than
   * erasing it, and only a transfer nobody has sent can be dropped: once the money has
   * left the source safe, the only honest way back is a transfer in the other direction.
   * The status written is `voided`, the word migration `0011` already allows for a
   * document that was written and then abandoned — no new state was invented here.
   */
  async cancelTransfer(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(cashTransfers)
        .where(and(eq(cashTransfers.tenantId, tenantId), eq(cashTransfers.id, id)));
      if (!row) throw new DomainError('CASH_TRANSFER_NOT_FOUND', 'Cash transfer was not found', 404);
      if (row.status !== 'draft')
        throw new DomainError(
          'CASH_TRANSFER_INVALID_STATE',
          'Only a draft transfer can be cancelled — send it back instead',
          422,
        );
      await tx
        .update(cashTransfers)
        .set({ status: 'voided', updatedAt: new Date() })
        .where(and(eq(cashTransfers.tenantId, tenantId), eq(cashTransfers.id, id)));
      return { id, status: 'voided' };
    });
  }
  async sendTransfer(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(cashTransfers)
        .where(
          and(
            eq(cashTransfers.tenantId, tenantId),
            eq(cashTransfers.id, id),
            eq(cashTransfers.status, 'draft'),
          ),
        );
      if (!row) throw new DomainError('CASH_TRANSFER_INVALID_STATE', 'Only draft transfers can be sent', 422);
      const allocated = await this.sequences.next(
        { tenantId, branchId: row.branchId, docType: 'cash_transfer' },
        tx,
        { prefix: 'CT-', padding: 6 },
      );
      /**
       * 📤 اعتماد الإرسال — the money leaves the source safe and goes **into transit**,
       * not into the destination: the destination only has it once somebody signs for it
       * (`📥 تأكيد الاستلام`). The two facts have to agree — the balance went down and the
       * ledger must say where to — so the entry is:
       *
       *   Dr نقد تحت التحويل (1211003)   amount
       *   Cr خزنة المصدر (حسابها)          amount
       *
       * `cash_transfers.sent_journal_entry_id` (الترحيل `0011`) is the column this entry
       * was always meant for; it stayed NULL while the service moved balances only.
       */
      const fromAccountId = await this.locationAccount(tx, tenantId, row.fromCashLocationId);
      const transitAccountId = await this.transitAccount(tx, tenantId, row.branchId);
      const sentEntry = await this.accounting.postJournalInTx(tx, tenantId, {
        branchId: row.branchId,
        fiscalPeriodId: await this.accounting.openPeriodForDateInTx(
          tx,
          tenantId,
          new Date().toISOString().slice(0, 10),
        ),
        date: new Date().toISOString().slice(0, 10),
        description: `ارسال مناقلة ${allocated.display ?? ''}`.trim(),
        lines: [
          { accountId: transitAccountId, debit: row.amount, description: `مناقلة ${allocated.display ?? ''}` },
          { accountId: fromAccountId, credit: row.amount, description: `مناقلة ${allocated.display ?? ''}` },
        ],
        sourceType: 'cash_transfer',
        sourceId: id,
        idempotencyKey: `cash-transfer:${id}:sent`,
      });
      if (!sentEntry) throw new DomainError('NOT_FOUND', 'Journal entry was not created', 500);
      await this.bumpBalance(tx, tenantId, row.fromCashLocationId, row.currency, `-${row.amount}`);
      await tx
        .update(cashTransfers)
        .set({
          /** 💸 في الطريق — `sent` تعني خرج ولم يصل: الحالة تصف ما تقوله الأرصدة. */
          status: 'sent',
          number: allocated.display,
          sentAt: new Date(),
          sentJournalEntryId: sentEntry.id,
          updatedAt: new Date(),
        })
        .where(and(eq(cashTransfers.tenantId, tenantId), eq(cashTransfers.id, id)));
      return {
        id,
        status: 'sent',
        number: allocated.display,
        sentJournalEntryId: sentEntry.id,
        cashInTransitAccountId: transitAccountId,
      };
    });
  }
  async receiveTransfer(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(cashTransfers)
        .where(
          and(
            eq(cashTransfers.tenantId, tenantId),
            eq(cashTransfers.id, id),
            eq(cashTransfers.status, 'sent'),
          ),
        );
      if (!row)
        throw new DomainError('CASH_TRANSFER_INVALID_STATE', 'Only sent transfers can be received', 422);
      /**
       * 📥 تأكيد الاستلام — what was in transit reaches the destination safe:
       *
       *   Dr خزنة الوصول (حسابها)          amount
       *   Cr نقد تحت التحويل (1211003)    amount
       *
       * and the transit account is empty again: the pair of entries leaves the money in
       * exactly one place at every moment, which is what the two `*_journal_entry_id`
       * columns were put on the table for in `0011`.
       */
      const toAccountId = await this.locationAccount(tx, tenantId, row.toCashLocationId);
      const transitAccountId = await this.transitAccount(tx, tenantId, row.branchId);
      const receivedEntry = await this.accounting.postJournalInTx(tx, tenantId, {
        branchId: row.branchId,
        fiscalPeriodId: await this.accounting.openPeriodForDateInTx(
          tx,
          tenantId,
          new Date().toISOString().slice(0, 10),
        ),
        date: new Date().toISOString().slice(0, 10),
        description: `استلام مناقلة ${row.number ?? ''}`.trim(),
        lines: [
          { accountId: toAccountId, debit: row.amount, description: `مناقلة ${row.number ?? ''}` },
          { accountId: transitAccountId, credit: row.amount, description: `مناقلة ${row.number ?? ''}` },
        ],
        sourceType: 'cash_transfer',
        sourceId: id,
        idempotencyKey: `cash-transfer:${id}:received`,
      });
      if (!receivedEntry) throw new DomainError('NOT_FOUND', 'Journal entry was not created', 500);
      await this.bumpBalance(tx, tenantId, row.toCashLocationId, row.currency, row.amount);
      await tx
        .update(cashTransfers)
        .set({
          status: 'received',
          receivedAt: new Date(),
          receivedJournalEntryId: receivedEntry.id,
          updatedAt: new Date(),
        })
        .where(and(eq(cashTransfers.tenantId, tenantId), eq(cashTransfers.id, id)));
      return { id, status: 'received', receivedJournalEntryId: receivedEntry.id };
    });
  }

  listExpenseTypes(tenantId: string) {
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(expenseTypes)
        .where(and(eq(expenseTypes.tenantId, tenantId), isNull(expenseTypes.deletedAt))),
    );
  }
  async createExpenseType(
    tenantId: string,
    input: { nameAr: string; nameEn?: string; accountId: string; costCenterId?: string },
  ) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .insert(expenseTypes)
        .values({ id: newId(), tenantId, ...input })
        .returning(),
    );
    return row;
  }
  async updateExpenseType(
    tenantId: string,
    id: string,
    input: { nameAr?: string; nameEn?: string | null; accountId?: string; costCenterId?: string | null },
  ) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(expenseTypes)
        .set({
          ...(input.nameAr === undefined ? {} : { nameAr: input.nameAr }),
          ...(input.nameEn === undefined ? {} : { nameEn: input.nameEn }),
          ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
          ...(input.costCenterId === undefined ? {} : { costCenterId: input.costCenterId }),
          updatedAt: new Date(),
        })
        .where(
          and(eq(expenseTypes.tenantId, tenantId), eq(expenseTypes.id, id), isNull(expenseTypes.deletedAt)),
        )
        .returning(),
    );
    if (!row) throw new DomainError('NOT_FOUND', 'Expense card was not found', 404);
    return row;
  }
  /** Expense cards are only labels over an account, so removing one never touches the ledger. */
  async deleteExpenseType(tenantId: string, id: string) {
    const result = await withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .update(expenseTypes)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(eq(expenseTypes.tenantId, tenantId), eq(expenseTypes.id, id), isNull(expenseTypes.deletedAt)),
        ),
    );
    if (!result.rowCount) throw new DomainError('NOT_FOUND', 'Expense card was not found', 404);
    return { id, deleted: true };
  }

  async openShift(tenantId: string, branchId: string, userId: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      /**
       * One open drawer per cashier per branch — `shift_closes_one_open_key`. The desktop
       * never lets a cashier open a second one (`ClosShiftAndroid` works on the open
       * close), and a database constraint is a 500 to the cashier unless it is asked
       * about first.
       */
      const [open] = await tx
        .select({ id: shiftCloses.id })
        .from(shiftCloses)
        .where(
          and(
            eq(shiftCloses.tenantId, tenantId),
            eq(shiftCloses.branchId, branchId),
            eq(shiftCloses.userId, userId),
            eq(shiftCloses.status, 'open'),
          ),
        );
      if (open)
        throw new DomainError(
          'SHIFT_ALREADY_OPEN',
          'هذا المستخدم لديه وردية مفتوحة على هذا الفرع — أغلقها قبل فتح وردية جديدة',
          409,
        );
      const [row] = await tx
        .insert(shiftCloses)
        .values({ id: newId(), tenantId, branchId, userId, status: 'open' })
        .returning();
      return row;
    });
  }
  /**
   * The caller's open shift, with its takings *so far* attached as `live` — the
   * same numbers `closeShift` will freeze, so a cashier can see what the drawer
   * should hold before counting it.
   */
  /**
   * الشاشة تسأل عن وردية *الفرع المختار*؛ و`branch_id` يأتي من الرابط نصّاً، فقيمةٌ
   * ليست معرّفاً حقيقياً كانت تُقارَن بعمود `uuid` فيرد Postgres خطأً ويُترجَم 500.
   * وفرعٌ لا يمكن أن يكون فرعاً لا ورديةَ له: الجواب `null` — وهو نفس ما تقرأه الشاشة
   * حين لا توجد وردية مفتوحة، فلا مسار خطأٍ ثالثاً في واجهة الصندوق.
   */
  async currentShift(tenantId: string, branchId: string, userId: string) {
    if (!isUuid(branchId)) return null;
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [shift] = await tx
        .select()
        .from(shiftCloses)
        .where(
          and(
            eq(shiftCloses.tenantId, tenantId),
            eq(shiftCloses.branchId, branchId),
            eq(shiftCloses.userId, userId),
            eq(shiftCloses.status, 'open'),
          ),
        );
      if (!shift) return null;
      return { ...shift, live: await this.shiftTakings(tx, tenantId, shift) };
    });
  }

  /**
   * What the till has taken since `shift` opened: manual cash vouchers plus the
   * payments the sales engine wrote for this shift's invoices (or, for invoices
   * captured with no shift, for this branch during the window). Returns are
   * separated so a refund never inflates the drawer.
   */
  private async shiftTakings(
    tx: DrizzleTx,
    tenantId: string,
    shift: { id: string; branchId: string; openedAt: Date },
  ) {
    const posted = await tx
      .select()
      .from(vouchers)
      .where(
        and(
          eq(vouchers.tenantId, tenantId),
          eq(vouchers.branchId, shift.branchId),
          eq(vouchers.status, 'posted'),
          eq(vouchers.method, 'cash'),
          sql`${vouchers.postedAt} >= ${shift.openedAt}`,
        ),
      );
    const voucherCash = posted.reduce(
      (sum, row) => sum.plus(row.kind === 'receipt' ? row.amount : `-${row.amount}`),
      new Decimal(0),
    );

    const settled = await tx
      .select({
        method: invoicePayments.method,
        amount: invoicePayments.amount,
        kind: salesInvoices.kind,
        /** 🏦 أي بنك؟ `EntryOper.cs:493` يفرّق التحويل المسمّى من شبكة بلا اسم. */
        cashLocationId: invoicePayments.cashLocationId,
      })
      .from(invoicePayments)
      .innerJoin(salesInvoices, eq(salesInvoices.id, invoicePayments.invoiceId))
      .where(
        and(
          eq(invoicePayments.tenantId, tenantId),
          eq(salesInvoices.tenantId, tenantId),
          eq(salesInvoices.branchId, shift.branchId),
          gte(invoicePayments.createdAt, shift.openedAt),
          ne(salesInvoices.status, 'voided'),
          or(eq(salesInvoices.shiftId, shift.id), isNull(salesInvoices.shiftId)),
        ),
      );

    const zero = () => ({
      cash: new Decimal(0),
      card: new Decimal(0),
      bank: new Decimal(0),
      credit: new Decimal(0),
      other: new Decimal(0),
    });
    const sales = zero();
    const returns = zero();
    const bucket = (method: string) =>
      method === 'cash' || method === 'card' || method === 'bank' || method === 'credit' ? method : 'other';
    /**
     * 🏦 البنوك — `Class/EntryOper.cs` L493 وL537 وL620.
     * A bank transfer is network money that went to a **named** bank, so the close
     * keeps it apart: an unnamed transfer stays in 🌐 الشبكة (the desktop's
     * `BankId > 2` test — ids 1 and 2 are its الصندوق/المحفظة placeholders, which in
     * our model are simply not of kind `bank`), while a named one earns a line of
     * its own, and the close's entry debits *that* bank's account instead of the
     * generic network account. Returns subtract from the same bank.
     */
    const perBank = new Map<string, Decimal>();
    for (const row of settled) {
      const isReturn = row.kind === 'sale_return' || row.kind === 'credit_note';
      const target = isReturn ? returns : sales;
      target[bucket(row.method)] = target[bucket(row.method)].plus(row.amount);
      if (row.method !== 'bank' || !row.cashLocationId) continue;
      const running = perBank.get(row.cashLocationId) ?? new Decimal(0);
      perBank.set(row.cashLocationId, isReturn ? running.minus(row.amount) : running.plus(row.amount));
    }
    const namedBanks = await tx
      .select({ id: cashLocations.id, name: cashLocations.name })
      .from(cashLocations)
      .where(
        and(
          eq(cashLocations.tenantId, tenantId),
          perBank.size > 0 ? inArray(cashLocations.id, [...perBank.keys()]) : isNull(cashLocations.id),
        ),
      );
    const banks = namedBanks
      .map((bank) => ({ id: bank.id, name: bank.name, amount: (perBank.get(bank.id) ?? new Decimal(0)).toFixed(4) }))
      .sort((left, right) => Number(right.amount) - Number(left.amount));

    // ══ what the drawer actually sold — the invoice side of `frmCloseShift` ══
    // `ClosShiftAndroid.xaml.cs` L780–L930 walks the shift's own invoices and carries
    // four totals the method buckets above cannot produce: the net (💹 الصافي), the VAT
    // (🧾 الضريبة), the discount (🏷️ الخصم) and the postponed sales (📋 آجل — invoices
    // the customer did not settle). Returns subtract from all four, so a refunded sale
    // shrinks the VAT it once added.
    const invoices = await tx
      .select({
        kind: salesInvoices.kind,
        total: salesInvoices.total,
        tax: salesInvoices.taxTotal,
        discount: salesInvoices.invoiceDiscount,
        paid: salesInvoices.paidTotal,
      })
      .from(salesInvoices)
      .where(
        and(
          eq(salesInvoices.tenantId, tenantId),
          eq(salesInvoices.branchId, shift.branchId),
          ne(salesInvoices.status, 'voided'),
          gte(salesInvoices.createdAt, shift.openedAt),
          or(eq(salesInvoices.shiftId, shift.id), isNull(salesInvoices.shiftId)),
        ),
      );

    let net = new Decimal(0);
    let tax = new Decimal(0);
    let discount = new Decimal(0);
    let postponed = new Decimal(0);
    for (const row of invoices) {
      const sign = row.kind === 'sale_return' || row.kind === 'credit_note' ? -1 : 1;
      const invoiceTotal = money(row.total ?? '0');
      net = net.plus(invoiceTotal.mul(sign));
      tax = tax.plus(money(row.tax ?? '0').mul(sign));
      discount = discount.plus(money(row.discount ?? '0').mul(sign));
      const unpaid = invoiceTotal.minus(money(row.paid ?? '0'));
      if (unpaid.gt(0)) postponed = postponed.plus(unpaid.mul(sign));
    }

    // ══ 📤 المصاريف — `ClosShiftAndroid.xaml.cs` L592, `ReceiptType = 8` ══
    // Money that left the drawer for expenses, split into the four named buckets the
    // desktop keeps beside it (🚗 توصيل، ☕ الضيافة، 🛒 المشتريات، 🛡️ تأمين). The
    // desktop takes those from columns our invoices do not carry; the voucher's counter
    // account already points at an expense type, so the type's own name decides the
    // bucket — no new column, and a tenant that names its types in Arabic gets the split
    // for free.
    const types = await tx
      .select({ nameAr: expenseTypes.nameAr, accountId: expenseTypes.accountId })
      .from(expenseTypes)
      .where(and(eq(expenseTypes.tenantId, tenantId), isNull(expenseTypes.deletedAt)));
    const bucketOfExpense = (accountId: string | null) => {
      const name = types.find((type) => type.accountId === accountId)?.nameAr ?? '';
      if (name.includes('توصيل')) return 'delivery';
      if (name.includes('ضيافة')) return 'hospitality';
      if (name.includes('مشتريات')) return 'purchases';
      if (name.includes('تأمين')) return 'insurance';
      return 'other';
    };
    const expenses = { total: new Decimal(0), delivery: new Decimal(0), hospitality: new Decimal(0), purchases: new Decimal(0), insurance: new Decimal(0), other: new Decimal(0) };
    for (const row of posted) {
      if (row.kind !== 'payment' || row.subtype !== 'expense') continue;
      const amount = money(row.amount);
      expenses.total = expenses.total.plus(amount);
      const key = bucketOfExpense(row.counterAccountId ?? null);
      expenses[key] = expenses[key].plus(amount);
    }

    // 🌐 الشبكة — the desktop's `NetworkSum`: card and bank together, returns subtracted.
    const network = sales.card.plus(sales.bank).minus(returns.card).minus(returns.bank);
    const expectedCash = voucherCash.plus(sales.cash).minus(returns.cash);

    return {
      vouchers: posted.length,
      vouchersCash: voucherCash.toFixed(4),
      /** Kept as the number of settled payment rows — `pos-checkout` asserts on it. */
      invoices: settled.length,
      /** The invoices themselves, which is what the totals below are summed over. */
      invoiceRows: invoices.length,
      sales: {
        cash: sales.cash.toFixed(4),
        card: sales.card.toFixed(4),
        bank: sales.bank.toFixed(4),
        credit: sales.credit.toFixed(4),
      },
      returns: {
        cash: returns.cash.toFixed(4),
        card: returns.card.toFixed(4),
        bank: returns.bank.toFixed(4),
        credit: returns.credit.toFixed(4),
      },
      expectedCash: expectedCash.toFixed(4),
      /** 💵 النقدي — the desktop's `SAfeNetVal`. */
      cash: expectedCash.toFixed(4),
      /** 🏦 التحويلات البنكية ببنكها — كل بنك على سطره (`EntryOper.cs` L620). */
      banks,
      /** إجمالي ما نُسب إلى بنك مسمّى؛ جزء من 🌐 الشبكة لا إضافة عليه. */
      bankTransfers: banks.reduce((sum, bank) => sum.plus(bank.amount), new Decimal(0)).toFixed(4),
      network: network.toFixed(4),
      /** 💰 مجموع الشبكة والنقدي — the desktop's `sumCashAndCredit`. */
      sumCashAndNetwork: expectedCash.plus(network).toFixed(4),
      /** 💹 الصافي — the desktop's `Net`. */
      net: net.toFixed(4),
      /** 🧾 الضريبة — the desktop's `AllVAT`. */
      tax: tax.toFixed(4),
      /** 🏷️ الخصم — the desktop's `Discount`. */
      discount: discount.toFixed(4),
      /** 📋 آجل — the desktop's `PostPoneSales`: what the customer did not settle. */
      postponed: postponed.toFixed(4),
      expenses: {
        total: expenses.total.toFixed(4),
        delivery: expenses.delivery.toFixed(4),
        hospitality: expenses.hospitality.toFixed(4),
        purchases: expenses.purchases.toFixed(4),
        insurance: expenses.insurance.toFixed(4),
        other: expenses.other.toFixed(4),
      },
    };
  }
  /**
   * 📊 إغلاقات اليومية — `Form_WPF/frmCloseShift.xaml` («عرض وإدارة إغلاقات وردية
   * الموظفين»).
   *
   * The desktop's grid is `CasherClosed` joined to `CasherClosed_Sub`
   * (`frmCloseShift.xaml.cs:214` and `:270`): one row per close, with the money the
   * cashier took — cash, network, postponed — beside the money that left the drawer —
   * مصاريف، مشتريات، ضيافة، تأمين — and the two numbers an auditor reads first,
   * `🏦 رصيد الصندوق` (what was counted) and `📉 الفرق` (counted − expected).
   *
   * A **closed** shift is read from its frozen `summary`: the takings were captured at
   * the moment of counting and must not move afterwards. An **open** one still has no
   * summary, so it is computed live — the cashier watching the screen sees the drawer
   * fill up.
   */
  async dayCloses(
    tenantId: string,
    filters: { from?: string; to?: string; userId?: string; membershipId?: string; branchId?: string } = {},
  ) {
    // نفس سبب `currentShift`: معرّفٌ ليس معرّفاً يعني «لا صفوف»، لا استعلاماً ينفجر.
    if (filters.branchId && !isUuid(filters.branchId)) return [];
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      /**
       * 👤 الموظف — a shift is opened by a *user*, but the screen offers the employee
       * list. Accepting the membership id and resolving it here keeps the screen from
       * having to know how a person is joined to a login.
       */
      const wanted = new Set<string>();
      if (filters.userId) wanted.add(filters.userId);
      if (filters.membershipId) {
        const [member] = await tx
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(and(eq(memberships.tenantId, tenantId), eq(memberships.id, filters.membershipId)));
        if (member) wanted.add(member.userId);
      }
      /**
       * A caller who names a cashier wants *that* cashier. When the id is not one of
       * ours the answer is an empty list — never the whole book, which is what a
       * silently-dropped filter would return.
       */
      const byCashier = wanted.size > 0 ? inArray(shiftCloses.userId, [...wanted]) : undefined;
      const nobodyMatches =
        wanted.size === 0 && Boolean(filters.membershipId || filters.userId)
          ? isNull(shiftCloses.id)
          : undefined;

      const rows = await tx
        .select()
        .from(shiftCloses)
        .where(
          and(
            eq(shiftCloses.tenantId, tenantId),
            filters.branchId ? eq(shiftCloses.branchId, filters.branchId) : undefined,
            byCashier,
            nobodyMatches,
            filters.from ? gte(shiftCloses.openedAt, new Date(`${filters.from}T00:00:00.000Z`)) : undefined,
            filters.to ? lte(shiftCloses.openedAt, new Date(`${filters.to}T23:59:59.999Z`)) : undefined,
          ),
        )
        .orderBy(desc(shiftCloses.openedAt))
        .limit(200);

      // 👤 الموظف — the desktop reads `Employees.name` (`frmCloseShift.xaml.cs:330`). A
      // shift is opened by a *user*, so the name comes from the employee record behind
      // that user's membership, falling back to the user's own name — a cashier with no
      // HR record is still a cashier whose drawer this is.
      const staff = await tx
        .select({
          userId: memberships.userId,
          membershipId: memberships.id,
          fullName: users.fullName,
          employeeName: employees.name,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .leftJoin(
          employees,
          and(eq(employees.membershipId, memberships.id), isNull(employees.deletedAt)),
        )
        .where(eq(memberships.tenantId, tenantId));
      const nameOf = (userId: string) => {
        const found = staff.find((row) => row.userId === userId);
        return found?.employeeName ?? found?.fullName ?? '';
      };

      /**
       * 🧾 عهدة الإغلاق — the code and name behind the id the posted count carries, so the
       * grid can say *where* the money went without a second round trip.
       */
      const custodyIds = [
        ...new Set(
          rows
            .map((row) => (row.summary as Record<string, unknown> | null)?.custodyAccountId)
            .filter((id): id is string => typeof id === 'string'),
        ),
      ];
      const custodyAccounts = custodyIds.length
        ? await tx
            .select({ id: accounts.id, code: accounts.code, nameAr: accounts.nameAr })
            .from(accounts)
            .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, custodyIds)))
        : [];
      const custodyOf = (row: (typeof rows)[number]) => {
        const id = (row.summary as Record<string, unknown> | null)?.custodyAccountId;
        return custodyAccounts.find((account) => account.id === id);
      };

      return Promise.all(
        rows.map(async (row) => {
          const live = row.status === 'open' ? await this.shiftTakings(tx, tenantId, row) : undefined;
          const summary = (row.summary ?? {}) as Record<string, unknown>;
          const expenses = (live?.expenses ?? summary.expenses ?? {}) as Record<string, string | undefined>;
          const pick = (key: string) => live?.[key as keyof typeof live] ?? (summary[key] as string | undefined) ?? '0';
          const custody = custodyOf(row);
          return {
            id: row.id,
            /** 🔢 الرقم — allocated when the drawer was counted. */
            number: row.number,
            status: row.status,
            employee: nameOf(row.userId),
            employeeId: row.userId,
            /** The membership behind the cashier, so a screen can filter by 👤 الموظف. */
            membershipId: staff.find((person) => person.userId === row.userId)?.membershipId ?? null,
            openedAt: row.openedAt,
            closedAt: row.closedAt,
            /**
             * 📒 القيد — the entry this count produced, and whether one is still owed.
             *
             * R12: a drawer that matched the books is *still* postable, because the count
             * moves the day's cash into عهدة الإغلاق. Only a drawer that held nothing and
             * was expected to hold nothing has nothing to post (`SHIFT_BALANCED`).
             */
            journalEntryId: row.journalEntryId,
            postedAt: row.postedAt,
            postable:
              row.status === 'closed' &&
              !row.journalEntryId &&
              (money(row.diff).abs().gt(0) ||
                money(row.countedCash).abs().gt(0) ||
                money(row.expectedCash).abs().gt(0)),
            /** 🧾 عهدة الإغلاق — where the count landed, once the entry is posted. */
            custodyAccountId: (summary.custodyAccountId as string | undefined) ?? null,
            custodyAccountCode: custody ? (custody.code ?? null) : null,
            custodyAccountName: custody ? (custody.nameAr ?? null) : null,
            custodyAmount: (summary.custodyAmount as string | undefined) ?? null,
            /** 💹 الصافي */
            net: pick('net'),
            /** 🏦 رصيد الصندوق — what the cashier counted, not what the till expected. */
            safeBalance: row.status === 'closed' ? row.countedCash : '0',
            expected: row.status === 'closed' ? row.expectedCash : (live?.expectedCash ?? '0'),
            /** 📉 الفرق */
            diff: row.status === 'closed' ? row.diff : '0',
            /** 🏦 التحويلات البنكية ببنكها (سطور `bank-transfer` عند الإقفال). */
            banks: (live?.banks ??
              (summary.banks as Array<{ id: string; name: string; amount: string }> | undefined) ??
              []) as Array<{ id: string; name: string; amount: string }>,
            /** 📋 آجل */
            postponed: pick('postponed'),
            /** 🌐 الشبكة */
            network: pick('network'),
            /** 💵 النقدي */
            cash: pick('cash'),
            /** 💰 مجموع الشبكة والنقدي */
            sumCashAndNetwork: pick('sumCashAndNetwork'),
            /** 🧾 الضريبة */
            tax: pick('tax'),
            /** 🏷️ الخصم */
            discount: pick('discount'),
            expenses: {
              /** 📤 المصاريف */
              total: expenses.total ?? '0',
              /** 🚗 توصيل */
              delivery: expenses.delivery ?? '0',
              /** ☕ الضيافة */
              hospitality: expenses.hospitality ?? '0',
              /** 🛒 المشتريات */
              purchases: expenses.purchases ?? '0',
              /** 🛡️ تأمين */
              insurance: expenses.insurance ?? '0',
              other: expenses.other ?? '0',
            },
          };
        }),
      );
    });
  }

  /**
   * One close with its two children: `frmCloseShiftDetails.xaml` (the counted notes) and
   * `frmCloseShiftInv.xaml` (the invoices the drawer took).
   */
  async shiftClose(tenantId: string, id: string) {
    // A path parameter is whatever the caller typed; an invalid uuid is a missing close,
    // not an invalid query.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new DomainError('SHIFT_NOT_FOUND', 'Shift close was not found', 404);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(shiftCloses)
        .where(and(eq(shiftCloses.tenantId, tenantId), eq(shiftCloses.id, id)));
      if (!row) throw new DomainError('SHIFT_NOT_FOUND', 'Shift close was not found', 404);
      const [closes] = await this.dayCloses(tenantId, { userId: row.userId, branchId: row.branchId });
      const detail = closes && closes.id === id ? closes : undefined;
      return {
        shift: row,
        close: detail ?? null,
        counts: await tx
          .select()
          .from(cashCountLines)
          .where(and(eq(cashCountLines.tenantId, tenantId), eq(cashCountLines.shiftCloseId, id))),
        lines: await tx
          .select()
          .from(shiftCloseLines)
          .where(and(eq(shiftCloseLines.tenantId, tenantId), eq(shiftCloseLines.shiftCloseId, id))),
      };
    });
  }

  history(tenantId: string, branchId?: string) {
    if (branchId && !isUuid(branchId)) return Promise.resolve([]);
    return withTenantTx(this.database.db, tenantId, (tx) =>
      tx
        .select()
        .from(shiftCloses)
        .where(
          and(eq(shiftCloses.tenantId, tenantId), branchId ? eq(shiftCloses.branchId, branchId) : undefined),
        )
        .orderBy(desc(shiftCloses.openedAt))
        .limit(100),
    );
  }
  /**
   * Closes a cashier shift: counts the drawer and compares it against what the
   * till should hold.
   *
   * Before Phase 04 the "expected" side came from cash vouchers alone, so a shift
   * made entirely of POS sales closed with an expected cash of zero and every
   * counted note looked like a surplus. The desktop (`frmCloseShift`) summarised
   * the cashier's own takings — cash, network and postponed — and this now does
   * the same: manual vouchers *plus* the payments the sales engine wrote for
   * invoices captured by this shift (or, for invoices with no shift, posted at
   * this branch during the shift window). Returns are subtracted per method, so
   * a cash refund shrinks the expected cash instead of inflating it.
   */
  async closeShift(tenantId: string, id: string, counts: ShiftCount[]) {
    const closed = await withTenantTx(this.database.db, tenantId, async (tx) => {
      const [shift] = await tx
        .select()
        .from(shiftCloses)
        .where(
          and(eq(shiftCloses.tenantId, tenantId), eq(shiftCloses.id, id), eq(shiftCloses.status, 'open')),
        );
      if (!shift) throw new DomainError('SHIFT_INVALID_STATE', 'Shift is not open', 422);

      const takings = await this.shiftTakings(tx, tenantId, shift);
      const expected = money(takings.expectedCash);
      /**
       * 🔢 الرقم — `frmCloseShift.xaml`'s first column. A close is a document the cashier
       * signs, so it is numbered from the tenant's sequence the moment it is counted,
       * exactly the way a voucher is numbered when it is posted and not when it is
       * drafted. An open drawer stays unnumbered.
       */
      /**
       * 🔢 الرقم is numbered **tenant-wide**, not per branch — and that is forced, not
       * stylistic: `shift_closes_number_key` is unique on `(tenant_id, number)`, so two
       * branches each running their own `shift_close` sequence both reach `CS-000001`
       * and the second close dies on a duplicate key. The desktop's `ClosedID` is one
       * series for the whole company too, which is what makes `✖` on a printed close
       * report mean one close and not one of several. Migration 0044 seeds the
       * tenant-wide counter from the numbers already issued.
       */
      const allocated = await this.sequences.next({ tenantId, docType: 'shift_close' }, tx, {
        prefix: 'CS-',
        padding: 6,
      });
      const counted = counts.reduce(
        (sum, line) => sum.plus(money(line.denomination).mul(line.count)),
        new Decimal(0),
      );
      const summary = {
        ...takings,
        countedCash: counted.toFixed(4),
        diff: counted.minus(expected).toFixed(4),
      };

      let lineNo = 1;
      for (const line of counts)
        await tx
          .insert(cashCountLines)
          .values({
            shiftCloseId: id,
            lineNo: lineNo++,
            tenantId,
            currencyCode: line.currencyCode ?? 'SAR',
            denomination: line.denomination,
            count: line.count,
            total: money(line.denomination).mul(line.count).toFixed(4),
          });
      let summaryLine = 1;
      const totals: Array<{
        kind: string;
        method: string;
        amount: Decimal;
        metadata?: Record<string, unknown>;
      }> = [
        { kind: 'method-total', method: 'cash', amount: expected, metadata: summary },
        {
          kind: 'method-total',
          method: 'card',
          amount: money(takings.sales.card).minus(money(takings.returns.card)),
        },
        {
          kind: 'method-total',
          method: 'bank',
          amount: money(takings.sales.bank).minus(money(takings.returns.bank)),
        },
        {
          kind: 'method-total',
          method: 'credit',
          amount: money(takings.sales.credit).minus(money(takings.returns.credit)),
        },
        { kind: 'voucher-cash', method: 'cash', amount: money(takings.vouchersCash) },
        /**
         * 🏦 بنك باسمه — `Class/EntryOper.cs` L620: the close's own children carry one
         * row per bank so `frmCloseShiftDetails` can show where the transfer went and
         * the entry can debit *that* bank's account. An unnamed transfer has no line
         * here; it stays inside 🌐 الشبكة.
         */
        ...takings.banks.map((bank) => ({
          kind: 'bank-transfer',
          method: 'bank',
          amount: money(bank.amount),
          metadata: { cashLocationId: bank.id, name: bank.name },
        })),
      ];
      for (const total of totals)
        await tx
          .insert(shiftCloseLines)
          .values({
            shiftCloseId: id,
            lineNo: summaryLine++,
            tenantId,
            kind: total.kind,
            method: total.method,
            /**
             * `party_id` is a FK to `parties` — a bank is not a party, so the bank rides
             * in `metadata`, the way the desktop carries `CloseShiftBanks.BankId`.
             */
            partyId: null,
            amount: total.amount.toFixed(4),
            metadata: total.metadata ?? {},
          });
      await tx
        .update(shiftCloses)
        .set({
          status: 'closed',
          number: allocated.display,
          closedAt: new Date(),
          expectedCash: expected.toFixed(4),
          countedCash: counted.toFixed(4),
          diff: counted.minus(expected).toFixed(4),
          summary,
          updatedAt: new Date(),
        })
        .where(
          and(eq(shiftCloses.tenantId, tenantId), eq(shiftCloses.id, id), eq(shiftCloses.status, 'open')),
        );
      return { id, number: allocated.display, status: 'closed', summary };
    });
    // P-C11 — بعد الإغلاق: الفرق بين المعدود والمتوقّع هو الخبر الذي يُعلَن.
    const summary = closed.summary as Record<string, unknown>;
    void this.webhooks.emit('shift.closed', tenantId, {
      shiftId: closed.id,
      number: closed.number,
      countedCash: summary.countedCash ?? null,
      diff: summary.diff ?? null,
      closedAt: new Date().toISOString(),
    });
    return closed;
  }
  /**
   * 📒 قيد الإغلاق — `Class/EntryOper.cs` `BindCloseShiftToEntry`.
   *
   * The desktop's close entry is the *only* accounting a POS day ever gets: nothing is
   * posted when an invoice is saved, so the close itself debits the treasury, debits
   * `1221001` الشبكة, debits each named bank's own account, and credits `4100001`
   * المبيعات, `2222001` الضريبة المضافة and the rest.
   *
   * Copying that here would post the day **twice**. In the cloud every posted invoice
   * already wrote its entry — sales, VAT, discount, and the debit to the till's or the
   * bank's own account (`pos.service.ts` resolves a named bank's `accountId` the way
   * `EntryOper.cs:620` resolves `bank.AccCode`). So the close is left holding exactly
   * one number no other document can know: **📉 الفرق**, the difference between the
   * drawer the cashier counted by hand and the drawer the books expected.
   *
   *   counted < expected (عجز)  →  Dr فرق الصندوق  /  Cr الصندوق
   *   counted > expected (زيادة) →  Dr الصندوق      /  Cr فرق الصندوق
   *
   * A balanced drawer posts nothing and says so (`SHIFT_BALANCED`), because an entry
   * of two zero lines is how a ledger stops being evidence.
   *
   * عهدة الإغلاق (`1211002`) is deliberately **not** reproduced: in the desktop it parks
   * the counted cash on the cashier's custody account until it is deposited, and the
   * cloud has no deposit step to clear it — a balance nothing can ever clear is worse
   * than a leg we can add with the deposit screen.
   */
  async postShiftClose(tenantId: string, id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new DomainError('SHIFT_NOT_FOUND', 'Shift close was not found', 404);
    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(shiftCloses)
        .where(and(eq(shiftCloses.tenantId, tenantId), eq(shiftCloses.id, id)));
      if (!row) throw new DomainError('SHIFT_NOT_FOUND', 'Shift close was not found', 404);
      if (row.status !== 'closed')
        throw new DomainError('SHIFT_INVALID_STATE', 'Only a counted shift can be posted', 422, {
          field: 'status',
        });
      if (row.journalEntryId)
        throw new DomainError('SHIFT_ALREADY_POSTED', 'This shift was already posted', 409, {
          field: 'journalEntryId',
        });

      /**
       * 🧾 عهدة الإغلاق — the two legs the cloud was missing.
       *
       * The desktop's close entry (`ClosShiftAndroid.xaml.cs:1550–1650`,
       * `Class/EntryOper.cs:740–810`) does more than book the difference: the day's cash
       * leaves the till and lands on the cashier's custody (`1211002`), and only the
       * disagreement between the hand count and the books goes to «فروقات الصندوق».
       * The cloud posts the legs the cloud's own model needs — every sale already debited
       * the till, so the till is relieved of what the books hold (**expected**) while the
       * custody receives what the cashier actually holds (**counted**); the difference
       * between the two is the plug, and it keeps the direction it always had here:
       * shortage = Dr فروقات (an expense), surplus = Cr فروقات (income).
       *
       *   Dr عهدة الإغلاق  counted
       *   Cr الصندوق        expected
       *   ±  فروقات الصندوق expected − counted   (عجز ⇒ مدين · زيادة ⇒ دائن)
       *
       * So a **balanced** drawer still posts: the cash exists and it has to move. The
       * refusal is now only for a drawer that is empty *and* was expected to be empty —
       * a zero entry is not evidence of anything.
       */
      const counted = money(row.countedCash);
      const expected = money(row.expectedCash);
      const difference = expected.minus(counted);
      if (!expected.abs().gt(0) && !counted.abs().gt(0))
        throw new DomainError(
          'SHIFT_BALANCED',
          'الصندوق فارغ ومتوقَّعه فارغ — لا شيء يتحرّك، فلا قيد',
          422,
          { field: 'countedCash' },
        );

      const cashAccountId = await this.profileAccount(tx, tenantId, row.branchId, 'shift_close', 'cashAccountId');
      const custodyAccountId = await this.custodyAccount(tx, tenantId, row.branchId);
      const employeeName = await this.staffName(tx, tenantId, row.userId);
      /**
       * 🧾 عهدة الإغلاق تُسجَّل ولا تُقدَّر: صفرٌ لا يُكتب سطراً. وبيانُ كل سطر هو بيانُ
       * الديسكتوب نفسه — « عهدة الإغلاق {الاسم}» · « نقدي في الصندوق {الاسم}» ·
       * « فرق بالصندوق {الاسم}» (`EntryOper.cs:762/776/810`، `ClosShiftAndroid.xaml.cs:1578`).
       */
      const lines: Array<{ accountId: string; debit: string; credit: string; description: string }> = [];
      if (counted.abs().gt(0))
        lines.push(
          counted.gt(0)
            ? {
                accountId: custodyAccountId,
                debit: counted.toFixed(4),
                credit: '0',
                description: `عهدة الإغلاق ${employeeName}`,
              }
            : {
                accountId: custodyAccountId,
                debit: '0',
                credit: counted.abs().toFixed(4),
                description: `عهدة الإغلاق ${employeeName}`,
              },
        );
      if (expected.abs().gt(0))
        lines.push(
          expected.gt(0)
            ? {
                accountId: cashAccountId!,
                debit: '0',
                credit: expected.toFixed(4),
                description: `نقدي في الصندوق ${employeeName}`,
              }
            : {
                accountId: cashAccountId!,
                debit: expected.abs().toFixed(4),
                credit: '0',
                description: `نقدي في الصندوق ${employeeName}`,
              },
        );
      if (difference.abs().gt(0)) {
        /**
         * 📉 الفرق — and if the tenant named a difference account, it is the one that
         * moves; otherwise the legs above already balance and nothing is invented here.
         */
        const differenceAccountId = await this.profileAccount(
          tx,
          tenantId,
          row.branchId,
          'shift_close',
          'cashDifferenceAccountId',
          { required: false },
        );
        /**
         * ⚖️ ولا يُترك الفرق بلا حساب: بدونه لا يتوازن القيد، فيُقال صريحاً ما ينقص
         * (وهو ما كان يُقال قبل R12) ولا يُخترع حساب.
         */
        if (!differenceAccountId)
          throw new DomainError(
            'TREASURY_PROFILE_KEY_MISSING',
            'Posting profile has no cashDifferenceAccountId — map it in Settings › Posting profiles',
            422,
            { field: 'cashDifferenceAccountId' },
          );
        lines.push(
          difference.gt(0)
            ? {
                accountId: differenceAccountId,
                debit: difference.toFixed(4),
                credit: '0',
                description: `فرق بالصندوق ${employeeName}`,
              }
            : {
                accountId: differenceAccountId,
                debit: '0',
                credit: difference.abs().toFixed(4),
                description: `فرق بالصندوق ${employeeName}`,
              },
        );
      }
      /**
       * 📝 البيان — the desktop's own note, رقم الإغلاق and all
       * (`"اغلاق اليومية خاصة الموظف {name} رقم{ClosedId}"`), so an accountant searching
       * the ledger for a shift finds the shift.
       */
      const journal = await this.accounting.postJournalInTx(tx, tenantId, {
        branchId: row.branchId,
        fiscalPeriodId: await this.accounting.openPeriodForDateInTx(
          tx,
          tenantId,
          (row.closedAt ?? new Date()).toISOString().slice(0, 10),
        ),
        date: (row.closedAt ?? new Date()).toISOString().slice(0, 10),
        description: `اغلاق اليومية خاصة الموظف ${employeeName} رقم${row.number ?? row.id}`,
        lines,
        sourceType: 'shift_close',
        sourceId: id,
      });

      const postedAt = new Date();
      /**
       * 🧾 العهدة تُكتب على الإغلاق نفسه: الشاشة تعرض ما دخل العهدة، ومنه يُورَّد
       * بسند قبضٍ حسابُه المقابل «عهدة الإغلاق» — فلا يبقى رصيدٌ لا يُصفّى.
       */
      const custodySummary = {
        custodyAccountId,
        custodyAmount: counted.toFixed(4),
        tillAmount: expected.toFixed(4),
        differenceAmount: difference.toFixed(4),
      };
      await tx
        .update(shiftCloses)
        .set({
          journalEntryId: journal?.id ?? null,
          postedAt,
          updatedAt: postedAt,
          summary: sql`${shiftCloses.summary} || ${JSON.stringify(custodySummary)}::jsonb`,
        })
        .where(and(eq(shiftCloses.tenantId, tenantId), eq(shiftCloses.id, id)));

      return {
        id,
        number: row.number,
        journalEntryId: journal?.id ?? null,
        postedAt,
        ...custodySummary,
        /** 📉 الفرق — signed, so a caller can show عجز or زيادة without re-deriving it. */
        diff: row.diff,
      };
    });
  }

  /** 👤 الموظف — the employee record behind a user's membership, or the user's own name. */
  private async staffName(tx: DrizzleTx, tenantId: string, userId: string) {
    const [found] = await tx
      .select({ employeeName: employees.name, fullName: users.fullName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(employees, and(eq(employees.membershipId, memberships.id), isNull(employees.deletedAt)))
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)));
    return found?.employeeName ?? found?.fullName ?? '';
  }

  printShiftData(tenantId: string, id: string) {
    return withTenantTx(this.database.db, tenantId, async (tx) => ({
      shift: (
        await tx
          .select()
          .from(shiftCloses)
          .where(and(eq(shiftCloses.tenantId, tenantId), eq(shiftCloses.id, id)))
      )[0],
      lines: await tx
        .select()
        .from(shiftCloseLines)
        .where(and(eq(shiftCloseLines.tenantId, tenantId), eq(shiftCloseLines.shiftCloseId, id))),
      counts: await tx
        .select()
        .from(cashCountLines)
        .where(and(eq(cashCountLines.tenantId, tenantId), eq(cashCountLines.shiftCloseId, id))),
    }));
  }

  /**
   * 🏦 حركة الصندوق — `Form_WPF/frmRptKhzna.xaml`.
   *
   * The desktop does **not** read the receipts table for this statement: it resolves the
   * safe's account and then walks `Entry_sub` (`frmRptKhzna.xaml.cs` L156–L260), so a
   * movement is anything that posted to that account — a receipt, a sale, a salary, a
   * transfer. A statement built from `vouchers` alone would silently omit every movement
   * the treasury screen did not create, and the running balance would not tie to the
   * ledger.
   *
   * Three things the desktop does that the screen is judged by:
   *  * `رصيد سابق` — a first row carrying everything before `من تاريخ`, when a period is
   *    chosen and not ☑ `كل الفترة`;
   *  * a running `⚖️ الرصيد` and the two cards `⚖️ الرصيد الإجمالي` (balance at the end
   *    of the window) and `📅 رصيد الفترة المحددة` (the window's own movement);
   *  * only posted entries (`Entry.state = 1`, `IS_Deleted = 0`) — a draft must not move
   *    a safe on a report.
   *
   * One honest deviation, and why: the desktop's `Entry.date` is a *date and time*, so
   * `من وقت / إلى وقت` is a real filter there. Our `journal_entries.date` is a date; the
   * time lives on the voucher (`vouchers.voucher_time`, added in part one). A movement
   * with no recorded time therefore cannot be placed inside a day, so it is never
   * filtered out and never pushed into the opening balance — hiding a real entry from an
   * auditor is the worse error. Movements *with* a time obey the window exactly, and the
   * totals stay continuous because every movement is counted once.
   */
  async movements(tenantId: string, cashLocationId: string, query: MovementQuery = {}) {
    const all = query.all === true;
    const from = this.movementDate(query.from, 'من تاريخ');
    const to = this.movementDate(query.to, 'إلى تاريخ');
    const fromTime = this.movementTime(query.fromTime, '00:00', 'من وقت');
    const toTime = this.movementTime(query.toTime, '23:59', 'إلى وقت');
    if (!all && from && to && from > to)
      throw new DomainError('MOVEMENT_RANGE_INVALID', '«من تاريخ» must not be after «إلى تاريخ»', 422);
    if (!all && fromTime > toTime)
      throw new DomainError('MOVEMENT_RANGE_INVALID', '«من وقت» must not be after «إلى وقت»', 422);

    return withTenantTx(this.database.db, tenantId, async (tx) => {
      const [location] = await tx
        .select({
          id: cashLocations.id,
          name: cashLocations.name,
          kind: cashLocations.kind,
          accountId: cashLocations.accountId,
          currencyCode: cashLocations.currencyCode,
        })
        .from(cashLocations)
        .where(
          and(
            eq(cashLocations.tenantId, tenantId),
            eq(cashLocations.id, cashLocationId),
            isNull(cashLocations.deletedAt),
          ),
        );
      if (!location) throw new DomainError('CASH_LOCATION_NOT_FOUND', 'Cash location was not found', 404);
      if (!location.accountId)
        throw new DomainError(
          'CASH_ACCOUNT_REQUIRED',
          'لم يتم العثور على حساب مرتبط بهذا الصندوق — اربط الصندوق بحساب في «تعريف الخزن والبنوك»',
          422,
        );

      /** Any voucher behind the entry — its ⏰ الوقت is the only time we have. */
      const voucherJoin = and(
        eq(vouchers.tenantId, tenantId),
        eq(vouchers.id, journalEntries.sourceId),
        eq(journalEntries.sourceType, 'voucher'),
      );
      const accountScope = and(
        eq(journalEntryLines.tenantId, tenantId),
        eq(journalEntryLines.accountId, location.accountId),
        eq(journalEntries.status, 'posted'),
      );
      const period = !all && from && to ? and(gte(journalEntries.date, from), lte(journalEntries.date, to)) : undefined;

      // ══ الرصيد السابق — `frmRptKhzna.xaml.cs` L200 ══
      let opening = new Decimal(0);
      let openingIncome = new Decimal(0);
      let openingOutcome = new Decimal(0);
      if (period) {
        const [prior] = await tx
          .select({
            debit: sql<string>`coalesce(sum(${journalEntryLines.debit}), 0)::text`,
            credit: sql<string>`coalesce(sum(${journalEntryLines.credit}), 0)::text`,
          })
          .from(journalEntryLines)
          .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.entryId))
          .leftJoin(vouchers, voucherJoin)
          .where(
            and(
              accountScope,
              or(
                lt(journalEntries.date, from!),
                and(
                  eq(journalEntries.date, from!),
                  isNotNull(vouchers.voucherTime),
                  sql`${vouchers.voucherTime} < ${fromTime}::time`,
                ),
              ),
            ),
          );
        openingIncome = new Decimal(prior?.debit ?? '0');
        openingOutcome = new Decimal(prior?.credit ?? '0');
        opening = openingIncome.minus(openingOutcome);
      }

      // ══ الحركات في الفترة — grouped per entry, as the desktop groups by `Entry.GlobalID` ══
      const grouped = await tx
        .select({
          date: journalEntries.date,
          number: journalEntries.number,
          description: journalEntries.description,
          sourceType: journalEntries.sourceType,
          voucherKind: vouchers.kind,
          debit: sql<string>`sum(${journalEntryLines.debit})::text`,
          credit: sql<string>`sum(${journalEntryLines.credit})::text`,
        })
        .from(journalEntryLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.entryId))
        .leftJoin(vouchers, voucherJoin)
        .where(
          and(
            accountScope,
            period,
            or(
              isNull(vouchers.voucherTime),
              and(
                sql`${vouchers.voucherTime} >= ${fromTime}::time`,
                sql`${vouchers.voucherTime} <= ${toTime}::time`,
              ),
            ),
          ),
        )
        .groupBy(
          journalEntries.id,
          journalEntries.date,
          journalEntries.number,
          journalEntries.description,
          journalEntries.sourceType,
          vouchers.kind,
        )
        .orderBy(asc(journalEntries.date), asc(journalEntries.number));

      const rows: MovementRow[] = [];
      let running = opening;
      if (period) {
        rows.push({
          seq: 1,
          processType: 'رصيد سابق',
          number: '',
          date: shiftDay(from!, -1),
          income: openingIncome.toFixed(4),
          outcome: openingOutcome.toFixed(4),
          balance: opening.toFixed(4),
          note: '',
          isOpening: true,
        });
      }
      for (const row of grouped) {
        const income = new Decimal(row.debit ?? '0');
        const outcome = new Decimal(row.credit ?? '0');
        running = running.plus(income).minus(outcome);
        rows.push({
          seq: rows.length + 1,
          processType: processTypeAr(row.sourceType, row.voucherKind),
          number: row.number ?? '—',
          date: row.date,
          income: income.toFixed(4),
          outcome: outcome.toFixed(4),
          balance: running.toFixed(4),
          note: row.description ?? '',
        });
      }

      return {
        cashLocationId: location.id,
        cashLocation: location.name,
        currencyCode: location.currencyCode ?? 'SAR',
        accountId: location.accountId,
        from: period ? from : null,
        to: period ? to : null,
        fromTime,
        toTime,
        all,
        openingBalance: opening.toFixed(4),
        /** ⚖️ الرصيد الإجمالي — the balance at the end of the window. */
        totalAll: running.toFixed(4),
        /** 📅 رصيد الفترة المحددة — what the window itself moved. */
        totalPeriod: running.minus(opening).toFixed(4),
        rows,
      };
    });
  }

  private movementDate(value: string | undefined, label: string): string | undefined {
    if (value === undefined || value.trim() === '') return undefined;
    const text = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
      throw new DomainError('MOVEMENT_DATE_INVALID', `${label} must be a date (YYYY-MM-DD)`, 422);
    return text;
  }

  private movementTime(value: string | undefined, fallback: string, label: string): string {
    if (value === undefined || value.trim() === '') return fallback;
    const text = value.trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text))
      throw new DomainError('MOVEMENT_TIME_INVALID', `${label} must be a time (HH:mm)`, 422);
    return text;
  }

  getCashBalance(tenantId: string, cashLocationId: string, currency = 'SAR') {
    return withTenantTx(
      this.database.db,
      tenantId,
      async (tx) =>
        (
          await tx
            .select()
            .from(cashLocationBalances)
            .where(
              and(
                eq(cashLocationBalances.tenantId, tenantId),
                eq(cashLocationBalances.cashLocationId, cashLocationId),
                eq(cashLocationBalances.currencyCode, currency),
              ),
            )
        )[0] ?? { tenantId, cashLocationId, currencyCode: currency, balance: '0' },
    );
  }
  async recalcCashBalance(tenantId: string, cashLocationId: string, currency = 'SAR') {
    const balance = await this.getCashBalance(tenantId, cashLocationId, currency);
    return { ...balance, reconciled: true };
  }

  private async bumpBalance(
    tx: DrizzleTx,
    tenantId: string,
    cashLocationId: string,
    currencyCode: string,
    delta: string,
  ) {
    await tx
      .insert(cashLocationBalances)
      .values({ tenantId, cashLocationId, currencyCode, balance: delta, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [cashLocationBalances.cashLocationId, cashLocationBalances.currencyCode],
        set: { balance: sql`${cashLocationBalances.balance} + ${delta}`, updatedAt: new Date() },
      });
  }
}
