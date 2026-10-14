import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  customFieldEntitySchema,
  customFieldInputSchema,
  customFieldTypeSchema,
  customFieldValueInputSchema,
  DomainError,
  errorCodes,
  newId,
  type CustomFieldEntity,
  type CustomFieldInput,
  type CustomFieldType,
} from '@erp/contracts';
import {
  customFields,
  customFieldValues,
  employees,
  items,
  parties,
  purchaseInvoices,
  salesInvoices,
  withTenantTx,
  type CustomField,
  type DatabaseHandle,
  type DrizzleTx,
} from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';

const EMPTY = new Set([undefined, null, '']);

function validation(message: string, details?: unknown): DomainError {
  return new DomainError(errorCodes.VALIDATION_FAILED, message, 400, details);
}

function isBlank(value: unknown): boolean {
  return EMPTY.has(value as never);
}

function publicField(row: CustomField) {
  return {
    ...row,
    label: row.labelAr,
    type: row.fieldType,
    required: row.isRequired,
    active: row.isActive,
    order: row.sortOrder,
  };
}

@Injectable()
export class CustomFieldsService {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  async list(tenantId: string, entity?: string, includeInactive = false) {
    const parsedEntity = entity ? customFieldEntitySchema.safeParse(entity) : null;
    if (parsedEntity && !parsedEntity.success) throw validation('Unsupported custom-field entity');
    const rows = await withTenantTx(this.database.db, tenantId, (tx) => tx
      .select()
      .from(customFields)
      .where(and(
        eq(customFields.tenantId, tenantId),
        parsedEntity ? eq(customFields.entity, parsedEntity.data) : undefined,
        includeInactive ? undefined : eq(customFields.isActive, true),
        isNull(customFields.deletedAt),
      ))
      .orderBy(asc(customFields.sortOrder), asc(customFields.createdAt)));
    return rows.map(publicField);
  }

