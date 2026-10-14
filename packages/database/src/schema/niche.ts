import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseLegacyColumns, baseSoftDeleteColumns } from '../columns.js';

import { items } from './catalog.js';
import { branches, warehouses } from './organization.js';
import { parties } from './parties.js';
import { salesInvoiceLines, salesInvoices } from './sales.js';
import { vouchers } from './treasury.js';
import { tenants } from './platform.js';

const money = { precision: 20, scale: 4, mode: 'string' as const };
const pct = { precision: 7, scale: 4, mode: 'string' as const };

export const opticalPrescriptions = pgTable('optical_prescriptions', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), partyId: uuid('party_id').notNull().references(() => parties.id), invoiceLineId: uuid('invoice_line_id').references(() => salesInvoiceLines.id, { onDelete: 'set null' }), orientation: text('orientation').notNull().default('distance'), rightEye: jsonb('right_eye').$type<{ sph?: string; cyl?: string; axis?: string; add?: string; ipd?: string }>().notNull().default({}), leftEye: jsonb('left_eye').$type<{ sph?: string; cyl?: string; axis?: string; add?: string; ipd?: string }>().notNull().default({}), otherGrid: jsonb('other_grid').$type<Record<string, string>>().notNull().default({}), notes: text('notes'), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns(),
}, (t) => ({ party: index('optical_prescriptions_party_idx').on(t.tenantId, t.partyId), line: index('optical_prescriptions_line_idx').on(t.tenantId, t.invoiceLineId) }));

/**
 * ⚙️ أسماء الحقول — `Other_Column(R1,R2,R3,R4,R5,L1,L2,L3,L4,L5)`
 * (`Form_WPF/frmGlasses.xaml` «👓 بيانات النظارات» → التبويب «⚙  أسماء الحقول»).
 *
 * The ten boxes of «👓  القياسات» are **not** named in the markup — `loadNameLbl` reads
 * them at runtime with `isnull(R1,'RE-SPH') … isnull(L5,'LE-IPD') from Other_Column`, so
 * these ten column defaults *are* the desktop's own words, and the tenant may rename any
 * of them. Note the mapping: حقل 6…10 (L1…L5) are the **left** eye, حقل 1…5 (R1…R5) the
 * right — the same order «💾 حفظ الأسماء» writes them in.
 */
export const opticsFieldLabels = pgTable('optics_field_labels', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  r1: text('r1').notNull().default('RE-SPH'), r2: text('r2').notNull().default('RE-CYL'), r3: text('r3').notNull().default('RE-AX'), r4: text('r4').notNull().default('RE-ADD'), r5: text('r5').notNull().default('RE-IPD'),
  l1: text('l1').notNull().default('LE-SPH'), l2: text('l2').notNull().default('LE-CYL'), l3: text('l3').notNull().default('LE-AX'), l4: text('l4').notNull().default('LE-ADD'), l5: text('l5').notNull().default('LE-IPD'),
  ...baseAuditColumns(), ...baseSoftDeleteColumns(),
}, (t) => ({ tenant: uniqueIndex('optics_field_labels_tenant_key').on(t.tenantId).where(sql`deleted_at IS NULL`) }));

/**
 * 📏 القياس — `CustomerMeasurements(MeasurementID, Cust_ID, MeasurementName,
 * MeasurementDate, Notes, IsActive)` (`Form_WPF/frmMeasurements.xaml` «إدارة قياسات
 * العملاء» + `frmMeasurementDetails.xaml` «📏 بيانات القياس»).
 *
 * `measurements` keeps its free-form keys: `frmCustomers.xaml` L1184 «📐 المقاسات»
 * stores fixed columns of its own (الطول · كتف · الرقبة · وسع اليد · وسع الخطوة · رقم
 * الصفحة) on the same document, and values written through the 📏 خصائص are keyed by
 * attribute **id** — so renaming a خاصية never orphans a number already taken.
 */
export const customerMeasurements = pgTable('customer_measurements', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), partyId: uuid('party_id').notNull().references(() => parties.id), kind: text('kind').notNull().default('tailoring'),
  /** 👤 اسم صاحب القياس — `MeasurementName`; «قياس بتاريخ …» stands in when it is null. */
  name: text('name'),
  /** 📅 التاريخ — `MeasurementDate`. */
  measurementDate: date('measurement_date'),
  measurements: jsonb('measurements').$type<Record<string, string>>().notNull().default({}), notes: text('notes'), active: boolean('active').notNull().default(true), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns(),
}, (t) => ({ party: index('customer_measurements_party_idx').on(t.tenantId, t.partyId, t.createdAt), date: index('customer_measurements_tenant_date_idx').on(t.tenantId, t.measurementDate, t.createdAt) }));

