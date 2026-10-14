import { apiData, apiDelete, apiPost, apiPut } from './api';

export type CustomFieldEntity = 'party' | 'item' | 'invoice' | 'employee';
export type CustomFieldType = 'text' | 'number' | 'date' | 'select' | 'boolean';
export type CustomField = {
  id: string;
  entity: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  fieldType: CustomFieldType;
  options: string[];
  required: boolean;
  active: boolean;
  order: number;
};

export type CustomReport = {
  id: string;
  name: string;
  baseEntity: string;
  columns: unknown[];
  filters: unknown[];
  chartType: 'table' | 'bar' | 'line' | 'pie';
  isPublic: boolean;
};

export type CustomReportField = { key: string; label: string; source: 'native' | 'custom' | 'relation'; type: string; options?: string[] };
export type CustomReportDefinition = {
  name: string;
  baseEntity: string;
  columns: Array<{ source: 'native' | 'custom' | 'relation'; key: string; label?: string; agg?: string }>;
  filters: Array<{ source: 'native' | 'custom' | 'relation'; key: string; op: string; value: unknown }>;
  chartType: 'table' | 'bar' | 'line' | 'pie';
  isPublic: boolean;
};

export const listCustomFields = (entity: CustomFieldEntity, includeInactive = true) =>
  apiData<CustomField[]>(`/custom-fields?entity=${encodeURIComponent(entity)}&include_inactive=${includeInactive}`);

export const createCustomField = (body: unknown) => apiPost<CustomField>('/custom-fields', body);
export const updateCustomField = (id: string, body: unknown) => apiPut<CustomField>(`/custom-fields/${id}`, body);
export const deleteCustomField = (id: string) => apiDelete<{ id: string; deleted: boolean }>(`/custom-fields/${id}`);
export type CustomFieldValue = CustomField & { value: unknown };
export const getCustomFieldValues = (entity: CustomFieldEntity, entityId: string) => apiData<CustomFieldValue[]>(`/custom-fields/values?entity=${encodeURIComponent(entity)}&entity_id=${encodeURIComponent(entityId)}`);
export const saveCustomFieldValues = (entity: CustomFieldEntity, entityId: string, values: Record<string, unknown>) => apiPut<CustomFieldValue[]>('/custom-fields/values', { entity, entityId, values });

export const listCustomReports = () => apiData<CustomReport[]>('/custom-reports');
export const getCustomReport = (id: string) => apiData<CustomReport>(`/custom-reports/${id}`);
export const customReportFields = (baseEntity: string) => apiData<{ baseEntity: string; fields: CustomReportField[] }>(`/custom-reports/fields?base_entity=${encodeURIComponent(baseEntity)}`);
export const createCustomReport = (body: CustomReportDefinition) => apiPost<CustomReport>('/custom-reports', body);
export const runCustomReport = (id: string) => apiPost<unknown>(`/custom-reports/${id}/run`, {});
export const exportCustomReport = (id: string, format: 'csv' | 'pdf') => apiPost<{ filename: string; mimeType: string; encoding: string; content: string }>(`/custom-reports/${id}/export`, { format });
export const deleteCustomReport = (id: string) => apiDelete<{ id: string; deleted: boolean }>(`/custom-reports/${id}`);
