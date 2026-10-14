import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { baseAuditColumns, baseSoftDeleteColumns } from '../columns.js';

import { tenants } from './platform.js';

/**
 * Tenant-defined fields and saved report definitions.
 *
 * Values deliberately keep their JSON representation. The API validates the JSON against
 * the field definition before writing it; keeping the value typed in Postgres means exports
 * and report builders do not need a second EAV table for each primitive type.
 */
export const customFields = pgTable(
  'custom_fields',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    entity: text('entity').notNull(),
    key: text('key').notNull(),
    labelAr: text('label_ar').notNull(),
    labelEn: text('label_en'),
    fieldType: text('type').notNull(),
    options: jsonb('options').$type<string[]>().notNull().default([]),
    isRequired: boolean('is_required').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
  },
  (table) => ({
    tenantEntityKey: uniqueIndex('custom_fields_tenant_entity_key').on(table.tenantId, table.entity, table.key),
    tenantEntityOrder: index('custom_fields_tenant_entity_order_idx').on(table.tenantId, table.entity, table.sortOrder),
    activeIdx: index('custom_fields_tenant_active_idx').on(table.tenantId, table.entity, table.isActive),
    entityCheck: check('custom_fields_entity_check', sql`${table.entity} IN ('party', 'item', 'invoice', 'employee')`),
    typeCheck: check('custom_fields_type_check', sql`${table.fieldType} IN ('text', 'number', 'date', 'select', 'boolean')`),
  }),
);

export const customFieldValues = pgTable(
  'custom_field_values',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    fieldId: uuid('field_id').notNull().references(() => customFields.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    value: jsonb('value').notNull(),
    ...baseAuditColumns(),
  },
  (table) => ({
    fieldEntityKey: uniqueIndex('custom_field_values_tenant_entity_field_key').on(table.tenantId, table.entityType, table.entityId, table.fieldId),
    tenantEntityIdx: index('custom_field_values_tenant_entity_idx').on(table.tenantId, table.entityType, table.entityId),
    fieldIdx: index('custom_field_values_tenant_field_idx').on(table.tenantId, table.fieldId),
    entityCheck: check('custom_field_values_entity_check', sql`${table.entityType} IN ('party', 'item', 'invoice', 'employee')`),
  }),
);

export const customReports = pgTable(
  'custom_reports',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    baseEntity: text('base_entity').notNull(),
    columns: jsonb('columns').$type<unknown[]>().notNull().default([]),
    filters: jsonb('filters').$type<unknown[]>().notNull().default([]),
    chartType: text('chart_type').notNull().default('table'),
    isPublic: boolean('is_public').notNull().default(false),
    ...baseAuditColumns(),
    ...baseSoftDeleteColumns(),
  },
  (table) => ({
    tenantNameKey: uniqueIndex('custom_reports_tenant_name_key').on(table.tenantId, table.name).where(sql`deleted_at IS NULL`),
    tenantEntityIdx: index('custom_reports_tenant_entity_idx').on(table.tenantId, table.baseEntity, table.createdAt),
    entityCheck: check('custom_reports_base_entity_check', sql`${table.baseEntity} IN ('party', 'item', 'invoice', 'employee', 'sales_invoice')`),
    chartCheck: check('custom_reports_chart_type_check', sql`${table.chartType} IN ('table', 'bar', 'line', 'pie')`),
  }),
);

export type CustomField = typeof customFields.$inferSelect;
export type CustomFieldValue = typeof customFieldValues.$inferSelect;
export type CustomReport = typeof customReports.$inferSelect;