/** 📏 خصائص القياسات — `MeasurementAttributes(AttributeID, AttributeName, DisplayOrder, IsActive)`. */
export const tailoringMeasurementAttributes = pgTable('tailoring_measurement_attributes', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), nameAr: text('name_ar').notNull(), displayOrder: integer('display_order').notNull().default(0), active: boolean('active').notNull().default(true), ...baseAuditColumns(), ...baseSoftDeleteColumns(),
}, (t) => ({ name: uniqueIndex('tailoring_measurement_attributes_tenant_name_key').on(t.tenantId, t.nameAr).where(sql`deleted_at IS NULL`), order: index('tailoring_measurement_attributes_tenant_idx').on(t.tenantId, t.displayOrder) }));

/**
 * 🧵 طلب التفصيل — `TailoringOrders` / `vw_OrdersComplete`
 * (`Form_WPF/frmOrders.xaml` «إدارة طلبات التفصيل» + `frmOrderDetails.xaml` «إضافة طلب تفصيل»).
 * `remainingAmount` is *not* stored: ⌛ المتبقي is 💰 السعر − 💵 المدفوع, as
 * `frmOrderDetails.CalculateRemaining` L290 prints it.
 */
export const tailoringOrders = pgTable('tailoring_orders', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), number: text('number').notNull(), partyId: uuid('party_id').notNull().references(() => parties.id, { onDelete: 'restrict' }), measurementId: uuid('measurement_id').references(() => customerMeasurements.id, { onDelete: 'set null' }), typeId: uuid('type_id').notNull().references(() => tailoringTypes.id, { onDelete: 'restrict' }), statusId: uuid('status_id').notNull().references(() => tailoringOrderStatuses.id, { onDelete: 'restrict' }), orderDate: date('order_date').notNull(), deliveryDate: date('delivery_date'), quantity: numeric('quantity', money).notNull().default('1'), price: numeric('price', money).notNull().default('0'), paidAmount: numeric('paid_amount', money).notNull().default('0'), fabricType: text('fabric_type'), fabricColor: text('fabric_color'), designNotes: text('design_notes'), generalNotes: text('general_notes'), ...baseAuditColumns(), ...baseSoftDeleteColumns(),
}, (t) => ({ number: uniqueIndex('tailoring_orders_tenant_number_key').on(t.tenantId, t.number).where(sql`deleted_at IS NULL`), date: index('tailoring_orders_tenant_date_idx').on(t.tenantId, t.orderDate), party: index('tailoring_orders_tenant_party_idx').on(t.tenantId, t.partyId), status: index('tailoring_orders_tenant_status_idx').on(t.tenantId, t.statusId) }));

/** 🔧 الخيارات المختارة للطلب — `OrderOptions(OrderID, CategoryID, ValueID)`. */
export const tailoringOrderOptions = pgTable('tailoring_order_options', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), orderId: uuid('order_id').notNull().references(() => tailoringOrders.id, { onDelete: 'cascade' }), categoryId: uuid('category_id').notNull().references(() => tailoringOptionCategories.id, { onDelete: 'cascade' }), valueId: uuid('value_id').notNull().references(() => tailoringOptionValues.id, { onDelete: 'restrict' }), ...baseAuditColumns(),
}, (t) => ({ key: uniqueIndex('tailoring_order_options_tenant_key').on(t.tenantId, t.orderId, t.categoryId) }));

/** ⚙️ الحالة — `OrderStatus(StatusID, StatusName, IsActive, DisplayOrder)`. */
export const tailoringOrderStatuses = pgTable('tailoring_order_statuses', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), code: text('code').notNull(), nameAr: text('name_ar').notNull(), displayOrder: integer('display_order').notNull().default(0), isFinal: boolean('is_final').notNull().default(false), active: boolean('active').notNull().default(true), ...baseAuditColumns(), ...baseSoftDeleteColumns(),
}, (t) => ({ code: uniqueIndex('tailoring_order_statuses_tenant_code_key').on(t.tenantId, t.code).where(sql`deleted_at IS NULL`), order: index('tailoring_order_statuses_tenant_idx').on(t.tenantId, t.displayOrder) }));

/** 🧵 نوع التفصيل — `TailoringTypes(TypeID, TypeName, DefaultPrice, IsActive)`. */
export const tailoringTypes = pgTable('tailoring_types', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), code: text('code'), nameAr: text('name_ar').notNull(), defaultPrice: numeric('default_price', money).notNull().default('0'), active: boolean('active').notNull().default(true), ...baseAuditColumns(), ...baseSoftDeleteColumns(),
}, (t) => ({ name: uniqueIndex('tailoring_types_tenant_name_key').on(t.tenantId, t.nameAr).where(sql`deleted_at IS NULL`), code: uniqueIndex('tailoring_types_tenant_code_key').on(t.tenantId, t.code).where(sql`deleted_at IS NULL AND code IS NOT NULL`) }));