  async get(tenantId: string, id: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(customFields).where(and(
      eq(customFields.tenantId, tenantId),
      eq(customFields.id, id),
      isNull(customFields.deletedAt),
    )));
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'Custom field was not found', 404);
    return publicField(row);
  }

  async create(tenantId: string, raw: unknown, userId?: string) {
    const input = this.parseFieldInput(raw);
    const id = newId();
    try {
      const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.insert(customFields).values({
        id,
        tenantId,
        entity: input.entity,
        key: input.key,
        labelAr: input.label,
        labelEn: input.label_en,
        fieldType: this.fieldType(input),
        options: input.options ?? [],
        isRequired: input.required ?? input.isRequired ?? false,
        isActive: input.active ?? input.isActive ?? true,
        sortOrder: input.order ?? input.sortOrder ?? 0,
        createdBy: userId,
      }).returning());
      if (!row) throw new DomainError(errorCodes.INTERNAL, 'Custom field was not created', 500);
      return publicField(row);
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new DomainError('CUSTOM_FIELD_KEY_TAKEN', 'A field with this key already exists for this entity', 409);
      throw error;
    }
  }

  async update(tenantId: string, id: string, raw: unknown, userId?: string) {
    const current = await this.getRaw(tenantId, id);
    const input = this.parseFieldPatch(raw, current);
    const nextType = this.fieldType(input);
    if (nextType !== current.fieldType && input.options === undefined && nextType === 'select') {
      throw validation('Select fields must provide options');
    }
    try {
      const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.update(customFields).set({
        ...(input.label === undefined ? {} : { labelAr: input.label }),
        ...(input.label_en === undefined ? {} : { labelEn: input.label_en }),
        ...(input.options === undefined ? {} : { options: input.options }),
        ...(input.type === undefined && input.fieldType === undefined ? {} : { fieldType: nextType }),
        ...(input.required === undefined && input.isRequired === undefined ? {} : { isRequired: input.required ?? input.isRequired }),
        ...(input.active === undefined && input.isActive === undefined ? {} : { isActive: input.active ?? input.isActive }),
        ...(input.order === undefined && input.sortOrder === undefined ? {} : { sortOrder: input.order ?? input.sortOrder }),
        updatedAt: new Date(),
        updatedBy: userId,
        version: current.version + 1,
      }).where(and(eq(customFields.tenantId, tenantId), eq(customFields.id, id), isNull(customFields.deletedAt))).returning());
      if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'Custom field was not found', 404);
      return publicField(row);
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new DomainError('CUSTOM_FIELD_KEY_TAKEN', 'A field with this key already exists for this entity', 409);
      throw error;
    }
  }

  async remove(tenantId: string, id: string, userId?: string) {
    await this.get(tenantId, id);
    await withTenantTx(this.database.db, tenantId, (tx) => tx.update(customFields).set({
      isActive: false,
      deletedAt: new Date(),
      deletedBy: userId,
      updatedAt: new Date(),
      updatedBy: userId,
    }).where(and(eq(customFields.tenantId, tenantId), eq(customFields.id, id))));
    return { id, deleted: true };
  }

  /** Returns every active definition plus a JSON value keyed by the stable field key. */
  async values(tenantId: string, entity: string, entityId: string) {
    const parsedEntity = customFieldEntitySchema.safeParse(entity);
    if (!parsedEntity.success) throw validation('Unsupported custom-field entity');
    const definitions = await this.list(tenantId, parsedEntity.data);
    const rows = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(customFieldValues).where(and(
      eq(customFieldValues.tenantId, tenantId),
      eq(customFieldValues.entityType, parsedEntity.data),
      eq(customFieldValues.entityId, entityId),
    )));
    const byFieldId = new Map(rows.map((row) => [row.fieldId, row.value]));
    return definitions.map((field) => ({ ...field, value: byFieldId.get(field.id) ?? null }));
  }

  /** Bulk write used by cards; it validates the complete required set before any upsert. */
  async setValues(tenantId: string, raw: unknown, userId?: string) {
    const parsed = this.parseValuesInput(raw);
    const definitions = await this.list(tenantId, parsed.entity);
    const byKey = new Map(definitions.map((field) => [field.key, field]));
    const provided = new Set(Object.keys(parsed.values));
    const unknown = [...provided].filter((key) => !byKey.has(key));
    if (unknown.length) throw validation(`Unknown or inactive custom field: ${unknown[0]}`);
    for (const field of definitions) {
      const value = parsed.values[field.key];
      if (field.required && (provided.has(field.key) ? isBlank(value) : true)) {
        throw validation(`Required custom field is missing: ${field.labelAr}`, [{ field: field.key, message: 'Required field' }]);
      }
      if (provided.has(field.key)) this.validateValue(field, value);
    }

    await withTenantTx(this.database.db, parsed.entity === 'invoice' ? tenantId : tenantId, async (tx) => {
      await this.assertEntityExists(tx, tenantId, parsed.entity, parsed.entityId);
      for (const [key, value] of Object.entries(parsed.values)) {
        const field = byKey.get(key);
        if (!field) continue;
        await tx.insert(customFieldValues).values({
          id: newId(),
          tenantId,
          fieldId: field.id,
          entityType: parsed.entity,
          entityId: parsed.entityId,
          value,
          createdBy: userId,
        }).onConflictDoUpdate({
          target: [customFieldValues.tenantId, customFieldValues.entityType, customFieldValues.entityId, customFieldValues.fieldId],
          set: { value, updatedAt: new Date(), updatedBy: userId, version: 2 },
        });
      }
    });
    return this.values(tenantId, parsed.entity, parsed.entityId);
  }

  async setSingleValue(tenantId: string, fieldId: string, raw: unknown, userId?: string) {
    const value = (raw ?? {}) as Record<string, unknown>;
    const parsed = customFieldValueInputSchema.safeParse({
      ...value,
      entity: value.entity ?? value.entity_type,
      entityId: value.entityId ?? value.entity_id,
    });
    if (!parsed.success) throw validation('Invalid custom-field value request', parsed.error.issues);
    const field = await this.getRaw(tenantId, fieldId);
    if (!field.isActive || field.deletedAt) throw new DomainError(errorCodes.NOT_FOUND, 'Custom field was not found', 404);
    if (field.entity !== parsed.data.entity) throw validation('The value entity does not match the custom field');
    if (field.isRequired && isBlank(parsed.data.value)) throw validation(`Required custom field is missing: ${field.labelAr}`);
    this.validateValue(publicField(field), parsed.data.value);
    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.assertEntityExists(tx, tenantId, parsed.data.entity, parsed.data.entityId);
      await tx.insert(customFieldValues).values({ id: newId(), tenantId, fieldId, entityType: parsed.data.entity, entityId: parsed.data.entityId, value: parsed.data.value, createdBy: userId }).onConflictDoUpdate({
        target: [customFieldValues.tenantId, customFieldValues.entityType, customFieldValues.entityId, customFieldValues.fieldId],
        set: { value: parsed.data.value, updatedAt: new Date(), updatedBy: userId, version: 2 },
      });
    });
    return this.values(tenantId, parsed.data.entity, parsed.data.entityId);
  }

  /** Used by party/item/employee cards without exposing the value table to callers. */
  async decorate<T extends { id: string }>(tenantId: string, entity: CustomFieldEntity, rows: T[]): Promise<Array<T & { customFields: Record<string, unknown> }>> {
    if (!rows.length) return [];
    const definitions = await this.list(tenantId, entity);
    if (!definitions.length) return rows.map((row) => ({ ...row, customFields: {} }));
    const ids = rows.map((row) => row.id);
    const values = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(customFieldValues).where(and(
      eq(customFieldValues.tenantId, tenantId),
      eq(customFieldValues.entityType, entity),
      inArray(customFieldValues.entityId, ids),
    )));
    const fieldKeys = new Map(definitions.map((field) => [field.id, field.key]));
    const byEntity = new Map<string, Record<string, unknown>>();
    for (const row of values) {
      const key = fieldKeys.get(row.fieldId);
      if (!key) continue;
      const record = byEntity.get(row.entityId) ?? {};
      record[key] = row.value;
      byEntity.set(row.entityId, record);
    }
    return rows.map((row) => ({ ...row, customFields: byEntity.get(row.id) ?? {} }));
  }

  private parseFieldInput(raw: unknown): CustomFieldInput {
    const value = (raw ?? {}) as Record<string, unknown>;
    const normalized = {
      ...value,
      label: value.label ?? value.label_ar,
      label_en: value.label_en ?? value.labelEn,
      type: value.type ?? value.field_type,
      required: value.required ?? value.is_required,
      active: value.active ?? value.is_active,
      order: value.order ?? value.sort_order,
    };
    const parsed = customFieldInputSchema.safeParse(normalized);
    if (!parsed.success) throw validation('Invalid custom-field definition', parsed.error.issues);
    return parsed.data;
  }

  private parseFieldPatch(raw: unknown, current: CustomField): CustomFieldInput {
    const patch = (raw ?? {}) as Record<string, unknown>;
    const candidate = { entity: current.entity, key: current.key, ...patch, label: patch.label ?? patch.label_ar ?? current.labelAr, label_ar: patch.label_ar ?? current.labelAr, label_en: patch.label_en ?? current.labelEn ?? undefined, type: patch.type ?? patch.field_type ?? current.fieldType, fieldType: patch.fieldType ?? current.fieldType, options: patch.options ?? current.options };
    return this.parseFieldInput(candidate);
  }

  private fieldType(input: { type?: CustomFieldType; fieldType?: CustomFieldType }): CustomFieldType {
    const parsed = customFieldTypeSchema.safeParse(input.type ?? input.fieldType);
    if (!parsed.success) throw validation('Unsupported custom-field type');
    return parsed.data;
  }

  private parseValuesInput(raw: unknown): { entity: CustomFieldEntity; entityId: string; values: Record<string, unknown> } {
    const value = (raw ?? {}) as Record<string, unknown>;
    const entity = customFieldEntitySchema.safeParse(value.entity ?? value.entity_type);
    const entityId = value.entityId ?? value.entity_id;
    if (!entity.success || typeof entityId !== 'string' || !/^[0-9a-f-]{36}$/i.test(entityId) || !value.values || typeof value.values !== 'object' || Array.isArray(value.values)) {
      throw validation('Values require entity, entityId and an object of field values');
    }
    return { entity: entity.data, entityId, values: value.values as Record<string, unknown> };
  }

  private validateValue(field: { type: string; options?: string[] }, value: unknown) {
    if (isBlank(value)) return;
    if (field.type === 'text' && (typeof value !== 'string' || value.length > 5000)) throw validation('Text custom fields require a string of at most 5000 characters');
    if (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw validation('Number custom fields require a finite number');
    if (field.type === 'boolean' && typeof value !== 'boolean') throw validation('Boolean custom fields require true or false');
    if (field.type === 'date' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) throw validation('Date custom fields require YYYY-MM-DD');
    if (field.type === 'select' && (typeof value !== 'string' || !field.options?.includes(value))) throw validation('Select value is not one of the configured options');
  }

  private async getRaw(tenantId: string, id: string) {
    const [row] = await withTenantTx(this.database.db, tenantId, (tx) => tx.select().from(customFields).where(and(eq(customFields.tenantId, tenantId), eq(customFields.id, id), isNull(customFields.deletedAt))));
    if (!row) throw new DomainError(errorCodes.NOT_FOUND, 'Custom field was not found', 404);
    return row;
  }

  private async assertEntityExists(tx: DrizzleTx, tenantId: string, entity: CustomFieldEntity, entityId: string) {
    let found = false;
    if (entity === 'party') {
      const [row] = await tx.select({ id: parties.id }).from(parties).where(and(eq(parties.tenantId, tenantId), eq(parties.id, entityId), isNull(parties.deletedAt)));
      found = Boolean(row);
    } else if (entity === 'item') {
      const [row] = await tx.select({ id: items.id }).from(items).where(and(eq(items.tenantId, tenantId), eq(items.id, entityId), isNull(items.deletedAt)));
      found = Boolean(row);
    } else if (entity === 'employee') {
      const [row] = await tx.select({ id: employees.id }).from(employees).where(and(eq(employees.tenantId, tenantId), eq(employees.id, entityId), isNull(employees.deletedAt)));
      found = Boolean(row);
    } else {
      const [sale] = await tx.select({ id: salesInvoices.id }).from(salesInvoices).where(and(eq(salesInvoices.tenantId, tenantId), eq(salesInvoices.id, entityId)));
      if (sale) found = true;
      if (!found) {
        const [purchase] = await tx.select({ id: purchaseInvoices.id }).from(purchaseInvoices).where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.id, entityId)));
        found = Boolean(purchase);
      }
    }
    if (!found) throw new DomainError(errorCodes.NOT_FOUND, `${entity} record was not found`, 404);
  }

  private isUniqueViolation(error: unknown): boolean {
    const seen = new Set<object>();
    let current: unknown = error;
    while (typeof current === 'object' && current !== null && !seen.has(current)) {
      seen.add(current);
      const candidate = current as { code?: unknown; cause?: unknown };
      if (candidate.code === '23505') return true;
      current = candidate.cause;
    }
    return false;
  }
}
