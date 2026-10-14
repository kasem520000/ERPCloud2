import { apiData, apiList, apiPost, apiPut } from './api';

export type CrmStage = { id: string; name: string; color: string; order: number };
export type CrmPipeline = { id: string; name: string; isDefault: boolean; stages: CrmStage[] };
export type CrmDeal = {
  id: string;
  pipelineId: string;
  stageId: string;
  partyId: string;
  partyName: string;
  partyPhone: string;
  title: string;
  value: string;
  probability: number;
  expectedClose: string;
  ownerId: string;
  status: 'open' | 'won' | 'lost' | string;
  lostReason: string;
};
export type CrmActivity = {
  id: string;
  dealId: string;
  title?: string;
  type: string;
  subject: string;
  description: string;
  at: string;
  direction: string;
};
export type CrmDealDetail = CrmDeal & { activities: CrmActivity[] };
export type CrmTemplate = { id: string; name: string; body: string };
export type CrmForecast = { weighted: string; openCount: number; count: number; deals: CrmDeal[] };

export const listPipelines = () => apiList<CrmPipeline>('/crm/pipelines');
export const createPipeline = (body: { name: string; stages: CrmStage[] }) => apiPost<CrmPipeline>('/crm/pipelines', body);
export const listDeals = (pipelineId?: string) =>
  apiList<CrmDeal>(`/crm/deals${pipelineId ? `?pipelineId=${pipelineId}` : ''}`);
export const getDeal = (id: string) => apiData<CrmDealDetail>(`/crm/deals/${id}`);
export const createDeal = (body: {
  pipelineId: string;
  title: string;
  value: string;
  probability: number;
  partyId?: string;
  expectedClose?: string;
}) => apiPost<CrmDealDetail>('/crm/deals', body);
export const moveDeal = (id: string, stageId: string) => apiPut<CrmDealDetail>(`/crm/deals/${id}/move`, { stageId });
export const closeDeal = (id: string, status: 'won' | 'lost', lostReason?: string) =>
  apiPut<CrmDealDetail>(`/crm/deals/${id}/status`, { status, lostReason });
export const addActivity = (id: string, type: string, description: string) =>
  apiPost<CrmActivity>(`/crm/deals/${id}/activities`, { type, description });
export const sendDealWhatsapp = (id: string, body: { templateId?: string; message?: string; to?: string }) =>
  apiPost<CrmActivity>(`/crm/deals/${id}/whatsapp`, body);
export const listActivities = (dealId?: string) =>
  apiList<CrmActivity>(`/crm/activities${dealId ? `?dealId=${dealId}` : ''}`);
export const forecast = (pipelineId?: string) =>
  apiData<CrmForecast>(`/crm/forecast${pipelineId ? `?pipelineId=${pipelineId}` : ''}`);
export const listTemplates = () => apiList<CrmTemplate>('/crm/whatsapp/templates');