/** 🔧 الخيارات — `OptionCategories(CategoryID, CategoryName, IsActive, DisplayOrder)`. */
export const tailoringOptionCategories = pgTable('tailoring_option_categories', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), nameAr: text('name_ar').notNull(), displayOrder: integer('display_order').notNull().default(0), active: boolean('active').notNull().default(true), ...baseAuditColumns(), ...baseSoftDeleteColumns(),
}, (t) => ({ name: uniqueIndex('tailoring_option_categories_tenant_name_key').on(t.tenantId, t.nameAr).where(sql`deleted_at IS NULL`), order: index('tailoring_option_categories_tenant_idx').on(t.tenantId, t.displayOrder) }));

/** 🔧 الخيارات — `OptionValues(ValueID, CategoryID, ValueName, IsDefault, IsActive, DisplayOrder)`. */
export const tailoringOptionValues = pgTable('tailoring_option_values', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), categoryId: uuid('category_id').notNull().references(() => tailoringOptionCategories.id, { onDelete: 'cascade' }), nameAr: text('name_ar').notNull(), isDefault: boolean('is_default').notNull().default(false), displayOrder: integer('display_order').notNull().default(0), active: boolean('active').notNull().default(true), ...baseAuditColumns(), ...baseSoftDeleteColumns(),
}, (t) => ({ name: uniqueIndex('tailoring_option_values_tenant_name_key').on(t.tenantId, t.categoryId, t.nameAr).where(sql`deleted_at IS NULL`), category: index('tailoring_option_values_category_idx').on(t.tenantId, t.categoryId, t.displayOrder) }));

/**
 * 🧾 فاتورة التفصيل — `Inv_Tailor` / `Inv_Sub_Tailor`
 * (`Form_WPF/frmViewOrders.xaml` «عرض الطلبات - ViewOrders» + `AddNewSizes.xaml`
 * «إضافة مقاس جديد»).
 *
 * ⌛ الباقي و💰 الإجمالي are *not* stored: `frmViewOrders` shows
 * `الإجمالي × 1.05` and `الباقي = (الإجمالي × 1.05) − المدفوع` (L88–L90).
 */
export const tailoringInvoices = pgTable('tailoring_invoices', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), number: text('number').notNull(), partyId: uuid('party_id').references(() => parties.id, { onDelete: 'restrict' }), customerName: text('customer_name').notNull(), phone: text('phone'), invoiceDate: date('invoice_date').notNull(), quantity: numeric('quantity', money).notNull().default('1'), unitPrice: numeric('unit_price', money).notNull().default('0'), total: numeric('total', money).notNull().default('0'), paidAmount: numeric('paid_amount', money).notNull().default('0'), statusId: uuid('status_id').notNull().references(() => tailoringOrderStatuses.id, { onDelete: 'restrict' }), garmentTypeId: uuid('garment_type_id').references(() => tailoringGarmentTypes.id, { onDelete: 'set null' }), billed: boolean('billed').notNull().default(false), measurements: jsonb('measurements').$type<Record<string, string>>().notNull().default({}), notes: text('notes'), ...baseAuditColumns(), ...baseSoftDeleteColumns(),
}, (t) => ({ number: uniqueIndex('tailoring_invoices_tenant_number_key').on(t.tenantId, t.number).where(sql`deleted_at IS NULL`), date: index('tailoring_invoices_tenant_date_idx').on(t.tenantId, t.invoiceDate), party: index('tailoring_invoices_tenant_party_idx').on(t.tenantId, t.partyId), name: index('tailoring_invoices_tenant_name_idx').on(t.tenantId, t.customerName), status: index('tailoring_invoices_tenant_status_idx').on(t.tenantId, t.statusId) }));

/** 💵 إستلام دفعة — the link between a فاتورة تفصيل and the سند قبض that paid it. */
/** A payment line is written once and never edited — so, as with `invoice_payments`, it carries no version. */
export const tailoringInvoicePayments = pgTable('tailoring_invoice_payments', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), invoiceId: uuid('invoice_id').notNull().references(() => tailoringInvoices.id, { onDelete: 'cascade' }), voucherId: uuid('voucher_id').references(() => vouchers.id, { onDelete: 'set null' }), amount: numeric('amount', money).notNull(), paidAt: date('paid_at').notNull(), note: text('note'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), createdBy: uuid('created_by'),
}, (t) => ({ invoice: index('tailoring_invoice_payments_invoice_idx').on(t.tenantId, t.invoiceId, t.paidAt) }));

