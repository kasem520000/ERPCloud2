import { describe, expect, it } from 'vitest';

import {
  CrmRuleError,
  assertDealValue,
  assertProbability,
  assertTitle,
  defaultStages,
  forecastOpenDeals,
  inboundText,
  moveDeal,
  renderTemplate,
  weightedValue,
  whatsappActivity,
  type CrmDealState,
} from './crm.js';

const open = (stageId: string, value: string, probability: number): CrmDealState => ({
  stageId,
  status: 'open',
  value,
  probability,
});

describe('CRM pipeline, WhatsApp and forecast', () => {
  it('starts a pipeline with four ordered stages', () => {
    const stages = defaultStages();
    expect(stages).toHaveLength(4);
    expect(stages.map((stage) => stage.order)).toEqual([1, 2, 3, 4]);
    expect(stages[1]?.name).toBe('تواصل');
  });

  it('moves an open deal to the second stage', () => {
    const stages = defaultStages();
    const moved = moveDeal(open('lead', '1000.0000', 40), stages, 'contact');
    expect(moved.stageId).toBe('contact');
    expect(moved.value).toBe('1000.0000');
  });

  it('rejects a stage that is not on the pipeline', () => {
    expect(() => moveDeal(open('lead', '10.0000', 10), defaultStages(), 'other-pipeline')).toThrow(CrmRuleError);
  });

  it('refuses to drag a won or lost deal', () => {
    const won: CrmDealState = { stageId: 'close', status: 'won', value: '10.0000', probability: 100 };
    expect(() => moveDeal(won, defaultStages(), 'lead')).toThrow(CrmRuleError);
  });

  it('forecasts the sum of value times probability', () => {
    const result = forecastOpenDeals([
      open('lead', '1000.0000', 50),
      open('offer', '200.5000', 25),
    ]);
    expect(weightedValue('1000.0000', 50)).toBe('500.0000');
    expect(weightedValue('200.5000', 25)).toBe('50.1250');
    expect(result.weighted).toBe('550.1250');
    expect(result.openCount).toBe(2);
  });

  it('excludes lost and won deals from the forecast', () => {
    const result = forecastOpenDeals([
      open('lead', '100.0000', 100),
      { stageId: 'close', status: 'lost', value: '9000.0000', probability: 100 },
      { stageId: 'close', status: 'won', value: '8000.0000', probability: 100 },
    ]);
    expect(result.weighted).toBe('100.0000');
    expect(result.openCount).toBe(1);
  });

  it('fills the WhatsApp template with the customer and the deal', () => {
    expect(renderTemplate('مرحبا {name} بخصوص {deal}', { name: 'أحمد', deal: 'عقد سنوي' })).toBe(
      'مرحبا أحمد بخصوص عقد سنوي',
    );
    expect(() => renderTemplate('   ', {})).toThrow(CrmRuleError);
  });

  it('records an outbound WhatsApp message as an activity', () => {
    expect(whatsappActivity('مرحبا أحمد بخصوص عقد سنوي', 'out')).toEqual({
      type: 'whatsapp',
      description: 'مرحبا أحمد بخصوص عقد سنوي',
      direction: 'out',
    });
  });

  it('reads an inbound reply from a plain body or a provider payload', () => {
    expect(inboundText({ from: '966500000000', text: 'تم' })).toEqual({ phone: '966500000000', text: 'تم' });
    expect(
      inboundText({
        entry: [{ changes: [{ value: { messages: [{ from: '966511111111', text: { body: 'موافق' } }] } }] }],
      }),
    ).toEqual({ phone: '966511111111', text: 'موافق' });
    expect(inboundText({ from: '966500000000', text: '  ' })).toBeNull();
    expect(whatsappActivity('موافق', 'in').direction).toBe('in');
  });

  it('keeps deal values as decimal strings and rejects a bad title or probability', () => {
    expect(assertDealValue('49')).toBe('49.0000');
    expect(assertTitle('صفقة جديدة')).toBe('صفقة جديدة');
    expect(assertProbability(0)).toBe(0);
    expect(() => assertTitle('')).toThrow(CrmRuleError);
    expect(() => assertProbability(101)).toThrow(CrmRuleError);
    expect(() => assertDealValue('12.34567')).toThrow(CrmRuleError);
    expect(weightedValue('49.0000', 0)).toBe('0.0000');
  });
});
