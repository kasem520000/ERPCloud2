import { z } from 'zod';

export const customFieldEntitySchema = z.enum(['party', 'item', 'invoice', 'employee']);
export const customFieldTypeSchema = z.enum(['text', 'number', 'date', 'select', 'boolean']);
export const customReportBaseEntitySchema = z.enum(['party', 'item', 'invoice', 'employee', 'sales_invoice']);
export const customReportChartSchema = z.enum(['table', 'bar', 'line', 'pie']);

export const customFieldInputSchema = z.object({
  entity: customFieldEntitySchema,
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  label: z.string().trim().min(1).max(120),
  label_ar: z.string().trim().min(1).max(120).optional(),
  label_en: z.string().trim().max(120).optional(),
  type: customFieldTypeSchema.optional(),
  fieldType: customFieldTypeSchema.optional(),
  options: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  required: z.boolean().optional(),
  isRequired: z.boolean().optional(),
  active: z.boolean().optional(),
  isActive: z.boolean().optional(),
  order: z.number().int().min(0).max(100000).optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
}).superRefine((input, ctx) => {
  const type = input.type ?? input.fieldType;
  if (!input.label && !input.label_ar) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['label'], message: 'Field label is required' });
  if (!type) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['type'], message: 'Field type is required' });
  if (type === 'select' && (!input.options?.length || new Set(input.options).size !== input.options.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Select fields need unique options' });
  }
  if (type !== 'select' && input.options?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Only select fields may have options' });
  }
});

export const customFieldPatchSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  type: customFieldTypeSchema.optional(),
  fieldType: customFieldTypeSchema.optional(),
  options: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  required: z.boolean().optional(),
  isRequired: z.boolean().optional(),
  active: z.boolean().optional(),
  isActive: z.boolean().optional(),
  order: z.number().int().min(0).max(100000).optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});

export const customFieldValueInputSchema = z.object({
  entity: customFieldEntitySchema,
  entityId: z.string().uuid(),
  value: z.unknown(),
});

export const customReportColumnSchema = z.object({
  source: z.enum(['native', 'custom', 'relation']).optional(),
  key: z.string().min(1).max(100).optional(),
  label: z.string().max(120).optional(),
  agg: z.enum(['sum', 'count', 'avg', 'min', 'max']).optional(),
  // Friendly aliases accepted by the first builder versions and normalized server-side.
  field: z.string().min(1).max(100).optional(),
  custom_field: z.string().min(1).max(100).optional(),
}).superRefine((column, ctx) => {
  if (!column.key && !column.field && !column.custom_field) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['key'], message: 'Report column needs key, field or custom_field' });
});

export const customReportFilterSchema = z.object({
  source: z.enum(['native', 'custom', 'relation']).optional(),
  key: z.string().min(1).max(100).optional(),
  field: z.string().min(1).max(100).optional(),
  custom_field: z.string().min(1).max(100).optional(),
  op: z.enum(['eq', 'neq', 'contains', 'startsWith', 'gt', 'gte', 'lt', 'lte', 'in', 'between']).default('eq'),
  value: z.unknown(),
});

export const customReportInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  baseEntity: customReportBaseEntitySchema,
  columns: z.array(customReportColumnSchema).min(1).max(50),
  filters: z.array(customReportFilterSchema).max(50).default([]),
  chartType: customReportChartSchema.default('table'),
  isPublic: z.boolean().default(false),
});

export type CustomFieldEntity = z.infer<typeof customFieldEntitySchema>;
export type CustomFieldType = z.infer<typeof customFieldTypeSchema>;
export type CustomFieldInput = z.infer<typeof customFieldInputSchema>;
export type CustomFieldPatch = z.infer<typeof customFieldPatchSchema>;
export type CustomReportInput = z.infer<typeof customReportInputSchema>;
export type CustomReportColumn = z.infer<typeof customReportColumnSchema>;
export type CustomReportFilter = z.infer<typeof customReportFilterSchema>;