/** 👔 نوع الثوب — `typeCB` in `AddNewSizes.xaml` L423 (سعودي · بحريني · اماراتي · كويتي). */
export const tailoringGarmentTypes = pgTable('tailoring_garment_types', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), code: text('code').notNull(), nameAr: text('name_ar').notNull(), displayOrder: integer('display_order').notNull().default(0), active: boolean('active').notNull().default(true), ...baseAuditColumns(), ...baseSoftDeleteColumns(),
}, (t) => ({ code: uniqueIndex('tailoring_garment_types_tenant_code_key').on(t.tenantId, t.code).where(sql`deleted_at IS NULL`), order: index('tailoring_garment_types_tenant_idx').on(t.tenantId, t.displayOrder) }));

/**
 * 📋 بطاقة الفئة — `GroupMarine(id, code, name, nameEN, HourPrice, HalfHPrice, OfferHour,
 * OfferHalf, IsDeleted, image)` (`Form_WPF/frmGroupM.xaml` «📋 بطاقة فئة»).
 *
 * The فئة is the harbour's tariff: قيمة الساعة وقيمة النصف ساعة — and the rest of its
 * durations live in `vesselGroupPricing` (⏰ فترات التأجير, `Form_WPF/frmAddPeriod.xaml`).
 */
export const vesselGroups = pgTable('vessel_groups', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), name: text('name').notNull(), code: text('code'),
  /** 🔢 رقم الفئة — `GroupMarine.id`, which `LoadNextNo` computes as `count + 1`. */
  number: integer('number'),
  /** اسم الفئة (EN) — `nameEN` (`txtNameEN`). */
  nameEn: text('name_en'),
  /** قيمة الساعة — `HourPrice` (`txtHourPrice`). */
  hourPrice: numeric('hour_price', money).notNull().default('0'),
  /** عرض الساعة (دقيقة) — `OfferHour` (`txtHourOffer`). */
  hourOfferMinutes: integer('hour_offer_minutes').notNull().default(0),
  /** قيمة النصف ساعة — `HalfHPrice` (`txtHalfHPrice`). */
  halfHourPrice: numeric('half_hour_price', money).notNull().default('0'),
  /** عرض النصف ساعة (دقيقة) — `OfferHalf` (`txtHalfHOffer`). */
  halfHourOfferMinutes: integer('half_hour_offer_minutes').notNull().default(0),
  /** 🖼️ صورة الفئة — `GroupMarine.image`; a URL, because this platform has no byte store. */
  imageUrl: text('image_url'),
  ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns(),
}, (t) => ({ code: uniqueIndex('vessel_groups_code_key').on(t.tenantId, t.code).where(sql`code IS NOT NULL AND deleted_at IS NULL`), number: uniqueIndex('vessel_groups_tenant_number_key').on(t.tenantId, t.number).where(sql`number IS NOT NULL AND deleted_at IS NULL`) }));
export const vessels = pgTable('vessels', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), groupId: uuid('group_id').references(() => vesselGroups.id, { onDelete: 'set null' }), code: text('code').notNull(), name: text('name').notNull(), status: text('status').notNull().default('available'), capacity: integer('capacity').notNull().default(0), metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns(),
}, (t) => ({ code: uniqueIndex('vessels_code_key').on(t.tenantId, t.code).where(sql`deleted_at IS NULL`), group: index('vessels_group_idx').on(t.tenantId, t.groupId) }));
/**
 * ⏰ فترات التأجير — `RentPeriodSub(MGroupID, code, periodID, offer, rent)`
 * (`Form_WPF/frmAddPeriod.xaml` «⏰ إدارة فترات التأجير»), the فئة's tariff.
 *
 * `periodKind` is this platform's own key ('hour' · 'half_hour' · …) and is what prices a
 * حجز when `Booking.Price` is empty; `periodId` is the desktop's `RentPeriod.id`
 * (1 نصف ساعة … 10 خمس ساعات). The two canonical durations carry both, so the card's
 * قيمة الساعة وقيمة النصف ساعة and the تسعير behind them are one row, not two.
 */
