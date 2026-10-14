/**
 * Marina — `Form_WPF/frmBookingM.xaml` («الحجوزات») · `Form_WPF/frmViolationM.xaml`
 * («المخالفات») · `Form_WPF/frmGroupM.xaml` («📋 بطاقة فئة») · `Form_WPF/frmAdditions.xaml`
 * («📋 إضافات») · `Form_WPF/frmOwners.xaml` («تعريف مالك») ·
 * `Form_WPF/frmInvoiceRentSrch.xaml` («بحث الفواتير»).
 *
 * Reading (الحجوزات · المخالفات · فواتير التأجير · خطط التشغيل) needs `marina.view`;
 * writing a حجز أو مخالفة needs `marina.manage`; and issuing a فاتورة تأجير needs
 * `marina.invoice` — the same split as the windows: everyone looks, the harbour master
 * writes, and the cashier invoices.
 */
/* eslint-disable no-restricted-syntax */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';

import { getTenantContext, tryGetAuthContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import {
  MarinaDocumentsService,
  type AdditionInput,
  type BookingInput,
  type BookingPatch,
  type BookingQuery,
  type ViolationInput,
  type ViolationPatch,
  type ViolationQuery,
} from './booking-documents.service.js';
import { MarinaAdditionsService, type AdditionDefinitionInput, type AdditionDefinitionPatch } from './additions.service.js';
import {
  MarinaGroupCardsService,
  type GroupCardInput,
  type GroupCardPatch,
  type GroupPeriodInput,
  type NavigateDirection,
} from './group-cards.service.js';
import { MarinaService } from './marina.service.js';

@Controller('marina')
export class MarinaController {
  constructor(
    private readonly marina: MarinaService,
    private readonly documents: MarinaDocumentsService,
    private readonly groups: MarinaGroupCardsService,
    private readonly additions: MarinaAdditionsService,
  ) {}

  private get tenantId(): string {
    return getTenantContext().tenantId;
  }

  private get userId(): string | undefined {
    return tryGetAuthContext()?.userId;
  }

  @Get()
  @RequiresPermission('marina.view')
  list() {
    return this.marina.list(this.tenantId);
  }

  // ─────────────────────────────── 📋 بيانات الحجوزات ───────────────────────────────

  /**
   * «🔍 البحث» — رقم الحجز · اسم العميل أو جواله · من تاريخ وإلى تاريخ، و«📋 نتائج
   * البحث» هي نفسها «📋 بيانات الحجوزات» مفتوحةً على حجزٍ واحد.
   */
  @Get('bookings')
  @RequiresPermission('marina.view')
  bookings(
    @Query('number') number?: string,
    @Query('customer') customer?: string,
    @Query('partyId') partyId?: string,
    @Query('vesselId') vesselId?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const query: BookingQuery = {};
    if (number) query.number = number;
    if (customer) query.customer = customer;
    if (partyId) query.partyId = partyId;
    if (vesselId) query.vesselId = vesselId;
    if (status) query.status = status;
    if (from) query.from = from;
    if (to) query.to = to;
    if (limit) query.limit = limit;
    if (offset) query.offset = offset;
    return this.documents.listBookings(this.tenantId, query);
  }

  @Get('bookings/:id')
  @RequiresPermission('marina.view')
  booking(@Param('id') id: string) {
    return this.documents.getBooking(this.tenantId, id);
  }

  /** «💾» — الحجز كاملاً بإضافاته في صفقةٍ واحدة. */
  @Post('bookings')
  @RequiresPermission('marina.manage')
  createBooking(@Body() body: BookingInput) {
    return this.documents.createBooking(this.tenantId, body, this.userId);
  }

  @Patch('bookings/:id')
  @RequiresPermission('marina.manage')
  updateBooking(@Param('id') id: string, @Body() body: BookingPatch) {
    return this.documents.updateBooking(this.tenantId, id, body, this.userId);
  }

  @Delete('bookings/:id')
  @RequiresPermission('marina.manage')
  deleteBooking(@Param('id') id: string) {
    return this.documents.deleteBooking(this.tenantId, id, this.userId);
  }

  /** «🎁 الإضافات» — العدد × السعر = الإجمالي. */
  @Post('bookings/:id/additions')
  @RequiresPermission('marina.manage')
  addition(@Param('id') id: string, @Body() body: AdditionInput) {
    return this.documents.addAddition(this.tenantId, id, body, this.userId);
  }

  /** «🗑️ حذف» على صفٍّ من صفوف الإضافات. */
  @Delete('bookings/:id/additions/:additionId')
  @RequiresPermission('marina.manage')
  removeAddition(@Param('id') id: string, @Param('additionId') additionId: string) {
    return this.documents.removeAddition(this.tenantId, id, additionId);
  }

  // ─────────────────────────────── ➕ الإضافات ───────────────────────────────

  /**
   * «📋 إدارة الإضافات» — `select * from Additions where IsDeleted=0 ORDER BY id`, the
   * list «🎁 الإضافات» in «الحجوزات» is filled from.
   */
  @Get('additions')
  @RequiresPermission('marina.view')
  listAdditions() {
    return this.additions.list(this.tenantId);
  }

  /** 🔢 الرقم — `LoadNextAdditionNumber`: what a blank card shows in «🔢 الرقم». */
  @Get('additions/next')
  @RequiresPermission('marina.view')
  nextAdditionNumber() {
    return this.additions.nextNumber(this.tenantId);
  }

  /**
   * «💾 حفظ» on a blank card — «يجب إدخال اسم الإضافة ⚠️» بلا اسم، وقيمةٌ فارغةٌ صفر.
   * Declared before `additions/:id` so 🔢 الرقم الجديد is not read as an إضافة.
   */
  @Post('additions')
  @RequiresPermission('marina.manage')
  createAddition(@Body() body: AdditionDefinitionInput) {
    return this.additions.create(this.tenantId, body, this.userId);
  }

  /** «💾 حفظ» على بطاقةٍ قائمة — «✅ تم حفظ التعديلات بنجاح». */
  @Patch('additions/:id')
  @RequiresPermission('marina.manage')
  updateAddition(@Param('id') id: string, @Body() body: AdditionDefinitionPatch) {
    return this.additions.update(this.tenantId, id, body, this.userId);
  }

  /**
   * «🗑️ حذف» — after «يجب تحديد الإضافة المراد حذفها ⚠️» و«هل أنت متأكد من حذف هذه
   * الإضافة؟ 🗑️» (`frmAdditions.btnDelete_Click`).
   */
  @Delete('additions/:id')
  @RequiresPermission('marina.manage')
  deleteAddition(@Param('id') id: string) {
    return this.additions.remove(this.tenantId, id, this.userId);
  }

  /** 🧾 فاتورة التأجير من حجز — `RentInvoice(tot_Rent, tot_Additions, tax, tot_net)`. */
  @Post('bookings/:id/rental-invoice')
  @RequiresPermission('marina.invoice')
  invoice(@Param('id') id: string) {
    return this.marina.createRentalInvoice(this.tenantId, id);
  }

  // ─────────────────────────────── ⚠️ المخالفات ───────────────────────────────

  /** «⚠️ قائمة المخالفات» — `select * from Violation where IsDeleted=0`. */
  @Get('violations')
  @RequiresPermission('marina.view')
  violations(
    @Query('number') number?: string,
    @Query('type') type?: string,
    @Query('vesselId') vesselId?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const query: ViolationQuery = {};
    if (number) query.number = number;
    if (type) query.type = type;
    if (vesselId) query.vesselId = vesselId;
    if (status) query.status = status;
    if (from) query.from = from;
    if (to) query.to = to;
    return this.documents.listViolations(this.tenantId, query);
  }

  @Get('violations/:id')
  @RequiresPermission('marina.view')
  violation(@Param('id') id: string) {
    return this.documents.getViolation(this.tenantId, id);
  }

  /** «💾 حفظ» — ثلاثة رفوض بترتيب النافذة. */
  @Post('violations')
  @RequiresPermission('marina.manage')
  createViolation(@Body() body: ViolationInput) {
    return this.documents.createViolation(this.tenantId, body, this.userId);
  }

  @Patch('violations/:id')
  @RequiresPermission('marina.manage')
  updateViolation(@Param('id') id: string, @Body() body: ViolationPatch) {
    return this.documents.updateViolation(this.tenantId, id, body, this.userId);
  }

  @Delete('violations/:id')
  @RequiresPermission('marina.manage')
  deleteViolation(@Param('id') id: string) {
    return this.documents.deleteViolation(this.tenantId, id, this.userId);
  }

  // ─────────────────────────────── التعاريف ───────────────────────────────

  // ─────────────────────────────── 📋 بطاقة فئة ───────────────────────────────

  /**
   * «📋 قائمة الفئات» — `select * from GroupMarine where IsDeleted=0`
   * (`Form_WPF/frmGroupM.xaml` «📋 بطاقة فئة»), one card per فئة with its ⏰ فترات.
   */
  @Get('groups')
  @RequiresPermission('marina.view')
  groupCards() {
    return this.groups.list(this.tenantId);
  }

  /**
   * ⏮ الأول · ◀ السابق · ▶ التالي · ⏭ الأخير — the four arrows walk `GroupMarine` by
   * `id`; they stay where they are when there is nothing further, as the window does.
   *
   * Declared before `groups/:id` because Nest matches in registration order.
   */
  @Get('groups/navigate')
  @RequiresPermission('marina.view')
  groupCardNavigate(@Query('dir') dir = 'first', @Query('currentId') currentId?: string) {
    const direction: NavigateDirection =
      dir === 'last' ? 'last' : dir === 'next' ? 'next' : dir === 'previous' || dir === 'prev' ? 'previous' : 'first';
    return this.groups.navigate(this.tenantId, direction, currentId);
  }

  /** «⏰ المدة» — the ten durations of `RentPeriod`, for `frmAddPeriod`'s drop-down. */
  @Get('rent-periods')
  @RequiresPermission('marina.view')
  rentPeriods() {
    return this.groups.listRentPeriods();
  }

  @Get('groups/:id')
  @RequiresPermission('marina.view')
  groupCard(@Param('id') id: string) {
    return this.groups.get(this.tenantId, id);
  }

  /**
   * «💾 حفظ» — the card (رمز الفئة · الاسمين · قيمة الساعة وعرضها · قيمة النصف ساعة
   * وعرضها · 🖼️ الصورة), then the two canonical ⏰ فترات written as `frmGroupM` writes
   * them. A caller that sends nothing but `{ name, code }` gets exactly the group it got
   * before this part — the rest of the card defaults, and the pair of فترات is written.
   */
  @Post('groups')
  @RequiresPermission('marina.manage')
  group(@Body() body: GroupCardInput) {
    return this.groups.create(this.tenantId, body, this.userId);
  }

  @Patch('groups/:id')
  @RequiresPermission('marina.manage')
  updateGroupCard(@Param('id') id: string, @Body() body: GroupCardPatch) {
    return this.groups.update(this.tenantId, id, body, this.userId);
  }

  /** «🗑️ حذف» — «اختر الفئة ليتم حذفها», then «هذه الفئة لها ارتباطات فرعية لايمكن حذفها». */
  @Delete('groups/:id')
  @RequiresPermission('marina.manage')
  deleteGroupCard(@Param('id') id: string) {
    return this.groups.remove(this.tenantId, id, this.userId);
  }

  /**
   * «💾» of `Form_WPF/frmAddPeriod.xaml` («⏰ إدارة فترات التأجير») — ⏰ المدة · 💵 السعر ·
   * 🎁 العرض, saved as `delete RentPeriodSub where MGroupID=…` then every row again.
   */
  @Put('groups/:id/periods')
  @RequiresPermission('marina.manage')
  replaceGroupPeriods(@Param('id') id: string, @Body() body: { periods: GroupPeriodInput[] }) {
    return this.groups.replacePeriods(this.tenantId, id, body?.periods ?? [], this.userId);
  }

  /** ⏰ فترات التأجير as the older surface wrote them — a single سعر لِمدةٍ واحدة. */
  @Post('groups/:id/pricing')
  @RequiresPermission('marina.manage')
  price(@Param('id') id: string, @Body() b: { periodKind: string; price: string; currency?: string }) {
    return this.marina.price(this.tenantId, id, b);
  }

  @Post('vessels')
  @RequiresPermission('marina.manage')
  vessel(@Body() b: { groupId?: string; code: string; name: string; capacity?: number; metadata?: Record<string, unknown> }) {
    return this.marina.createVessel(this.tenantId, b);
  }

  /** «🗑️ حذف» of a ⚓ مركب — retired, so that its فئة can be retired after it. */
  @Delete('vessels/:id')
  @RequiresPermission('marina.manage')
  deleteVessel(@Param('id') id: string) {
    return this.marina.deleteVessel(this.tenantId, id);
  }

  @Post('vessels/:id/owners')
  @RequiresPermission('marina.manage')
  owner(@Param('id') id: string, @Body() b: { partyId: string; percent: string }) {
    return this.marina.addOwner(this.tenantId, id, b);
  }

  @Post('operation-plans')
  @RequiresPermission('marina.manage')
  plan(@Body() b: { groupId?: string; planDate: string; name: string; lines?: Array<{ vesselId: string; periodLabel?: string; metadata?: Record<string, unknown> }> }) {
    return this.marina.plan(this.tenantId, b);
  }
}

/**
 * Marina operations — preparation, rota, invoice linking and the day close (0025).
 *
 * They sit in a second controller so the original CRUD surface stays readable; Nest maps
 * both onto the same `/marina` prefix.
 */
@Controller('marina')
export class MarinaOperationsController {
  constructor(private readonly marina: MarinaService) {}

  @Get('operation-plans')
  @RequiresPermission('marina.view')
  plans(@Query('date') planDate?: string) {
    return this.marina.listPlans(getTenantContext().tenantId, planDate);
  }

  @Get('preparations')
  @RequiresPermission('marina.view')
  preparations(@Query('date') date?: string, @Query('status') status?: string) {
    return this.marina.listPreparations(getTenantContext().tenantId, { date, status });
  }

  @Post('bookings/:id/preparation')
  @RequiresPermission('marina.manage')
  prepare(@Param('id') id: string, @Body() body: { preparedOn?: string; fuelLevel?: string; lifeJackets?: number; checklist?: Record<string, unknown>; notes?: string }) {
    return this.marina.prepareBooking(getTenantContext().tenantId, id, body ?? {});
  }

  @Post('preparations/:id/return')
  @RequiresPermission('marina.manage')
  returnVessel(@Param('id') id: string, @Body() body: { returnNotes?: string }) {
    return this.marina.returnPreparation(getTenantContext().tenantId, id, body ?? {});
  }

  /** «🔍 خيارات البحث» — `frmInvoiceRentSrch` — then «🗑️ تصفية الحقول» clears them. */
  @Get('rental-invoices')
  @RequiresPermission('marina.view')
  rentals(
    @Query('partyId') partyId?: string,
    @Query('customer') customer?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('minNet') minNet?: string,
    @Query('maxNet') maxNet?: string,
  ) {
    return this.marina.listRentalInvoices(getTenantContext().tenantId, { partyId, customer, from, to, minNet, maxNet });
  }

  @Get('bookings/uninvoiced')
  @RequiresPermission('marina.view')
  uninvoiced() {
    return this.marina.listUninvoicedBookings(getTenantContext().tenantId);
  }

  @Post('rental-invoices/link')
  @RequiresPermission('marina.invoice')
  link(@Body() body: { bookingIds: string[] }) {
    return this.marina.linkInvoices(getTenantContext().tenantId, body?.bookingIds ?? []);
  }

  @Get('day-close')
  @RequiresPermission('marina.view')
  daySummary(@Query('branch_id') branchId: string, @Query('date') date: string) {
    return this.marina.dayCloseSummary(getTenantContext().tenantId, branchId, date);
  }

  @Get('day-closings')
  @RequiresPermission('marina.view')
  dayClosings(@Query('branch_id') branchId?: string) {
    return this.marina.listDayClosings(getTenantContext().tenantId, branchId);
  }

  @Post('day-close')
  @RequiresPermission('marina.manage')
  closeDay(@Body() body: { branchId: string; closeDate: string; notes?: string; force?: boolean }) {
    return this.marina.closeDay(getTenantContext().tenantId, body);
  }
}
