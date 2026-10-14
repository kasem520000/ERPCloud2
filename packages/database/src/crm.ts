/**
 * CRM rules that do not touch the database.
 * A forecast is the sum of open deal value × probability. Lost deals contribute nothing.
 * WhatsApp is an activity, not a second ledger.
 */

export class CrmRuleError extends Error {
  constructor(readonly rule: 'STAGE' | 'TITLE' | 'PROBABILITY' | 'VALUE' | 'CLOSED' | 'MESSAGE') {
    super(rule);
    this.name = 'CrmRuleError';
  }
}

export type CrmStage = {
  id: string;
  name: string;
  color: string;
  order: number;
};

export type CrmDealState = {
  stageId: string;
  status: 'open' | 'won' | 'lost';
  value: string;
  probability: number;
};

export const DEFAULT_PIPELINE_STAGES: readonly CrmStage[] = [
  { id: 'lead', name: 'عميل محتمل', color: '#64748b', order: 1 },
  { id: 'contact', name: 'تواصل', color: '#0ea5e9', order: 2 },
  { id: 'offer', name: 'عرض سعر', color: '#f59e0b', order: 3 },
  { id: 'close', name: 'إغلاق', color: '#16a34a', order: 4 },
];

export function defaultStages(): CrmStage[] {
  return DEFAULT_PIPELINE_STAGES.map((stage) => ({ ...stage }));
}

export function assertTitle(title: string): string {
  const text = title.trim();
  if (text.length < 1 || text.length > 120) throw new CrmRuleError('TITLE');
  return text;
}

export function assertProbability(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new CrmRuleError('PROBABILITY');
  return value;
}

export function assertDealValue(raw: string): string {
  const text = raw.trim();
  if (!/^\d{1,14}(\.\d{1,4})?$/.test(text)) throw new CrmRuleError('VALUE');
  const [whole, fraction = ''] = text.split('.');
  return `${whole}.${fraction.padEnd(4, '0').slice(0, 4)}`;
}

export function moveDeal(deal: CrmDealState, stages: readonly CrmStage[], stageId: string): CrmDealState {
  if (deal.status !== 'open') throw new CrmRuleError('CLOSED');
  if (!stages.some((stage) => stage.id === stageId)) throw new CrmRuleError('STAGE');
  return { ...deal, stageId };
}

function minor(valueText: string): bigint {
  const [whole, fraction = ''] = valueText.split('.');
  return BigInt(`${whole || '0'}${fraction.padEnd(4, '0').slice(0, 4)}`);
}

function fromMinor(value: bigint): string {
  const text = value.toString().padStart(5, '0');
  return `${text.slice(0, -4)}.${text.slice(-4)}`;
}

/** value × probability / 100, kept at four decimal places. No binary float. */
export function weightedValue(valueText: string, probability: number): string {
  return fromMinor((minor(assertDealValue(valueText)) * BigInt(assertProbability(probability))) / 100n);
}

export function forecastOpenDeals(deals: readonly CrmDealState[]): { weighted: string; openCount: number } {
  let sum = 0n;
  let openCount = 0;
  for (const deal of deals) {
    if (deal.status !== 'open') continue;
    openCount += 1;
    sum += minor(weightedValue(deal.value, deal.probability));
  }
  return { weighted: fromMinor(sum), openCount };
}

export function renderTemplate(body: string, vars: Readonly<Record<string, string>>): string {
  const text = body.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => vars[key] ?? '');
  if (!text.trim()) throw new CrmRuleError('MESSAGE');
  return text.trim();
}

export type CrmActivityDraft = {
  type: 'call' | 'meeting' | 'whatsapp' | 'email' | 'note';
  description: string;
  direction: 'out' | 'in' | '';
};

export function whatsappActivity(description: string, direction: 'out' | 'in'): CrmActivityDraft {
  const text = description.trim();
  if (!text) throw new CrmRuleError('MESSAGE');
  return { type: 'whatsapp', description: text, direction };
}

export function inboundText(body: unknown): { phone: string; text: string } | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const directPhone = record.from ?? record.phone;
  const directText = record.text ?? record.message;
  if (typeof directPhone === 'string' && typeof directText === 'string' && directText.trim()) {
    return { phone: directPhone, text: directText.trim() };
  }
  const entry = Array.isArray(record.entry) ? record.entry[0] : undefined;
  const change = entry && typeof entry === 'object' && Array.isArray((entry as { changes?: unknown }).changes)
    ? (entry as { changes: Array<{ value?: { messages?: Array<{ from?: string; text?: { body?: string } }> } }> }).changes[0]
    : undefined;
  const message = change?.value?.messages?.[0];
  const text = message?.text?.body?.trim() ?? '';
  if (!message?.from || !text) return null;
  return { phone: message.from, text };
}