export const vesselGroupPricing = pgTable('vessel_group_pricing', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), groupId: uuid('group_id').notNull().references(() => vesselGroups.id, { onDelete: 'cascade' }), periodKind: text('period_kind').notNull(),
  /** ⏰ المدة — `RentPeriod.id`. */
  periodId: integer('period_id'),
  /** Length of that فترة in minutes — نصف ساعة 30 … خمس ساعات 300. */
  minutes: integer('minutes').notNull().default(0),
  /** 🎁 العرض — `RentPeriodSub.offer`, in minutes. */
  offerMinutes: integer('offer_minutes').notNull().default(0),
  price: numeric('price', money).notNull(), currency: text('currency').notNull().default('SAR'), ...baseAuditColumns(),
}, (t) => ({ kind: uniqueIndex('vessel_group_pricing_kind_key').on(t.tenantId, t.groupId, t.periodKind), period: uniqueIndex('vessel_group_pricing_period_key').on(t.tenantId, t.groupId, t.periodId).where(sql`period_id IS NOT NULL`) }));
export const vesselOwners = pgTable('vessel_owners', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), vesselId: uuid('vessel_id').notNull().references(() => vessels.id, { onDelete: 'cascade' }), partyId: uuid('party_id').notNull().references(() => parties.id), percent: numeric('percent', pct).notNull(), ...baseAuditColumns(), ...baseSoftDeleteColumns(),
}, (t) => ({ owner: uniqueIndex('vessel_owners_party_key').on(t.tenantId, t.vesselId, t.partyId).where(sql`deleted_at IS NULL`) }));
/**
 * ➕ الإضافة — `Additions(id, name, SalePrice, IsDeleted)`
 * (`Form_WPF/frmAdditions.xaml` «📋 إضافات» — لوحتها «📋 إدارة الإضافات»).
 *
 * The window is three boxes (🔢 الرقم · 📝 الاسم · 💰 القيمة) and three buttons
 * (➕ جديد · 💾 حفظ · 🗑️ حذف), and it is what fills «🎁 الإضافات» in `frmBookingM`:
 * `LoadAdditions` is `select id, Name from Additions where IsDeleted=0`, and choosing one
 * writes its `SalePrice` into «السعر».
 *
 * 🔢 الرقم is read-only in the window (`IsReadOnly="True"`), and 💰 القيمة is a zero when
 * the box is left empty — both kept. The one thing it refuses is a name-less save.
 */
export const marinaAdditions = pgTable('marina_additions', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  /** 🔢 الرقم — `txtNo`; the next one is `max(الرقم) + 1` of what is still there. */
  number: integer('number').notNull(),
  /** 📝 الاسم — `txtName`; «يجب إدخال اسم الإضافة ⚠️» when it is blank. */
  name: text('name').notNull(),
  /** 💰 القيمة — `SalePrice`, for one unit; «الإجمالي» = الكمية × السعر. */
  salePrice: numeric('sale_price', money).notNull().default('0'),
  currency: text('currency').notNull().default('SAR'), ...baseAuditColumns(), ...baseSoftDeleteColumns(),
}, (t) => ({ number: uniqueIndex('marina_additions_tenant_number_key').on(t.tenantId, t.number).where(sql`deleted_at IS NULL`), name: index('marina_additions_tenant_name_idx').on(t.tenantId, t.name) }));

/**
 * 🛶 الحجز — `Booking(InvID, MarineId, UserId, ClientId, Bdate, dateIn, PeriodHour,
 * PeriodMinute, Price, status, BookingType, notes, IsDeleted)`
 * (`Form_WPF/frmBookingM.xaml` «الحجوزات»).
 *
 * `status` keeps the desktop's own words — «مؤكد» و«غير مؤكد» هما عنصرا `cmbBookingStatu`
 * ويُحفظان بنصّهما العربي؛ وصفٌّ كُتب قبل هذا الجزء يحمل 'booked' ويُقرأ «مؤكد». و📅
 * التاريخ (`Bdate`) غير 📅 تاريخ الحجز (`dateIn`) هناك، وهنا كذلك: `documentDate` يوم
 * الورقة و`startsAt` يوم الرحلة. و«📝 ملاحظات» غائبةٌ عن قصد: `txtNotes` تُمحى ولا تُحفظ.
 */
export const marinaBookings = pgTable('marina_bookings', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), branchId: uuid('branch_id').notNull().references(() => branches.id), partyId: uuid('party_id').notNull().references(() => parties.id), vesselId: uuid('vessel_id').notNull().references(() => vessels.id),
  /** 🔢 الرقم — `BK-000001`. */
  number: text('number'),
  /** 📅 التاريخ — `Bdate`؛ يوم الورقة لا يوم الرحلة. */
  documentDate: date('document_date').notNull().default(sql`CURRENT_DATE`),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(), endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  /** 🚢 نوع الحجز — «حجز عادي» أو «بحر مفتوح». */
  bookingType: text('booking_type').notNull().default('حجز عادي'),
  /** ⏱️ المدة ساعة — `PeriodHour`. */
  periodHours: integer('period_hours').notNull().default(0),
  /** ⏱️ المدة دقيقة — `PeriodMinute`؛ و`RentPeriod` = الساعة + الدقيقة ÷ 60. */
  periodMinutes: integer('period_minutes').notNull().default(0),
  /** 💰 القيمة — `Price`، يكتبها المشغّل، وتصير `tot_Rent` في فاتورة التأجير. */
  rentalAmount: numeric('rental_amount', money).notNull().default('0'),
  companions: integer('companions').notNull().default(0), insuranceAmount: numeric('insurance_amount', money).notNull().default('0'), status: text('status').notNull().default('booked'), metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns(),
}, (t) => ({ vesselTime: index('marina_bookings_vessel_time_idx').on(t.tenantId, t.vesselId, t.startsAt, t.endsAt), number: uniqueIndex('marina_bookings_tenant_number_key').on(t.tenantId, t.number).where(sql`number IS NOT NULL AND deleted_at IS NULL`), date: index('marina_bookings_tenant_date_idx').on(t.tenantId, t.documentDate, t.createdAt) }));
/** 🎁 الإضافات — `BookingAddition(bookId, AditionID, Price, quanty, notes, IsDeleted)`. */
export const marinaBookingAdditions = pgTable('marina_booking_additions', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), bookingId: uuid('booking_id').notNull().references(() => marinaBookings.id, { onDelete: 'cascade' }), description: text('description').notNull(),
  /** العدد — `quanty`. */
  quantity: numeric('quantity', money).notNull().default('1'),
  /** السعر — `Price`، لوحدةٍ واحدة؛ والإجمالي = العدد × السعر. */
  unitPrice: numeric('unit_price', money).notNull().default('0'),
  /** الإجمالي — `amount`. */
  amount: numeric('amount', money).notNull(),
  /** ➕ الإضافة — `BookingAddition.AditionID`؛ ما اختاره المشغّل من «🎁 الإضافات». */
  additionId: uuid('addition_id').references(() => marinaAdditions.id, { onDelete: 'set null' }), ...baseAuditColumns(),
});
export const rentalInvoices = pgTable('rental_invoices', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), bookingId: uuid('booking_id').notNull().references(() => marinaBookings.id), salesInvoiceId: uuid('sales_invoice_id').references(() => salesInvoices.id, { onDelete: 'set null' }),
  /** 📅 التاريخ — `RentInvoice.date`. */
  documentDate: date('document_date'),
  periodAmount: numeric('period_amount', money).notNull(), additionsAmount: numeric('additions_amount', money).notNull().default('0'), insuranceAmount: numeric('insurance_amount', money).notNull().default('0'),
  /** الإجمالي — `CalcuAll`: الإضافات + القيمة. */
  total: numeric('total', money).notNull(),
  /** ضريبة 15% — `tax` = ROUND(الإجمالي × MainVAT ÷ 100, 2). */
  taxAmount: numeric('tax_amount', money).notNull().default('0'),
  /** الصافي — `tot_net` = الإجمالي + الضريبة. */
  netAmount: numeric('net_amount', money).notNull().default('0'), status: text('status').notNull().default('draft'), metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}), ...baseAuditColumns(), ...baseLegacyColumns(),
}, (t) => ({ booking: uniqueIndex('rental_invoices_booking_key').on(t.tenantId, t.bookingId) }));
/**
 * ⚠️ المخالفة — `Violation(MarineId, Vdate, Period, status, ViolatType, notes, IsDeleted)`
 * (`Form_WPF/frmViolationM.xaml` «المخالفات»). `description` هي `notes` عند الديسكتوب
 * («📝 ملاحظة»)، و`violationType` هي «⚠️ نوع المخالفة» و`periodDays` هي «⏱️ مدة المخالفة
 * (يوم)» — وهما ما ترفض النافذة بدونهما.
 */
export const marinaViolations = pgTable('marina_violations', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  /** 🔢 الرقم — `VI-000001` (وهو `MAX(id) + 1` في `LoadNextNo`). */
  number: text('number'),
  vesselId: uuid('vessel_id').references(() => vessels.id), bookingId: uuid('booking_id').references(() => marinaBookings.id), partyId: uuid('party_id').references(() => parties.id), violationDate: date('violation_date').notNull(),
  /** ⏱️ مدة المخالفة (يوم) — `Period`. */
  periodDays: numeric('period_days', money),
  /** ⚠️ نوع المخالفة — `ViolatType`. */
  violationType: text('violation_type'),
  amount: numeric('amount', money).notNull().default('0'), description: text('description').notNull(), status: text('status').notNull().default('open'), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns(),
}, (t) => ({ number: uniqueIndex('marina_violations_tenant_number_key').on(t.tenantId, t.number).where(sql`number IS NOT NULL AND deleted_at IS NULL`), type: index('marina_violations_tenant_type_idx').on(t.tenantId, t.violationType, t.violationDate) }));
export const marinaOperationPlans = pgTable('marina_operation_plans', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), groupId: uuid('group_id').references(() => vesselGroups.id), planDate: date('plan_date').notNull(), name: text('name').notNull(), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns(),
}, (t) => ({ day: index('marina_operation_plans_day_idx').on(t.tenantId, t.planDate) }));
export const marinaOperationPlanLines = pgTable('marina_operation_plan_lines', {
  planId: uuid('plan_id').notNull().references(() => marinaOperationPlans.id, { onDelete: 'cascade' }), lineNo: integer('line_no').notNull(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), vesselId: uuid('vessel_id').notNull().references(() => vessels.id), periodLabel: text('period_label'), metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
}, (t) => ({ pk: primaryKey({ columns: [t.planId, t.lineNo] }) }));

/** تحضير المراكب — one preparation per booking, plus the return that closes it. */
export const marinaPreparations = pgTable('marina_preparations', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), bookingId: uuid('booking_id').notNull().references(() => marinaBookings.id, { onDelete: 'cascade' }), vesselId: uuid('vessel_id').notNull().references(() => vessels.id), preparedOn: date('prepared_on').notNull(), status: text('status').notNull().default('prepared'), fuelLevel: text('fuel_level'), lifeJackets: integer('life_jackets').notNull().default(0), checklist: jsonb('checklist').$type<Record<string, unknown>>().notNull().default({}), notes: text('notes'), preparedAt: timestamp('prepared_at', { withTimezone: true }).notNull().defaultNow(), returnedAt: timestamp('returned_at', { withTimezone: true }), returnNotes: text('return_notes'), ...baseAuditColumns(),
}, (t) => ({ booking: uniqueIndex('marina_preparations_booking_key').on(t.tenantId, t.bookingId), day: index('marina_preparations_day_idx').on(t.tenantId, t.preparedOn, t.status) }));

/** إغلاق اليومية — a closed harbour day refuses new bookings and rental invoices. */
export const marinaDayClosings = pgTable('marina_day_closings', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), branchId: uuid('branch_id').notNull().references(() => branches.id), closeDate: date('close_date').notNull(), bookingsCount: integer('bookings_count').notNull().default(0), rentalsCount: integer('rentals_count').notNull().default(0), rentalsTotal: numeric('rentals_total', money).notNull().default('0'), additionsTotal: numeric('additions_total', money).notNull().default('0'), insuranceTotal: numeric('insurance_total', money).notNull().default('0'), violationsTotal: numeric('violations_total', money).notNull().default('0'), notes: text('notes'), closedAt: timestamp('closed_at', { withTimezone: true }).notNull().defaultNow(), closedBy: uuid('closed_by'), ...baseAuditColumns(),
}, (t) => ({ day: uniqueIndex('marina_day_closings_day_key').on(t.tenantId, t.branchId, t.closeDate) }));

export const vehicleMakes = pgTable('vehicle_makes', { id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), name: text('name').notNull(), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns() }, (t) => ({ name: uniqueIndex('vehicle_makes_name_key').on(t.tenantId, t.name).where(sql`deleted_at IS NULL`) }));
export const vehicleModels = pgTable('vehicle_models', { id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), makeId: uuid('make_id').notNull().references(() => vehicleMakes.id, { onDelete: 'cascade' }), name: text('name').notNull(), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns() }, (t) => ({ name: uniqueIndex('vehicle_models_name_key').on(t.tenantId, t.makeId, t.name).where(sql`deleted_at IS NULL`) }));
export const itemVehicleFitment = pgTable('item_vehicle_fitment', { id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), itemId: uuid('item_id').notNull().references(() => items.id, { onDelete: 'cascade' }), makeId: uuid('make_id').notNull().references(() => vehicleMakes.id), modelId: uuid('model_id').references(() => vehicleModels.id), yearFrom: integer('year_from'), yearTo: integer('year_to'), notes: text('notes'), ...baseAuditColumns(), ...baseSoftDeleteColumns(), ...baseLegacyColumns() }, (t) => ({ lookup: index('item_vehicle_fitment_lookup_idx').on(t.tenantId, t.makeId, t.modelId, t.yearFrom, t.yearTo), item: index('item_vehicle_fitment_item_idx').on(t.tenantId, t.itemId) }));

export const sallaConnections = pgTable('salla_connections', { id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), storeId: text('store_id').notNull(), accessTokenEnc: text('access_token_enc').notNull(), refreshTokenEnc: text('refresh_token_enc'), webhookSecretEnc: text('webhook_secret_enc').notNull(), status: text('status').notNull().default('active'), scopes: jsonb('scopes').$type<string[]>().notNull().default([]), expiresAt: timestamp('expires_at', { withTimezone: true }), ...baseAuditColumns(), ...baseSoftDeleteColumns() }, (t) => ({ store: uniqueIndex('salla_connections_store_key').on(t.tenantId, t.storeId).where(sql`deleted_at IS NULL`) }));
export const sallaItemSync = pgTable('salla_item_sync', { id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), connectionId: uuid('connection_id').references(() => sallaConnections.id, { onDelete: 'cascade' }), itemId: uuid('item_id').notNull().references(() => items.id, { onDelete: 'cascade' }), remoteId: text('remote_id'), lastExportedSnapshot: jsonb('last_exported_snapshot').$type<Record<string, unknown>>().notNull().default({}), diffFlags: jsonb('diff_flags').$type<string[]>().notNull().default([]), status: text('status').notNull().default('pending'), nextRetryAt: timestamp('next_retry_at', { withTimezone: true }), attempts: integer('attempts').notNull().default(0), ...baseAuditColumns() }, (t) => ({ item: uniqueIndex('salla_item_sync_item_key').on(t.tenantId, t.connectionId, t.itemId) }));
export const sallaExportLog = pgTable('salla_export_log', { id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), connectionId: uuid('connection_id').references(() => sallaConnections.id, { onDelete: 'set null' }), itemId: uuid('item_id').references(() => items.id, { onDelete: 'set null' }), action: text('action').notNull(), status: text('status').notNull().default('queued'), requestPayload: jsonb('request_payload').$type<Record<string, unknown>>().notNull().default({}), responsePayload: jsonb('response_payload').$type<Record<string, unknown>>(), error: text('error'), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow() }, (t) => ({ status: index('salla_export_log_status_idx').on(t.tenantId, t.status) }));
/**
 * 📦 منتجات المتجر — what `FrmSallah`'s «📦 جلب المنتجات» pulled
 * (`Class/ProductsManager.cs` → `GET products`). The desktop counts them and forgets
 * them (`"تم جلب {n} منتج."`); this is where the count comes from.
 */
export const sallaProducts = pgTable('salla_products', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), connectionId: uuid('connection_id').notNull().references(() => sallaConnections.id, { onDelete: 'cascade' }), remoteId: text('remote_id').notNull(), sku: text('sku'), name: text('name'), price: numeric('price', money).notNull().default('0'), quantity: numeric('quantity', money).notNull().default('0'), status: text('status'), currency: text('currency').notNull().default('SAR'), payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}), syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(), ...baseAuditColumns(),
}, (t) => ({ remote: uniqueIndex('salla_products_remote_key').on(t.tenantId, t.connectionId, t.remoteId), connection: index('salla_products_connection_idx').on(t.tenantId, t.connectionId, t.syncedAt) }));

/**
 * 📋 طلبات المتجر — `Class/OrdersManager.cs` → `GET orders`. `remoteId` is what makes the
 * import idempotent: a طلب that is already here is skipped, not invoiced twice.
 */
export const sallaOrders = pgTable('salla_orders', {
  id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), connectionId: uuid('connection_id').notNull().references(() => sallaConnections.id, { onDelete: 'cascade' }), remoteId: text('remote_id').notNull(), number: text('number'), remoteStatus: text('remote_status'), customerName: text('customer_name'), customerMobile: text('customer_mobile'), currency: text('currency').notNull().default('SAR'), total: numeric('total', money).notNull().default('0'), placedAt: timestamp('placed_at', { withTimezone: true }), branchId: uuid('branch_id'), warehouseId: uuid('warehouse_id'), salesInvoiceId: uuid('sales_invoice_id'), payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}), ...baseAuditColumns(), ...baseSoftDeleteColumns(),
}, (t) => ({ remote: uniqueIndex('salla_orders_remote_key').on(t.tenantId, t.connectionId, t.remoteId).where(sql`deleted_at IS NULL`), connection: index('salla_orders_connection_idx').on(t.tenantId, t.connectionId, t.placedAt) }));

export const sallaBranchMappings = pgTable('salla_branch_mappings', { id: uuid('id').primaryKey(), tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }), connectionId: uuid('connection_id').references(() => sallaConnections.id, { onDelete: 'cascade' }), branchId: uuid('branch_id').references(() => branches.id), warehouseId: uuid('warehouse_id').references(() => warehouses.id), cashLocationId: uuid('cash_location_id'), remoteBranchId: text('remote_branch_id'), ...baseAuditColumns(), ...baseSoftDeleteColumns() }, (t) => ({ remote: uniqueIndex('salla_branch_mappings_remote_key').on(t.tenantId, t.connectionId, t.remoteBranchId).where(sql`deleted_at IS NULL`) }));

export const nicheTables = { opticalPrescriptions, opticsFieldLabels, customerMeasurements, tailoringMeasurementAttributes, tailoringOrders, tailoringOrderOptions, tailoringOrderStatuses, tailoringTypes, tailoringOptionCategories, tailoringOptionValues, tailoringInvoices, tailoringInvoicePayments, tailoringGarmentTypes, vesselGroups, vessels, vesselGroupPricing, vesselOwners, marinaAdditions, marinaBookings, marinaBookingAdditions, rentalInvoices, marinaViolations, marinaOperationPlans, marinaOperationPlanLines, marinaPreparations, marinaDayClosings, vehicleMakes, vehicleModels, itemVehicleFitment, sallaConnections, sallaItemSync, sallaExportLog, sallaProducts, sallaOrders, sallaBranchMappings };
